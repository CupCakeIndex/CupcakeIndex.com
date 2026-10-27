// The Cupcake Analyst chat on the site (docs/bot.js): a Cloudflare Worker between the page and Claude.
// It keeps the Claude API key secret, only answers signed-in members, and counts each member's questions and cost
// for the month (Cloudflare KV), so nobody can run up the bill. The page runs the stat lookups itself, on the site's
// own data, and sends the results back here; this Worker only talks to Claude.
//
//   GET  /me    -> { member, questions, usd, limit, today, days, sub, comped, links }   (the chat button only shows for
//                  members; Settings shows the subscription, or the Subscribe links to those allowed to buy)
//   POST /chat  -> one Claude turn: { content, stop_reason, usage }  body: { system, tools, messages, newQuestion, take }
//   GET  /admin -> the owner only: this month's chat cost and money in by tier { month, usd, questions, takes, days,
//                  tiers, owner, unsorted } (the site's Admin page > Costs; the owner doesn't pay, so isn't in a tier)
//   POST /portal -> { url }: Stripe's page to change card, switch tier or cancel (Settings > Manage subscription)
//   All of those need "Authorization: Bearer <Firebase ID token>" (the site's Sign in with Google).
//   POST /stripe -> Stripe's webhook (no sign-in; checked with Stripe's signature instead). It keeps each subscriber's
//                  subscription in KV: sub:<uid> and cus:<Stripe customer> -> uid. The uid comes from the payment
//                  link's client_reference_id, which Settings adds to the link.
//
// Setup (Cloudflare dashboard > Workers > this worker > Settings):
//   Variables and Secrets: ANTHROPIC_API_KEY  a Claude API key (console.anthropic.com > API keys), as a Secret
//                          MEMBERS            free members (comped), comma-separated, as Text; add :2 for Tier 2
//                                             (you@x.com, friend@y.com:2). Paying members come from Stripe instead
//                          STRIPE_SECRET_KEY  Stripe > Developers > API keys, as a Secret (sk_test_... while testing)
//                          STRIPE_WEBHOOK_SECRET  the webhook's signing secret (whsec_...), as a Secret
//                          SUBSCRIBE_TESTERS  while the Stripe key is a test key, only these emails see Subscribe and get
//                                             access from a (test-card) subscription; comma-separated, as Text
//                          PAY_LINKS (optional) the live Tier 1 and Tier 2 payment links, comma-separated; blank = the test ones
//                          MODEL (optional)   claude-sonnet-5-5 to try the smarter, ~20x pricier model; blank = Haiku
//   Bindings: KV namespace, variable name USAGE (Storage > KV > create one called analyst-usage)
// Stripe webhook (Stripe > Developers > Webhooks > Add endpoint): <this worker's URL>/stripe, events
//   checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed

const ALLOWED = ["https://cupcakeindex.com", "https://www.cupcakeindex.com", "http://localhost:8765"];
const PROJECT = "cupcake-index"; // Firebase project: whose sign-in tokens we accept
const OWNER = "thecupcakeindex.support@gmail.com"; // testing: no question limit, only the dollar backstop
// $ per million tokens [in, out] (list prices, Oct 2026; Haiku's is for prompts under 100K tokens)
const PRICES = { "claude-haiku-5-5": [0.10, 0.50], "claude-sonnet-5-5": [2, 10] };
// by tier: questions a month, a day (so nobody uses the month in one night), Claude $ backstop (past it, it stops
// until the 1st) and take checks a month (the chat's "Check a take"; each one is a few Claude calls)
const LIMITS = [{ q: 300, day: 40, usd: 3, takes: 30 }, { q: 1000, day: 100, usd: 8, takes: 150 }];
const OWNER_CAP_USD = 5; // the owner has no other limits
const TEST_LINKS = ["https://buy.stripe.com/test_8x24gy4ax5RBaaw8xc6sw00", "https://buy.stripe.com/test_9B6cN4dL7eo796s3cS6sw02"];
const PAID = ["active", "trialing", "past_due"]; // past_due: Stripe is still retrying the card, so keep access meanwhile
const STRIPE_FEE = (usd) => usd * 0.029 + usd * 0.007 + 0.30; // card 2.9% + 30¢, Billing 0.7%: about what Stripe keeps

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

// ---------- usage: one KV entry per person per month ----------
const month = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
async function usage(env, uid) {
  return (await env.USAGE.get(`u:${uid}:${month()}`, "json")) || { q: 0, usd: 0, days: {} };
}
// membership tiers: [name, $ a month]. A MEMBERS entry is an email (Tier 1) or email:2 (Tier 2); a Stripe
// subscription's tier comes from its price (500 cents = Tier 1, 1000 = Tier 2).
const TIERS = [["Tier 1", 5], ["Tier 2", 10]];
const memberList = (env) => (env.MEMBERS || "").toLowerCase().split(/[,\s]+/).filter(Boolean)
  .map((x) => { const [email, t] = x.split(":"); return { email, tier: Math.min(TIERS.length, Math.max(1, +t || 1)) - 1 }; });

// ---------- Stripe ----------
const testing = (env) => /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY || "");
const list = (v) => (v || "").toLowerCase().split(/[,\s]+/).filter(Boolean);
// with a test key, test cards would give anyone free access: only the testers (and the owner) count
const canBuy = (me, env) => !!env.STRIPE_SECRET_KEY && me.verified && (!testing(env) || me.email === OWNER || list(env.SUBSCRIBE_TESTERS).includes(me.email));
// who gets the chat, and at what tier: a free member (MEMBERS) or a paying one, whichever tier is higher
async function access(me, env) {
  const comp = me.verified ? memberList(env).find((x) => x.email === me.email) : null;
  const sub = await env.USAGE.get(`sub:${me.uid}`, "json");
  const paid = sub && PAID.includes(sub.status) && canBuy(me, env) ? sub.tier : -1;
  const tier = Math.max(comp ? comp.tier : -1, paid);
  return { member: tier >= 0, tier, comped: !!comp && comp.tier >= paid, sub };
}
async function stripe(env, path, form) {
  const r = await fetch("https://api.stripe.com/v1/" + path, { method: form ? "POST" : "GET",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Stripe said ${r.status}`);
  return d;
}
// Stripe-Signature: t=<time>,v1=<hex HMAC-SHA256 of "<time>.<raw body>" with the webhook secret>; 5 minutes' tolerance
async function fromStripe(req, raw, env) {
  const parts = (req.headers.get("Stripe-Signature") || "").split(","), t = parts.find((x) => x.startsWith("t="))?.slice(2);
  const sigs = parts.filter((x) => x.startsWith("v1=")).map((x) => x.slice(3));
  if (!t || !sigs.length || !env.STRIPE_WEBHOOK_SECRET || !(Math.abs(Date.now() / 1000 - +t) <= 300)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const same = (a, b) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
  return sigs.some((s) => same(s, hex));
}
// keep the subscription as Stripe has it now (fetched fresh, so events arriving out of order don't matter)
async function saveSub(env, uid, subId, email) {
  const s = await stripe(env, `subscriptions/${subId}`), item = s.items?.data?.[0] || {};
  const old = (await env.USAGE.get(`sub:${uid}`, "json")) || {};
  const rec = { email: email || old.email || "", customer: s.customer, subscription: s.id, tier: (item.price?.unit_amount || 0) >= 1000 ? 1 : 0,
    status: s.status, renews: s.current_period_end ?? item.current_period_end ?? null, cancel_at_period_end: !!s.cancel_at_period_end };
  await env.USAGE.put(`sub:${uid}`, JSON.stringify(rec));
  await env.USAGE.put(`cus:${s.customer}`, uid);
}
async function webhook(req, env) {
  const raw = await req.text();
  if (!(await fromStripe(req, raw, env))) return new Response("bad signature", { status: 400 });
  const ev = JSON.parse(raw), o = ev.data?.object || {};
  if (ev.type === "checkout.session.completed") {
    if (o.client_reference_id && o.subscription) await saveSub(env, o.client_reference_id, o.subscription, String(o.customer_details?.email || o.customer_email || "").toLowerCase());
  } else if (ev.type.startsWith("customer.subscription.") || ev.type === "invoice.payment_failed") {
    const subId = ev.type === "invoice.payment_failed" ? o.subscription || o.parent?.subscription_details?.subscription : o.id;
    const uid = o.customer && (await env.USAGE.get(`cus:${o.customer}`));
    if (uid && subId) await saveSub(env, uid, subId); // no uid yet: checkout.session.completed will fetch it anyway
  }
  return new Response("ok");
}

// this month's chat cost and money in, by tier, for the Admin page: totals only, no emails (KV's free plan allows 1,000 lists a day)
async function everyone(env, me) {
  const comped = memberList(env).filter((x) => x.email !== OWNER), compedEmails = new Set(comped.map((x) => x.email));
  const subs = {}; // uid -> tier, paying subscribers only
  let cursor;
  do {
    const page = await env.USAGE.list({ prefix: "sub:", cursor });
    for (const k of page.keys) { const s = await env.USAGE.get(k.name, "json"); if (s?.status === "active") subs[k.name.slice(4)] = s.tier; }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const tiers = TIERS.map(([name, price], i) => {
    const n = Object.values(subs).filter((t) => t === i).length;
    return { name, price, members: n, gross: n * price, in: n * (price - STRIPE_FEE(price)), usd: 0, questions: 0 };
  });
  const m = month(), out = { month: m, usd: 0, questions: 0, takes: 0, days: {}, tiers, testing: testing(env),
    owner: { usd: 0, questions: 0 }, comped: { members: comped.length, usd: 0, questions: 0 }, unsorted: { usd: 0, questions: 0 } };
  do {
    const page = await env.USAGE.list({ prefix: "u:", cursor });
    for (const k of page.keys.filter((k) => k.name.endsWith(":" + m))) {
      const u = await env.USAGE.get(k.name, "json");
      if (!u) continue;
      out.usd += u.usd; out.questions += u.q; out.takes += u.t || 0;
      const email = u.email || (k.name.startsWith(`u:${me.uid}:`) ? me.email : ""); // the owner's own, even from before emails were kept
      const uid = k.name.split(":")[1]; // unsorted: no email yet, or no longer a member
      const t = email === OWNER ? out.owner : uid in subs ? tiers[subs[uid]] : compedEmails.has(email) ? out.comped : out.unsorted;
      t.usd += u.usd; t.questions += u.q;
      for (const [d, x] of Object.entries(u.days || {})) {
        const t = (out.days[d] ||= { q: 0, usd: 0 });
        t.q += x.q; t.usd += x.usd;
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}
const summary = (u, me, a) => {
  const L = LIMITS[a.tier] || LIMITS[0], owner = me.email === OWNER;
  return { member: true, tier: a.tier, questions: u.q, usd: Math.round(u.usd * 10000) / 10000, limit: L.q, day_limit: owner ? null : L.day,
    takes: u.t || 0, take_limit: L.takes, today: u.days[today()]?.q || 0, days: u.days, cap_usd: owner ? OWNER_CAP_USD : L.usd, testing: owner };
};
// what Settings shows: the subscription (if any), and the Subscribe links to those allowed to buy
const billing = (me, env, a) => ({ comped: a.comped,
  sub: a.sub && canBuy(me, env) ? { tier: a.sub.tier, status: a.sub.status, renews: a.sub.renews, cancel_at_period_end: a.sub.cancel_at_period_end } : null,
  links: canBuy(me, env) ? (env.PAY_LINKS ? env.PAY_LINKS.split(/[,\s]+/).filter(Boolean) : testing(env) ? TEST_LINKS : []) : [],
  prices: TIERS.map((t) => t[1]), limits: LIMITS.map((L) => ({ q: L.q, takes: L.takes })), test_mode: testing(env) });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0], Vary: "Origin" };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" } });
    if (url.pathname === "/stripe" && req.method === "POST") { // Stripe's servers: checked by signature, not sign-in
      try { return await webhook(req, env); } catch (e) { return new Response(String(e.message || e), { status: 500 }); } // 500: Stripe retries later
    }
    if (origin && !ALLOWED.includes(origin)) return json({ error: "not allowed" }, 403);

    let me;
    try { me = await signedIn(req); } catch (e) { return json({ error: "sign-in check failed" }, 503); }
    if (!me) return json({ error: "sign in first" }, 401);
    const a = await access(me, env);
    if (url.pathname === "/me") {
      if (!a.member) return json({ member: false, ...billing(me, env, a) });
      const u = await usage(env, me.uid);
      if (u.q && !u.email) { u.email = me.email; await env.USAGE.put(`u:${me.uid}:${month()}`, JSON.stringify(u), { expirationTtl: 60 * 60 * 24 * 400 }); } // so Admin can put it in their tier
      return json({ ...summary(u, me, a), ...billing(me, env, a) });
    }
    if (url.pathname === "/portal" && req.method === "POST") {
      if (!a.sub?.customer || !canBuy(me, env)) return json({ error: "No subscription to manage." }, 404);
      try { return json({ url: (await stripe(env, "billing_portal/sessions", { customer: a.sub.customer, return_url: "https://cupcakeindex.com/#/settings" })).url }); }
      catch (e) { return json({ error: `Stripe didn't answer (${e.message}). Try again in a minute.` }, 502); }
    }
    if (url.pathname.startsWith("/admin") && !(me.email === OWNER && me.verified)) return json({ error: "not allowed" }, 403);
    if (url.pathname === "/admin") return json(await everyone(env, me));
    if (url.pathname !== "/chat" || req.method !== "POST") return json({ error: "not found" }, 404);
    if (!a.member) return json({ error: "The Analyst is for members." }, 403);

    // the page sends the instructions, its tools and the conversation; we fix the model and the size of the answer
    const raw = await req.text();
    if (raw.length > 3000000) return json({ error: "That conversation got too long (pictures add up). Tap New to start a fresh one." }, 413); // ~10 shrunk pictures
    let b;
    try { b = JSON.parse(raw); } catch (e) { return json({ error: "bad request" }, 400); }
    const tools = Array.isArray(b.tools) ? b.tools : [];
    if (typeof b.system !== "string" || b.system.length > 60000 || !Array.isArray(b.messages) || !b.messages.length || b.messages.length > 80
      || tools.length > 40 || tools.some((t) => t.type || !t.name || !t.input_schema)) return json({ error: "bad request" }, 400); // our own tools only (no web search etc.)

    const u = await usage(env, me.uid), d = today(), owner = me.email === OWNER, L = LIMITS[a.tier] || LIMITS[0], sum = () => summary(u, me, a);
    u.days[d] ||= { q: 0, usd: 0 };
    if (u.usd >= (owner ? OWNER_CAP_USD : L.usd)) return json({ error: `You've hit this month's limit. It resets on the 1st.`, usage: sum() }, 429);
    if (b.newQuestion && !owner && u.q >= L.q) return json({ error: `You've used all ${L.q.toLocaleString()} questions this month. They reset on the 1st.`, usage: sum() }, 429);
    if (b.newQuestion && !owner && u.days[d].q >= L.day) return json({ error: `That's ${L.day} questions today. More tomorrow.`, usage: sum() }, 429);
    if (b.take && !owner && (u.t || 0) >= L.takes) return json({ error: `You've used all ${L.takes} take checks this month. They reset on the 1st.`, usage: sum() }, 429);

    // raw HTTP, not the SDK: this Worker is pasted into the Cloudflare dashboard, which has no package install step
    const model = PRICES[env.MODEL] ? env.MODEL : "claude-haiku-5-5", [pin, pout] = PRICES[model];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 8000, output_config: { effort: "high" }, cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: b.system, cache_control: { type: "ephemeral" } }], tools, messages: b.messages }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      const busy = r.status === 429 || r.status === 529 || r.status >= 500;
      return json({ error: busy ? "Claude is busy right now. Try again in a minute." : `Claude said no (${out.error?.message || r.status}).` }, busy ? 503 : 502);
    }
    const t = out.usage || {};
    const usd = ((t.input_tokens || 0) + (t.cache_creation_input_tokens || 0) * 1.25 + (t.cache_read_input_tokens || 0) * 0.1) * pin / 1e6 + (t.output_tokens || 0) * pout / 1e6;
    u.usd += usd; u.days[d].usd += usd; u.email = me.email;
    if (b.newQuestion) { u.q++; u.days[d].q++; }
    if (b.take) { u.t = (u.t || 0) + 1; u.days[d].t = (u.days[d].t || 0) + 1; }
    await env.USAGE.put(`u:${me.uid}:${month()}`, JSON.stringify(u), { expirationTtl: 60 * 60 * 24 * 400 });
    return json({ content: out.content, stop_reason: out.stop_reason, cost: usd, model, usage: sum() });
  },
};
