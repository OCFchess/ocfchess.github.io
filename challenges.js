/* CHESS. — direct challenges
 * Loaded on every page except login. Does two things:
 *   1. Listens for incoming challenges and shows an Accept / Decline popup.
 *   2. Exposes window.chessChallenge.send(...) so a profile page can challenge someone.
 * Uses Supabase Realtime broadcast (no database changes) + the same "games" table
 * flow as normal matchmaking: challenger creates the game as White, opponent joins as Black.
 */
(() => {
  // Name of the feature shown on the button and popups.
  const NAME = "Challenge";
  window.chessChallengeName = NAME;

  let resolveReady;
  window.chessChallengeReady = new Promise((r) => (resolveReady = r));

  (async () => {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const sb = createClient(
      "https://hloyebtuqozxalewkbgp.supabase.co",
      "sb_publishable_LhVKo17KVegP0q_qWqghnw_wkOYn3l4",
      { auth: { autoRefreshToken: false } }
    );
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { resolveReady(null); return; }

    const me = session.user.id;
    const { data: mp } = await sb.from("profiles").select("username,title").eq("id", me).maybeSingle();
    const myName = mp?.username || session.user.user_metadata?.username || "Someone";
    const myTitle = mp?.title || null;

    const EXPIRE_MS = 45000;     // how long a challenge stays open
    const START_WAIT_MS = 15000; // how long the accepter waits for the game to be created

    /* ---------- tiny UI ---------- */
    const style = document.createElement("style");
    style.textContent = `
      #chTray{position:fixed;top:84px;right:16px;z-index:2000;display:flex;flex-direction:column;gap:10px;width:min(340px,calc(100vw - 32px))}
      .chToast{background:#191b20;border:1px solid #c62828;border-radius:10px;padding:14px 16px;color:#f4f4f5;
        font:14px/1.4 Inter,Arial,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.55)}
      .chToast b{font-weight:800}
      .chToast .chTb{display:inline-block;background:#A71924;color:#fff;font-size:10px;font-weight:900;padding:2px 5px;border-radius:3px;margin-right:6px;vertical-align:middle}
      .chToast .chSub{color:#999da8;font-size:12px;margin-top:3px}
      .chToast .chRow{display:flex;gap:8px;margin-top:12px}
      .chToast button{flex:1;border:0;border-radius:7px;padding:10px 0;min-height:40px;color:#fff;background:#c62828;font:inherit;font-weight:800;font-size:13px;cursor:pointer}
      .chToast button:hover{background:#e53935}
      .chToast button.alt{background:#22252c;border:1px solid #30333b}
      .chToast button.alt:hover{background:#30333b}
    `;
    document.head.append(style);
    const tray = document.createElement("div");
    tray.id = "chTray";
    document.body.append(tray);

    function toast({ title, titleBadge, text, sub, buttons = [] }) {
      const el = document.createElement("div");
      el.className = "chToast";
      const head = document.createElement("div");
      if (titleBadge) {
        const b = document.createElement("span");
        b.className = "chTb"; b.textContent = titleBadge.toUpperCase();
        head.append(b);
      }
      const bold = document.createElement("b");
      bold.textContent = title;
      head.append(bold, " " + text);
      el.append(head);
      if (sub) { const s = document.createElement("div"); s.className = "chSub"; s.textContent = sub; el.append(s); }
      if (buttons.length) {
        const row = document.createElement("div"); row.className = "chRow";
        for (const b of buttons) {
          const btn = document.createElement("button");
          btn.type = "button"; btn.textContent = b.label;
          if (b.alt) btn.className = "alt";
          btn.onclick = b.onClick;
          row.append(btn);
        }
        el.append(row);
      }
      tray.append(el);
      return el;
    }
    const dismiss = (el) => el && el.remove();
    function note(text, ms = 5000) {
      const el = toast({ title: "", text });
      setTimeout(() => dismiss(el), ms);
      return el;
    }

    /* ---------- helpers ---------- */
    const catOf = (t) => (t < 180000 ? "Bullet" : t < 480000 ? "Blitz" : t < 1500000 ? "Rapid" : "Classical");
    const tcLabel = (base, inc) => `${base / 60000} + ${inc / 1000} · ${catOf(base + 40 * inc)}`;
    const validColor = (c) => c === "w" || c === "b" || c === "r";
    const myColorLabel = (c) => (c === "w" ? "you play White" : c === "b" ? "you play Black" : "random colours");
    // c = the challenger's colour; the opponent gets the opposite one.
    const theirColorLabel = (c) => (c === "w" ? "you play Black" : c === "b" ? "you play White" : "random colours");
    const validTc = (b, i) => Number.isInteger(b) && Number.isInteger(i) && b >= 30000 && b <= 10800000 && i >= 0 && i <= 180000;

    // One cached, subscribed broadcast channel per recipient.
    const chans = new Map();
    function chanFor(userId) {
      if (!chans.has(userId)) {
        const ch = sb.channel("challenge-" + userId);
        chans.set(userId, new Promise((res, rej) => {
          ch.subscribe((st) => {
            if (st === "SUBSCRIBED") res(ch);
            else if (st === "CHANNEL_ERROR" || st === "TIMED_OUT" || st === "CLOSED") {
              chans.delete(userId); rej(new Error("Connection failed"));
            }
          });
        }));
      }
      return chans.get(userId);
    }
    async function sendTo(userId, event, payload) {
      const ch = await chanFor(userId);
      return ch.send({ type: "broadcast", event, payload });
    }
    const quiet = (p) => p.catch(() => {});

    // Busy = already in an active game, or has a fresh open game waiting for an opponent.
    async function amBusy() {
      const since = new Date(Date.now() - 5 * 60e3).toISOString();
      const { data } = await sb.from("games").select("id,status,created_at")
        .or(`white_id.eq.${me},black_id.eq.${me}`).in("status", ["waiting", "active"]).limit(5);
      return (data || []).some((g) => g.status === "active" || g.created_at > since);
    }

    /* ---------- state ---------- */
    let outgoing = null;       // challenge I sent, waiting for an answer
    let pendingStart = null;   // challenge I accepted, waiting for the game to be created
    const incoming = new Map();// id -> { el, timer, p }

    function clearOutgoing() {
      if (!outgoing) return;
      clearTimeout(outgoing.timer);
      dismiss(outgoing.el);
      outgoing = null;
    }

    /* ---------- sending a challenge (called from a profile page) ---------- */
    async function send(targetId, targetName, base_ms, inc_ms, color = "r") {
      if (targetId === me) return { ok: false, error: "You can't challenge yourself." };
      if (!validTc(base_ms, inc_ms)) return { ok: false, error: "Invalid time control." };
      if (!validColor(color)) return { ok: false, error: "Invalid colour." };
      if (outgoing) return { ok: false, error: "You already have a challenge pending." };
      if (await amBusy()) return { ok: false, error: "Finish your current game first." };

      const id = crypto.randomUUID();
      let r;
      try {
        r = await sendTo(targetId, "challenge", { id, from: me, fromName: myName, fromTitle: myTitle, base_ms, inc_ms, color });
      } catch { return { ok: false, error: "Couldn't reach the server. Try again." }; }
      if (r !== "ok") return { ok: false, error: "Couldn't send the challenge. Try again." };

      const cancel = () => {
        quiet(sendTo(targetId, "cancel", { id }));
        clearOutgoing();
      };
      const el = toast({
        title: NAME + " request sent", text: "to " + targetName,
        sub: tcLabel(base_ms, inc_ms) + " · " + myColorLabel(color) + " · waiting for a response…",
        buttons: [{ label: "Cancel", alt: true, onClick: cancel }],
      });
      const timer = setTimeout(() => {
        quiet(sendTo(targetId, "cancel", { id }));
        clearOutgoing();
        note(`${targetName} didn't respond (they may be offline).`, 6000);
      }, EXPIRE_MS);
      outgoing = { id, to: targetId, toName: targetName, base_ms, inc_ms, color, el, timer };
      return { ok: true };
    }

    /* ---------- the opponent accepted: create the game and tell them ---------- */
    async function onAccepted(p) {
      if (!outgoing || p.id !== outgoing.id || p.by !== outgoing.to) return;
      const o = outgoing;
      clearTimeout(o.timer);
      dismiss(o.el);
      outgoing = null;
      const wait = toast({ title: o.toName, text: "accepted — starting the game…" });

      const { data, error } = await sb.from("games")
        .insert({ white_id: me, base_ms: o.base_ms, inc_ms: o.inc_ms }).select("id").single();
      if (error) {
        dismiss(wait);
        quiet(sendTo(o.to, "decline", { id: o.id, reason: "error" }));
        note("Couldn't create the game: " + error.message, 7000);
        return;
      }
      // Resolve "random" now, fairly, on the challenger's side.
      const finalColor = o.color === "r" ? (crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? "w" : "b") : o.color;
      const go = () => { quiet(sendTo(o.to, "go", { id: o.id })); location.href = "play.html?game=" + data.id; };
      // The opponent always joins the Black seat first (same path as matchmaking).
      // Once they confirm, swap seats if the challenger wants Black, then open the board.
      const t = setTimeout(go, 8000);
      joinedWaiters.set(o.id, async () => {
        clearTimeout(t);
        if (finalColor === "b") {
          const { data: sw, error: swErr } = await sb.from("games")
            .update({ white_id: o.to, black_id: me })
            .eq("id", data.id).eq("status", "active").eq("white_id", me).select("id");
          if (swErr || !sw?.length) sessionStorage.setItem("chColorFail", "1");
        }
        go();
      });
      quiet(sendTo(o.to, "start", { id: o.id, gameId: data.id }));
    }
    const joinedWaiters = new Map();

    /* ---------- receiving a challenge ---------- */
    async function onChallenge(p) {
      if (!p || typeof p.id !== "string" || typeof p.from !== "string" || p.from === me) return;
      if (typeof p.fromName !== "string" || !validTc(p.base_ms, p.inc_ms) || !validColor(p.color)) return;
      if (incoming.has(p.id)) return;
      if ([...incoming.values()].some((x) => x.p.from === p.from)) return; // one open challenge per sender
      if (outgoing || pendingStart || await amBusy()) {
        quiet(sendTo(p.from, "decline", { id: p.id, reason: "busy" }));
        return;
      }
      const entry = { p };
      const close = () => { clearTimeout(entry.timer); dismiss(entry.el); incoming.delete(p.id); };
      entry.close = close;
      entry.el = toast({
        title: p.fromName.slice(0, 20), titleBadge: typeof p.fromTitle === "string" ? p.fromTitle.slice(0, 4) : null,
        text: "wants to " + NAME.toLowerCase() + " you", sub: tcLabel(p.base_ms, p.inc_ms) + " · " + theirColorLabel(p.color),
        buttons: [
          { label: "Accept", onClick: () => accept(entry) },
          { label: "Decline", alt: true, onClick: () => { close(); quiet(sendTo(p.from, "decline", { id: p.id, reason: "declined" })); } },
        ],
      });
      entry.timer = setTimeout(close, EXPIRE_MS);
      incoming.set(p.id, entry);
    }

    async function accept(entry) {
      const p = entry.p;
      if (await amBusy()) {
        entry.close();
        note("Finish your current game first.");
        quiet(sendTo(p.from, "decline", { id: p.id, reason: "busy" }));
        return;
      }
      // Turn down any other open challenges.
      for (const [id, e] of incoming) {
        if (id !== p.id) { quiet(sendTo(e.p.from, "decline", { id, reason: "busy" })); e.close(); }
      }
      entry.close();
      const wait = toast({ title: p.fromName.slice(0, 20), text: "— waiting for the game to start…" });
      const timer = setTimeout(() => {
        dismiss(wait); pendingStart = null;
        note("The game didn't start. The challenger may have left.", 6000);
      }, START_WAIT_MS);
      pendingStart = { id: p.id, from: p.from, base_ms: p.base_ms, inc_ms: p.inc_ms, wait, timer, gameId: null };
      try { await sendTo(p.from, "accept", { id: p.id, by: me }); }
      catch { dismiss(wait); clearTimeout(timer); pendingStart = null; note("Couldn't reach the challenger."); }
    }

    /* ---------- challenger created the game: join it as Black ---------- */
    async function onStart(p) {
      const ps = pendingStart;
      if (!ps || p.id !== ps.id || typeof p.gameId !== "string") return;
      clearTimeout(ps.timer);
      const fail = (msg) => { dismiss(ps.wait); pendingStart = null; note(msg, 6000); };

      const { data: g } = await sb.from("games").select("id,white_id,black_id,status,base_ms,inc_ms")
        .eq("id", p.gameId).maybeSingle();
      if (!g || g.white_id !== ps.from || g.black_id || g.status !== "waiting"
          || g.base_ms !== ps.base_ms || g.inc_ms !== ps.inc_ms) return fail("Couldn't join that game.");

      const { data, error } = await sb.from("games").update({ black_id: me, status: "active" })
        .eq("id", g.id).is("black_id", null).select("id");
      if (error || !data?.length) return fail("Couldn't join that game.");

      ps.gameId = g.id;
      quiet(sendTo(ps.from, "joined", { id: ps.id }));
      // Challenger may swap colours before the board opens; wait for their "go" (with a fallback).
      ps.timer = setTimeout(() => { location.href = "play.html?game=" + g.id; }, 8000);
    }

    /* ---------- my inbox ---------- */
    sb.channel("challenge-" + me)
      .on("broadcast", { event: "challenge" }, ({ payload }) => onChallenge(payload))
      .on("broadcast", { event: "cancel" }, ({ payload }) => incoming.get(payload?.id)?.close())
      .on("broadcast", { event: "accept" }, ({ payload }) => payload && onAccepted(payload))
      .on("broadcast", { event: "start" }, ({ payload }) => payload && onStart(payload))
      .on("broadcast", { event: "go" }, ({ payload }) => {
        if (pendingStart && payload?.id === pendingStart.id && pendingStart.gameId) {
          location.href = "play.html?game=" + pendingStart.gameId;
        }
      })
      .on("broadcast", { event: "joined" }, ({ payload }) => joinedWaiters.get(payload?.id)?.())
      .on("broadcast", { event: "decline" }, ({ payload }) => {
        if (outgoing && payload?.id === outgoing.id) {
          const name = outgoing.toName;
          clearOutgoing();
          note(payload.reason === "busy" ? `${name} is busy right now.` : `${name} declined your challenge.`, 6000);
        } else if (pendingStart && payload?.id === pendingStart.id) {
          clearTimeout(pendingStart.timer); dismiss(pendingStart.wait); pendingStart = null;
          note("The challenger cancelled.", 5000);
        }
      })
      .subscribe();

    if (sessionStorage.getItem("chColorFail")) {
      sessionStorage.removeItem("chColorFail");
      note("Couldn't switch colours — colours were assigned the default way.", 7000);
    }

    window.chessChallenge = { send, me };
    resolveReady(window.chessChallenge);
  })().catch((e) => { console.error("Challenges unavailable:", e); resolveReady(null); });
})();
