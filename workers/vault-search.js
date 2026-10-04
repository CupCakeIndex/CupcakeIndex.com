// The Vault card search (cupcakeindex.com/pc): a Cloudflare Worker between the page and eBay.
// It keeps the eBay key secret, only answers cupcakeindex.com, and passes listing photos through so the page's
// cropper can read them (eBay's image server doesn't allow that directly).
//
//   GET /search?q=2023 prizm stroud silver   -> { items: [{ title, image, url }] }  (football card singles, US)
//   GET /img?u=https://i.ebayimg.com/...     -> the image, readable by the page
//
// Setup (Cloudflare dashboard > Workers > this worker > Settings > Variables and Secrets):
//   EBAY_CLIENT_ID      your eBay App ID (Client ID), as a Secret
//   EBAY_CLIENT_SECRET  your eBay Cert ID (Client Secret), as a Secret

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

    if (url.pathname === "/img") {
      const u = url.searchParams.get("u") || "";
      if (!/^https:\/\/i\.ebayimg\.com\//.test(u)) return new Response("only eBay images", { status: 400 });
      const r = await fetch(u, { cf: { cacheTtl: 86400 } });
      return new Response(r.body, { status: r.status, headers: { "Content-Type": r.headers.get("Content-Type") || "image/jpeg", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" } });
    }

    return new Response("The Vault card search. Try /search?q=prizm", { headers: cors });
  },
};
