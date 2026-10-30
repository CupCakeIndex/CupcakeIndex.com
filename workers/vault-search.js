// The Vault card search (cupcakeindex.com/pc): a Cloudflare Worker between the page and eBay.
// It keeps the eBay key secret, only answers cupcakeindex.com, and passes listing photos through so the page's
// cropper can read them (eBay's image server doesn't allow that directly).
//
//   GET /search?q=2023 prizm stroud silver   -> { items: [{ title, image, url }] }  (football card singles, US)
//   GET /img?u=https://i.ebayimg.com/...     -> the image, readable by the page
//   GET /price?player=..&year=..&set=..&parallel=..&number=..&serial=..&grade=..
//        -> { estimate, low, high, confidence, reason, count, comps: [{ title, price, url }] }
//        eBay listings for the card, then Claude picks the ones that are really this card (same parallel, serial,
//        grade) and estimates what it would sell for. Each answer is kept for a day, so a card costs one estimate a day.
//
// Setup (Cloudflare dashboard > Workers > this worker > Settings > Variables and Secrets):
//   EBAY_CLIENT_ID      your eBay App ID (Client ID), as a Secret
//   EBAY_CLIENT_SECRET  your eBay Cert ID (Client Secret), as a Secret
//   ANTHROPIC_API_KEY   a Claude API key, as a Secret (the same one the Analyst worker uses), for /price
//
// Selling (owner only: the PCB owner's Firebase sign-in is checked on every call):
//   POST /ebay/status   -> { connected }            is Terry's eBay account linked?
//   POST /ebay/connect  -> { url }                  eBay's "allow access" page; it comes back to /ebay/callback
//   POST /ebay/sell     { id, title, price, condition, description } -> { url, listingId }
//        uploads the card's photos to eBay, makes the listing (Buy It Now, quantity 1) with the card's details and
//        Terry's own shipping, payment and return policies from Seller Hub, and publishes it. A card can only be
//        listed once at a time (its SKU is pcb-<card id>): asking again gives back the listing that's already up.
//   Setup for selling:
//   EBAY_RUNAME         the eBay "RuName" (developer.ebay.com > User Tokens > eBay Redirect URL whose accepted URL is
//                       https://<this worker>/ebay/callback), as a Secret
//   KV namespace bound as VAULT (keeps Terry's eBay sign-in)
//   EBAY_POSTAL_CODE    (optional) ZIP the cards ship from, only needed if Seller Hub has no ship-from location yet

const ALLOWED = ["https://cupcakeindex.com", "https://www.cupcakeindex.com", "http://localhost:8765"];
const CATEGORY = "261328"; // eBay: Sports Trading Card Singles
let token = null, tokenUntil = 0;

async function ebayToken(env) {
  if (token && Date.now() < tokenUntil) return token;
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(env.EBAY_CLIENT_ID + ":" + env.EBAY_CLIENT_SECRET) },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!r.ok) throw new Error("eBay sign-in failed (" + r.status + "): check the two secrets");
  const d = await r.json();
  token = d.access_token;
  tokenUntil = Date.now() + (d.expires_in - 120) * 1000;
  return token;
}

const PRICE_DAYS = 1;         // an estimate is reused this long before eBay and Claude are asked again
const PRICE_MODEL = "claude-haiku-5-5";

async function listings(env, q) {
  const api = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  api.searchParams.set("q", q + " football");
  api.searchParams.set("category_ids", CATEGORY);
  api.searchParams.set("limit", "60");
  const r = await fetch(api, { headers: { Authorization: "Bearer " + (await ebayToken(env)), "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
  return ((await r.json()).itemSummaries || []).filter((it) => it.price?.currency === "USD");
}

// The tool Claude has to answer with, so the answer is always the same shape.
const ESTIMATE_TOOL = {
  name: "price_estimate",
  description: "Report the estimated value of the card.",
  input_schema: {
    type: "object",
    properties: {
      matches: { type: "array", items: { type: "integer" }, description: "Numbers of the listings that are this exact card" },
      estimate: { type: "number", description: "Most likely sale price in US dollars, 0 if there's nothing to go on" },
      low: { type: "number" }, high: { type: "number" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      reason: { type: "string", description: "One short plain sentence on what the estimate is based on" },
    },
    required: ["matches", "estimate", "low", "high", "confidence", "reason"],
  },
};

async function estimate(env, card) {
  const name = [card.year, card.set, card.player, card.number, card.parallel, card.serial, card.grade].filter(Boolean).join(" ");
  // Serial numbering: "01/10" is copy 1 of 10. Sellers write "/10", so that's what gets searched.
  const sm = (card.serial || "").match(/(\d+)?\s*\/\s*(\d+)/), copy = sm?.[1] ? +sm[1] : 0, run = sm ? +sm[2] : 0;
  const serialQ = run ? "/" + run : "";
  // three searches: the exact card, the same print run without year or color (titles often leave those out),
  // and the player's whole set (other parallels, so there's something to compare with when the exact card isn't listed)
  const wide = [card.year, card.set, card.player].filter(Boolean).join(" ");
  const narrow = [wide, card.parallel, serialQ, card.grade].filter(Boolean).join(" ");
  const middle = run ? [card.player, card.set, serialQ].filter(Boolean).join(" ") : "";
  const queries = [...new Set([narrow, middle, wide].filter(Boolean))];
  const seen = new Map();
  const add = (lists) => { for (const list of lists) for (const it of list) if (!seen.has(it.itemId)) seen.set(it.itemId, it); };
  add(await Promise.all(queries.map((q) => listings(env, q))));
  // Few results usually means a word in the set name doesn't match eBay titles (a typo like "Holliday", or a name
  // sellers shorten). Search again with just the brand (first word of the set) and with the print run.
  if (seen.size < 20) {
    const brand = (card.set || "").trim().split(/\s+/)[0] || "";
    const more = [[card.year, card.player, brand], run ? [card.player, brand, serialQ] : null]
      .filter(Boolean).map((q) => q.filter(Boolean).join(" ")).filter((q) => !queries.includes(q));
    add(await Promise.all(more.map((q) => listings(env, q))));
  }
  const items = [...seen.values()].slice(0, 100);
  if (!items.length) return { estimate: 0, low: 0, high: 0, confidence: "low", reason: "No eBay listings found for this card.", count: 0, comps: [] };
  const lines = items.map((it, i) => {
    const ship = +(it.shippingOptions?.[0]?.shippingCost?.value || 0);
    const kind = it.buyingOptions?.includes("AUCTION") ? `auction, current bid (${it.bidCount || 0} bids)` : "buy it now";
    return `${i + 1}. ${it.title} | $${(+it.price.value).toFixed(2)}${ship ? ` + $${ship.toFixed(2)} shipping` : ""} | ${kind}`;
  }).join("\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: PRICE_MODEL, max_tokens: 1500, tools: [ESTIMATE_TOOL], tool_choice: { type: "tool", name: "price_estimate" },
      messages: [{ role: "user", content:
        `Estimate what this football card would sell for today: ${name}.\n` +
        (card.grade ? `It is graded ${card.grade}; only listings with that same grade are this card.\n` : "It is raw (not graded); graded copies are not this card.\n") +
        (run === 1 ? "It is a 1 of 1: the only copy made, so there are no other copies to compare with. Judge from the scarcest numbered parallels of this player in this set and similar sets, and price it well above them.\n"
          : run ? `It is serial-numbered ${copy ? `${copy}/${run}, copy ${copy} of` : "out of"} only ${run} made. Scarcity drives the price: ` +
            `a /${run} is worth clearly more than a /25 or /50 of the same card, and much more than unnumbered parallels or the base card. ` +
            `If this exact /${run} isn't listed, start from the nearest numbered parallels of this player in this set and scale up for how much rarer it is. ` +
            (copy === 1 || copy === run ? `Copy ${copy} of ${run} (${copy === 1 ? "the first one" : "the last one"}) can carry a small premium with some collectors. ` : "") +
            "If the copy number matches the player's jersey number, that carries a premium too.\n"
          : "") +
        "Below are current eBay listings (asking prices, which usually run above what cards actually sell for; auction bids are not final). " +
        "Pick the listings that are this exact card: same player, year, set, parallel or insert, serial numbering and grade. " +
        "Lots, reprints, customs and other parallels don't count, though they can help you judge if there are no exact matches. " +
        "The set name was typed by hand and may be misspelled or shortened: match listings by what the card is, not exact spelling. " +
        "A Chrome, Prizm, Optic or other premium version is a different product from the plain set of the same name, unless this card's set says so. " +
        "A serial-numbered card is never worth less than unnumbered copies of the same card: if you only find base or unnumbered copies, " +
        "estimate from the usual premium for that print run and keep the confidence low. " +
        "Then give a realistic sale price and range. If the exact card has few or no listings, say so and lower the confidence. " +
        "Keep the reason to one or two short sentences about the card (no \"I\").\n\n" + lines }],
    }),
  });
  const out = await r.json();
  const ans = (out.content || []).find((b) => b.type === "tool_use")?.input;
  if (!ans) throw new Error(out.error?.message || "no estimate came back");
  const comps = (ans.matches || []).map((n) => items[n - 1]).filter(Boolean)
    .map((it) => ({ title: it.title, price: +it.price.value, url: it.itemWebUrl }));
  return { estimate: ans.estimate, low: ans.low, high: ans.high, confidence: ans.confidence, reason: ans.reason,
           count: comps.length, comps: comps.slice(0, 5) };
}

// ---------- selling on eBay (owner only) ----------
const PROJECT = "cupcake-index";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const SELL_SCOPES = ["https://api.ebay.com/oauth/api_scope", "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account"].join(" ");

// Firebase sign-in tokens (RS256, Google's public keys), the same check as the Analyst worker
let jwks = null, jwksUntil = 0;
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
async function googleKeys() {
  if (jwks && Date.now() < jwksUntil) return jwks;
  const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  if (!r.ok) throw new Error("couldn't get Google's sign-in keys");
  jwks = (await r.json()).keys;
  jwksUntil = Date.now() + 3600 * 1000;
  return jwks;
}
async function signedIn(req) {
  const tok = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const [h, p, sig] = tok.split(".");
  if (!h || !p || !sig) return null;
  const dec = (x) => JSON.parse(new TextDecoder().decode(b64u(x)));
  const head = dec(h), body = dec(p), now = Date.now() / 1000;
  const jwk = (await googleKeys()).find((k) => k.kid === head.kid);
  if (!jwk || head.alg !== "RS256") return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(sig), new TextEncoder().encode(h + "." + p));
  if (!ok || body.aud !== PROJECT || body.iss !== "https://securetoken.google.com/" + PROJECT || body.exp < now || body.iat > now + 60 || !body.sub) return null;
  return { uid: body.sub };
}
// Firestore REST values -> plain values
const fval = (v) => !v ? undefined : "stringValue" in v ? v.stringValue : "integerValue" in v ? +v.integerValue : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : null;
async function isOwner(req) {
  const me = await signedIn(req);
  if (!me) return false;
  const r = await fetch(`${FS}/pcmeta/owner`);
  return r.ok && fval((await r.json()).fields?.uid) === me.uid;
}

// Terry's eBay sign-in: a refresh token kept in KV, turned into a short-lived access token when needed
let userTok = null, userTokUntil = 0;
async function ebayUser(env) {
  if (userTok && Date.now() < userTokUntil) return userTok;
  const refresh = await env.VAULT.get("ebay:refresh");
  if (!refresh) throw new Error("eBay isn't connected yet");
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(env.EBAY_CLIENT_ID + ":" + env.EBAY_CLIENT_SECRET) },
    body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refresh) + "&scope=" + encodeURIComponent(SELL_SCOPES),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("eBay sign-in expired, connect eBay again (" + (d.error_description || r.status) + ")");
  userTok = d.access_token;
  userTokUntil = Date.now() + (d.expires_in - 120) * 1000;
  return userTok;
}
async function sellApi(env, method, path, body, extra = {}) {
  const r = await fetch(path.startsWith("http") ? path : "https://api.ebay.com" + path, {
    method, headers: { Authorization: "Bearer " + (await ebayUser(env)), "Content-Type": "application/json", "Content-Language": "en-US",
      "Accept-Language": "en-US", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US", ...extra },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let d = {};
  try { d = text ? JSON.parse(text) : {}; } catch (e) { d = { raw: text }; }
  return { ok: r.ok, status: r.status, d, headers: r.headers };
}
const ebayErr = (step, res) => new Error(`${step}: ` + ((res.d.errors || []).map((e) => e.longMessage || e.message).join(" ") || res.status));

// a photo saved as a data: URL -> an eBay-hosted picture URL (eBay listings need their pictures on eBay)
async function uploadPhoto(env, dataUrl) {
  const m = /^data:(image\/[\w+.-]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!m) return null;
  const form = new FormData();
  form.append("image", new Blob([b64u(m[2].replace(/\+/g, "-").replace(/\//g, "_"))], { type: m[1] }), "card.jpg");
  const r = await fetch("https://apim.ebay.com/commerce/media/v1_beta/image/create_image_from_file", {
    method: "POST", headers: { Authorization: "Bearer " + (await ebayUser(env)) }, body: form,
  });
  const text = await r.text();
  let d = {};
  try { d = text ? JSON.parse(text) : {}; } catch (e) { /* empty body */ }
  if (!r.ok) throw new Error("photo upload: " + ((d.errors || []).map((e) => e.longMessage || e.message).join(" ") || r.status));
  if (d.imageUrl) return d.imageUrl;
  const loc = r.headers.get("Location");
  if (!loc) throw new Error("photo upload: eBay didn't say where the picture went");
  const g = await sellApi(env, "GET", loc);
  if (!g.ok || !g.d.imageUrl) throw ebayErr("photo upload", g);
  return g.d.imageUrl;
}

// eBay's trading-card conditions: Graded (2750) with grader / grade / cert, or Ungraded (4000) with card condition.
// The IDs come from eBay itself, matched by name, so nothing is guessed.
async function cardCondition(env, card, rawCondition) {
  const res = await sellApi(env, "GET", `/sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies?filter=categoryIds:%7B${CATEGORY}%7D`);
  if (!res.ok) throw ebayErr("card conditions", res);
  const conds = res.d.itemConditionPolicies?.[0]?.itemConditions || [];
  const descs = (id) => conds.find((c) => c.conditionId === id)?.conditionDescriptors || [];
  const pick = (list, re) => list.find((d) => re.test(d.conditionDescriptorName || ""));
  const value = (desc, test) => desc?.conditionDescriptorValues?.find((v) => test(v.conditionDescriptorValueName || ""));
  const g = /\b(PSA|BGS|SGC|CGC|CSG|HGA|TAG|BCCG|BVG|KSA|GMA|ISA)\b\s*(?:GEM\s*(?:MINT|MT)\s*|MINT\s*|PRISTINE\s*)?(10|[1-9](?:\.5)?)?/i.exec(card.grade || "");
  if (g) {
    const list = descs("2750"), grader = pick(list, /grader/i), grade = pick(list, /^grade$/i), cert = pick(list, /cert/i);
    const gv = value(grader, (n) => new RegExp("\\b" + g[1] + "\\b", "i").test(n)) || value(grader, (n) => /other/i.test(n));
    const out = [];
    if (grader && gv) out.push({ name: grader.conditionDescriptorId, values: [gv.conditionDescriptorValueId] });
    const nv = g[2] && value(grade, (n) => n.trim() === g[2]);
    if (grade && nv) out.push({ name: grade.conditionDescriptorId, values: [nv.conditionDescriptorValueId] });
    if (cert && card.cert) out.push({ name: cert.conditionDescriptorId, additionalInfo: String(card.cert).slice(0, 30) });
    return { condition: "LIKE_NEW", conditionDescriptors: out };
  }
  const cc = pick(descs("4000"), /condition/i);
  const want = (rawCondition || "Near mint or better").toLowerCase();
  const cv = value(cc, (n) => n.toLowerCase() === want) || value(cc, (n) => /near mint/i.test(n));
  return { condition: "USED_VERY_GOOD", conditionDescriptors: cc && cv ? [{ name: cc.conditionDescriptorId, values: [cv.conditionDescriptorValueId] }] : [] };
}

async function policies(env) {
  const get = async (kind) => {
    const r = await sellApi(env, "GET", `/sell/account/v1/${kind}_policy?marketplace_id=EBAY_US`);
    if (!r.ok) throw ebayErr(kind + " policy", r);
    const list = r.d[kind + "Policies"] || [];
    if (!list.length) throw new Error(`no ${kind} policy in Seller Hub yet (Seller Hub > Account > Business policies)`);
    return (list.find((x) => /card/i.test(x.name || "")) || list[0])[kind + "PolicyId"];
  };
  const [fulfillmentPolicyId, paymentPolicyId, returnPolicyId] = await Promise.all(["fulfillment", "payment", "return"].map(get));
  return { fulfillmentPolicyId, paymentPolicyId, returnPolicyId };
}
async function shipFrom(env) {
  const r = await sellApi(env, "GET", "/sell/inventory/v1/location?limit=20");
  const loc = (r.d.locations || []).find((l) => l.merchantLocationStatus !== "DISABLED");
  if (loc) return loc.merchantLocationKey;
  if (!env.EBAY_POSTAL_CODE) throw new Error("eBay needs a ship-from ZIP: add EBAY_POSTAL_CODE to the worker's variables");
  const c = await sellApi(env, "POST", "/sell/inventory/v1/location/pcb-home",
    { location: { address: { postalCode: env.EBAY_POSTAL_CODE, country: "US" } }, locationTypes: ["WAREHOUSE"], name: "Cards" });
  if (!c.ok && c.status !== 409) throw ebayErr("ship-from location", c);
  return "pcb-home";
}

async function sellCard(env, body) {
  const id = String(body.id || "");
  const price = Math.round(+body.price * 100) / 100, title = String(body.title || "").trim().slice(0, 80);
  if (!id || !title) throw new Error("missing card or title");
  if (!(price >= 0.99)) throw new Error("the price has to be at least $0.99");
  const sku = ("pcb-" + id).replace(/[^\w-]/g, "").slice(0, 50);
  // already listed? give that listing back instead of listing the card twice
  const old = await sellApi(env, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=EBAY_US`);
  const live = (old.d.offers || []).find((o) => o.status === "PUBLISHED" && o.listing?.listingId && o.listing.listingStatus === "ACTIVE");
  if (live) return { listingId: live.listing.listingId, url: "https://www.ebay.com/itm/" + live.listing.listingId, already: true };

  const doc = await fetch(`${FS}/pc/${encodeURIComponent(id)}`);
  if (!doc.ok) throw new Error("couldn't read the card");
  const f = (await doc.json()).fields || {}, card = {};
  for (const k of Object.keys(f)) card[k] = fval(f[k]);
  const imageUrls = [];
  for (const k of ["front", "back"]) { const u = await uploadPhoto(env, card[k]); if (u) imageUrls.push(u); }
  if (!imageUrls.length) throw new Error("the card needs a photo first");
  const run = (String(card.serial || "").match(/\/\s*(\d+)/) || [])[1];
  const aspects = { Sport: ["Football"], "Player/Athlete": [card.player], Team: [card.team], Season: [card.year], "Year Manufactured": [card.year],
    Set: [card.set], "Parallel/Variety": [card.parallel], "Card Number": [card.number], "Print Run": run ? [run] : undefined,
    Autographed: [card.auto ? "Yes" : "No"], Type: ["Sports Trading Card"], Features: card.rookie ? ["Rookie"] : undefined,
    "Card Name": [card.player], "Country/Region of Manufacture": undefined };
  for (const k of Object.keys(aspects)) {
    const v = (aspects[k] || []).filter((x) => x != null && String(x).trim()).map((x) => String(x).trim().slice(0, 65));
    if (v.length) aspects[k] = v; else delete aspects[k];
  }
  const cond = await cardCondition(env, card, body.condition);
  const description = String(body.description || title).slice(0, 4000);
  const item = await sellApi(env, "PUT", `/sell/inventory/v1/inventory_item/${sku}`, {
    availability: { shipToLocationAvailability: { quantity: 1 } }, ...cond,
    product: { title, description, imageUrls, aspects },
  });
  if (!item.ok) throw ebayErr("card details", item);
  const offer = { sku, marketplaceId: "EBAY_US", format: "FIXED_PRICE", availableQuantity: 1, categoryId: CATEGORY,
    listingDescription: description, listingPolicies: await policies(env), merchantLocationKey: await shipFrom(env),
    pricingSummary: { price: { value: price.toFixed(2), currency: "USD" } } };
  let offerId = (old.d.offers || [])[0]?.offerId;
  if (offerId) {
    const u = await sellApi(env, "PUT", `/sell/inventory/v1/offer/${offerId}`, offer);
    if (!u.ok) throw ebayErr("listing", u);
  } else {
    const c = await sellApi(env, "POST", "/sell/inventory/v1/offer", offer);
    if (!c.ok) throw ebayErr("listing", c);
    offerId = c.d.offerId;
  }
  const pub = await sellApi(env, "POST", `/sell/inventory/v1/offer/${offerId}/publish`, {});
  if (!pub.ok) throw ebayErr("publishing", pub);
  return { listingId: pub.d.listingId, url: "https://www.ebay.com/itm/" + pub.d.listingId };
}

async function selling(req, env, url, cors) {
  const json = (d, status = 200) => Response.json(d, { status, headers: cors });
  if (url.pathname === "/ebay/callback") {
    // eBay sends Terry back here after "Agree": swap the code for a long-lived sign-in and keep it
    const state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
    const back = (msg) => Response.redirect("https://cupcakeindex.com/pc/#" + msg, 302);
    if (!code || !state || !(await env.VAULT.get("ebay:state:" + state))) return back("ebay-failed");
    await env.VAULT.delete("ebay:state:" + state);
    const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(env.EBAY_CLIENT_ID + ":" + env.EBAY_CLIENT_SECRET) },
      body: "grant_type=authorization_code&code=" + encodeURIComponent(code) + "&redirect_uri=" + encodeURIComponent(env.EBAY_RUNAME),
    });
    const d = await r.json();
    if (!r.ok || !d.refresh_token) return back("ebay-failed");
    await env.VAULT.put("ebay:refresh", d.refresh_token);
    userTok = d.access_token; userTokUntil = Date.now() + (d.expires_in - 120) * 1000;
    return back("ebay-connected");
  }
  if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Authorization, Content-Type" } });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.VAULT || !env.EBAY_RUNAME) return json({ error: "Selling isn't set up yet (the worker needs the VAULT storage and EBAY_RUNAME)." }, 503);
  if (!(await isOwner(req))) return json({ error: "Only the binder's owner can do that." }, 403);
  try {
    if (url.pathname === "/ebay/status") return json({ connected: !!(await env.VAULT.get("ebay:refresh")) });
    if (url.pathname === "/ebay/connect") {
      const state = crypto.randomUUID();
      await env.VAULT.put("ebay:state:" + state, "1", { expirationTtl: 900 });
      const a = new URL("https://auth.ebay.com/oauth2/authorize");
      a.searchParams.set("client_id", env.EBAY_CLIENT_ID); a.searchParams.set("redirect_uri", env.EBAY_RUNAME);
      a.searchParams.set("response_type", "code"); a.searchParams.set("scope", SELL_SCOPES); a.searchParams.set("state", state);
      return json({ url: a.toString() });
    }
    if (url.pathname === "/ebay/sell") return json(await sellCard(env, await req.json()));
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
  return json({ error: "unknown" }, 404);
}

const big = (u) => (u || "").replace(/s-l\d+\./, "s-l1600."); // full-size photo instead of the thumbnail

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0], Vary: "Origin" };
    if (url.pathname.startsWith("/ebay/")) {
      if (origin && !ALLOWED.includes(origin)) return new Response("not allowed", { status: 403 });
      return selling(req, env, url, cors);
    }
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });

    if (url.pathname === "/search") {
      if (origin && !ALLOWED.includes(origin)) return new Response("not allowed", { status: 403 });
      const q = (url.searchParams.get("q") || "").slice(0, 120).trim();
      if (!q) return Response.json({ items: [] }, { headers: cors });
      try {
        const api = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
        api.searchParams.set("q", q + " football");
        api.searchParams.set("category_ids", CATEGORY);
        api.searchParams.set("limit", "24");
        const r = await fetch(api, { headers: { Authorization: "Bearer " + (await ebayToken(env)), "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
        const d = await r.json();
        const items = (d.itemSummaries || []).filter((it) => it.image?.imageUrl)
          .map((it) => ({ title: it.title, image: big(it.image.imageUrl), url: it.itemWebUrl,
            // all of the listing's photos (the back is usually the 2nd)
            images: [it.image.imageUrl, ...(it.additionalImages || []).map((x) => x.imageUrl)].filter(Boolean).slice(0, 6).map(big) }));
        return Response.json({ items }, { headers: { ...cors, "Cache-Control": "public, max-age=3600" } });
      } catch (e) {
        return Response.json({ items: [], error: String(e.message || e) }, { status: 502, headers: cors });
      }
    }

    if (url.pathname === "/price") {
      if (origin && !ALLOWED.includes(origin)) return new Response("not allowed", { status: 403 });
      const card = {};
      for (const k of ["player", "year", "set", "parallel", "number", "serial", "grade"]) card[k] = (url.searchParams.get(k) || "").slice(0, 60).trim();
      if (!card.player) return Response.json({ error: "no player" }, { status: 400, headers: cors });
      if (!env.ANTHROPIC_API_KEY) return Response.json({ error: "price estimates aren't set up yet" }, { status: 503, headers: cors });
      // one estimate per card a day: the same card asked again gets the saved answer (no eBay or Claude call)
      const key = new Request("https://vault-price.cache/v2/" + encodeURIComponent(JSON.stringify(Object.values(card)).toLowerCase()));
      const hit = await caches.default.match(key);
      if (hit) return new Response(hit.body, { headers: { ...cors, "Content-Type": "application/json" } });
      try {
        const res = Response.json({ ...(await estimate(env, card)), checked: new Date().toISOString() },
          { headers: { "Cache-Control": `public, max-age=${PRICE_DAYS * 86400}` } });
        await caches.default.put(key, res.clone());
        return new Response(res.body, { headers: { ...cors, "Content-Type": "application/json" } });
      } catch (e) {
        return Response.json({ error: String(e.message || e) }, { status: 502, headers: cors });
      }
    }

    if (url.pathname === "/img") {
      const u = url.searchParams.get("u") || "";
      if (!/^https:\/\/i\.ebayimg\.com\//.test(u)) return new Response("only eBay images", { status: 400 });
      const r = await fetch(u, { cf: { cacheTtl: 86400 } });
      return new Response(r.body, { status: r.status, headers: { "Content-Type": r.headers.get("Content-Type") || "image/jpeg", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" } });
    }

    return new Response("The Vault card search. Try /search?q=prizm", { headers: cors });
  },
};
