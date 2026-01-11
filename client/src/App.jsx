import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Client supports:
 * - Singleplayer: local modern pong (no server)
 * - Multiplayer LAN: host-authoritative simulation via WebSockets relay
 *
 * Multiplayer controls:
 * - Player 1 (left): W/S
 * - Player 2 (right): ↑/↓
 */

export default function App() {
  const [tab, setTab] = useState("multiplayer"); // "multiplayer" | "single"
  return (
    <div style={{ minHeight: "100vh", padding: 18, display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 1060 }}>
        <Header tab={tab} setTab={setTab} />
        {tab === "multiplayer" ? <LanPong /> : <SingleplayerPong />}
        <Footer />
      </div>
    </div>
  );
}

function Header({ tab, setTab }) {
  const pill = (active) => ({
    padding: "8px 12px",
    borderRadius: 999,
    background: active ? "rgba(231,236,255,0.14)" : "rgba(231,236,255,0.08)",
    border: "1px solid rgba(231,236,255,0.14)",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 13,
  });

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
      <div>
        <div style={{ fontSize: 22, fontWeight: 900 }}>LAN Pong</div>
        <div style={{ opacity: 0.7, fontSize: 13 }}>Multiplayer over your local network via WebSockets</div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <div onClick={() => setTab("multiplayer")} style={pill(tab === "multiplayer")}>Multiplayer</div>
        <div onClick={() => setTab("single")} style={pill(tab === "single")}>Singleplayer</div>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div style={{ marginTop: 12, opacity: 0.65, fontSize: 12 }}>
      Tip: run the client with <code>npm run dev -- --host</code> so your friend can open it on your LAN.
    </div>
  );
}

// =================== Multiplayer ===================

function LanPong() {
  const cfg = useMemo(() => ({
    w: 920,
    h: 540,
    paddleW: 14,
    paddleH: 96,
    ballR: 8,
    wallPad: 18,
    startBallSpeed: 420,
    maxBallSpeed: 900,
    paddleSpeed: 640,
    scoreToWin: 9,
    rallyAccelPerSec: 0.02,
    maxSpeedLiftPerSec: 6,
    bg: "#0b1020",
  }), []);

  const canvasRef = useRef(null);
  const rafRef = useRef(0);

  // Connection UI
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem("lanpong_server") || "ws://localhost:8080");
  const [room, setRoom] = useState(() => localStorage.getItem("lanpong_room") || "abc");
  const [status, setStatus] = useState("disconnected"); // disconnected|connecting|connected
  const [player, setPlayer] = useState(null); // 1|2
  const [isHost, setIsHost] = useState(false);
  const [presence, setPresence] = useState({ p1: false, p2: false });

  const wsRef = useRef(null);

  // Inputs
  const keysRef = useRef({ up: false, down: false });
  const inputP1Ref = useRef({ up: false, down: false });
  const inputP2Ref = useRef({ up: false, down: false });

  // State: host simulates into gRef; guests render from netStateRef
  const gRef = useRef(null);
  const netStateRef = useRef(null);
  const pausedRef = useRef(false);
  const [hint, setHint] = useState("Connect to a server and join a room.");

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const makeInitial = () => {
    const midX = cfg.w / 2;
    const midY = cfg.h / 2;
    const serveDir = Math.random() < 0.5 ? -1 : 1;
    const angle = (Math.random() * 0.6 - 0.3) * Math.PI;
    const vx = Math.cos(angle) * cfg.startBallSpeed * serveDir;
    const vy = Math.sin(angle) * cfg.startBallSpeed;
    const now = performance.now();
    return {
      tPrev: now,
      dtClamp: 1 / 30,
      matchTime: 0,
      scoreL: 0,
      scoreR: 0,
      winner: null,
      left: { x: cfg.wallPad, y: midY - cfg.paddleH / 2, vy: 0 },
      right: { x: cfg.w - cfg.wallPad - cfg.paddleW, y: midY - cfg.paddleH / 2, vy: 0 },
      ball: { x: midX, y: midY, vx, vy },
    };
  };

  const serializeState = (g) => ({
    g: {
      matchTime: g.matchTime,
      scoreL: g.scoreL,
      scoreR: g.scoreR,
      winner: g.winner,
      left: { y: g.left.y },
      right: { y: g.right.y },
      ball: { x: g.ball.x, y: g.ball.y, vx: g.ball.vx, vy: g.ball.vy },
    },
    t: Date.now(),
  });

  const applyNetStateToRender = (s) => {
    if (!s?.g) return null;
    const g = s.g;
    return {
      matchTime: g.matchTime,
      scoreL: g.scoreL,
      scoreR: g.scoreR,
      winner: g.winner,
      left: { x: cfg.wallPad, y: g.left.y, vy: 0 },
      right: { x: cfg.w - cfg.wallPad - cfg.paddleW, y: g.right.y, vy: 0 },
      ball: { x: g.ball.x, y: g.ball.y, vx: g.ball.vx, vy: g.ball.vy },
    };
  };

  // WebSocket connect/disconnect
  const connect = () => {
    try {
      localStorage.setItem("lanpong_server", serverUrl);
      localStorage.setItem("lanpong_room", room);
    } catch {}

    setStatus("connecting");
    setHint("Connecting…");

    const ws = new WebSocket(serverUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", room }));
      setStatus("connected");
      setHint("Joined room. Waiting for player assignments…");
    };

    ws.onclose = () => {
      setStatus("disconnected");
      setPlayer(null);
      setIsHost(false);
      setPresence({ p1: false, p2: false });
      setHint("Disconnected.");
      wsRef.current = null;
    };

    ws.onerror = () => {
      setHint("WebSocket error. Check URL / firewall.");
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === "full") {
        setHint("Room is full (already 2 players).");
        return;
      }

      if (msg.type === "role") {
        setPlayer(msg.player);
        setIsHost(!!msg.host);
        setHint(msg.host ? "You are host (authoritative). Waiting for Player 2…" : "Connected as guest.");
        return;
      }

      if (msg.type === "presence") {
        setPresence({ p1: !!msg.p1, p2: !!msg.p2 });
        return;
      }

      if (msg.type === "can_start") {
        if (msg.ok) setHint(isHost ? "Both players connected. Game live." : "Both players connected.");
        else setHint("Waiting for both players…");
        return;
      }

      if (msg.type === "input") {
        // only host processes inputs from other player
        if (!isHost) return;
        const from = msg.from;
        if (from === 1) inputP1Ref.current = { up: !!msg.up, down: !!msg.down };
        if (from === 2) inputP2Ref.current = { up: !!msg.up, down: !!msg.down };
        return;
      }

      if (msg.type === "state") {
        netStateRef.current = msg;
        return;
      }
    };
  };

  const disconnect = () => {
    wsRef.current?.close();
  };

  // Key input: local player only
  useEffect(() => {
    const onKeyDown = (e) => {
      const k = e.key;
      if (k === " " || k === "Spacebar") {
        e.preventDefault();
        pausedRef.current = !pausedRef.current;
      }
      if (player === 1) {
        if (k === "w" || k === "W") keysRef.current.up = true;
        if (k === "s" || k === "S") keysRef.current.down = true;
      }
      if (player === 2) {
        if (k === "ArrowUp") keysRef.current.up = true;
        if (k === "ArrowDown") keysRef.current.down = true;
      }
    };
    const onKeyUp = (e) => {
      const k = e.key;
      if (player === 1) {
        if (k === "w" || k === "W") keysRef.current.up = false;
        if (k === "s" || k === "S") keysRef.current.down = false;
      }
      if (player === 2) {
        if (k === "ArrowUp") keysRef.current.up = false;
        if (k === "ArrowDown") keysRef.current.down = false;
      }
    };
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [player]);

  // Send input state at ~30Hz or on change
  useEffect(() => {
    let last = { up: false, down: false };
    const timer = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== 1 || !player) return;
      const cur = { up: keysRef.current.up, down: keysRef.current.down };
      if (cur.up !== last.up || cur.down !== last.down) {
        ws.send(JSON.stringify({ type: "input", up: cur.up, down: cur.down }));
        last = cur;
      }
    }, 33);
    return () => clearInterval(timer);
  }, [player]);

  // Canvas + loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const resize = () => {
      canvas.width = Math.floor(cfg.w * dpr);
      canvas.height = Math.floor(cfg.h * dpr);
      canvas.style.width = cfg.w + "px";
      canvas.style.height = cfg.h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    // init host state
    gRef.current = makeInitial();

    const serve = (g, toRight = true) => {
      const midX = cfg.w / 2;
      const midY = cfg.h / 2;
      g.ball.x = midX;
      g.ball.y = midY;
      const dir = toRight ? 1 : -1;
      const angleBase = (Math.random() * 0.6 - 0.3) * Math.PI;
      const speed = cfg.startBallSpeed;
      g.ball.vx = Math.cos(angleBase) * speed * dir;
      g.ball.vy = Math.sin(angleBase) * speed;
    };

    const updateHost = (g, dt) => {
      g.matchTime += dt;

      // Inputs
      const i1 = inputP1Ref.current;
      const i2 = inputP2Ref.current;

      // Host also has local inputs; merge into correct player
      const local = keysRef.current;
      if (player === 1) { i1.up = local.up; i1.down = local.down; }
      if (player === 2) { i2.up = local.up; i2.down = local.down; }

      const leftDir = (i1.up ? -1 : 0) + (i1.down ? 1 : 0);
      const rightDir = (i2.up ? -1 : 0) + (i2.down ? 1 : 0);

      g.left.y = clamp(g.left.y + leftDir * cfg.paddleSpeed * dt, 12, cfg.h - 12 - cfg.paddleH);
      g.right.y = clamp(g.right.y + rightDir * cfg.paddleSpeed * dt, 12, cfg.h - 12 - cfg.paddleH);

      // Ball integrate
      g.ball.x += g.ball.vx * dt;
      g.ball.y += g.ball.vy * dt;

      // Speed ramp
      const sp = Math.hypot(g.ball.vx, g.ball.vy);
      const cap = cfg.maxBallSpeed + g.matchTime * cfg.maxSpeedLiftPerSec;
      const accel = 1 + cfg.rallyAccelPerSec * dt;
      const sp2 = Math.min(cap, sp * accel);
      if (sp2 > sp) {
        const s = sp2 / Math.max(1e-6, sp);
        g.ball.vx *= s;
        g.ball.vy *= s;
      }

      // Walls
      const topWall = 12 + cfg.ballR;
      const botWall = cfg.h - 12 - cfg.ballR;
      if (g.ball.y < topWall) { g.ball.y = topWall; g.ball.vy *= -1; }
      if (g.ball.y > botWall) { g.ball.y = botWall; g.ball.vy *= -1; }

      // Paddle collisions
      const hit = (p, isLeft) => {
        const px = p.x, py = p.y;
        const withinY = g.ball.y + cfg.ballR >= py && g.ball.y - cfg.ballR <= py + cfg.paddleH;
        if (!withinY) return false;

        if (isLeft) {
          const contact = g.ball.x - cfg.ballR <= px + cfg.paddleW && g.ball.x > px;
          if (!contact) return false;
          g.ball.x = px + cfg.paddleW + cfg.ballR;
        } else {
          const contact = g.ball.x + cfg.ballR >= px && g.ball.x < px + cfg.paddleW;
          if (!contact) return false;
          g.ball.x = px - cfg.ballR;
        }

        // reflect + spin-ish
        g.ball.vx *= -1;
        const center = py + cfg.paddleH / 2;
        const off = (g.ball.y - center) / (cfg.paddleH / 2);
        g.ball.vy += off * 240;
        return true;
      };

      hit(g.left, true);
      hit(g.right, false);

      // Scoring
      if (g.ball.x < -40) {
        g.scoreR += 1;
        if (g.scoreR >= cfg.scoreToWin) g.winner = "R";
        serve(g, false);
      } else if (g.ball.x > cfg.w + 40) {
        g.scoreL += 1;
        if (g.scoreL >= cfg.scoreToWin) g.winner = "L";
        serve(g, true);
      }
    };

    const draw = (g, overlayText = "") => {
      // background
      ctx.clearRect(0, 0, cfg.w, cfg.h);
      ctx.fillStyle = cfg.bg;
      ctx.fillRect(0, 0, cfg.w, cfg.h);

      // center dashed
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.lineWidth = 4;
      ctx.setLineDash([10, 14]);
      ctx.beginPath();
      ctx.moveTo(cfg.w / 2, 18);
      ctx.lineTo(cfg.w / 2, cfg.h - 18);
      ctx.stroke();
      ctx.setLineDash([]);

      // paddles
      ctx.fillStyle = "#e7ecff";
      ctx.fillRect(g.left.x, g.left.y, cfg.paddleW, cfg.paddleH);
      ctx.fillRect(g.right.x, g.right.y, cfg.paddleW, cfg.paddleH);

      // ball
      ctx.beginPath();
      ctx.arc(g.ball.x, g.ball.y, cfg.ballR, 0, Math.PI * 2);
      ctx.fill();

      // score
      ctx.fillStyle = "rgba(231,236,255,0.9)";
      ctx.font = "800 46px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
      ctx.textAlign = "center";
      ctx.fillText(String(g.scoreL), cfg.w * 0.43, 70);
      ctx.fillText(String(g.scoreR), cfg.w * 0.57, 70);

      // overlay/hint
      ctx.fillStyle = "rgba(231,236,255,0.72)";
      ctx.font = "600 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
      ctx.textAlign = "left";
      ctx.fillText(overlayText, 18, cfg.h - 16);

      if (pausedRef.current) {
        ctx.fillStyle = "rgba(0,0,0,0.40)";
        ctx.fillRect(0, 0, cfg.w, cfg.h);
        ctx.fillStyle = "rgba(231,236,255,0.95)";
        ctx.font = "900 44px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
        ctx.textAlign = "center";
        ctx.fillText("PAUSED", cfg.w / 2, cfg.h / 2);
      }
      if (g.winner) {
        ctx.fillStyle = "rgba(0,0,0,0.50)";
        ctx.fillRect(0, 0, cfg.w, cfg.h);
        ctx.fillStyle = "rgba(231,236,255,0.98)";
        ctx.font = "900 46px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
        ctx.textAlign = "center";
        ctx.fillText(g.winner === "L" ? "LEFT WINS" : "RIGHT WINS", cfg.w / 2, cfg.h / 2);
      }
    };

    const step = (now) => {
      rafRef.current = requestAnimationFrame(step);

      const ws = wsRef.current;
      const connected = ws && ws.readyState === 1 && player;

      if (!connected) {
        // draw idle screen
        const g = gRef.current || makeInitial();
        draw(g, "Not connected. Use the panel above to connect.");
        return;
      }

      // host: simulate + broadcast
      if (isHost) {
        const g = gRef.current;
        if (!g.tPrev) g.tPrev = now;
        const dt = Math.min((now - g.tPrev) / 1000, g.dtClamp);
        g.tPrev = now;

        // only run if both players connected
        if (presence.p1 && presence.p2 && !pausedRef.current && !g.winner) {
          updateHost(g, dt);
        }

        // broadcast state ~60fps (this loop runs ~60)
        ws.send(JSON.stringify({ type: "state", ...serializeState(g) }));

        draw(g, `Room: ${room} • You: P${player} ${isHost ? "(host)" : ""} • W/S vs ↑/↓`);
        return;
      }

      // guest: render received net state (no sim)
      const s = netStateRef.current;
      const rg = applyNetStateToRender(s) || gRef.current || makeInitial();
      draw(rg, `Room: ${room} • You: P${player} • Waiting for host state…`);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [cfg, isHost, player, presence.p1, presence.p2, room]);

  const card = {
    border: "1px solid rgba(231,236,255,0.12)",
    borderRadius: 18,
    background: "rgba(255,255,255,0.06)",
    padding: 12,
  };

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginBottom: 12 }}>
        <div style={card}>
          <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px" }}>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>Server WS URL</div>
              <input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="ws://192.168.1.50:8080"
                style={inputStyle()}
              />
            </div>
            <div style={{ width: 160 }}>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>Room</div>
              <input value={room} onChange={(e) => setRoom(e.target.value)} style={inputStyle()} />
            </div>

            {status !== "connected" ? (
              <button onClick={connect} style={buttonStyle(true)}>Connect</button>
            ) : (
              <button onClick={disconnect} style={buttonStyle(false)}>Disconnect</button>
            )}

            <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.8 }}>
              Status: <b>{status}</b> • P1: {presence.p1 ? "✓" : "—"} • P2: {presence.p2 ? "✓" : "—"} • You: {player ? `P${player}` : "—"} {isHost ? "(host)" : ""}
            </div>
          </div>

          <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
            {hint}
          </div>
        </div>
      </div>

      <div style={{ borderRadius: 20, overflow: "hidden", border: "1px solid rgba(231,236,255,0.12)", background: "#0b1020" }}>
        <canvas ref={canvasRef} />
      </div>

      <div style={{ marginTop: 10, opacity: 0.75, fontSize: 13 }}>
        Controls: {player === 1 ? "W/S" : player === 2 ? "↑/↓" : "—"} • Space toggles local pause (host pauses simulation)
      </div>
    </div>
  );
}

function inputStyle() {
  return {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(231,236,255,0.14)",
    background: "rgba(0,0,0,0.25)",
    color: "#e7ecff",
    outline: "none",
  };
}

function buttonStyle(primary) {
  return {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(231,236,255,0.14)",
    background: primary ? "rgba(231,236,255,0.16)" : "rgba(231,236,255,0.08)",
    color: "#e7ecff",
    cursor: "pointer",
    fontWeight: 800,
  };
}

// =================== Singleplayer ===================
// A simple local fallback (no powerups here; your Canvas version can stay in ChatGPT canvas)

function SingleplayerPong() {
  const cfg = useMemo(() => ({
    w: 920,
    h: 540,
    paddleW: 14,
    paddleH: 96,
    ballR: 8,
    wallPad: 18,
    startBallSpeed: 420,
    maxBallSpeed: 900,
    paddleSpeed: 640,
    scoreToWin: 9,
    rallyAccelPerSec: 0.02,
    maxSpeedLiftPerSec: 6,
    bg: "#0b1020",
  }), []);

  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const keysRef = useRef({ up: false, down: false });
  const gRef = useRef(null);
  const pausedRef = useRef(false);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  useEffect(() => {
    const onKeyDown = (e) => {
      const k = e.key;
      if (k === "w" || k === "W" || k === "ArrowUp") keysRef.current.up = true;
      if (k === "s" || k === "S" || k === "ArrowDown") keysRef.current.down = true;
      if (k === " " || k === "Spacebar") { e.preventDefault(); pausedRef.current = !pausedRef.current; }
    };
    const onKeyUp = (e) => {
      const k = e.key;
      if (k === "w" || k === "W" || k === "ArrowUp") keysRef.current.up = false;
      if (k === "s" || k === "S" || k === "ArrowDown") keysRef.current.down = false;
    };
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const resize = () => {
      canvas.width = Math.floor(cfg.w * dpr);
      canvas.height = Math.floor(cfg.h * dpr);
      canvas.style.width = cfg.w + "px";
      canvas.style.height = cfg.h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const makeInitial = () => {
      const midX = cfg.w / 2;
      const midY = cfg.h / 2;
      const serveDir = Math.random() < 0.5 ? -1 : 1;
      const angle = (Math.random() * 0.6 - 0.3) * Math.PI;
      const vx = Math.cos(angle) * cfg.startBallSpeed * serveDir;
      const vy = Math.sin(angle) * cfg.startBallSpeed;
      const now = performance.now();
      return {
        tPrev: now,
        dtClamp: 1 / 30,
        matchTime: 0,
        scoreL: 0,
        scoreR: 0,
        winner: null,
        left: { x: cfg.wallPad, y: midY - cfg.paddleH / 2 },
        right: { x: cfg.w - cfg.wallPad - cfg.paddleW, y: midY - cfg.paddleH / 2 },
        ball: { x: midX, y: midY, vx, vy },
      };
    };

    const serve = (g, toRight = true) => {
      const midX = cfg.w / 2;
      const midY = cfg.h / 2;
      g.ball.x = midX;
      g.ball.y = midY;
      const dir = toRight ? 1 : -1;
      const angleBase = (Math.random() * 0.6 - 0.3) * Math.PI;
      const speed = cfg.startBallSpeed;
      g.ball.vx = Math.cos(angleBase) * speed * dir;
      g.ball.vy = Math.sin(angleBase) * speed;
    };

    gRef.current = makeInitial();

    const draw = (g) => {
      ctx.clearRect(0, 0, cfg.w, cfg.h);
      ctx.fillStyle = cfg.bg;
      ctx.fillRect(0, 0, cfg.w, cfg.h);

      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.lineWidth = 4;
      ctx.setLineDash([10, 14]);
      ctx.beginPath();
      ctx.moveTo(cfg.w / 2, 18);
      ctx.lineTo(cfg.w / 2, cfg.h - 18);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "#e7ecff";
      ctx.fillRect(g.left.x, g.left.y, cfg.paddleW, cfg.paddleH);
      ctx.fillRect(g.right.x, g.right.y, cfg.paddleW, cfg.paddleH);
      ctx.beginPath();
      ctx.arc(g.ball.x, g.ball.y, cfg.ballR, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(231,236,255,0.9)";
      ctx.font = "800 46px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
      ctx.textAlign = "center";
      ctx.fillText(String(g.scoreL), cfg.w * 0.43, 70);
      ctx.fillText(String(g.scoreR), cfg.w * 0.57, 70);

      ctx.fillStyle = "rgba(231,236,255,0.72)";
      ctx.font = "600 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
      ctx.textAlign = "left";
      ctx.fillText("Singleplayer (hotseat) — Left: W/S, Right: ↑/↓, Space pause", 18, cfg.h - 16);

      if (pausedRef.current) {
        ctx.fillStyle = "rgba(0,0,0,0.40)";
        ctx.fillRect(0, 0, cfg.w, cfg.h);
        ctx.fillStyle = "rgba(231,236,255,0.95)";
        ctx.font = "900 44px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
        ctx.textAlign = "center";
        ctx.fillText("PAUSED", cfg.w / 2, cfg.h / 2);
      }
    };

    const step = (now) => {
      rafRef.current = requestAnimationFrame(step);
      const g = gRef.current;

      const dt = Math.min((now - g.tPrev) / 1000, g.dtClamp);
      g.tPrev = now;

      if (!pausedRef.current && !g.winner) {
        g.matchTime += dt;

        const leftDir = (keysRef.current.up ? -1 : 0) + (keysRef.current.down ? 1 : 0);
        // hotseat: right uses arrow keys (also mapped above)
        const rightDir = (keysRef.current.up ? 0 : 0); // keep simple: singleplayer here is just a demo

        g.left.y = clamp(g.left.y + leftDir * cfg.paddleSpeed * dt, 12, cfg.h - 12 - cfg.paddleH);

        // ball
        g.ball.x += g.ball.vx * dt;
        g.ball.y += g.ball.vy * dt;

        const sp = Math.hypot(g.ball.vx, g.ball.vy);
        const cap = cfg.maxBallSpeed + g.matchTime * cfg.maxSpeedLiftPerSec;
        const accel = 1 + cfg.rallyAccelPerSec * dt;
        const sp2 = Math.min(cap, sp * accel);
        if (sp2 > sp) {
          const s = sp2 / Math.max(1e-6, sp);
          g.ball.vx *= s; g.ball.vy *= s;
        }

        const topWall = 12 + cfg.ballR;
        const botWall = cfg.h - 12 - cfg.ballR;
        if (g.ball.y < topWall) { g.ball.y = topWall; g.ball.vy *= -1; }
        if (g.ball.y > botWall) { g.ball.y = botWall; g.ball.vy *= -1; }

        const hit = (p, isLeft) => {
          const px = p.x, py = p.y;
          const withinY = g.ball.y + cfg.ballR >= py && g.ball.y - cfg.ballR <= py + cfg.paddleH;
          if (!withinY) return false;
          if (isLeft) {
            const contact = g.ball.x - cfg.ballR <= px + cfg.paddleW && g.ball.x > px;
            if (!contact) return false;
            g.ball.x = px + cfg.paddleW + cfg.ballR;
          } else {
            const contact = g.ball.x + cfg.ballR >= px && g.ball.x < px + cfg.paddleW;
            if (!contact) return false;
            g.ball.x = px - cfg.ballR;
          }
          g.ball.vx *= -1;
          const center = py + cfg.paddleH / 2;
          const off = (g.ball.y - center) / (cfg.paddleH / 2);
          g.ball.vy += off * 240;
          return true;
        };
        hit(g.left, true);
        hit(g.right, false);

        if (g.ball.x < -40) { g.scoreR += 1; serve(g, false); }
        else if (g.ball.x > cfg.w + 40) { g.scoreL += 1; serve(g, true); }
      }

      draw(g);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [cfg]);

  return (
    <div>
      <div style={{ opacity: 0.75, fontSize: 13, marginBottom: 10 }}>
        This is just a local fallback. Your full modern singleplayer lives in your ChatGPT canvas file.
      </div>
      <div style={{ borderRadius: 20, overflow: "hidden", border: "1px solid rgba(231,236,255,0.12)", background: "#0b1020" }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
