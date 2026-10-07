// Pick'em leaderboard (Pick'em > Leaderboard) and leaderboard names (Settings, signed in).
// Names are unique: each one is reserved in names/<key> (key = the name in lowercase letters and numbers only, so
// "Terry" and "terry_" are the same name), and the database rules only let its owner use it.
// Your season record (graded in your browser by pickem.js, the same numbers as your season panel) is published to
// leaderboard/<league>-<season>-<your id> whenever it changes. Anyone can read the board; only you can write your row.
const Leaderboard = (() => {
  const NAME = "lb-name"; // {name, key}, synced to your account (account.js)
  const BAD = /(fuck|shit|cunt|nigg|fag|bitch|whore|slut|rape|nazi|hitler|porn|dick|cock|pussy)/;
  const keyOf = (n) => (n || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const valid = (n) => /^[A-Za-z0-9 _.'-]{3,20}$/.test(n) && keyOf(n).length >= 3 && !BAD.test(keyOf(n));
  const mine = () => store.get(NAME) || null;
  const seasonNow = () => { const d = new Date(); return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1; };
  const user = () => (typeof Account !== "undefined" && Account.enabled() ? Account.user() : null);

  // -------- names
  async function check(name) {
    if (!valid(name)) return "invalid";
    const d = await (await Account.firestore()).collection("names").doc(keyOf(name)).get();
    return !d.exists ? "ok" : d.data().uid === user()?.uid ? "mine" : "taken";
  }
  async function claim(name) {
    const u = user();
    if (!u || !valid(name)) throw new Error("invalid");
    const fs = await Account.firestore(), key = keyOf(name), old = mine()?.key;
    await fs.runTransaction(async (tx) => {
      const ref = fs.collection("names").doc(key), snap = await tx.get(ref);
      if (snap.exists && snap.data().uid !== u.uid) throw new Error("taken");
      tx.set(ref, { uid: u.uid, name });
      if (old && old !== key) tx.delete(fs.collection("names").doc(old));
    });
    store.set(NAME, { name, key });
    await republish();
  }

  // -------- your row on the board
  function summary(log) {
    const weeks = Object.entries(log || {}).filter(([, g]) => g.w + g.l);
    const w = weeks.reduce((n, [, g]) => n + g.w, 0), l = weeks.reduce((n, [, g]) => n + g.l, 0);
    const best = weeks.filter(([, g]) => g.done).sort(([, a], [, b]) => b.w / (b.w + b.l) - a.w / (a.w + a.l) || b.w - a.w)[0];
    return { w, l, weeks: weeks.length, best: best ? `${best[1].w}-${best[1].l}` : "" };
  }
  function perfect(lg, season) { // Perfect Pick'em weeks this season (pickem.js)
    try { return (JSON.parse(store.get("pickem-badges") || "[]") || []).filter((b) => b.lg === lg && b.season === +season).length; } catch { return 0; }
  }
  async function publish(lg, season, log) {
    const u = user(), n = mine();
    if (!u || !n) return;
    const s = { ...summary(log), perfect: perfect(lg, season) }, id = `${lg}-${season}-${u.uid}`, sig = JSON.stringify([n.name, s]);
    if (!s.w && !s.l) return;
    try { if (localStorage.getItem("lb-pub-" + id) === sig) return; } catch {}
    try {
      const fs = await Account.firestore();
      await fs.collection("leaderboard").doc(id).set({ uid: u.uid, name: n.name, nameKey: n.key, lg, season: +season, ...s,
        updated: firebase.firestore.FieldValue.serverTimestamp() });
      try { localStorage.setItem("lb-pub-" + id, sig); } catch {}
    } catch (e) { console.warn("leaderboard", e); }
  }
  async function republish() { // after a name change: every season you have a record for
    let keys = [];
    try { keys = Object.keys(localStorage).filter((k) => /^pickem-log-(cfb|nfl)-\d{4}$/.test(k)); } catch {}
    for (const k of keys) {
      const [, lg, season] = k.match(/^pickem-log-(cfb|nfl)-(\d{4})$/);
      try { localStorage.removeItem(`lb-pub-${lg}-${season}-${user()?.uid}`); } catch {}
      await publish(lg, season, JSON.parse(store.get(k) || "{}") || {});
    }
  }

  // -------- the board (Pick'em > Leaderboard)
  async function render(root, lg) {
    const season = seasonNow(), me = user();
    const tabs = `<div class="subtabs"><a class="subtab" href="${link("picks")}">My picks</a><a class="subtab on" href="${link("picks", null, { board: 1 })}">Leaderboard</a></div>`;
    root.innerHTML = tabs + `<div class="card muted">Loading the leaderboard…</div>`;
    let rows = [];
    try {
      const snap = await (await Account.firestore()).collection("leaderboard").where("lg", "==", lg).where("season", "==", season).get();
      rows = snap.docs.map((d) => d.data());
    } catch (e) {
      root.innerHTML = tabs + `<div class="card">Couldn't load the leaderboard (${esc(e.code || e.message)}). Try again in a minute.</div>`;
      return;
    }
    rows.sort((a, b) => b.w - a.w || a.l - b.l || a.name.localeCompare(b.name));
    let rank = 0, prev = null;
    const pct = (r) => (r.w + r.l ? Math.round((100 * r.w) / (r.w + r.l)) : 0);
    const body = rows.slice(0, 200).map((r, i) => {
      if (!prev || prev.w !== r.w || prev.l !== r.l) rank = i + 1; // ties share a rank
      prev = r;
      return `<tr class="${me && r.uid === me.uid ? "lb-me" : ""}"><td class="num">${rank}</td><td><b>${esc(r.name)}</b>${r.perfect ? ` <span class="lb-perfect" title="Perfect Pick'em: every game right in ${r.perfect} week${r.perfect > 1 ? "s" : ""}">🏅${r.perfect > 1 ? "×" + r.perfect : ""}</span>` : ""}</td>
        <td class="num">${r.w}-${r.l}</td><td class="num">${pct(r)}%</td><td class="num">${esc(r.best || "–")}</td><td class="num">${r.weeks}</td></tr>`;
    }).join("");
    const join = !Account.enabled() ? "" : !me ? `<p class="note">Sign in (Settings) and pick a leaderboard name to join.</p>`
      : !mine() ? `<p class="note">You're signed in but don't have a leaderboard name yet. <a href="${link("settings")}">Pick one in Settings →</a></p>` : "";
    root.innerHTML = tabs + `<div class="card">
      <h2>Pick'em leaderboard <span class="muted">${esc(LEAGUE_NAME[lg] || lg)} · ${season}</span></h2>
      ${join}
      ${rows.length ? `<div class="table-wrap"><table class="box lb-tbl"><thead><tr><th class="num">#</th><th>Name</th><th class="num">Record</th><th class="num">Win %</th><th class="num">Best week</th><th class="num">Weeks</th></tr></thead><tbody>${body}</tbody></table></div>`
        : `<p class="muted">Nobody's on the board yet. Make your picks, pick a leaderboard name in Settings, and you'll show up once your first game is final.</p>`}
      <p class="note">🏅 = Perfect Pick'em: every game picked, locked in on time, all right. Ranked by games picked right, then fewest wrong. Records update when each player opens Pick'em. Just for fun.</p></div>`;
  }

  // -------- Settings section
  function section() {
    if (typeof Account === "undefined" || !Account.enabled()) return "";
    const u = user(), n = mine();
    if (!u) return `<h3>Pick'em leaderboard</h3><p class="note">Sign in above to get a leaderboard name and show up on the Pick'em leaderboard.</p>`;
    return `<h3>Pick'em leaderboard</h3>
      <p class="note">Your name on the Pick'em leaderboard. 3 to 20 letters, numbers or spaces, and nobody else can have it.</p>
      <div class="lb-set"><input id="lb-name" maxlength="20" autocomplete="off" spellcheck="false" placeholder="Pick a name" value="${esc(n?.name || "")}">
        <button class="btn" id="lb-save" type="button">${n ? "Change name" : "Save name"}</button><small id="lb-msg" class="muted">${n ? `You're “${esc(n.name)}”.` : ""}</small></div>`;
  }
  let t = null;
  const msg = (s, cls = "") => { const m = document.getElementById("lb-msg"); if (m) { m.textContent = s; m.className = cls || "muted"; } };
  document.addEventListener("input", (e) => {
    if (e.target.id !== "lb-name") return;
    clearTimeout(t);
    const v = e.target.value.trim();
    if (!v) return msg("");
    if (!valid(v)) return msg("3–20 letters, numbers or spaces (and keep it clean).", "lb-bad");
    t = setTimeout(async () => {
      try { const r = await check(v); msg(r === "ok" ? "Available ✓" : r === "mine" ? "That's yours ✓" : "Taken. Try another.", r === "taken" ? "lb-bad" : "lb-good"); }
      catch { msg(""); }
    }, 400);
  });
  document.addEventListener("click", async (e) => {
    if (e.target.id !== "lb-save") return;
    const v = document.getElementById("lb-name")?.value.trim() || "";
    if (!valid(v)) return msg("3–20 letters, numbers or spaces (and keep it clean).", "lb-bad");
    msg("Saving…");
    try { await claim(v); msg(`Saved. You're “${v}” on the leaderboard.`, "lb-good"); }
    catch (err) { msg(err.message === "taken" ? "Taken. Try another." : "Couldn't save it. Try again in a minute.", "lb-bad"); }
  });

  return { publish, render, section, seasonNow, claim, valid, name: () => mine()?.name || "" };
})();
