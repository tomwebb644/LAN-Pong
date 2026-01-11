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
  const [tab, setTab] = useState("single"); // "multiplayer" | "single"
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

function SingleplayerPong() {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);

  // ======= Config =======
  const cfg = useMemo(
    () => ({
      w: 920,
      h: 540,
      paddleW: 14,
      paddleH: 96,
      ballR: 8,
      wallPad: 18,

      // Speeds are px/s
      startBallSpeed: 420,
      maxBallSpeed: 900,
      paddleSpeed: 640,
      cpuReact: 0.12,
      spin: 280,

      // Match
      scoreToWin: 9,

      // Speed ramp ("longer the game goes on")
      rallyAccelPerSec: 0.02,
      maxSpeedLiftPerSec: 6,

      // Powerups
      powerupChargeMax: 3,

      // Visual
      bg: "#0b1020",
    }),
    []
  );

  // ======= UI state (React) =======
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);

  const [hint, setHint] = useState(
    "W/S or ↑/↓ • Space pause • R reset • Complete challenges to unlock powerups"
  );
  const hintRef = useRef(
    "W/S or ↑/↓ • Space pause • R reset • Complete challenges to unlock powerups"
  );
  const setHintSafe = (txt) => {
    hintRef.current = txt;
    setHint(txt);
  };

  // ======= Mutable refs =======
  const keysRef = useRef({ up: false, down: false });
  const gRef = useRef(null);

  // ======= Helpers =======
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const makeInitial = () => {
    const midX = cfg.w / 2;
    const midY = cfg.h / 2;

    const serveDir = Math.random() < 0.5 ? -1 : 1;
    const angle = (Math.random() * 0.6 - 0.3) * Math.PI;
    const vx = Math.cos(angle) * cfg.startBallSpeed * serveDir;
    const vy = Math.sin(angle) * cfg.startBallSpeed;

    const now = performance.now();

    const powerups = {
      dash: {
        key: "1",
        name: "Dash",
        desc: "Instantly jump your paddle",
        unlocked: false,
        charges: 0,
        cooldownUntil: 0,
      },
      gravityWell: {
        key: "2",
        name: "Gravity Well",
        desc: "Drop a mid-court curve field",
        unlocked: false,
        charges: 0,
        cooldownUntil: 0,
      },
      decoyBall: {
        key: "3",
        name: "Decoy Ball",
        desc: "Spawn a fake ball that fools CPU",
        unlocked: false,
        charges: 0,
        cooldownUntil: 0,
      },
      parry: {
        key: "4",
        name: "Parry",
        desc: "Timed window: next hit boosts",
        unlocked: false,
        charges: 0,
        cooldownUntil: 0,
      },
    };

    return {
      tPrev: now,
      dtClamp: 1 / 30,

      // Match
      winner: null,
      scoreL: 0,
      scoreR: 0,
      matchTime: 0,

      // Paddle
      left: { x: cfg.wallPad, y: midY - cfg.paddleH / 2, vy: 0 },
      right: { x: cfg.w - cfg.wallPad - cfg.paddleW, y: midY - cfg.paddleH / 2, vy: 0 },
      leftScale: 1,

      // Ball
      ball: { x: midX, y: midY, vx, vy },

      // Rally stats
      rallyHits: 0,
      consecutiveReturns: 0,
      usedPowerupSinceLastPoint: false,
      secondsSurvivedSincePoint: 0,
      lastHitOffset: 0,

      // CPU (human)
      cpuAimY: midY,
      cpuNextAimAt: now,
      cpuAimErr: 0,
      cpuBias: 0,
      lastPlayerBias: 0,
      cpuVel: 0,

      // Challenges
      challenge: null,
      challengeDone: false,
      challengeStartedAt: now,
      actionPulseAt: 0,
      gate: null,
      lastWallBounceAt: 0,

      // Powerups
      powerups,
      gravity: null, // {x,y,until,strength}
      ghostBall: null, // {x,y,vx,vy,until}
      parryWindowUntil: 0,

      // VFX
      particles: [],
      trail: [],
    };
  };

  const reset = (hard = false) => {
    gRef.current = makeInitial();
    if (hard) {
      pausedRef.current = false;
      setPaused(false);
      setHintSafe(
        "W/S or ↑/↓ • Space pause • R reset • Complete challenges to unlock powerups"
      );
    }
  };

  // ======= Challenges =======
  // These are *interactive* and not just "win points".
  const challengePool = useMemo(
    () => [
      {
        id: "actionTiming",
        title: "Reflex Test",
        text: "Press E when the ball is near your paddle (a prompt appears)",
        init: (g) => {
          g.actionPulseAt = 0;
        },
        tick: (g) => {
          // show prompt when ball is inbound and close-ish
          const inbound = g.ball.vx < -80;
          const near = g.ball.x < cfg.w * 0.28;
          const prompt = inbound && near;
          if (prompt && g.actionPulseAt === 0) {
            g.actionPulseAt = performance.now();
          }
          // if ball moves away, reset prompt
          if (!prompt) g.actionPulseAt = 0;
        },
        onAction: (g) => {
          // succeed if the prompt is active and ball is truly near
          const ok =
            g.actionPulseAt > 0 &&
            g.ball.vx < -80 &&
            g.ball.x < cfg.w * 0.24 &&
            Math.abs(g.ball.y - (g.left.y + (cfg.paddleH * g.leftScale) / 2)) < 110;
          return ok;
        },
      },
      {
        id: "movingGate",
        title: "Gate Shot",
        text: "Send the ball through the moving gate at mid-court",
        init: (g) => {
          g.gate = {
            x: cfg.w / 2,
            y: 110 + Math.random() * (cfg.h - 220),
            h: 92,
            vy: (Math.random() < 0.5 ? -1 : 1) * (120 + Math.random() * 60),
          };
        },
        tick: (g, dt) => {
          if (!g.gate) return;
          g.gate.y += g.gate.vy * dt;
          if (g.gate.y < 80) {
            g.gate.y = 80;
            g.gate.vy *= -1;
          }
          if (g.gate.y > cfg.h - 80 - g.gate.h) {
            g.gate.y = cfg.h - 80 - g.gate.h;
            g.gate.vy *= -1;
          }
        },
        onBallCrossMid: (g) => {
          if (!g.gate) return false;
          return g.ball.y > g.gate.y && g.ball.y < g.gate.y + g.gate.h;
        },
      },
      {
        id: "wallTrick",
        title: "Wall Trick",
        text: "Make the ball bounce off a wall before the CPU returns it",
        init: (g) => {
          g.lastWallBounceAt = 0;
        },
        onWallBounce: (g) => {
          // record bounce time
          g.lastWallBounceAt = performance.now();
        },
        onCpuHit: (g) => {
          // complete if we bounced recently
          const now = performance.now();
          return g.lastWallBounceAt > 0 && now - g.lastWallBounceAt < 1600;
        },
      },
      {
        id: "stillHands",
        title: "Still Hands",
        text: "For 2s, don't press movement keys while rally continues",
        init: (g) => {
          g.stillTime = 0;
        },
        tick: (g, dt, keys) => {
          const moving = keys.up || keys.down;
          const rallyOn = Math.abs(g.ball.vx) > 1;
          if (rallyOn && !moving) g.stillTime += dt;
          if (moving) g.stillTime = 0;
        },
        check: (g) => g.stillTime >= 2,
      },
    ],
    [cfg.h, cfg.w]
  );

  const pickNextChallenge = (g) => {
    const prevId = g.challenge?.id;
    const options = challengePool.filter((c) => c.id !== prevId);
    const next = options[Math.floor(Math.random() * options.length)];
    g.challenge = next;
    g.challengeDone = false;
    g.challengeStartedAt = performance.now();
    next?.init?.(g);
    setHintSafe(`Challenge: ${next.title} — ${next.text}`);
  };

  const spawnPop = (g, x, y, n = 10) => {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 220;
      g.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.6 + Math.random() * 0.4,
      });
    }
  };

  const awardChallengeReward = (g) => {
    const order = ["dash", "gravityWell", "decoyBall", "parry"];
    const locked = order.find((k) => !g.powerups[k].unlocked);
    if (locked) {
      g.powerups[locked].unlocked = true;
      g.powerups[locked].charges = 1;
      setHintSafe(`Unlocked: ${g.powerups[locked].name} (press ${g.powerups[locked].key})`);
      return;
    }

    // all unlocked -> add a charge to a random powerup that isn't full
    const candidates = order.filter((k) => g.powerups[k].charges < cfg.powerupChargeMax);
    if (candidates.length) {
      const k = candidates[Math.floor(Math.random() * candidates.length)];
      g.powerups[k].charges += 1;
      setHintSafe(`Challenge complete! +1 ${g.powerups[k].name} charge (x${g.powerups[k].charges}).`);
    } else {
      setHintSafe("Challenge complete! All charges full.");
    }
  };

  // ======= Powerups =======
  const tryActivatePowerup = (g, key) => {
    const now = performance.now();
    const entries = Object.entries(g.powerups);
    const found = entries.find(([, p]) => p.key === key);
    if (!found) return;
    const [id, p] = found;

    if (!p.unlocked) {
      setHintSafe(`Locked: ${p.name} — complete challenges to unlock.`);
      return;
    }
    if (p.charges <= 0) {
      setHintSafe(`No charges: ${p.name} — complete challenges to earn charges.`);
      return;
    }
    if (now < p.cooldownUntil) {
      setHintSafe(`${p.name} cooling down…`);
      return;
    }

    p.charges -= 1;
    g.usedPowerupSinceLastPoint = true;

    if (id === "dash") {
      // Dash direction: follow player input; if none, dash toward ball.
      const leftH = cfg.paddleH * g.leftScale;
      const center = g.left.y + leftH / 2;
      const towardBall = Math.sign(g.ball.y - center);
      const dir = keysRef.current.up
        ? -1
        : keysRef.current.down
        ? 1
        : towardBall || 1;
      const dist = 130;
      g.left.y = clamp(g.left.y + dir * dist, 12, cfg.h - 12 - leftH);
      p.cooldownUntil = now + 1800;
      spawnPop(g, g.left.x + cfg.paddleW + 18, g.left.y + leftH / 2, 14);
      setHintSafe("Dash! (instant reposition)");
    }

    if (id === "gravityWell") {
      g.gravity = {
        x: cfg.w / 2,
        y: clamp(g.ball.y, 80, cfg.h - 80),
        until: now + 5200,
        strength: 520,
      };
      p.cooldownUntil = now + 6500;
      spawnPop(g, cfg.w / 2, g.gravity.y, 18);
      setHintSafe("Gravity Well deployed.");
    }

    if (id === "decoyBall") {
      // Create a ghost ball that the CPU sometimes tracks.
      g.ghostBall = {
        x: g.ball.x,
        y: g.ball.y,
        vx: g.ball.vx,
        vy: g.ball.vy * (Math.random() < 0.5 ? 0.7 : 1.3),
        until: now + 4200,
      };
      p.cooldownUntil = now + 7000;
      spawnPop(g, g.ball.x, g.ball.y, 16);
      setHintSafe("Decoy Ball active (CPU may bite).");
    }

    if (id === "parry") {
      // Parry is skill-based: you must activate it near impact.
      // You get a short window where the next paddle hit gets a strong boost.
      g.parryWindowUntil = now + 950;
      p.cooldownUntil = now + 4200;
      setHintSafe("Parry window opened! Try to hit within ~1s.");
    }
  };

  // ======= Input =======
  useEffect(() => {
    const onKeyDown = (e) => {
      const k = e.key;
      if (k === "w" || k === "W" || k === "ArrowUp") keysRef.current.up = true;
      if (k === "s" || k === "S" || k === "ArrowDown") keysRef.current.down = true;

      if (k === " " || k === "Spacebar") {
        e.preventDefault();
        setPaused((p) => {
          const next = !p;
          pausedRef.current = next;
          return next;
        });
      }

      if (k === "r" || k === "R") {
        reset(true);
      }

      if (k === "e" || k === "E") {
        const g = gRef.current;
        if (!g || pausedRef.current || g.winner) return;
        // Challenge action
        const ok = g.challenge?.onAction?.(g);
        if (ok) {
          g.challengeDone = true;
          spawnPop(g, cfg.w / 2, 120, 22);
          awardChallengeReward(g);
          setTimeout(() => {
            const gg = gRef.current;
            if (gg && !gg.winner) pickNextChallenge(gg);
          }, 650);
        } else {
          // tiny feedback
          spawnPop(g, g.left.x + cfg.paddleW + 20, g.left.y + cfg.paddleH / 2, 6);
        }
      }

      if (k === "1" || k === "2" || k === "3" || k === "4") {
        const g = gRef.current;
        if (g && !pausedRef.current && !g.winner) tryActivatePowerup(g, k);
      }
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
  }, [cfg.h, cfg.w]);

  // ======= Main loop =======
  useEffect(() => {
    reset(true);
    pausedRef.current = false;

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

    const serve = (toRight = true) => {
      const g = gRef.current;
      const midX = cfg.w / 2;
      const midY = cfg.h / 2;
      g.ball.x = midX;
      g.ball.y = midY;

      const dir = toRight ? 1 : -1;

      // Human-ish serving: when CPU serves to player, sometimes easier serve.
      const isCpuServeToPlayer = !toRight;
      const sloppy = isCpuServeToPlayer && Math.random() < 0.35;

      const angleBase = sloppy
        ? (Math.random() * 0.32 - 0.16) * Math.PI
        : (Math.random() * 0.6 - 0.3) * Math.PI;

      const speed = sloppy ? cfg.startBallSpeed * 0.88 : cfg.startBallSpeed;
      g.ball.vx = Math.cos(angleBase) * speed * dir;
      g.ball.vy = Math.sin(angleBase) * speed;

      g.consecutiveReturns = 0;
      g.usedPowerupSinceLastPoint = false;
      g.lastHitOffset = 0;
      g.rallyHits = 0;
      g.lastPlayerBias = 0;

      // Clear transient power effects
      g.gravity = null;
      g.ghostBall = null;
      g.parryWindowUntil = 0;
    };

    const roundRect = (x, y, w, h, r) => {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    };

    const drawHUD = (g) => {
      const now = performance.now();

      // score
      ctx.fillStyle = "rgba(231,236,255,0.9)";
      ctx.font = "800 46px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
      ctx.textAlign = "center";
      ctx.fillText(String(g.scoreL), cfg.w * 0.43, 70);
      ctx.fillText(String(g.scoreR), cfg.w * 0.57, 70);

      // hint
      ctx.fillStyle = "rgba(231,236,255,0.72)";
      ctx.font = "500 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
      ctx.textAlign = "left";
      ctx.fillText(hintRef.current, 18, cfg.h - 16);

      // powerup bar
      const order = ["dash", "gravityWell", "decoyBall", "parry"];
      let x = 18;
      const y = 18;
      for (const id of order) {
        const p = g.powerups[id];
        const w = 210;
        const h = 30;
        const locked = !p.unlocked;
        const cooling = now < p.cooldownUntil;
        const charges = p.charges;

        ctx.fillStyle = locked ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.10)";
        ctx.strokeStyle = locked ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.16)";
        ctx.lineWidth = 1;
        roundRect(x, y, w, h, 12);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = locked ? "rgba(231,236,255,0.35)" : "rgba(231,236,255,0.92)";
        ctx.font = "700 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
        ctx.textAlign = "left";
        ctx.fillText(`${p.key}  ${p.name}`, x + 10, y + 19);

        ctx.textAlign = "right";
        ctx.font = "600 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
        if (locked) {
          ctx.fillStyle = "rgba(231,236,255,0.35)";
          ctx.fillText("LOCKED", x + w - 10, y + 19);
        } else if (cooling) {
          ctx.fillStyle = "rgba(231,236,255,0.7)";
          const secs = Math.max(0, (p.cooldownUntil - now) / 1000);
          ctx.fillText(`${secs.toFixed(1)}s`, x + w - 10, y + 19);
        } else {
          ctx.fillStyle = charges > 0 ? "rgba(231,236,255,0.9)" : "rgba(231,236,255,0.55)";
          ctx.fillText(`x${charges}`, x + w - 10, y + 19);
        }

        x += w + 10;
      }

      // E prompt
      if (g.challenge?.id === "actionTiming" && g.actionPulseAt > 0) {
        ctx.fillStyle = "rgba(231,236,255,0.9)";
        ctx.font = "900 18px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
        ctx.textAlign = "center";
        ctx.fillText("PRESS E", cfg.w * 0.22, cfg.h * 0.18);
      }
    };

    const draw = () => {
      const g = gRef.current;
      const now = performance.now();

      // bg
      ctx.clearRect(0, 0, cfg.w, cfg.h);
      ctx.fillStyle = cfg.bg;
      ctx.fillRect(0, 0, cfg.w, cfg.h);

      // vignette
      const grad = ctx.createRadialGradient(cfg.w / 2, cfg.h / 2, 40, cfg.w / 2, cfg.h / 2, 520);
      grad.addColorStop(0, "rgba(255,255,255,0.06)");
      grad.addColorStop(1, "rgba(0,0,0,0.40)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cfg.w, cfg.h);

      // center dashed line
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.lineWidth = 4;
      ctx.setLineDash([10, 14]);
      ctx.beginPath();
      ctx.moveTo(cfg.w / 2, 18);
      ctx.lineTo(cfg.w / 2, cfg.h - 18);
      ctx.stroke();
      ctx.setLineDash([]);

      // moving gate
      if (g.gate && g.challenge?.id === "movingGate") {
        ctx.strokeStyle = "rgba(231,236,255,0.35)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(g.gate.x, g.gate.y);
        ctx.lineTo(g.gate.x, g.gate.y + g.gate.h);
        ctx.stroke();
        ctx.fillStyle = "rgba(231,236,255,0.12)";
        ctx.fillRect(g.gate.x - 6, g.gate.y, 12, g.gate.h);
      }

      // gravity well
      if (g.gravity && now < g.gravity.until) {
        ctx.strokeStyle = "rgba(231,236,255,0.35)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(g.gravity.x, g.gravity.y, 42, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(231,236,255,0.18)";
        ctx.beginPath();
        ctx.arc(g.gravity.x, g.gravity.y, 72, 0, Math.PI * 2);
        ctx.stroke();
      }

      // trail
      ctx.fillStyle = "rgba(231,236,255,0.12)";
      for (const t of g.trail) {
        ctx.beginPath();
        ctx.arc(t.x, t.y, cfg.ballR * t.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // paddles
      ctx.fillStyle = "#e7ecff";
      const leftH = cfg.paddleH * g.leftScale;
      ctx.fillRect(g.left.x, g.left.y, cfg.paddleW, leftH);
      ctx.fillRect(g.right.x, g.right.y, cfg.paddleW, cfg.paddleH);

      // parry indicator
      if (now < g.parryWindowUntil) {
        ctx.strokeStyle = "rgba(231,236,255,0.45)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(g.left.x + cfg.paddleW / 2, g.left.y + leftH / 2, 36, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ghost ball (visual only)
      if (g.ghostBall && now < g.ghostBall.until) {
        ctx.fillStyle = "rgba(231,236,255,0.22)";
        ctx.beginPath();
        ctx.arc(g.ghostBall.x, g.ghostBall.y, cfg.ballR, 0, Math.PI * 2);
        ctx.fill();
      }

      // real ball
      ctx.fillStyle = "#e7ecff";
      ctx.beginPath();
      ctx.arc(g.ball.x, g.ball.y, cfg.ballR, 0, Math.PI * 2);
      ctx.fill();

      // particles
      ctx.fillStyle = "rgba(231,236,255,0.75)";
      for (const p of g.particles) {
        ctx.globalAlpha = clamp(p.life, 0, 1);
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;

      drawHUD(g);

      if (pausedRef.current) {
        ctx.fillStyle = "rgba(0,0,0,0.40)";
        ctx.fillRect(0, 0, cfg.w, cfg.h);
        ctx.fillStyle = "rgba(231,236,255,0.95)";
        ctx.font = "900 44px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
        ctx.textAlign = "center";
        ctx.fillText("PAUSED", cfg.w / 2, cfg.h / 2);
        ctx.font = "500 16px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
        ctx.fillStyle = "rgba(231,236,255,0.78)";
        ctx.fillText("Press Space to resume", cfg.w / 2, cfg.h / 2 + 34);
      }

      if (g.winner) {
        ctx.fillStyle = "rgba(0,0,0,0.50)";
        ctx.fillRect(0, 0, cfg.w, cfg.h);
        ctx.fillStyle = "rgba(231,236,255,0.98)";
        ctx.font = "900 46px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
        ctx.textAlign = "center";
        ctx.fillText(g.winner === "L" ? "YOU WIN" : "CPU WINS", cfg.w / 2, cfg.h / 2);
        ctx.font = "500 16px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
        ctx.fillStyle = "rgba(231,236,255,0.78)";
        ctx.fillText("Press R to play again", cfg.w / 2, cfg.h / 2 + 34);
      }
    };

    const step = (now) => {
      const g = gRef.current;
      rafRef.current = requestAnimationFrame(step);

      const dtRaw = (now - g.tPrev) / 1000;
      g.tPrev = now;
      const dt = Math.min(dtRaw, g.dtClamp);

      if (pausedRef.current || g.winner) {
        draw();
        return;
      }

      // init challenge
      if (!g.challenge) pickNextChallenge(g);

      // match time
      g.matchTime += dt;

      // challenge tick
      const keys = keysRef.current;
      g.challenge?.tick?.(g, dt, keys);

      // particles
      g.particles = g.particles
        .map((p) => ({
          ...p,
          x: p.x + p.vx * dt,
          y: p.y + p.vy * dt,
          vy: p.vy + 420 * dt,
          life: p.life - dt,
        }))
        .filter((p) => p.life > 0);

      // trail
      g.trail.push({ x: g.ball.x, y: g.ball.y, r: 1 });
      if (g.trail.length > 18) g.trail.shift();
      for (const t of g.trail) t.r *= 0.96;

      // Player paddle
      let dir = 0;
      if (keys.up) dir -= 1;
      if (keys.down) dir += 1;
      g.left.vy = dir * cfg.paddleSpeed;
      const leftH = cfg.paddleH * g.leftScale;
      g.left.y = clamp(g.left.y + g.left.vy * dt, 12, cfg.h - 12 - leftH);

      // CPU paddle (human-ish)
      // CPU may sometimes track ghost ball if active.
      const ballForCpu =
        g.ghostBall && now < g.ghostBall.until && Math.random() < 0.55 ? g.ghostBall : g.ball;

      const top = 12 + cfg.ballR;
      const bot = cfg.h - 12 - cfg.ballR;
      const span = bot - top;
      const fatigue = clamp(g.rallyHits / 18, 0, 1);
      const ballSpeed = Math.hypot(ballForCpu.vx, ballForCpu.vy);
      const reaimEvery = clamp((0.26 - (ballSpeed - 400) / 3200) * (1 + fatigue * 0.25), 0.1, 0.3);

      let aimY = cfg.h / 2;
      let bounces = 0;

      if (ballForCpu.vx > 40) {
        const timeToReach = (g.right.x - ballForCpu.x) / ballForCpu.vx;
        if (timeToReach > 0) {
          const closeness = clamp((ballForCpu.x - cfg.w / 2) / (cfg.w / 2), 0, 1);
          const vyFactor = 0.7 + 0.3 * closeness;
          const raw = ballForCpu.y + ballForCpu.vy * vyFactor * timeToReach;

          const n = (raw - top) / span;
          bounces = Math.max(0, Math.floor(Math.abs(n)));

          const m = ((raw - top) % (2 * span) + 2 * span) % (2 * span);
          aimY = m <= span ? top + m : bot - (m - span);

          if (now >= g.cpuNextAimAt) {
            const basePx = 22;
            const travelPx = clamp(timeToReach * (12 + ballSpeed * 0.04), 0, 150);
            const bounceAmp = 1 + bounces * 1.1;
            const speedAmp = 1 + clamp((ballSpeed - 520) / 900, 0, 0.9);
            const fatigueAmp = 1 + fatigue * 0.55;
            const errMag = (basePx + travelPx) * bounceAmp * speedAmp * fatigueAmp;

            // smooth drifting error
            const rnd = Math.random() * 2 - 1;
            g.cpuAimErr = g.cpuAimErr * 0.78 + rnd * errMag * 0.22;
            g.cpuBias = g.cpuBias * 0.985 + (Math.random() - 0.5) * 2.5;

            // occasional intent misread
            if (Math.random() < 0.12) {
              const misread = Math.random() < 0.55 ? 1 : -1;
              g.cpuAimErr += (g.lastPlayerBias || 0) * 30 * misread * (1 + bounces * 0.35);
            }

            g.cpuNextAimAt = now + reaimEvery * 1000;
          }

          aimY = clamp(aimY + g.cpuAimErr + g.cpuBias, top, bot);
        }
      } else {
        g.cpuAimErr *= 0.92;
        g.cpuBias *= 0.985;
        aimY = cfg.h / 2;
      }

      const react = cfg.cpuReact * (1 - fatigue * 0.18);
      g.cpuAimY += (aimY - g.cpuAimY) * react;
      const cpuCenter = g.right.y + cfg.paddleH / 2;
      const cpuErr = g.cpuAimY - cpuCenter;

      const bounceSlow = 1 / (1 + bounces * 0.22);
      const cpuSpeed = cfg.paddleSpeed * (1 - fatigue * 0.06) * bounceSlow;
      const desiredVel = clamp(cpuErr * 4.6, -cpuSpeed, cpuSpeed);
      const maxAccel = 3200;
      const dv = clamp(desiredVel - g.cpuVel, -maxAccel * dt, maxAccel * dt);
      g.cpuVel = clamp(g.cpuVel + dv, -cpuSpeed, cpuSpeed);
      g.right.y = clamp(g.right.y + g.cpuVel * dt, 12, cfg.h - 12 - cfg.paddleH);
      if (Math.abs(cpuErr) < 10) g.cpuVel *= 0.92;

      // Ball integrate
      g.ball.x += g.ball.vx * dt;
      g.ball.y += g.ball.vy * dt;

      // Ghost integrate (visual + CPU bait)
      if (g.ghostBall && now < g.ghostBall.until) {
        g.ghostBall.x += g.ghostBall.vx * dt;
        g.ghostBall.y += g.ghostBall.vy * dt;
      }

      // Speed ramp (match time + rally)
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
      const bounceWall = (ballObj) => {
        if (ballObj.y < topWall) {
          ballObj.y = topWall;
          ballObj.vy *= -1;
          return true;
        } else if (ballObj.y > botWall) {
          ballObj.y = botWall;
          ballObj.vy *= -1;
          return true;
        }
        return false;
      };

      const bouncedMain = bounceWall(g.ball);
      if (bouncedMain) g.challenge?.onWallBounce?.(g);
      if (g.ghostBall && now < g.ghostBall.until) bounceWall(g.ghostBall);

      // Gate crossing check (midline)
      if (g.challenge?.id === "movingGate" && g.gate) {
        // detect a crossing from left->right or right->left through x ~= gate.x
        if (
          (g.ball.vx > 0 && g.ball.x >= g.gate.x && g.ball.x - g.ball.vx * dt < g.gate.x) ||
          (g.ball.vx < 0 && g.ball.x <= g.gate.x && g.ball.x - g.ball.vx * dt > g.gate.x)
        ) {
          if (g.challenge.onBallCrossMid?.(g)) {
            g.challengeDone = true;
          }
        }
      }

      // Gravity well effect
      if (g.gravity && now < g.gravity.until) {
        const dx = g.gravity.x - g.ball.x;
        const dy = g.gravity.y - g.ball.y;
        const dist = Math.max(60, Math.hypot(dx, dy));
        // strongest near the well
        const pull = (g.gravity.strength / dist) * dt;
        g.ball.vy += dy * pull * 0.012;
        g.ball.vx += dx * pull * 0.006;
      }

      // Collisions
      const hitPaddle = (paddle, paddleH, isLeft) => {
        const px = paddle.x;
        const py = paddle.y;
        const bw = cfg.ballR;

        const withinY = g.ball.y + bw >= py && g.ball.y - bw <= py + paddleH;
        if (!withinY) return false;

        if (isLeft) {
          const contact = g.ball.x - bw <= px + cfg.paddleW && g.ball.x > px;
          if (!contact) return false;
          g.ball.x = px + cfg.paddleW + bw;
        } else {
          const contact = g.ball.x + bw >= px && g.ball.x < px + cfg.paddleW;
          if (!contact) return false;
          g.ball.x = px - bw;
        }

        // reflect X
        g.ball.vx *= -1;

        const paddleCenter = py + paddleH / 2;
        const offsetNorm = (g.ball.y - paddleCenter) / (paddleH / 2);

        if (isLeft) {
          g.lastPlayerBias = offsetNorm < -0.15 ? -1 : offsetNorm > 0.15 ? 1 : 0;
          g.challenge?.onPlayerHit?.(g, offsetNorm);
        }

        // spin
        g.ball.vy += offsetNorm * cfg.spin;

        // Parry boost if window is active and you hit during it
        if (isLeft && now < g.parryWindowUntil) {
          g.ball.vx *= 1.12;
          g.ball.vy *= 1.06;
          g.ball.vy += offsetNorm * 220;
          g.parryWindowUntil = 0;
          spawnPop(g, g.ball.x, g.ball.y, 22);
          setHintSafe("PARRY! Big return.");
        }

        // speed-up on hits
        const sp = Math.hypot(g.ball.vx, g.ball.vy);
        const capNow = cfg.maxBallSpeed + g.matchTime * cfg.maxSpeedLiftPerSec;
        const spNext = Math.min(capNow, sp * 1.04 + 8);
        const scale = spNext / Math.max(1e-6, sp);
        g.ball.vx *= scale;
        g.ball.vy *= scale;

        // prevent near-vertical stalls
        const minX = 180;
        if (Math.abs(g.ball.vx) < minX) {
          g.ball.vx = Math.sign(g.ball.vx || (isLeft ? 1 : -1)) * minX;
        }

        // rally count
        g.rallyHits += 1;

        if (!isLeft) {
          // CPU hit hooks wallTrick challenge
          const ok = g.challenge?.onCpuHit?.(g);
          if (ok) g.challengeDone = true;
        }

        return true;
      };

      const leftH2 = cfg.paddleH * g.leftScale;
      hitPaddle(g.left, leftH2, true);
      hitPaddle(g.right, cfg.paddleH, false);

      // Scoring
      const onPoint = () => {
        g.secondsSurvivedSincePoint = 0;
        g.usedPowerupSinceLastPoint = false;
        g.consecutiveReturns = 0;
        g.lastHitOffset = 0;
        g.rallyHits = 0;
        g.lastPlayerBias = 0;
        g.gate = null;
        g.actionPulseAt = 0;
        g.lastWallBounceAt = 0;

        // next challenge after any point (keeps it interactive)
        setTimeout(() => {
          const gg = gRef.current;
          if (gg && !gg.winner) pickNextChallenge(gg);
        }, 450);
      };

      if (g.ball.x < -40) {
        g.scoreR += 1;
        onPoint();
        if (g.scoreR >= cfg.scoreToWin) {
          g.winner = "R";
          setHintSafe("R to reset");
        } else {
          setHintSafe("CPU scored • Serve to you");
          serve(false);
        }
      } else if (g.ball.x > cfg.w + 40) {
        g.scoreL += 1;
        onPoint();
        if (g.scoreL >= cfg.scoreToWin) {
          g.winner = "L";
          setHintSafe("R to reset");
        } else {
          setHintSafe("You scored • Serve to CPU");
          serve(true);
        }
      }

      // Challenge completion checks
      if (!g.challengeDone) {
        if (g.challenge?.check?.(g)) g.challengeDone = true;
      }

      if (g.challengeDone) {
        g.challengeDone = false;
        spawnPop(g, cfg.w / 2, 120, 22);
        awardChallengeReward(g);
        setTimeout(() => {
          const gg = gRef.current;
          if (gg && !gg.winner) pickNextChallenge(gg);
        }, 650);
      }

      draw();
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [cfg, challengePool]);

  return (
    <div style={{ minHeight: "70vh", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 1020 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>Modern Pong</div>
            <div style={{ fontSize: 13, opacity: 0.65 }}>
              Challenges unlock/charge powerups. Action key: <span style={{ fontWeight: 700 }}>E</span>.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              style={buttonStyle(false)}
              onClick={() =>
                setPaused((p) => {
                  const next = !p;
                  pausedRef.current = next;
                  return next;
                })
              }
              title="Space"
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              style={buttonStyle(false)}
              onClick={() => reset(true)}
              title="R"
            >
              Reset
            </button>
          </div>
        </div>

        <div style={{ borderRadius: 20, overflow: "hidden", border: "1px solid rgba(231,236,255,0.12)", background: "#0b1020", boxShadow: "0 16px 40px rgba(0,0,0,0.35)" }}>
          <canvas ref={canvasRef} style={{ display: "block" }} />
        </div>

        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.75 }}>
          Powerups: <span style={{ fontWeight: 700 }}>1</span> Dash • <span style={{ fontWeight: 700 }}>2</span> Gravity Well •{" "}
          <span style={{ fontWeight: 700 }}>3</span> Decoy Ball • <span style={{ fontWeight: 700 }}>4</span> Parry
        </div>
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.6 }}>
          {hint}
        </div>
      </div>
    </div>
  );
}
