// The Cupcake Analyst chat on the site (docs/bot.js): a Cloudflare Worker between the page and Claude.
// It keeps the Claude API key secret, only answers signed-in members, and counts each member's questions and cost
// for the month (Cloudflare KV), so nobody can run up the bill. The page runs the stat lookups itself, on the site's
// own data, and sends the results back here; this Worker only talks to Claude.
//
//   GET  /me    -> { member, questions, usd, limit, today, days }   (the chat button only shows for members)
//   POST /chat  -> one Claude turn: { content, stop_reason, usage }  body: { system, tools, messages, newQuestion }
//   Both need "Authorization: Bearer <Firebase ID token>" (the site's Sign in with Google).
//
// Setup (Cloudflare dashboard > Workers > this worker > Settings):
//   Variables and Secrets: ANTHROPIC_API_KEY  a Claude API key (console.anthropic.com > API keys), as a Secret
//                          MEMBERS            emails allowed to use it, comma-separated, as Text (later: paid members)
//   Bindings: KV namespace, variable name USAGE (Storage > KV > create one called analyst-usage)
// Stripe (paid members) comes later; for now MEMBERS is the list.

const ALLOWED = ["https://cupcakeindex.com", "https://www.cupcakeindex.com", "http://localhost:8765"];
const PROJECT = "cupcake-index"; // Firebase project: whose sign-in tokens we accept
const OWNER = "thecupcakeindex.support@gmail.com"; // testing: no question limit, only the dollar backstop
const MODEL = "claude-haiku-5-5";
const PRICE_IN = 0.10, PRICE_OUT = 0.50; // $ per million tokens (Haiku 5.5, prompts under 100K tokens)
const LIMIT = 300; // questions a month a member gets
const DAY_LIMIT = 40; // and a day, so nobody uses the month in one night
const MONTH_CAP_USD = 5; // backstop per person, the owner included: past this, it stops until the 1st

// ---------- Firebase sign-in tokens (RS256, Google's public keys) ----------
let jwks = null, jwksUntil = 0;
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
async function googleKeys() {
  if (jwks && Date.now() < jwksUntil) return jwks;
  const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  if (!r.ok) throw new Error("couldn't get Google's sign-in keys");
  const age = +((r.headers.get("Cache-Control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
  jwks = (await r.json()).keys;
  jwksUntil = Date.now() + age * 1000;
  return jwks;
}
async function signedIn(req) {
  const tok = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const [h, p, s] = tok.split(".");
  if (!h || !p || !s) return null;
  const dec = (x) => JSON.parse(new TextDecoder().decode(b64u(x)));
  const head = dec(h), body = dec(p), now = Date.now() / 1000;
  const jwk = (await googleKeys()).find((k) => k.kid === head.kid);
  if (!jwk || head.alg !== "RS256") return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(h + "." + p));
  if (!ok || body.aud !== PROJECT || body.iss !== "https://securetoken.google.com/" + PROJECT || body.exp < now || body.iat > now + 60 || !body.sub) return null;
  return { uid: body.sub, email: String(body.email || "").toLowerCase(), verified: !!body.email_verified };
}
const isMember = (u, env) => u.verified && (env.MEMBERS || "").toLowerCase().split(/[,\s]+/).filter(Boolean).includes(u.email);

// ---------- usage: one KV entry per person per month ----------
const month = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
async function usage(env, uid) {
  return (await env.USAGE.get(`u:${uid}:${month()}`, "json")) || { q: 0, usd: 0, days: {} };
}
const summary = (u, me) => ({ member: true, questions: u.q, usd: Math.round(u.usd * 10000) / 10000, limit: LIMIT, day_limit: me.email === OWNER ? null : DAY_LIMIT,
  today: u.days[today()]?.q || 0, days: u.days, cap_usd: MONTH_CAP_USD, testing: me.email === OWNER });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0], Vary: "Origin" };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" } });
    if (origin && !ALLOWED.includes(origin)) return json({ error: "not allowed" }, 403);

    let me;
    try { me = await signedIn(req); } catch (e) { return json({ error: "sign-in check failed" }, 503); }
    if (!me) return json({ error: "sign in first" }, 401);
    if (url.pathname === "/me") return json(isMember(me, env) ? summary(await usage(env, me.uid), me) : { member: false });
    if (url.pathname !== "/chat" || req.method !== "POST") return json({ error: "not found" }, 404);
    if (!isMember(me, env)) return json({ error: "The Analyst is for members." }, 403);

    // the page sends the instructions, its tools and the conversation; we fix the model and the size of the answer
    const raw = await req.text();
    if (raw.length > 400000) return json({ error: "That conversation got too long. Start a new one." }, 413);
    let b;
    try { b = JSON.parse(raw); } catch (e) { return json({ error: "bad request" }, 400); }
    const tools = Array.isArray(b.tools) ? b.tools : [];
    if (typeof b.system !== "string" || b.system.length > 60000 || !Array.isArray(b.messages) || !b.messages.length || b.messages.length > 80
      || tools.length > 24 || tools.some((t) => t.type || !t.name || !t.input_schema)) return json({ error: "bad request" }, 400); // our own tools only (no web search etc.)

    const u = await usage(env, me.uid), d = today(), owner = me.email === OWNER;
    u.days[d] ||= { q: 0, usd: 0 };
    if (u.usd >= MONTH_CAP_USD) return json({ error: `You've hit this month's limit. It resets on the 1st.`, usage: summary(u, me) }, 429);
    if (b.newQuestion && !owner && u.q >= LIMIT) return json({ error: `You've used all ${LIMIT} questions this month. They reset on the 1st.`, usage: summary(u, me) }, 429);
    if (b.newQuestion && !owner && u.days[d].q >= DAY_LIMIT) return json({ error: `That's ${DAY_LIMIT} questions today. More tomorrow.`, usage: summary(u, me) }, 429);

    // raw HTTP, not the SDK: this Worker is pasted into the Cloudflare dashboard, which has no package install step
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, output_config: { effort: "medium" }, cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: b.system, cache_control: { type: "ephemeral" } }], tools, messages: b.messages }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      const busy = r.status === 429 || r.status === 529 || r.status >= 500;
      return json({ error: busy ? "Claude is busy right now. Try again in a minute." : `Claude said no (${out.error?.message || r.status}).` }, busy ? 503 : 502);
    }
    const t = out.usage || {};
    const usd = ((t.input_tokens || 0) + (t.cache_creation_input_tokens || 0) * 1.25 + (t.cache_read_input_tokens || 0) * 0.1) * PRICE_IN / 1e6 + (t.output_tokens || 0) * PRICE_OUT / 1e6;
    u.usd += usd; u.days[d].usd += usd;
    if (b.newQuestion) { u.q++; u.days[d].q++; }
    await env.USAGE.put(`u:${me.uid}:${month()}`, JSON.stringify(u), { expirationTtl: 60 * 60 * 24 * 400 });
    return json({ content: out.content, stop_reason: out.stop_reason, cost: usd, usage: summary(u, me) });
  },
};
