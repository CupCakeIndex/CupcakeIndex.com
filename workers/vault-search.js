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
  for (const list of await Promise.all(queries.map((q) => listings(env, q))))
    for (const it of list) if (!seen.has(it.itemId)) seen.set(it.itemId, it);
  const items = [...seen.values()].slice(0, 90);
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
        "Then give a realistic sale price and range. If the exact card has few or no listings, say so and lower the confidence.\n\n" + lines }],
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

const big = (u) => (u || "").replace(/s-l\d+\./, "s-l1600."); // full-size photo instead of the thumbnail

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0], Vary: "Origin" };
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
      const key = new Request("https://vault-price.cache/" + encodeURIComponent(JSON.stringify(Object.values(card)).toLowerCase()));
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
