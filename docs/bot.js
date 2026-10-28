// The Cupcake Analyst chat: a small button in the bottom right, for members (MEMBERS or a subscription) and, once the
// Worker's FREE_QUESTIONS is set, for everyone: signed out, tapping it asks you to sign in; signed in but not paying,
// you get that many free questions in all (then it asks you to upgrade), and the take check stays locked. Ask a question; Claude answers from the site's own data with the same stat tools as Terry's
// Analyst page (bot-tools.js, generated from analyst/index.html), and can open a Visualize chart or a page of the
// site. The Claude key lives in the Worker (workers/analyst.js), which also counts questions and cost per member.
// The lookups run here, in the page, on the same files the site shows; only the conversation goes to the Worker.
const Bot = (() => {
  const URL_ = "https://cupcake-analyst.thecupcakeindex-support.workers.dev";
  const MAX_ROUNDS = 8; // tool rounds per question
  const LAST_ROUND = "That was your last lookup. Answer now with what you've found, and say plainly what you couldn't check.";
  let closeChat = () => {}; // set once the panel is built: closeChat(false) closes it
  let me = null, msgs = [], sys = null, busy = false, el = null, user = null, tools = null, mode = "ask", tone = "straight", quiet = false;
  const TONES = [["straight", "Straight"], ["funny", "Funny"], ["sarcastic", "Sarcastic"]];
  // the stat tools (57 KB) load only for members, the first time the button shows
  const needTools = () => tools ||= new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = `bot-tools.js?v=${SITE_VERSION}`; s.onload = ok; s.onerror = () => { tools = null; bad(new Error("The Analyst's tools didn't load. Check your connection.")); };
    document.head.appendChild(s);
  });

  async function call(path, body) {
    const token = await user.getIdToken();
    const r = await fetch(URL_ + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `The Analyst isn't answering (${r.status}).`), { usage: d.usage });
    return d;
  }

  // ---------- who sees the button: members, free users, and signed-out visitors while free questions are on ----------
  let freeQ = null; // the Worker's free questions (0 = off), asked once without signing in
  window.addEventListener("account", async (ev) => {
    user = ev.detail;
    me = null;
    if (user) { try { me = await call("/me"); } catch (e) { me = null; } }
    else {
      freeQ ??= fetch(URL_ + "/free").then((r) => r.json()).then((d) => +d.questions || 0).catch(() => 0);
      const n = await freeQ;
      if (n && !user) me = { guest: true, free_q: n };
    }
    show();
    rerender();
  });
  const rerender = () => { if (!document.getElementById("view-settings")?.classList.contains("hidden")) Settings.render(); };

  // ---------- Settings: subscribe, or the subscription you have ----------
  // The Worker decides who may buy (while Stripe is in test mode, only its testers) and hands over the payment links.
  // The link carries the uid (client_reference_id), so Stripe's webhook knows whose subscription it is.
  let waiting = 0; // after paying, Stripe sends them back to #/settings?subscribed=1: check /me until the webhook lands
  const thanks = () => /[?&]subscribed=1/.test(location.hash);
  const when = (s) => new Date(s * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  function section() {
    if (!user || !me) return "";
    const tier = (i) => `Tier ${i + 1}`, s = me.sub, paid = s && ["active", "trialing", "past_due"].includes(s.status);
    const used = me.member ? `<p class="note">This month: ${me.questions} of ${me.limit.toLocaleString()} questions, ${me.takes || 0} of ${me.take_limit} take checks.</p>`
      : me.free ? `<p class="note">Free: ${me.questions} of your ${me.limit} free questions used. Take checks come with a subscription.</p>` : "";
    let body;
    if (paid) {
      const line = s.status === "past_due" ? "Your last payment didn't go through. Update your card to keep the Analyst."
        : s.cancel_at_period_end ? `Canceled. You keep the Analyst until ${when(s.renews)}.` : s.renews ? `Renews ${when(s.renews)}.` : "";
      body = `<p class="note"><b>You're on ${tier(s.tier)}</b> · $${me.prices[s.tier]} a month. ${line}</p>${used}
        <div class="acct-btns"><button type="button" class="boxbtn" id="sub-manage">Manage subscription</button></div>
        <p class="note" id="sub-msg" role="status">Change your card, switch tiers or cancel, on Stripe's page.</p>`;
    } else if (me.member) {
      body = `<p class="note"><b>You're a member</b> (${tier(me.tier || 0)}, free).</p>${used}`;
    } else if (thanks()) {
      body = `<p class="note" id="sub-msg" role="status">Thanks! Setting up your membership…</p>`;
    } else if (me.links?.length) {
      const q = `?client_reference_id=${encodeURIComponent(user.uid)}${user.email ? `&locked_prefilled_email=${encodeURIComponent(user.email)}` : ""}`;
      body = `<p class="note">Ask anything about any team or player and get answers from the site's own model and stats, or paste a take from X to fact-check it.</p>${used}
        <div class="sub-tiers">${me.links.slice(0, 2).map((l, i) => `<div class="sub-tier"><b>${tier(i)}</b><span class="sub-price">$${me.prices[i]}<small> a month</small></span>
          <small>${me.limits[i].q.toLocaleString()} questions a month<br>${me.limits[i].takes} take checks a month</small>
          <a class="btn" href="${esc(l + q)}">Subscribe</a></div>`).join("")}</div>
        <p class="note">Paid through Stripe. Cancel any time in Settings.${me.test_mode ? " <b>Test mode:</b> use card 4242 4242 4242 4242, no real money." : ""}</p>`;
    } else if (me.free) {
      body = used;
    } else return "";
    return `<h3>Cupcake Analyst</h3>${body}`;
  }
  function wire(root) {
    const b = root.querySelector("#sub-manage"), msg = root.querySelector("#sub-msg");
    if (b) b.onclick = async () => {
      b.disabled = true; msg.textContent = "Opening Stripe…";
      try { location.href = (await call("/portal", {})).url; } catch (e) { msg.textContent = e.message; b.disabled = false; }
    };
    if (thanks() && !me?.member && msg && !waiting) {
      let tries = 0;
      waiting = setInterval(async () => {
        try { me = await call("/me"); } catch (e) { /* try again */ }
        if (me?.member) {
          clearInterval(waiting); waiting = 0;
          history.replaceState(null, "", location.hash.replace(/[?&]subscribed=1/, ""));
          show(); rerender();
        } else if (++tries >= 20) { // a minute: stop asking, and leave the thank-you up
          clearInterval(waiting);
          const m = document.getElementById("sub-msg");
          if (m) m.textContent = "Your payment went through, but the membership hasn't shown up yet. Reload this page in a minute.";
        }
      }, 3000);
    }
  }
  function show() {
    const on = !!(me?.member || me?.free || me?.guest);
    if (!on) { el?.remove(); el = null; return; }
    if (!el) build();
    el.classList.toggle("guest", !!me.guest);
    el.classList.toggle("locked", !!me.free && !me.member); // free: no take checks (style.css shows the note instead)
    const g = el.querySelector(".bot-guest b");
    if (g && me.guest) g.textContent = `${me.free_q} free questions`;
    if (!me.guest) needTools().catch(() => {});
    usageLine();
  }

  // ---------- the button and the panel ----------
  function build() {
    el = document.createElement("div");
    el.className = "bot";
    el.innerHTML = `<button type="button" class="bot-fab" aria-expanded="false" aria-controls="bot-panel" title="Ask the Cupcake Analyst" aria-label="Ask the Cupcake Analyst">
        <span class="bot-mark"></span><span class="bot-word">Analyst<i>_</i></span><span class="bot-word-m">Ask<i>_</i></span></button>
      <section id="bot-panel" class="bot-panel" hidden aria-label="Cupcake Analyst">
        <header><b class="bot-title"><span class="bot-mark"></span><span>CUPCAKE<b>_ANALYST</b></span></b><span class="bot-use muted"></span>
          <button type="button" class="bot-max" aria-pressed="false" title="Make the chat bigger" aria-label="Make the chat bigger"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg></button>
          <button type="button" class="bot-new" title="Start a new conversation">New</button>
          <button type="button" class="bot-x" aria-label="Close">✕</button></header>
        <div class="bot-log" aria-live="polite"><p class="bot-hi bot-hi-ask muted">Ask about any player, team or stat. I answer from the site's own numbers and can open a chart for you.
          Try "Who leads the NFL in CPOE?" or "Chart Indiana's offense vs defense".</p>
          <p class="bot-hi bot-hi-take muted">Paste a take from X or the group chat, or add a screenshot of it. I check every claim against our numbers, give you the verdict and write two replies you can post.</p></div>
        <div class="bot-pics" hidden></div>
        <div class="bot-mode" role="group" aria-label="What to do"><button type="button" data-mode="ask">Ask</button><button type="button" data-mode="take">Check a take</button>
          <span class="bot-tone" role="group" aria-label="Reply tone">${TONES.map(([k, l]) => `<button type="button" data-tone="${k}">${l}</button>`).join("")}</span></div>
        <form class="bot-ask"><label class="bot-attach" title="Add a picture (a screenshot of a post, a stat graphic...)" aria-label="Add a picture">
            <input type="file" accept="image/*" multiple hidden><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15.5 9.5h.01"/></svg></label>
          <textarea rows="1" maxlength="600" placeholder="Ask a football question" aria-label="Your question"></textarea>
          <button type="submit" class="bot-send">Send</button></form>
        <p class="bot-lock muted">Take checks come with a subscription (30 a month on Tier 1). <a class="bot-link" href="#/settings">See the plans</a></p>
        <div class="bot-guest"><div class="bot-guest-card"><b>Free questions</b>
          <p>Ask about any team, player or stat. Answers come from the site's own numbers.</p>
          <button type="button" class="bot-signin">Sign in with Google</button></div></div>
      </section>`;
    document.body.appendChild(el);
    // the site's own cupcake mark (from the header logo), in a rounded badge
    const mark = document.querySelector(".logo-mark");
    if (mark) el.querySelectorAll(".bot-mark").forEach((m) => m.appendChild(mark.cloneNode(true)));
    const fab = el.querySelector(".bot-fab"), panel = el.querySelector(".bot-panel"), ta = el.querySelector("textarea");
    let shut = 0;
    // the panel grows out of the Ask button, and shrinks back into it (style.css bot-pop); instant: it already slid away
    const toggle = (open, instant) => {
      clearTimeout(shut);
      fab.setAttribute("aria-expanded", String(open));
      el.classList.toggle("open", open);
      document.body.classList.toggle("bot-open", open); // the phone back button steps aside (style.css)
      panel.classList.toggle("closing", !open && !instant);
      if (open) { panel.hidden = false; setTimeout(() => ta.focus(), 50); }
      else shut = setTimeout(() => { panel.hidden = true; panel.classList.remove("closing"); }, instant || matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
    };
    closeChat = toggle;
    fab.addEventListener("click", () => toggle(panel.hidden || panel.classList.contains("closing")));
    el.querySelector(".bot-signin").addEventListener("click", () => Account.signIn());
    // links to the site's pages (Open team, See the plans, Upgrade): go(), which tucks the chat away on phones, and
    // closes it when you're already on that page (the link would do nothing otherwise)
    el.addEventListener("click", (e) => {
      const a = e.target.closest('a[href^="#/"]');
      if (!a || !el.contains(a) || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      go(a.getAttribute("href"), true);
    });
    // phones: drag the chat down to close it, from the header, or from the conversation once it's scrolled to the top
    let drag = null;
    const unset = () => { panel.style.transition = panel.style.transform = panel.style.animation = ""; };
    panel.addEventListener("touchstart", (e) => {
      const t = e.target, logEl = t.closest(".bot-log");
      drag = innerWidth < 600 && e.touches.length === 1 && !t.closest("textarea, input") && (t.closest("header") || (logEl && logEl.scrollTop <= 0))
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now(), dy: 0, on: false, logEl } : null;
    }, { passive: true });
    panel.addEventListener("touchmove", (e) => {
      if (!drag) return;
      const dx = e.touches[0].clientX - drag.x, dy = e.touches[0].clientY - drag.y;
      if (!drag.on) {
        if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
        if (dy < 0 || Math.abs(dx) > Math.abs(dy) || (drag.logEl && drag.logEl.scrollTop > 0)) { drag = null; return; }
        drag.on = true;
        panel.style.transition = "none"; panel.style.animation = "none";
      }
      e.preventDefault();
      drag.dy = Math.max(0, dy);
      panel.style.transform = `translateY(${drag.dy}px)`;
    }, { passive: false });
    panel.addEventListener("touchend", () => {
      const d = drag;
      drag = null;
      if (!d?.on) return;
      const fast = d.dy / Math.max(1, Date.now() - d.at) > 0.6;
      if (d.dy > panel.offsetHeight * 0.25 || (fast && d.dy > 40)) {
        panel.style.transition = "transform .2s ease-in"; panel.style.transform = "translateY(100%)";
        setTimeout(() => { toggle(false, true); setTimeout(unset, 20); }, 200);
      } else {
        panel.style.transition = "transform .2s ease-out"; panel.style.transform = "";
        setTimeout(unset, 200);
      }
    });
    el.querySelector(".bot-x").addEventListener("click", () => toggle(false));
    // bigger chat on a computer (phones already get the whole screen); remembered on this device
    const maxBtn = el.querySelector(".bot-max"), setMax = (on) => {
      el.classList.toggle("max", on);
      maxBtn.setAttribute("aria-pressed", String(on));
      maxBtn.title = maxBtn.ariaLabel = on ? "Make the chat smaller" : "Make the chat bigger";
      try { localStorage.setItem("bot-max", on ? "1" : ""); } catch (e) { /* private mode */ }
    };
    try { setMax(localStorage.getItem("bot-max") === "1"); } catch (e) { /* private mode */ }
    maxBtn.addEventListener("click", () => { setMax(!el.classList.contains("max")); log().scrollTop = log().scrollHeight; });
    el.querySelector(".bot-new").addEventListener("click", () => { if (busy) return; msgs = []; sys = null; needsPic = null; el.querySelector(".bot-log").innerHTML = ""; ta.focus(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) toggle(false); });
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.querySelector("form").requestSubmit(); } });
    // pictures: the picture button (photos or camera on a phone), paste a screenshot, or drop one on the panel
    const file = el.querySelector(".bot-attach input");
    file.addEventListener("change", () => { addPics(file.files); file.value = ""; });
    ta.addEventListener("paste", (e) => { const f = [...(e.clipboardData?.files || [])].filter((x) => x.type.startsWith("image/")); if (f.length) { e.preventDefault(); addPics(f); } });
    panel.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.items || [])].some((x) => x.type.startsWith("image/"))) { e.preventDefault(); panel.classList.add("drop"); } });
    panel.addEventListener("dragleave", (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove("drop"); });
    panel.addEventListener("drop", (e) => { panel.classList.remove("drop"); const f = [...(e.dataTransfer?.files || [])].filter((x) => x.type.startsWith("image/")); if (f.length) { e.preventDefault(); addPics(f); } });
    // Ask / Check a take, and the tone of the take replies (both remembered on this device)
    const setMode = (m) => {
      mode = m === "take" ? "take" : "ask";
      el.classList.toggle("take", mode === "take");
      el.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
      ta.placeholder = mode === "take" ? "Paste a take, or add a screenshot" : "Ask a football question";
      try { localStorage.setItem("bot-mode", mode); } catch (e) { /* private mode */ }
    };
    const setTone = (t) => {
      tone = TONES.some(([k]) => k === t) ? t : "straight";
      el.querySelectorAll("[data-tone]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tone === tone)));
      try { localStorage.setItem("bot-tone", tone); } catch (e) { /* private mode */ }
    };
    try { setMode(localStorage.getItem("bot-mode")); setTone(localStorage.getItem("bot-tone")); } catch (e) { setMode("ask"); setTone("straight"); }
    el.querySelector(".bot-mode").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b?.dataset.mode) { setMode(b.dataset.mode); ta.focus(); }
      if (b?.dataset.tone) setTone(b.dataset.tone);
    });
    el.querySelector(".bot-log").addEventListener("input", (e) => { // a post's link pasted under a take check
      const box = e.target.closest(".bot-xlink");
      if (!box) return;
      const v = e.target.value.trim(), id = postId(v);
      box.querySelector("small").textContent = !v ? "" : id ? "Got it: the buttons below reply to that post." : "That isn't a post's link. Those look like x.com/name/status/123.";
      box.closest(".bot-msg, .take").querySelectorAll(".bot-x-post").forEach((a) => {
        a.href = xUrl(a.dataset.text, id);
        if (id) a.dataset.id = id; else delete a.dataset.id;
        a.textContent = `${id ? "Reply on X" : "Post on X"} ↗`;
      });
    });
    el.querySelector(".bot-log").addEventListener("click", (e) => {
      const x = e.target.closest(".bot-x-post");
      if (x && matchMedia("(pointer: coarse)").matches) { // phones: x.com in the home-screen app's browser is signed out
        e.preventDefault();
        if (!x.dataset.id) { navigator.share ? navigator.share({ text: x.dataset.text }).catch(() => {}) : window.open(x.href, "_blank"); return; }
        // a reply: copy it, open the post in the X app, and fall back to the web if the app isn't there
        navigator.clipboard?.writeText(x.dataset.text).catch(() => {});
        x.textContent = "Copied. Paste it in X";
        const web = setTimeout(() => { if (!document.hidden) window.open(x.href, "_blank"); }, 1500);
        document.addEventListener("visibilitychange", () => clearTimeout(web), { once: true });
        location.href = `twitter://status?id=${x.dataset.id}`;
        return;
      }
      const b = e.target.closest(".bot-copy");
      if (!b) return;
      navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1500); }).catch(() => {});
    });
    el.querySelector(".bot-pics").addEventListener("click", (e) => { const b = e.target.closest("[data-rm]"); if (b) { pics.splice(+b.dataset.rm, 1); drawPics(); } });
    el.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = ta.value.trim();
      if ((!q && !pics.length) || busy || pics.some((x) => !x.data)) return;
      ta.value = ""; ta.style.height = "auto";
      const sent = pics.splice(0);
      drawPics();
      (mode === "take" ? checkTake : ask)(q, sent);
    });
  }
  // ---------- pictures ----------
  // Shrunk in the browser before sending (longest side 1280px, JPEG): Claude reads them just as well, the request stays
  // small (the Worker caps a conversation's size) and each one costs about a tenth of a cent on Haiku.
  const MAX_PICS = 3, MAX_SIDE = 1280;
  let pics = []; // [{url (preview), data (base64 JPEG, once shrunk)}]
  async function shrink(f) {
    const img = await createImageBitmap(f), k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); // transparent PNGs: white, not black
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.82);
  }
  function addPics(files) {
    for (const f of [...files].filter((x) => x.type.startsWith("image/")).slice(0, MAX_PICS - pics.length)) {
      const p = { url: URL.createObjectURL(f), data: null };
      pics.push(p);
      shrink(f).then((u) => { p.data = u.split(",")[1]; drawPics(); }).catch(() => { pics = pics.filter((x) => x !== p); drawPics(); bubble("bot", `<p class="bot-err">That picture couldn't be read. Try a screenshot or a JPEG.</p>`); });
    }
    drawPics();
    el.querySelector("textarea").focus();
  }
  function drawPics() {
    const box = el.querySelector(".bot-pics");
    box.hidden = !pics.length;
    box.innerHTML = pics.map((p, i) => `<span class="bot-pic${p.data ? "" : " loading"}"><img src="${p.url}" alt=""><button type="button" data-rm="${i}" aria-label="Remove this picture">✕</button></span>`).join("")
      + (pics.length < MAX_PICS ? "" : `<small class="muted">Up to ${MAX_PICS} pictures a question</small>`);
    el.querySelector(".bot-attach").classList.toggle("full", pics.length >= MAX_PICS);
  }

  function usageLine() {
    const u = el?.querySelector(".bot-use");
    if (!u || !me) return;
    if (me.guest) { u.textContent = ""; return; }
    if (me.free && !me.member) { u.textContent = `${Math.min(me.questions, me.limit)}/${me.limit} free`; u.title = "Free questions used. After that, the Analyst comes with a subscription."; return; }
    const over = me.questions > me.limit;
    const pct = (n, of) => `${Math.min(100, Math.floor((n || 0) / of * 100))}%`; // rounded down, so 100% only when it's all used
    u.textContent = `${pct(me.questions, me.limit)} questions${me.take_limit ? ` · ${pct(me.takes, me.take_limit)} takes` : ""}${me.testing ? ` · $${(me.usd || 0).toFixed(2)}` : ""}${over ? " · over" : ""}`;
    u.title = !me.testing ? `How much of this month's questions and take checks you've used. They reset on the 1st.` : me.testing ? `Testing: today ${me.today} questions. Members get ${me.limit} a month${me.day_limit ? ` and ${me.day_limit} a day` : ""}; you're not stopped at ${me.limit}, only at $${me.cap_usd} a month.` : "";
  }

  // ---------- the conversation ----------
  const log = () => el.querySelector(".bot-log");
  function bubble(cls, html) {
    const d = document.createElement("div");
    d.className = "bot-msg " + cls;
    d.innerHTML = html;
    log().appendChild(d);
    log().scrollTop = log().scrollHeight;
    return d;
  }
  // formatting so an answer scans instead of reading like a wall: the first line is the lead, "Label: detail" lines
  // become labeled rows, a short line ending in ":" is a small heading, and records, scores, win chances, ranks and
  // injury statuses are colored. Also **bold**, "- " lists, and links to the site's own pages only.
  const KV = /^([A-Z#][^:.!?]{0,34}):\s+(.+)$/; // "Giants: 163 points for", "Questionable: Marcus Mariota (knee)"
  function fmt(t) {
    const color = (h) => h.split(/(<[^>]+>)/).map((s, i) => i % 2 ? s : s
      .replace(/\b(out for the season|Out|IR|on injured reserve|Injured reserve)\b/g, '<span class="bot-bad">$1</span>')
      .replace(/\b(Questionable|Doubtful)\b/g, '<span class="bot-warn">$1</span>')
      .replace(/(^|[\s(])(#\d{1,3}|\d+(?:\.\d+)?%|\d{1,3}-\d{1,3}(?:-\d{1,2})?)(?=[\s,.;:)!?]|$)/g, '$1<span class="bot-num">$2</span>')).join("");
    const inline = (s) => color(esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\((#\/[^)\s]+)\)/g, '<a href="$2">$1</a>'));
    const kv = (l) => { const m = l.match(KV); return m ? `<b class="bot-k">${inline(m[1])}</b> ${inline(m[2])}` : inline(l); };
    const paras = t.trim().split(/\n{2,}/);
    return paras.map((p, n) => {
      const lines = p.split("\n").map((l) => l.trim()).filter(Boolean), bullet = /^[-*•] /;
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^[^.!?]{2,40}:$/.test(l) && i < lines.length - 1) { out.push(`<h4 class="bot-h">${inline(l.slice(0, -1))}</h4>`); continue; }
        if (bullet.test(l)) { const items = []; while (i < lines.length && bullet.test(lines[i])) items.push(`<li>${kv(lines[i++].replace(bullet, ""))}</li>`); i--; out.push(`<ul>${items.join("")}</ul>`); continue; }
        if (KV.test(l) && (KV.test(lines[i + 1] || "") || KV.test(lines[i - 1] || ""))) { const rows = []; while (i < lines.length && KV.test(lines[i])) rows.push(`<div>${kv(lines[i++])}</div>`); i--; out.push(`<div class="bot-rows">${rows.join("")}</div>`); continue; }
        out.push(`<p${n === 0 && i === 0 && paras.length + lines.length > 2 ? ' class="bot-lead"' : ""}>${inline(l)}</p>`);
      }
      return out.join("");
    }).join("");
  }

  // free questions all used: ask them to upgrade instead of sending
  const outOfFree = () => me?.free && !me.member && me.questions >= me.limit;
  const upgrade = () => bubble("bot", `<p>You've used your ${me.limit} free questions.${me.limits?.[0] ? ` Tier 1 is $${me.prices[0]} a month for ${me.limits[0].q.toLocaleString()} questions and ${me.limits[0].takes} take checks.` : ""}</p>
    <p><a class="bot-link" href="#/settings">Upgrade →</a></p>`);
  async function ask(q, sent = []) {
    if (outOfFree()) { upgrade(); log().scrollTop = log().scrollHeight; return; }
    busy = true;
    el.classList.add("busy");
    bubble("me", (sent.length ? `<div class="bot-thumbs">${sent.map((p) => `<img src="${p.url}" alt="Your picture">`).join("")}</div>` : "") + (q ? `<p>${esc(q)}</p>` : ""));
    const wait = bubble("bot wait", `<p class="muted"><span class="bot-dots">Thinking</span></p>`);
    const steps = wait.querySelector("p");
    try { await needTools(); } catch (e) { wait.innerHTML = `<p class="bot-err">${esc(e.message)}</p>`; busy = false; el.classList.remove("busy"); return; }
    BotTools.setSay((s) => { steps.innerHTML = `<span class="bot-dots">${esc(s)}</span>`; log().scrollTop = log().scrollHeight; });
    const keep = msgs.length;
    const links = [];
    try {
      msgs.push({ role: "user", content: [{ type: "text", text: await now() },
        ...sent.map((p) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.data } })),
        { type: "text", text: q || "What do you make of this?" }] });
      const system = sys ||= await prompt();
      let res = null;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        res = await call("/chat", { system, tools: TOOL_DEFS(), messages: msgs, newQuestion: round === 0 });
        me = { ...me, ...res.usage };
        usageLine();
        msgs.push({ role: "assistant", content: res.content }); // the whole turn, thinking blocks included, unchanged
        if (res.stop_reason !== "tool_use") break;
        const results = [];
        for (const b of res.content.filter((x) => x.type === "tool_use")) {
          let out, bad = false;
          try { out = await run(b.name, b.input || {}, links); } catch (e) { out = { error: String(e.message || e) }; bad = true; }
          let s = JSON.stringify(out);
          if (s.length > 40000) s = s.slice(0, 40000) + "…(cut: ask for a narrower list)";
          results.push({ type: "tool_result", tool_use_id: b.id, content: s, ...(bad ? { is_error: true } : {}) });
        }
        if (round === MAX_ROUNDS - 2) results.push({ type: "text", text: LAST_ROUND }); // answer next time, never "ran out of steps"
        msgs.push({ role: "user", content: results }); // every result of the round in one message
        steps.innerHTML = `<span class="bot-dots">Thinking</span>`;
      }
      const text = (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
      wait.classList.remove("wait");
      wait.innerHTML = (text ? fmt(text) : `<p class="muted">${res?.stop_reason === "refusal" ? "I can't help with that one." : "I ran out of steps on that one. Try asking it a narrower way."}</p>`)
        + links.map((l) => `<p><a class="bot-link" href="${esc(l.href)}">${esc(l.label)} →</a></p>`).join("");
    } catch (e) {
      msgs.length = keep; // drop the failed question, so the conversation stays valid
      if (e.usage) { me = { ...me, ...e.usage }; usageLine(); }
      wait.classList.remove("wait");
      if (outOfFree()) { wait.remove(); upgrade(); }
      else wait.innerHTML = `<p class="bot-err">${esc(e.message || "Something went wrong.")}</p>`;
    }
    log().scrollTop = log().scrollHeight;
    busy = false;
    el.classList.remove("busy");
  }

  // ---------- Check a take: Terry's Analyst page, for members ----------
  // Paste a take (or a screenshot of one): Claude checks every claim with the same tools as the chat, then hands back a
  // verdict, the claims with our numbers, what the take leaves out, a small chart, and two replies to post. The page
  // picks each reply's shape and length (so they don't all sound alike), a filter catches the LLM writing habits from
  // Terry's style note and phrases this member's recent replies already used, and one review call fixes any reply whose
  // conclusion doesn't follow from its numbers. Each check is its own conversation; the chat's stays as it was.
  const SHAPES = {
    compare: "Open with a comparison to one named peer (player or team) on the same stat, then say what it means for the take.",
    rank: "Open with where they rank and out of how many, then one detail that explains the rank.",
    drop: "One or two short sentences, under 160 characters total: the single most telling number, then a flat opinion.",
    skipped: "Open with the thing the take left out (the opponents, the games missed, the split, the sample), then the number that shows it.",
    story: "Two or three sentences that walk through how it changed over the weeks or seasons, with the number landing in the last sentence.",
    split: "Open with a split that changes the picture (on 3rd down, in the red zone, vs the blitz, the last few games vs the first few, vs good teams), then the overall number for contrast.",
    concede: "Grant one part of the take with a number, then turn it with a second, different number.",
    context: "Open with the situation around the number (schedule strength, injuries, the coach's tendencies, the role), then the number.",
  };
  const LENGTHS = { short: "a short burn, under 120 characters (one number, one line)", normal: "a normal reply, about 150-280 characters" };
  const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } } };
  function pickShapes() {
    const last = store.get("take-shapes") || [];
    const pool = Object.keys(SHAPES).filter((k) => !last.includes(k)).sort(() => Math.random() - 0.5);
    const len = (k) => k === "drop" || Math.random() < 0.35 ? "short" : "normal";
    return { agree: pool[0], pushback: pool[1], agree_len: len(pool[0]), pushback_len: len(pool[1]) };
  }
  // the writing filter (Terry's LLM Writing Tendencies note), plus 3-word phrases this member's last 30 replies repeated
  const STOP = new Set("a an the and or but of to in on at for with by from is are was were be been his her their its this that it he she they we you i as so if than then just not no has have had do does did".split(" "));
  const words = (t) => BotTools.norm(t || "").split(" ").filter(Boolean);
  function grams(t) {
    const w = words(t), out = new Set();
    for (let i = 0; i + 3 <= w.length; i++) { const g = w.slice(i, i + 3); if (!g.every((x) => STOP.has(x)) && !g.some((x) => /\d/.test(x))) out.add(g.join(" ")); }
    return out;
  }
  function repeats() {
    const c = new Map();
    for (const r of store.get("take-replies") || []) for (const g of grams(r)) c.set(g, (c.get(g) || 0) + 1);
    return [...c].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([g]) => g);
  }
  const BANNED = ["delve", "crucial", "pivotal", "robust", "seamless", "seamlessly", "leverage", "foster", "underscore", "underscores", "bolster", "intricate", "multifaceted", "nuanced", "comprehensive", "holistic", "landscape", "realm", "tapestry", "testament", "navigate", "embark", "showcase", "showcases", "highlights", "emphasizes", "ensures", "enhances", "elevate", "unlock", "empower", "game-changer", "cutting-edge", "truly", "incredibly", "significantly", "remarkably", "fundamentally", "profoundly", "furthermore", "moreover", "additionally", "consequently", "notably", "ultimately", "overall", "bold", "spicy", "respectfully", "receipts"];
  const BANNED_RE = new RegExp(`\\b(${BANNED.join("|")})\\b`, "i");
  const PATTERNS = [
    [/[—]|\s–\s/, "an em dash"],
    [/\bnot (just|only)\b[^.]{0,60}\b(but|it'?s|it is)\b/i, "a \"not just X, it's Y\" setup"],
    [/\bisn'?t about\b[^.]{0,60}\bit'?s about\b/i, "an \"isn't about X, it's about Y\" setup"],
    [/,\s*(highlighting|showcasing|underscoring|proving|ensuring|signaling|reflecting|cementing|showing that)\b/i, "a trailing -ing clause"],
    [/\b(could potentially|it could be argued|may often|generally tends)\b/i, "stacked hedging"],
    [/\b(it'?s worth noting|it is important to note|when it comes to|at the end of the day|plays a (key|vital|crucial) role)\b/i, "a stock filler phrase"],
    [/\b(the result|here'?s the thing|the truth|the reality|bottom line|the kicker|translation|spoiler)\s*:/i, "a colon reveal"],
    [/\?\s+[A-Za-z]/, "a rhetorical question answered right after"],
    [/\b(great|interesting|hot) take\b|\blet'?s (be real|look)\b|\bthe numbers say otherwise\b|\bnot the flex\b/i, "a stock reply line"],
    [/#\w/, "a hashtag"], [/https?:\/\//, "a link"],
  ];
  function styleIssues(t, banned) {
    const out = [], m = String(t || "").match(BANNED_RE);
    if (m) out.push(`uses "${m[1]}"`);
    for (const [re, what] of PATTERNS) if (re.test(t || "")) out.push(`has ${what}`);
    const g = grams(t), hit = banned.filter((x) => g.has(x));
    if (hit.length) out.push(`repeats ${hit.slice(0, 4).map((x) => `"${x}"`).join(", ")} from your recent replies`);
    const col = String(t || "").match(/\b[a-z]+_[a-z0-9_]+\b/);
    if (col) out.push(`uses the column name "${col[0]}" (say it in plain words)`);
    if (String(t || "").length > 280) out.push(`is ${String(t).length} characters (keep it to 280)`);
    return out;
  }
  const TONE_RULE = {
    straight: "Straight: confident and a little dry, no jokes.",
    funny: "Funny, not mean: a light joke, playful comparison or football reference built from this take's details and wrapped around the number.",
    sarcastic: "Sarcastic: deadpan and mock-sincere; the joke comes from the specific thing the take ignores (the games he missed, the soft schedule, the 2-week sample). Roast the take, never the person.",
  };
  const VERDICT = {
    name: "take_verdict",
    description: "Deliver the finished take check. Call it once, last, after every lookup. Nothing else is shown to the member.",
    input_schema: { type: "object", required: ["verdict", "headline", "claims", "replies"], properties: {
      verdict: { type: "string", enum: ["holds", "mixed", "misleading", "wrong", "cant_check", "question"] },
      headline: { type: "string", description: "one sentence summing it up" },
      claims: { type: "array", items: { type: "object", required: ["claim", "verdict", "evidence"], properties: { claim: { type: "string" }, verdict: { type: "string", enum: ["holds", "mixed", "misleading", "wrong", "cant_check"] }, evidence: { type: "string" } } } },
      missing: { type: "array", items: { type: "string" } },
      chart: { type: "object", required: ["title", "items"], properties: { title: { type: "string" }, unit: { type: "string" }, lower_is_better: { type: "boolean" }, source: { type: "string" },
        items: { type: "array", items: { type: "object", required: ["label", "value"], properties: { label: { type: "string" }, value: { type: "number" }, rank: { type: "integer" }, highlight: { type: "boolean" } } } } } },
      replies: { type: "object", properties: { agree: { type: "string" }, pushback: { type: "string" }, answer: { type: "string" } } },
    } },
  };
  function takeRules(shapes, banned) {
    return `TAKE CHECK. The member pasted a take (from X, Reddit or a group chat; text and/or a screenshot) and wants it fact-checked like a sharp football statistician would, plus replies they can post themselves.

How to work:
1. Pull out each checkable claim and get the real numbers with the tools: find_player before player_stats; leaderboard to rank a number among peers; team_stats and our_rankings for teams, schedules and cupcake padding; team_status and site_tab "injuries" for injuries; site_tab "frauds"/"over_achievers" for overrated, bust or breakout takes; pace_to for every "on pace for" or "will he reach X" take; scatter_data for two stats across every team or the top players; stat_menu to find the stat that settles it (reach past yards, touchdowns and EPA when another stat settles it better: success rate, CPOE, first-down rate, YAC, drops, vs the blitz, pressure, red zone, 3rd down, penalties); site_lists for coaches, records, Trade watch and our Heisman race; season_records for record claims; career and game_log for older seasons and careers; schedule_history for schedule strength in past years; rare_plays for specific plays; how_we_count for how our stats are defined. Several calls per round when you can.
2. Only state numbers that came from a tool result. Never from memory. Don't do math in your head: state both numbers instead of a gap you worked out. A claim our data can't settle is "cant_check", saying what's missing.
3. Look for the classic flaws: tiny sample, cherry-picked weeks, counting stat vs rate, ignoring opponent quality (our rankings and cupcake data), games missed, different positions or eras, correlation sold as cause.
4. If the post asks a question instead of making a claim, verdict "question", the headline is the straight answer, and write one reply: replies.answer (use the "agree" shape and length below). A "will he reach X" question: answer from pace_to (ahead of the needed pace leans yes, behind leans no), never from other players' averages.
5. LOGIC: every yes/no, verdict and "probably" must follow from the numbers you cite.
6. No betting content: no spreads, lines, odds or picks. Our win chance is fine.

Finish by calling take_verdict once:
- verdict: holds | mixed | misleading | wrong | cant_check | question. headline: one sentence.
- claims: each claim, its own verdict, and the numbers that decide it with ranks (one or two sentences). Stats in plain words, never column names.
- missing: context the take leaves out (0-3 short items).
- chart (optional): one bar chart that makes the point, only numbers you pulled, 4-10 items sorted best first, the player or team in the take marked highlight; for a ranking give every item its rank (1 = first) so skipped places show. Short labels (last names, team abbreviations).
- replies.agree backs the take with a stat; replies.pushback corrects it with a different stat. If the take is plainly right, pushback adds the nuance instead. Each at most 280 characters, no links, no hashtags, no @handles.
REPLY TONE: ${TONE_RULE[tone]} The numbers stay exactly right. No insults about anyone's looks, family or identity, no slurs. Never use "bold" in any form, "hot take", "spicy", "respectfully", "let's be real", "the numbers say otherwise", "the receipts", "imagine", or a cupcake joke unless the take is about a soft schedule. The two replies open differently (different first word and sentence shape).
REPLY SHAPES (follow them): "agree": ${SHAPES[shapes.agree]} Length: ${LENGTHS[shapes.agree_len]}. "pushback": ${SHAPES[shapes.pushback]} Length: ${LENGTHS[shapes.pushback_len]}. Targets, not quotas; never pad.
WRITING (headline, evidence, missing, replies): write like a sharp fan typing on X. Plain words. No em dashes. No intensifiers (truly, incredibly, significantly). No "not just X, it's Y", no colon reveals ("Here's the thing:"), no rhetorical questions you answer yourself, no trailing "-ing" clause (", highlighting..."), no stacked hedges, no wrap-up sentence, no "Overall", no formal transitions (furthermore, moreover, additionally, notably, ultimately). Don't default to three of anything. Pick a side and defend it with the number. A line that could sit under any take about any player is a bad line: use a detail only this take has. Don't open by restating the take.${banned.length ? `\nPhrases this member's recent replies already used, don't reuse: ${banned.join(" | ")}` : ""}
A filter checks the replies after you answer; anything it catches gets rewritten.`;
  }
  // the one review call: a logic check on every reply and the headline, plus a rewrite of anything the filter caught
  async function review(res, banned, system) {
    // a question gets one answer; a claim gets one reply that backs it and one that pushes back. The model sometimes
    // filled "answer" and "agree" with the same text, and the card showed both (Oct 27 2026): keep only the right
    // slots, and a missing or duplicate one is written fresh below
    const rp = (res.replies ||= {}), q = res.verdict === "question";
    if (q) rp.answer ||= rp.agree || rp.pushback;
    else if (!rp.agree && rp.answer) rp.agree = rp.answer;
    for (const k of q ? ["agree", "pushback"] : ["answer"]) delete rp[k];
    const keys = q ? ["answer"] : ["agree", "pushback"], issues = {};
    for (const k of keys) {
      if (!rp[k]) { rp[k] = "(missing)"; issues[k] = [`is missing: write it from the facts above${k === "pushback" ? ", with a different stat that pushes back or adds the nuance" : ""}`]; continue; }
      const i = styleIssues(rp[k], banned); if (i.length) issues[k] = i;
    }
    if (!q && BotTools.norm(rp.agree) === BotTools.norm(rp.pushback)) (issues.pushback ||= []).push("is the same as the other reply: write one that pushes back (or adds the nuance) with a different stat");
    const a = words(rp.agree)[0], b = words(rp.pushback)[0];
    if (a && a === b) (issues.pushback ||= []).push(`opens with the same word as the other reply ("${a}")`);
    const toneAsk = tone === "straight" ? "" : ` The member picked this tone for the replies: ${TONE_RULE[tone]} A reply that reads flat or straight instead counts as a problem: rewrite it in that tone.`;
    const ask = `You're reviewing reply drafts before a member posts them. The facts they were built from:
${JSON.stringify({ headline: res.headline, claims: res.claims })}

${["headline", ...keys].map((k) => `"${k}": ${k === "headline" ? res.headline : rp[k]}${issues[k] ? `\nFilter caught: ${issues[k].join("; ")}` : ""}`).join("\n\n")}

For the headline and each draft: does its conclusion follow from its own numbers and the facts above (a yes/no or "probably" the numbers point the other way on, a comparison that doesn't bear on the question, a number used to mean something it doesn't)?${toneAsk} Rewrite ONLY a draft with a logic problem, a tone problem or a filter catch: keep every number, name and fact exactly, roughly the same length and the same opening shape, fix each problem, at most 280 characters, plain words, no em dashes, no hashtags, no links.${banned.length ? ` Phrases that must not appear: ${banned.join(" | ")}.` : ""}
Reply with ONLY JSON, no other text: ${JSON.stringify(Object.fromEntries(["headline", ...keys].map((k) => [k, "the text, rewritten only if it had a problem"])))}`;
    try {
      const out = await call("/chat", { system, tools: [], messages: [{ role: "user", content: ask }], newQuestion: false });
      me = { ...me, ...out.usage }; usageLine();
      const t = (out.content || []).filter((x) => x.type === "text").map((x) => x.text).join("");
      const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
      for (const k of keys) if (typeof j[k] === "string" && j[k].trim() && styleIssues(j[k], banned).length <= (issues[k] || []).length) rp[k] = j[k].trim();
      if (typeof j.headline === "string" && j.headline.trim()) res.headline = j.headline.trim();
    } catch (e) { /* keep the drafts as they were */ }
    for (const k of keys) if (rp[k] === "(missing)") delete rp[k]; // the review didn't write it: show nothing, not a placeholder
    if (!q && rp.pushback && BotTools.norm(rp.agree) === BotTools.norm(rp.pushback)) delete rp.pushback; // never the same reply twice
    res.replies = rp;
    return res;
  }

  // the last link whose picture or video we couldn't see: a screenshot sent on its own next is that post's
  let needsPic = null;
  async function checkTake(q, sent = [], anyway = false) {
    if (sent.length && !q.trim() && needsPic) q = needsPic;
    needsPic = null;
    busy = true;
    el.classList.add("busy");
    const mine = bubble("me", `<span class="bot-tag">Take check</span>` + (sent.length ? `<div class="bot-thumbs">${sent.map((p) => `<img src="${p.url}" alt="Your picture">`).join("")}</div>` : "") + (q ? `<p>${esc(q)}</p>` : ""));
    const wait = bubble("bot wait", `<p class="muted"><span class="bot-dots">Reading the take</span></p>`), steps = wait.querySelector("p");
    try { await needTools(); } catch (e) { wait.innerHTML = `<p class="bot-err">${esc(e.message)}</p>`; busy = false; el.classList.remove("busy"); return; }
    // a pasted post link: read the post from X (its public embed service), so a link alone is enough
    const post = postId(q) ? await readPost(q) : null, linkOnly = postId(q) && !q.replace(/https?:\/\/\S+/g, "").trim() && !sent.length;
    if (post) wait.insertAdjacentHTML("beforebegin", `<p class="bot-read muted">Read from X, ${esc(post.who)}: “${esc(post.text || "(no text)")}”</p>`);
    if (linkOnly && !post) { // nothing to check: say so without using up a take check
      wait.classList.remove("wait");
      wait.innerHTML = `<p>I couldn't read that post from X (it may be deleted, private or from a locked account). Add a screenshot of it, or paste its text.</p>`;
      busy = false; el.classList.remove("busy"); return;
    }
    // the post has a picture or video, which X doesn't share: ask for a screenshot before using up a take check
    if (post?.pic && !sent.length) needsPic = q;
    if (post?.pic && !sent.length && !anyway) {
      const bare = !post.text;
      wait.classList.remove("wait");
      wait.innerHTML = `<p>${bare ? "That post is only a picture or video, and I can't see those from links." : "This post has a picture or video I can't see, and the take is often in it."}
        Add a screenshot so I check the whole thing? Nothing's used up yet.</p>
        <div class="bot-ra"><button type="button" data-shot>Add a screenshot</button>${bare ? "" : `<button type="button" data-anyway>Check without it</button>`}</div>`;
      busy = false; el.classList.remove("busy");
      const clear = () => { mine.remove(); wait.previousElementSibling?.classList.contains("bot-read") && wait.previousElementSibling.remove(); wait.remove(); };
      wait.querySelector("[data-shot]").onclick = () => { // the link goes back in the box, and the picture picker opens: then Send checks both, once
        clear();
        const ta = el.querySelector("textarea");
        ta.value = q;
        el.querySelector(".bot-attach input").click();
        ta.focus();
      };
      const go = wait.querySelector("[data-anyway]");
      if (go) go.onclick = () => { clear(); checkTake(q, [], true); };
      return;
    }
    BotTools.setSay((s) => { steps.innerHTML = `<span class="bot-dots">${esc(s)}</span>`; log().scrollTop = log().scrollHeight; });
    const shapes = pickShapes(), banned = repeats(), links = [];
    quiet = true;
    try {
      const system = sys ||= await prompt();
      const tm = [{ role: "user", content: [{ type: "text", text: await now() },
        ...sent.map((p) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.data } })),
        { type: "text", text: takeRules(shapes, banned) + "\n\nTHE TAKE:\n" + (q || "(see the screenshot)") + (sent.length ? "\n\nA screenshot is attached: read the take, and any numbers in it, from the picture." : "")
          + (post ? `\n\nThe linked post, read from X. ${post.who} wrote: "${post.text}"${post.pic && !sent.length ? "\nIt also has a picture or video that couldn't be seen (they chose to check without a screenshot). If the take depends on it, say what you'd need from it." : ""}` : "") }] }];
      const defs = [...TOOL_DEFS().filter((t) => t.name !== "show_chart" && t.name !== "open_page"), VERDICT];
      let res = null, last = null;
      for (let round = 0; round < MAX_ROUNDS + 2 && !res; round++) {
        last = await call("/chat", { system, tools: defs, messages: tm, newQuestion: false, take: round === 0 });
        me = { ...me, ...last.usage };
        usageLine();
        const v = (last.content || []).find((b) => b.type === "tool_use" && b.name === VERDICT.name);
        if (v) { res = v.input; break; }
        tm.push({ role: "assistant", content: last.content });
        if (last.stop_reason !== "tool_use") break;
        const results = [];
        for (const b of last.content.filter((x) => x.type === "tool_use")) {
          let out, bad = false;
          try { out = await run(b.name, b.input || {}, links); } catch (e) { out = { error: String(e.message || e) }; bad = true; }
          let s = JSON.stringify(out);
          if (s.length > 40000) s = s.slice(0, 40000) + "…(cut: ask for a narrower list)";
          results.push({ type: "tool_result", tool_use_id: b.id, content: s, ...(bad ? { is_error: true } : {}) });
        }
        // a busy take (a screenshot with a whole chart in it) used to stop at "I ran out of steps": the round before
        // the last, it's told to deliver the verdict with what it has, unchecked claims marked cant_check
        if (round === MAX_ROUNDS) results.push({ type: "text", text: "That was your last lookup. Call take_verdict now with what you've found; mark any claim you didn't get to as cant_check and say what's missing." });
        tm.push({ role: "user", content: results });
        steps.innerHTML = `<span class="bot-dots">Checking the numbers</span>`;
      }
      if (!res?.verdict) {
        const text = (last?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
        wait.classList.remove("wait");
        wait.innerHTML = text ? fmt(text) : `<p class="muted">${last?.stop_reason === "refusal" ? "I can't check that one." : "I ran out of steps on that one. Try one claim at a time."}</p>`;
      } else {
        steps.innerHTML = `<span class="bot-dots">Checking the replies</span>`;
        await review(res, banned, system);
        wait.classList.remove("wait");
        wait.classList.add("take");
        wait.innerHTML = verdictCard(res, q);
        store.set("take-shapes", [shapes.agree, shapes.pushback]);
        store.set("take-replies", [res.replies?.answer, res.replies?.agree, res.replies?.pushback, ...(store.get("take-replies") || [])].filter(Boolean).slice(0, 30));
      }
    } catch (e) {
      if (e.usage) { me = { ...me, ...e.usage }; usageLine(); }
      wait.classList.remove("wait");
      wait.innerHTML = `<p class="bot-err">${esc(e.message || "Something went wrong.")}</p>`;
    }
    quiet = false;
    log().scrollTop = log().scrollHeight;
    busy = false;
    el.classList.remove("busy");
  }

  const VLABEL = { holds: "HOLDS UP", mixed: "MIXED", misleading: "MISLEADING", wrong: "WRONG", cant_check: "CAN'T CHECK", question: "ANSWER" };
  const vcls = (v) => ({ holds: "ok", question: "ok", mixed: "meh", misleading: "meh", wrong: "no" })[v] || "na";
  // the post's text from X's oEmbed (free, no key, allows cupcakeindex.com); pictures don't come through, only a pic.twitter.com link
  async function readPost(t) {
    const m = String(t).match(/https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/\w+\/status(?:es)?\/\d+/i);
    if (!m) return null;
    try {
      // straight from X first; Firefox's tracking protection and ad blockers block publish.x.com, so then via the Worker
      const direct = async () => { const r = await fetch(`https://publish.x.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(m[0])}`); if (!r.ok) throw new Error(r.status); return r.json(); };
      const d = await direct().catch(() => call(`/post?url=${encodeURIComponent(m[0])}`)), p = new DOMParser().parseFromString(d.html || "", "text/html").querySelector("blockquote p");
      if (!p) return null;
      const pic = [...p.querySelectorAll("a")].some((a) => /pic\.(twitter|x)\.com/.test(a.textContent));
      p.querySelectorAll("a").forEach((a) => { if (/pic\.(twitter|x)\.com|^https?:\/\/t\.co\//.test(a.textContent)) a.remove(); });
      p.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
      return { who: `${d.author_name} (@${(d.author_url || "").split("/").pop()})`, text: p.textContent.trim(), pic };
    } catch (e) { return null; }
  }
  const postId = (t) => String(t || "").match(/(?:x|twitter)\.com\/\w+\/status(?:es)?\/(\d+)/i)?.[1];
  const xUrl = (t, id) => `https://x.com/intent/post?text=${encodeURIComponent(t)}${id ? `&in_reply_to=${id}` : ""}`;
  function verdictCard(r, take) {
    const c = r.chart, items = Array.isArray(c?.items) ? c.items.filter((x) => Number.isFinite(+x.value)).slice(0, 10) : [];
    const top = Math.max(...items.map((x) => Math.abs(+x.value)), 0) || 1;
    const fmtV = (v) => Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(Math.round(v * 100) / 100);
    const chart = items.length >= 2 ? `<figure class="bot-tchart"><figcaption>${esc(c.title)}${c.unit ? ` <span class="muted">${esc(c.unit)}${c.lower_is_better ? ", lower is better" : ""}</span>` : ""}</figcaption>
        ${items.map((x) => `<div class="${x.highlight ? "hi" : ""}"><span>${x.rank ? `<i>${+x.rank}</i>` : ""}${esc(x.label)}</span><b style="--w:${Math.max(2, Math.abs(+x.value) / top * 100).toFixed(1)}%"></b><em>${fmtV(+x.value)}</em></div>`).join("")}
        ${c.source ? `<small class="muted">${esc(c.source)}</small>` : ""}</figure>` : "";
    // Post on X: a reply to the post when they pasted its link, else a new post. They still press Post themselves.
    // No link (a screenshot, or just the text): a box under the verdict takes one and turns the buttons into replies.
    const id = postId(take);
    const rp = r.replies || {};
    const reply = (k, label) => rp[k] ? `<div class="bot-reply"><h4 class="bot-h">${label} <span class="muted">${rp[k].length}/280</span></h4><p>${esc(rp[k])}</p>
        <div class="bot-ra"><button type="button" class="bot-copy" data-copy="${esc(rp[k])}">Copy</button><a class="bot-x-post" href="${esc(xUrl(rp[k], id))}" data-text="${esc(rp[k])}"${id ? ` data-id="${id}"` : ""} target="_blank" rel="noopener">${id ? "Reply on X" : "Post on X"} ↗</a></div></div>` : "";
    return `<div class="bot-stamp ${vcls(r.verdict)}">${VLABEL[r.verdict] || "CAN'T CHECK"}</div>
      <p class="bot-lead">${esc(r.headline || "")}</p>
      ${(r.claims || []).length ? `<h4 class="bot-h">The claims</h4><ul class="bot-claims">${r.claims.map((x) => `<li><span class="bot-ctag ${vcls(x.verdict)}">${VLABEL[x.verdict] || "CAN'T CHECK"}</span> <b>${esc(x.claim)}</b><br>${esc(x.evidence)}</li>`).join("")}</ul>` : ""}
      ${(r.missing || []).length ? `<h4 class="bot-h">What it leaves out</h4><ul>${r.missing.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${chart}
      ${!id && (rp.answer || rp.agree || rp.pushback) ? `<label class="bot-xlink"><span>Replying in a thread? Paste the post's link (Share > Copy link):</span>
        <input type="url" inputmode="url" autocomplete="off" placeholder="x.com/name/status/…"><small class="muted" role="status"></small></label>` : ""}
      ${reply("answer", "Your reply")}${reply("agree", "Reply that backs it")}${reply("pushback", "Reply that pushes back")}`;
  }

  // ---------- the instructions ----------
  // Built once per conversation and never changed (New starts over): Claude ties its earlier reasoning to the exact
  // instructions, so a system prompt that changes mid-conversation (a clock in it) gets the next question refused.
  // Anything that changes over time goes in now() instead, which rides along with each question.
  async function now() {
    const R = await BotTools.base();
    // the site's rankings can land a few minutes before the chat's copy is rebuilt (analyst_refresh.yml): say so
    const idx = await getJSON(`data/index.json?_=${Date.now()}`).catch(() => null);
    const behind = ["nfl", "cfb"].filter((lg) => { const ss = idx?.leagues?.[lg]?.seasons || {}, k = Object.keys(ss).sort().at(-1); return k && ss[k].weeks.at(-1) > R[lg].week; });
    return `[Right now it's ${new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })} for the member.${behind.length ? ` Our ${behind.map((x) => x.toUpperCase()).join(" and ")} rankings were just updated and our_rankings may still show last week's for a few minutes: say so if they ask about rankings. game_prediction, scores, standings and news are always current.` : ""}]`;
  }
  // what the chat knows about itself: the plans and this member's own usage, from the Worker's /me (the real limits)
  function plans() {
    const L = me?.limits || [], P = me?.prices || [], n = (x) => Number(x || 0).toLocaleString();
    const tiers = L.map((t, i) => `Tier ${i + 1}, $${P[i]} a month: ${n(t.q)} questions a month${t.day ? ` (up to ${n(t.day)} a day)` : ""} and ${n(t.takes)} take checks a month.`).join(" ");
    const mine = me?.free && !me.member ? `This member is on the free questions: ${n(me.questions)} of ${n(me.limit)} used, no take checks.`
      : me?.sub && ["active", "trialing", "past_due"].includes(me.sub.status) ? `This member pays for Tier ${me.sub.tier + 1}${me.sub.cancel_at_period_end ? " (canceled; it runs until the end of the period they paid for)" : ""}. This month: ${n(me.questions)} of ${n(me.limit)} questions, ${n(me.takes)} of ${n(me.take_limit)} take checks.`
      : me?.member ? `This member has Tier ${(me.tier || 0) + 1} for free (the site gave it to them). This month: ${n(me.questions)} of ${n(me.limit)} questions, ${n(me.takes)} of ${n(me.take_limit)} take checks.` : "";
    return `About you, the Analyst (answer these from here, never "I can't look that up"):
- Every message they send you counts as one question. Follow-ups count too. Your lookups and charts don't count extra.
- Free: anyone signed in with Google gets ${me?.free_q || (me?.free ? me.limit : 0) ? n(me.free_q || me.limit) : "a set number of"} free questions in all, not every month. When they're used up, the chat asks them to upgrade to a plan. Free questions don't include take checks.
- Plans (paid through Stripe; subscribe, change your card, switch plans or cancel any time in Settings, in the Cupcake Analyst section): ${tiers || "Tier 1 and Tier 2, a month each; the prices and limits are in Settings."} Monthly questions and take checks reset on the 1st.
- A take check ("Check a take" under the box): paste a take from X or a group chat, or a screenshot of it. You check every claim against our numbers, give a verdict, and write two replies they can post. Plans only.
- Settings shows how much they've used. ${mine}
- You answer from the site's own data and the same ESPN feeds the pages use. You can't see their account details beyond this, and you can't change plans yourself: point them to Settings.`;
  }
  async function prompt() {
    const R = await BotTools.base(), S = BotTools.seasons, T = BotTools.teamSeasons;
    return `You are the Cupcake Analyst, the stat desk inside The Cupcake Index (cupcakeindex.com), a college football and NFL power rankings and analytics site. A member is chatting with you in a small panel on the site.

Each question starts with the member's day and time in [brackets] (not something they typed). Our data: weekly stats for NFL players ${S("nfl").at(-1)}-${S("nfl")[0]} and college ${S("cfb").at(-1)}-${S("cfb")[0]} (regular season; the current seasons are partial), NFL team game stats back to ${T("nfl").at(-1)}, our model's rankings (NFL after week ${R.nfl.week}, college after week ${R.cfb.week} of ${R.cfb.season}), the NFL injury report and depth charts, every player's full career season by season from ESPN, back to his first year (career), and any season's game-by-game log back to the late 1990s (game_log).

How to answer:
- Use the tools for every number. find_player before player_stats; leaderboard to rank someone among peers; team_stats and our_rankings for teams, schedules and cupcake padding; team_status for injuries and starters (the same list as our Injuries tab); site_tab for our Injuries / Frauds / Over-achievers tabs; pace_to for "on pace for" questions; stat_menu to find the right stat; site_lists for coaches, records, Trade watch and our Heisman race; rare_plays for specific plays; how_we_count for how OUR stats and rankings are defined (call it before explaining any of our numbers). Make several calls in one round when you can.
- Only state numbers that came from a tool result in this conversation. Never use numbers from memory. Don't do math in your head (gaps, sums, differences, "X ahead of Y"): use a number a tool gave you, or just state both numbers. Records come from season_records. If our data can't answer it, say what's missing in one line.
- Charts: when a chart would help or the member asks for one, call chart_stats to find the Visualize stats, then show_chart. It opens the chart on the site behind this panel. Match the chart to the question:
  - Comparing specific players ("Toney vs Smith"): a radar with players = both player_ids from find_player, position set, and radar_stats = 5-7 stats that matter for that position (a WR: catches, receiving yards, yards per catch, receiving TDs, catch rate, yards after the catch...). Every chart about named players passes their ids in players, so they're on it.
  - Comparing teams: a radar or bar with highlight = those teams.
  - Who leads a stat: a bar, top 10, with the player or team they asked about in players / highlight.
  - Two stats against each other: a scatter, with the named players or teams highlighted.
  When they ask to change the chart ("make it a radar"), keep the same players or teams and redo show_chart; don't drop who they asked about. Never say the chart tool can't do something before trying it.
  To send them to a page (rankings, a team page, Injuries...), use open_page.
- Leaderboard stat names: any column (pass_yds, rush_td, tackles, def_sacks, pressure, pen, pts...) or a rate. Player rates: ${Object.keys(BotTools.RATES).join(", ")}, passer_rating, passer_rating_vs_blitz. Team rates: ${Object.keys(BotTools.TEAM_RATES).join(", ")}.
- "Who wins", "who do you have", "predict this game": call game_prediction and answer with our pick, the win chance and the predicted score, then the one or two reasons that matter most. Never say we don't have a prediction without calling it.
- Days and times: say when a game is ("tonight", "tomorrow", "Saturday") only by copying its "when" from scores, which is already in the member's time. Never work it out from dates yourself.
- Injury notes and headlines are reports from the date they carry (note_date, published). A game they mention may already be over: check scores before saying a player will or won't play in a game.
- "What's the score", "did they win", "when do they play": scores. Standings, division leaders, playoff seeds: standings. Recent news on a team or player: news.
- Careers and older seasons: anything before ${S("nfl").at(-1)} (NFL) or ${S("cfb").at(-1)} (college), a player's whole career, "first three years", or comparing careers: call career (season totals) or game_log (a single game or game-by-game stats in a season). career opens our career comparison chart, which is the chart for those years: Visualize (show_chart, radars) only has ${S("nfl").at(-1)} on, so if they asked for a radar of older seasons, say that in one short line and show the career comparison.
- Schedule strength in past seasons ("weakest schedule ever", "toughest in the last 30 years", a team's history): schedule_history. If they don't say college or NFL, answer for both.
- Pictures: when the member shares one (a screenshot of a post or a take, a stat graphic, a box score), read it closely first. If it makes claims, check each number with the tools and say plainly what holds up and what doesn't, with our numbers. If you can't read part of it, say which part.
- Never tell the member we don't have something until you've tried every tool that could have it. The weekly data starting in ${S("nfl").at(-1)} is NOT where our player history starts. If a tool says it has no data, try the next tool that could (player_stats, then game_log or career) before answering.
- Our site is the source of truth. If no tool covers what they asked, say "I can't look that up yet" and point to the page with open_page; never say the site doesn't have something, and never guess.
- No betting content: no spreads, lines, odds, over/unders or picks against a line. Our win chance and predicted score are fine.

${plans()}

Style: a sharp fan who knows the numbers, talking to another fan. Lead with the answer in one sentence, then the two or three numbers that back it (with ranks), then stop. Usually under 120 words. Make it easy to scan on a phone: one idea per short paragraph, never a block of several sentences. When you give three or more facts of the same kind (teams, players, injuries), put each on its own line as "Label: detail" (like "Giants: 4-2-1, won 1 straight") or as "- " items, under a short line ending in ":" if it helps. Write stats in plain words ("yards per carry", not ypc or column names). Take a side when the numbers point one way. No em dashes, no "Great question", no wrap-up sentence, no hashtags, no emoji. Plain text; **bold** sparingly; "- " for list items.`;
  }

  // ---------- the tools: the Analyst's (bot-tools.js) plus the site's own ----------
  // The site's own tools read the same files and ESPN feeds the pages read, at the moment they're asked, so the chat
  // and the site can't disagree. (bot-tools.js reads data/analyst.json, rebuilt by analyst_refresh.yml.)
  const ESPN = (lg, path) => `https://site.web.api.espn.com/apis/${path}/sports/football/${lg === "nfl" ? "nfl" : "college-football"}`;
  const getJSON = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`Couldn't reach ${u.includes("espn") ? "ESPN" : "the site's data"} (${r.status}). Try again.`); return r.json(); };
  const matchTeam = (q, names) => { // best match first, so "Washington" finds Washington before Washington State
    q = BotTools.norm(q);
    for (const t of [(n) => n === q, (n) => n.split(" ").includes(q), (n) => n.includes(q)]) { const n = names.find((x) => t(BotTools.norm(x))); if (n) return n; }
    return null;
  };
  // a kickoff in the member's own time, with the day spelled out, so the chat never does date math:
  // "tonight 8:15 PM EDT", "tomorrow 7:00 PM EDT", "Saturday Oct 31, 12:00 PM EDT", "last Sunday Oct 25, 1:00 PM EDT"
  function whenIs(iso) {
    const d = new Date(iso), now = new Date(), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const n = Math.round((day(d) - day(now)) / 864e5), time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    const wd = d.toLocaleDateString("en-US", { weekday: "long" }), md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (n === 0) return `${d.getHours() >= 17 ? "tonight" : "today"} ${time}`;
    if (n === 1) return `tomorrow ${time}`;
    if (n === -1) return `yesterday ${time}`;
    return `${n < 0 && n > -7 ? "last " : ""}${wd} ${md}, ${time}${Math.abs(n) > 6 ? ` (${n > 0 ? `in ${n} days` : `${-n} days ago`})` : ""}`;
  }
  // one week of ESPN's scoreboard (this week if w is empty), team names the way our pages show them:
  // "Washington Commanders" (NFL), "Washington" (college: no mascot)
  async function espnWeek(lg, w) {
    const nm = (t) => (lg === "nfl" ? t?.displayName : t?.location || t?.displayName), q = new URLSearchParams();
    if (lg === "cfb") { q.set("groups", "80"); q.set("limit", "300"); }
    if (w) { q.set("seasontype", "2"); q.set("week", String(w)); }
    const sb = await getJSON(`${ESPN(lg, "site/v2")}/scoreboard?${q}`);
    const games = (sb.events || []).map((e) => {
      const c = e.competitions?.[0] || {}, st = e.status?.type || {};
      const side = (h) => { const t = (c.competitors || []).find((x) => x.homeAway === h) || {};
        return { team: nm(t.team), score: st.state === "pre" ? undefined : +t.score, record: t.records?.[0]?.summary, ap_rank: t.curatedRank?.current < 99 ? t.curatedRank.current : undefined }; };
      return { id: e.id, week: sb.week?.number, away: side("away"), home: side("home"), status: st.state === "pre" ? "not started" : st.completed ? "final" : "live",
        detail: st.shortDetail, when: whenIs(e.date), tv: (c.broadcasts || []).flatMap((b) => b.names || []).join(", ") || undefined };
    });
    return { n: sb.week?.number, games, bye: (sb.week?.teamsOnBye || []).map(nm) };
  }
  const gameOf = (W, team) => { const hit = matchTeam(team, W.games.flatMap((g) => [g.home.team, g.away.team]).filter(Boolean)); return hit && W.games.filter((g) => g.home.team === hit || g.away.team === hit); };
  const SITE = [
    {
      name: "game_prediction",
      description: "Our model's pick for a team's next game (or a given week), read live from the site: who we have winning, each side's win chance, our predicted score, both QBs, and the reasons the game page lists. Use it for any 'who wins', 'who do you have', 'predict', 'what's the score going to be' question.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, team: { type: "string" }, week: { type: "integer" } }, required: ["league", "team"] },
      async execute(a) {
        const lg = String(a.league), idx = await (await fetch("data/index.json", { cache: "no-store" })).json();
        const seasons = idx.leagues[lg].seasons, season = Object.keys(seasons).sort().at(-1), weeks = seasons[season].weeks;
        // which game: the week they named, else their game this week if it hasn't finished (tonight's game, not next
        // week's), else the newest picks. The rankings file from week N holds the picks for week N + 1 (like the game page).
        let want = a.week ? +a.week : null;
        if (!want) {
          const W = await espnWeek(lg).catch(() => null), g = W && gameOf(W, a.team);
          if (g?.length && g[0].status !== "final") want = W.n;
        }
        const file = want && weeks.includes(want - 1) ? want - 1 : weeks.at(-1);
        const W = await (await fetch(`data/${lg}/${season}/week_${file}.json`)).json();
        const P = W.predictions || [], hit = matchTeam(a.team, P.flatMap((x) => [x.home, x.away]));
        const p = hit && P.find((x) => x.home === hit || x.away === hit);
        if (!p) throw new Error(`No ${lg} prediction for "${a.team}" in week ${file + 1} (a bye, or not a team we rank).`);
        const hp = p.home_win_prob;
        // what the game page shows; never the spread, book lines or "edge" (the site's own betting-style numbers stay off)
        return { season: +season, week: p.week, away: p.away, home: p.home, our_pick: p.pick,
          win_chance: { [p.home]: Math.round(100 * hp), [p.away]: Math.round(100 - 100 * hp) },
          predicted_score: p.home_pts != null ? { [p.home]: p.home_pts, [p.away]: p.away_pts } : null, qbs: { [p.home]: p.home_qb, [p.away]: p.away_qb },
          why: p.notes || (p.why ? [p.why] : []) };
      },
    },
    {
      name: "scores",
      description: "Live from ESPN, same as our Scores page: this week's games (or a given week) with kickoff time, TV, live score and clock, or the final. With team: just that team's game. Use it for 'did they win', 'what's the score', 'when do they play', 'who plays tonight'.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, team: { type: "string" }, week: { type: "integer" } }, required: ["league"] },
      async execute(a) {
        const lg = String(a.league);
        let W = await espnWeek(lg, a.week);
        if (!a.team) return { as_of: new Date().toISOString(), week: W.n, games: W.games.slice(0, 60), on_bye: W.bye.length ? W.bye : undefined };
        const find = (W) => gameOf(W, a.team);
        let games = find(W), bye = matchTeam(a.team, W.bye);
        // a bye (or this week already played and they're asking what's next): look one week ahead
        if (!games && !a.week && W.n) { const N = await espnWeek(lg, W.n + 1); games = find(N); if (games) W = N; }
        if (!games) throw new Error(bye ? `${bye} are on a bye in week ${W.n}.` : `No ${lg} game for "${a.team}" on ESPN's scoreboard${a.week ? ` in week ${a.week}` : ""}.`);
        return { as_of: new Date().toISOString(), week: W.n, ...(bye ? { note: `${bye} had a bye in week ${W.n - 1}; this is their next game.` } : {}), games };
      },
    },
    {
      name: "game_stats",
      description: "Live from ESPN, same as our game page: the box score of one game, live or final. Score and clock, team stats side by side (yards, plays, yards per play, 3rd/4th downs, turnovers, time of possession...), each team's passing, rushing, receiving, defense and kicking lines by player, every scoring play, the drive in progress and ESPN's win probability. Use it for anything about a game that's on now or just ended ('stats from the current game', 'how is Hurts doing tonight', 'who's leading in rushing', 'how did they score'). With no week: this week's game.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, team: { type: "string" }, week: { type: "integer" } }, required: ["league", "team"] },
      async execute(a) {
        const lg = String(a.league), W = await espnWeek(lg, a.week), g = gameOf(W, a.team)?.[0];
        if (!g) throw new Error(`No ${lg} game for "${a.team}" on ESPN's scoreboard${a.week ? ` in week ${a.week}` : " this week"}. Try the scores tool for when they play.`);
        if (g.status === "not started") return { game: g, note: "It hasn't started, so there's no box score yet." };
        // only the game itself: ESPN's summary also carries betting lines (odds, pickcenter), which we never pass on
        const s = await getJSON(`${ESPN(lg, "site/v2")}/summary?event=${encodeURIComponent(g.id)}`), b = s.boxscore || {};
        const team = (t) => t?.displayName || t?.location;
        const KEEP = ["passing", "rushing", "receiving", "defensive", "interceptions", "kicking"], TOP = { passing: 2, rushing: 4, receiving: 6, defensive: 5, interceptions: 3, kicking: 1 };
        const wp = (s.winprobability || []).slice(-1)[0];
        return {
          as_of: new Date().toISOString(), game: g,
          team_stats: (b.teams || []).map((t) => ({ team: team(t.team), ...Object.fromEntries((t.statistics || []).map((x) => [x.label || x.name, x.displayValue])) })),
          players: (b.players || []).map((p) => ({ team: team(p.team), ...Object.fromEntries((p.statistics || []).filter((c) => KEEP.includes(c.name)).map((c) => [c.name,
            (c.athletes || []).slice(0, TOP[c.name]).map((x) => ({ player: x.athlete?.displayName, ...Object.fromEntries((c.labels || []).map((l, i) => [l, x.stats?.[i]])) }))])) })),
          scoring: (s.scoringPlays || []).map((x) => ({ q: x.period?.number, clock: x.clock?.displayValue, team: x.team?.abbreviation || team(x.team), play: x.text, score: `${x.awayScore}-${x.homeScore} (away-home)` })),
          drive_now: s.drives?.current?.description ? { team: team(s.drives.current.team), so_far: s.drives.current.description } : undefined,
          win_chance: wp ? { home: `${Math.round(wp.homeWinPercentage * 100)}%`, source: "ESPN" } : undefined,
        };
      },
    },
    {
      name: "standings",
      description: "Live from ESPN, same as our Standings page: each division (NFL) or conference (college) with records, points for and against, streak and NFL playoff seed (1-7 make it), plus our rank. Optional team to get just its group.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, team: { type: "string" } }, required: ["league"] },
      async execute(a) {
        const lg = String(a.league), d = await getJSON(`${ESPN(lg, "v2")}/standings?${lg === "nfl" ? "level=3" : "group=80"}`);
        const groupsOf = (n) => (n.standings?.entries ? [{ name: n.name, entries: n.standings.entries }] : (n.children || []).flatMap(groupsOf));
        const st = (e, k) => e.stats.find((s) => s.type === k || s.name === k)?.displayValue;
        const ours = Object.fromEntries((BotTools.data()?.[lg]?.teams || []).map((t) => [BotTools.norm(t.team), t.rank]));
        let groups = groupsOf(d).map((g) => ({ group: g.name, teams: g.entries.map((e) => {
          const name = lg === "nfl" ? e.team.displayName : e.team.location || e.team.displayName;
          return { team: name, our_rank: ours[BotTools.norm(name)], record: st(e, "total"), conf: lg === "nfl" ? st(e, "vs. Conf.") : st(e, "vsconf"),
            pts_for: st(e, lg === "nfl" ? "pointsFor" : "pointsfor"), pts_against: st(e, lg === "nfl" ? "pointsAgainst" : "pointsagainst"), streak: st(e, "streak"),
            ...(lg === "nfl" ? { seed: +(e.stats.find((s) => s.type === "playoffseed" || s.name === "playoffseed")?.value || 0) || undefined } : {}) }; }) }));
        if (a.team) {
          const hit = matchTeam(a.team, groups.flatMap((g) => g.teams.map((t) => t.team)));
          if (!hit) throw new Error(`No ${lg} team matching "${a.team}" in the standings.`);
          groups = groups.filter((g) => g.teams.some((t) => t.team === hit));
        }
        return { groups };
      },
    },
    {
      name: "news",
      description: "The latest headlines (title, source, time, one-line summary), newest first: our News page plus ESPN's live feed, so breaking news (a trade minutes ago) is here. Optional search words (a team, a player, 'trade'). Use it for 'what happened with', 'any news on', 'why is he out', and before saying a trade or signing hasn't happened.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, search: { type: "string" } }, required: [] },
      async execute(a) {
        // our News page is collected hourly (src/news.py), so a trade from 20 minutes ago isn't in it yet (Buckner to
        // the 49ers, Oct 27 2026): ESPN's live headlines fill the gap, read straight from the browser like live.js does
        const espn = (lg) => fetch(`https://site.api.espn.com/apis/site/v2/sports/football/${lg === "cfb" ? "college-football" : "nfl"}/news?limit=50`)
          .then((r) => (r.ok ? r.json() : { articles: [] })).then((d) => (d.articles || []).map((x) => ({ league: lg, title: x.headline, source: "ESPN", published: x.published, summary: x.description })))
          .catch(() => []);
        const [n, ...live] = await Promise.all([getJSON(`data/news.json?_=${Date.now()}`), ...(a.league ? [a.league] : ["nfl", "cfb"]).map(espn)]);
        const w = BotTools.norm(a.search || "").split(" ").filter(Boolean), seen = new Set();
        const items = [...(n.items || []), ...live.flat()]
          .filter((x) => x.title && (!a.league || x.league === a.league) && w.every((t) => BotTools.norm(`${x.title} ${x.summary || ""}`).includes(t)))
          .filter((x) => { const k = BotTools.norm(x.title); return !seen.has(k) && seen.add(k); })
          .sort((x, y) => String(y.published || "").localeCompare(String(x.published || "")));
        if (!items.length) throw new Error(`No headlines (our News page or ESPN's live feed) match "${a.search || ""}" right now.`);
        return { updated: new Date().toISOString(), headlines: items.slice(0, 12).map((x) => ({ title: x.title, source: x.source, published: x.published, summary: x.summary || undefined })) };
      },
    },
    {
      name: "chart_stats",
      description: "Find the Stats > Visualize stat key for a chart. search = plain words ('yards per carry', 'sacks', 'epa'). who = players or teams. Returns up to 25 [key, label, group, position].",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, who: { type: "string", enum: ["players", "teams"] }, search: { type: "string" } }, required: ["league", "who", "search"] },
      async execute(a) {
        const C = await Viz.catalog(String(a.league)), list = C[a.who === "teams" ? "teams" : "players"];
        const w = BotTools.norm(a.search).split(" ").filter(Boolean);
        const score = (s) => w.filter((x) => BotTools.norm(s[1] + " " + s[0] + " " + s[2]).includes(x)).length;
        const hits = list.map((s) => [score(s), s]).filter(([n]) => n).sort((x, y) => y[0] - x[0]).slice(0, 25).map(([, s]) => s);
        return hits.length ? hits : { none: true, groups: [...new Set(list.map((s) => s[2]))] };
      },
    },
    {
      name: "show_chart",
      description: "Open a Stats > Visualize chart on the site. stat (and y_stat for a scatter) must be keys from chart_stats. who: players or teams. type: bar, line (week by week), scatter (stat across, y_stat up), pie, radar or table. players: player_ids from find_player (up to 5): a radar then shows exactly them, other charts highlight them. highlight: team names (teams charts: a radar shows exactly them; others color them). radar_stats: 4-8 chart_stats keys for the radar's spokes (leave out for the position's usual profile). team: only that team's players. position: QB RB WR TE K OL EDGE IDL LB CB S (players; set it for a player radar so percentiles compare like with like). top: 5, 10, 15, 25 or all. season_from/season_to, weeks_from/weeks_to: the range (default: this season, every week). per: game or total.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, who: { type: "string", enum: ["players", "teams"] }, type: { type: "string", enum: ["bar", "line", "scatter", "pie", "radar", "table"] },
        stat: { type: "string" }, y_stat: { type: "string" }, team: { type: "string" }, players: { type: "array", items: { type: "string" } }, highlight: { type: "array", items: { type: "string" } },
        radar_stats: { type: "array", items: { type: "string" } }, position: { type: "string" }, top: { type: "string" },
        season_from: { type: "integer" }, season_to: { type: "integer" }, weeks_from: { type: "integer" }, weeks_to: { type: "integer" }, per: { type: "string", enum: ["game", "total"] }, title: { type: "string" } }, required: ["league", "who", "type", "stat"] },
      async execute(a, links) {
        const lg = String(a.league), C = await Viz.catalog(lg), list = C[a.who === "teams" ? "teams" : "players"];
        for (const k of [a.stat, a.y_stat, ...(a.radar_stats || [])].filter(Boolean)) if (!list.some((s) => s[0] === k)) throw new Error(`"${k}" isn't a Visualize stat. Call chart_stats first.`);
        const D = await BotTools.load(lg, BotTools.seasons(lg)[0]);
        const key = (n) => { const k = BotTools.teamKey(D, n); if (!k) throw new Error(`No ${lg} team matching "${n}".`); return k; };
        const o = { league: lg, show: "visualize", who: a.who, type: a.type, stat: a.stat };
        if (a.y_stat) o.y = a.y_stat;
        if (a.team && a.who === "players") o.team = key(a.team);
        if (a.who === "players" && a.players?.length) {
          const bad = a.players.filter((id) => !D.pmeta[String(id)]);
          if (bad.length) throw new Error(`No ${lg} ${D.season || ""} games for player_id ${bad.join(", ")}. Use the player_id from find_player.`);
          o.pick = a.players.slice(0, 5).map(String).join(",");
        }
        if (a.who === "teams" && a.highlight?.length) o.pick = a.highlight.slice(0, 6).map(key).join(",");
        if (a.type === "radar" && a.radar_stats?.length) o.radar = a.radar_stats.slice(0, 8).join(",");
        if (a.position && a.who === "players") o.pos = String(a.position).toUpperCase();
        if (a.top) o.top = String(a.top);
        if (a.season_from) o.from = String(a.season_from);
        if (a.season_to) o.to = String(a.season_to);
        if (a.weeks_from) o.wk1 = String(a.weeks_from);
        if (a.weeks_to) o.wk2 = String(a.weeks_to);
        if (a.per) o.per = a.per;
        if (a.title) o.ttl = String(a.title).slice(0, 80);
        const href = `#/stats?${new URLSearchParams(o)}`;
        go(href);
        links.push({ href, label: a.title ? `Chart: ${a.title}` : "Open the chart" });
        return { opened: true, note: "The chart is open on the page behind the chat. Say what it shows in a sentence; don't repeat the link." };
      },
    },
    {
      name: "career",
      description: "Any NFL or college player's whole career, season by season, from ESPN: the same numbers as the player page's Stats by year, back to his first season (Brady from 2000). Use it for any season before 2022, careers, 'first three years', and comparing careers. Opens our career comparison chart for them. players: 1-4 names. career_years [first, last] lines them up by career year (1 = rookie year); seasons [first, last] picks years instead. category: passing, rushing, receiving, defensive, kicking... (default: each player's main one).",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, players: { type: "array", items: { type: "string" }, maxItems: 4 },
        category: { type: "string" }, career_years: { type: "array", items: { type: "integer" }, maxItems: 2 }, seasons: { type: "array", items: { type: "integer" }, maxItems: 2 } }, required: ["league", "players"] },
      async execute(a, links) {
        const lg = a.league === "cfb" ? "cfb" : "nfl", keys = [];
        for (const n of (a.players || []).slice(0, 4)) { // the site's own player search (the header's search box)
          const hits = await Live.searchPlayers(String(n), 6), h = hits.find((x) => x.key.startsWith(lg + ":")) || hits[0];
          if (!h) throw new Error(`No player named "${n}" on ESPN.`);
          keys.push(h.key);
        }
        if (!keys.length) throw new Error("Name at least one player.");
        const P = await Promise.all(keys.map((k) => { const [l, id] = k.split(":"); return Live.career(l, id); }));
        const byCareer = Array.isArray(a.career_years) && a.career_years.length, win = (byCareer ? a.career_years : a.seasons) || [];
        const lo = +win[0] || -Infinity, hi = +(win[1] ?? win[0]) || Infinity;
        const players = P.map((p) => {
          const lvl = p.lvl, rows = (C) => C.rows.filter((r) => r.level === lvl);
          const debut = p.debut || Math.min(...Object.values(p.cats).flatMap((C) => rows(C).map((r) => r.year)));
          const cats = Object.keys(p.cats).filter((c) => rows(p.cats[c]).length);
          const main = a.category && cats.includes(a.category) ? [a.category]
            : cats.sort((x, y) => rows(p.cats[y]).length - rows(p.cats[x]).length).slice(0, 3); // his main categories
          const stats = Object.fromEntries(main.map((c) => { const C = p.cats[c];
            const seasons = rows(C).map((r) => ({ season: r.year, career_year: r.year - debut + 1, team: r.team.abbr || undefined,
              ...Object.fromEntries(C.names.map((n) => [C.labels[n] || n, r.vals[n]]).filter(([, v]) => v != null && v !== "")) }))
              .filter((r) => { const x = byCareer ? r.career_year : r.season; return x >= lo && x <= hi; });
            return [c, { seasons, ...(win.length ? {} : { career_totals: C.career }) }]; }));
          return { name: p.name, position: p.pos, first_season: debut, active: p.active, stats };
        });
        const [l0, id0] = keys[0].split(":"), params = { league: l0, tab: "career", align: byCareer ? "career" : "season" };
        if (keys.length > 1) params.vs = keys.slice(1).join(",");
        if (a.category) params.cat = a.category;
        if (win.length) { params.from = String(lo); if (isFinite(hi)) params.to = String(hi); }
        const href = `#/player/${encodeURIComponent(id0)}?${new URLSearchParams(params)}`;
        go(href);
        links.push({ href, label: `Open ${keys.length > 1 ? "career comparison" : `${P[0].name}'s career`}` });
        return { source: "ESPN career stats (the player pages' Stats by year)", lined_up_by: byCareer ? "career year" : "season", players };
      },
    },
    {
      name: "schedule_history",
      description: "Schedule strength for every team and season we have games for (college 1979 on, NFL 1999 on): opponents' win share (games vs the team left out), college: cupcakes played (our rule), lower-division games and opponents' average rating in our model; NFL: opponents' average point margin. Ranks the easiest or hardest schedules over a range of seasons, or shows one team's seasons. Use it for 'weakest/toughest schedule ever / since X / in the last N years'.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, from: { type: "integer" }, to: { type: "integer" }, team: { type: "string" },
        order: { type: "string", enum: ["easiest", "hardest"] }, by: { type: "string", enum: ["opp_win_pct", "opp_rating", "opp_margin", "cupcakes"] }, top: { type: "integer" } }, required: ["league"] },
      async execute(a) {
        const D = await getJSON("data/schedule_history.json"), lg = a.league === "cfb" ? "cfb" : "nfl", L = D[lg], have = Object.keys(L).map(Number).sort((x, y) => x - y);
        const from = Math.max(+a.from || have[0], have[0]), to = Math.min(+a.to || have.at(-1), have.at(-1));
        // college: the model's opponent rating is the fair measure (lower-division teams' records only count their games against FBS teams)
        const by = a.by || (lg === "cfb" ? "opp_rating" : "opp_win_pct"), easiest = a.order !== "hardest";
        const minG = lg === "nfl" ? 14 : 10, team = a.team && matchTeam(a.team, [...new Set(Object.values(L).flatMap((s) => s.teams.map((t) => t.team)))]);
        if (a.team && !team) throw new Error(`No ${lg} team matching "${a.team}" in our schedule history.`);
        let rows = have.filter((s) => s >= from && s <= to).flatMap((s) => L[s].teams.map((t) => ({ season: s, ...t, ...(L[s].partial || (lg === "nfl" && s === have.at(-1)) ? { season_in_progress: true } : {}) })))
          .filter((t) => (team ? t.team === team : t.games >= minG) && t[by] != null);
        const sign = (by === "cupcakes" ? -1 : 1) * (easiest ? 1 : -1); // easiest = the weakest opponents, or the most cupcakes
        rows.sort((x, y) => sign * (x[by] - y[by]));
        return { covers: `${lg === "nfl" ? "NFL" : "College (FBS)"} ${from}-${to}${+a.from && +a.from < have[0] ? ` (our games start in ${have[0]})` : ""}`, ranked_by: by, order: easiest ? "easiest" : "hardest",
          note: D.note, ...(team ? {} : { min_games: minG }), seasons_compared: rows.length, teams: rows.slice(0, Math.min(+a.top || 10, team ? 60 : 25)) };
      },
    },
    {
      name: "season_records",
      description: "Single-season records (NFL and college): passing, rushing and receiving yards, TDs and catches, plus NFL sacks and interceptions. The value, who holds it, his team and the year. Use it for 'the record', 'on pace for the record', 'how close to the record'.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] } }, required: ["league"] },
      async execute(a) {
        const d = await getJSON("data/season_records.json"), lg = a.league === "cfb" ? "cfb" : "nfl";
        return { note: d.note, records: d[lg] };
      },
    },
    {
      name: "game_log",
      description: "Any player's game-by-game stats for one season from ESPN, the same as the player page's Game log (NFL back to the late 1990s): opponent, result and his stats each game. Use it for a single game ('week 3 of 2019'), best or worst games, or splits in any season, including before 2022. week: just that week. Opens his game log on the site.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, player: { type: "string" }, season: { type: "integer" }, week: { type: "integer" } }, required: ["league", "player", "season"] },
      async execute(a, links) {
        const lg = a.league === "cfb" ? "cfb" : "nfl", hits = await Live.searchPlayers(String(a.player), 6);
        const h = hits.find((x) => x.key.startsWith(lg + ":")) || hits[0];
        if (!h) throw new Error(`No player named "${a.player}" on ESPN.`);
        const [l, id] = h.key.split(":"), season = +a.season;
        const g = await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/football/${l === "nfl" ? "nfl" : "college-football"}/athletes/${encodeURIComponent(id)}/gamelog?season=${season}`);
        const labels = g.names || g.labels || []; // passingYards, rushingYards...: ESPN's short labels repeat ("YDS" twice)
        const games = (g.seasonTypes || []).flatMap((st) => (st.categories || []).flatMap((c) => (c.events || []).map((x) => {
          const e = g.events?.[x.eventId] || {};
          return { season_type: /post/i.test(st.displayName || "") ? "postseason" : "regular", week: e.week, date: (e.gameDate || "").slice(0, 10),
            opponent: `${e.atVs || "vs"} ${e.opponent?.abbreviation || e.opponent?.displayName || "?"}`, result: [e.gameResult, e.score].filter(Boolean).join(" ") || undefined,
            ...Object.fromEntries(labels.map((k, i) => [k, x.stats?.[i]]).filter(([, v]) => v != null && v !== "")) };
        }))).sort((x, y) => (x.date < y.date ? -1 : 1));
        if (!games.length) throw new Error(`ESPN has no ${season} game log for ${h.name}.`);
        const pick = a.week ? games.filter((x) => x.week === +a.week && x.season_type === "regular") : games;
        if (!pick.length) throw new Error(`${h.name} has no week ${a.week} game in ${season} (a bye, or he didn't play). His weeks that season: ${games.filter((x) => x.season_type === "regular").map((x) => x.week).join(", ")}.`);
        const href = `#/player/${encodeURIComponent(id)}?${new URLSearchParams({ league: l, tab: "log", season: String(season) })}`;
        go(href);
        links.push({ href, label: `Open ${h.name}'s ${season} game log` });
        return { source: "ESPN game log (the player page's Game log)", player: h.name, season, games: pick };
      },
    },
    {
      name: "player_bio",
      description: "A player's bio from ESPN, the same as the top of his player page: team, position, jersey, height, weight, age and birthday, hometown, college, draft spot, years in the league, status (active, free agent...) and current injury. Use it for 'how tall is', 'how old is', 'where did he go to college', 'when was he drafted', 'what number does he wear'.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, player: { type: "string" } }, required: ["player"] },
      async execute(a, links) {
        const hits = await Live.searchPlayers(String(a.player), 6);
        const h = (a.league && hits.find((x) => x.key.startsWith(a.league + ":"))) || hits[0];
        if (!h) throw new Error(`No player named "${a.player}" on ESPN.`);
        const [l, id] = h.key.split(":");
        const p = (await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/football/${l === "nfl" ? "nfl" : "college-football"}/athletes/${encodeURIComponent(id)}`)).athlete || {};
        const inj = p.injuries?.[0], fa = p.status?.type === "free-agent";
        const href = `#/player/${encodeURIComponent(id)}?${new URLSearchParams({ league: l })}`;
        links.push({ href, label: `Open ${p.displayName || h.name}'s page` });
        return { source: "ESPN (the player page)", player: p.displayName || h.name, league: l,
          team: fa ? "free agent" : p.team?.displayName, position: p.position?.displayName, jersey: p.displayJersey,
          height: p.displayHeight, weight: p.displayWeight, age: p.age, born: p.displayDOB, hometown: p.displayBirthPlace,
          college: p.college?.name || p.collegeTeam?.displayName, draft: p.displayDraft, experience: p.displayExperience, class: p.displayClass,
          status: p.status?.name, injury: inj ? [inj.status, inj.type?.description || inj.details?.type].filter(Boolean).join(", ") : undefined };
      },
    },
    {
      name: "open_page",
      description: "Open a page of the site: rankings, resume (Résumé Check), schedules, team (a team's page, needs team), scores, standings, leaders (Stats), injuries, frauds (NFL), projected, records (NFL), takes, news, trade_watch (NFL), coaches.",
      input_schema: { type: "object", properties: { page: { type: "string", enum: ["rankings", "resume", "schedules", "team", "scores", "standings", "leaders", "injuries", "frauds", "projected", "records", "takes", "news", "trade_watch", "coaches"] },
        league: { type: "string", enum: ["nfl", "cfb"] }, team: { type: "string" } }, required: ["page", "league"] },
      async execute(a, links) {
        const lg = String(a.league), p = String(a.page);
        const SHOW = { injuries: "injuries", frauds: "frauds", projected: "projected", records: "records" };
        let href, label = p.replace("_", " ");
        if (p === "team") {
          const D = await BotTools.load(lg, BotTools.seasons(lg)[0]), k = BotTools.teamKey(D, a.team || "");
          if (!k) throw new Error(`No ${lg} team matching "${a.team}".`);
          href = `#/team/${encodeURIComponent(k.split(":")[1])}?league=${lg}`;
          label = D.teams[k][0];
        } else if (SHOW[p] || p === "leaders") href = `#/stats?league=${lg}${SHOW[p] ? "&show=" + SHOW[p] : ""}`;
        else href = `#/${p === "trade_watch" ? "trades" : p}?league=${lg}`;
        go(href);
        links.push({ href, label: `Open ${label}` });
        return { opened: true, page: label };
      },
    },
    {
      name: "read_page",
      description: "Read any page of the site exactly as it shows on screen (the page's text, after it loads). Use it whenever a member asks about something the site shows and no other tool has it: a team page tab (schedule, roster, depth chart, injuries, moves, at a glance), a player page tab (bio, career, game log, records, charts), a game page (box score, drives, play-by-play), the rankings, Résumé Check, schedules, scores, standings, stats leaders, injuries, frauds, projected, records, takes, news, trade watch, free agents, coaches, compare, the hall of shame or release notes. It opens that page behind the chat. tab: the page's tab (team: schedule, glance, roster, depth, injuries, moves, takes; player: career, log, records, charts, takes).",
      input_schema: { type: "object", properties: {
        page: { type: "string", enum: ["rankings", "resume", "schedules", "team", "player", "game", "scores", "standings", "leaders", "injuries", "frauds", "projected", "records", "takes", "news", "trade_watch", "freeagents", "coaches", "compare", "shame", "updates"] },
        league: { type: "string", enum: ["nfl", "cfb"] }, team: { type: "string", description: "team page, or the team whose game (this week's unless week)" },
        player: { type: "string" }, tab: { type: "string" }, week: { type: "integer" } }, required: ["page", "league"] },
      async execute(a, links) {
        const lg = String(a.league), p = String(a.page), q = new URLSearchParams({ league: lg });
        if (a.tab) q.set("tab", String(a.tab));
        const SHOW = { injuries: "injuries", frauds: "frauds", projected: "projected", records: "records" };
        let path;
        if (p === "team") {
          const D = await BotTools.load(lg, BotTools.seasons(lg)[0]), k = BotTools.teamKey(D, a.team || "");
          if (!k) throw new Error(`No ${lg} team matching "${a.team}".`);
          path = `team/${encodeURIComponent(k.split(":")[1])}`;
        } else if (p === "player") {
          const hits = await Live.searchPlayers(String(a.player || ""), 6), h = hits.find((x) => x.key.startsWith(lg + ":")) || hits[0];
          if (!h) throw new Error(`No player named "${a.player}" on ESPN.`);
          const [l, id] = h.key.split(":");
          q.set("league", l);
          path = `player/${encodeURIComponent(id)}`;
        } else if (p === "game") {
          const g = gameOf(await espnWeek(lg, a.week), String(a.team || ""))?.[0];
          if (!g) throw new Error(`No ${lg} game for "${a.team}"${a.week ? ` in week ${a.week}` : " this week"}.`);
          path = `game/${encodeURIComponent(g.id)}`;
        } else if (SHOW[p] || p === "leaders") { path = "stats"; if (SHOW[p]) q.set("show", SHOW[p]); }
        else path = p === "trade_watch" ? "trades" : p;
        const href = `#/${path}?${q}`, back = location.hash;
        location.hash = href.slice(1);
        // wait for the page to finish drawing: its text stops changing (pages fetch ESPN, so up to ~10 s)
        const view = () => document.querySelector(".view:not(.hidden)");
        let text = "", same = 0;
        for (let i = 0; i < 40 && same < 3; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const t = (view()?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
          same = t && t === text && !/^loading|loading…$/i.test(t) ? same + 1 : 0;
          text = t;
        }
        if (quiet) location.hash = back.slice(1); // a take check reads without moving the page behind it
        else links.push({ href, label: `Open ${p === "updates" ? "release notes" : p.replace("_", " ")}` });
        if (!text) throw new Error("That page came up empty.");
        return { page: href, text: text.length > 14000 ? text.slice(0, 14000) + "\n…(cut off: ask for a tab or narrower page)" : text };
      },
    },
  ];
  // on a phone the panel covers the page: the chat slides away first, then the page changes (and fades in), so it
  // doesn't jump behind the chat. Already on that page (a link tapped): just close the chat
  const sameHash = (a, b) => {
    const norm = (h) => { const [path, q = ""] = decodeURIComponent(h.replace(/^#\/?/, "")).split("?"); const u = new URLSearchParams(q); u.sort(); return path + "?" + u; };
    return norm(a) === norm(b);
  };
  function go(href, tapped) {
    if (quiet) return; // a take check looks things up without moving the page behind it
    const open = el && !el.querySelector(".bot-panel").hidden;
    if (sameHash(href, location.hash)) { if (open && (tapped || window.innerWidth < 600)) closeChat(false); return; }
    if (open && window.innerWidth < 600) { closeChat(false); setTimeout(() => { location.hash = href.slice(1); }, 170); }
    else location.hash = href.slice(1);
  }
  const TOOL_DEFS = () => [...BotTools.TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    ...SITE.map(({ name, description, input_schema }) => ({ name, description, input_schema }))];
  async function run(name, input, links) {
    const t = SITE.find((x) => x.name === name) || BotTools.TOOLS.find((x) => x.name === name);
    if (!t) throw new Error(`No tool named ${name}.`);
    await BotTools.base();
    return t.execute(input, links);
  }

  return { show, section, wire };
})();
