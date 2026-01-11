import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

const server = http.createServer();
const wss = new WebSocketServer({ server });

/**
 * rooms: roomId -> {
 *   p1: WebSocket|null,
 *   p2: WebSocket|null,
 *   host: WebSocket|null,  // authoritative simulator (defaults to p1)
 *   lastState: object|null
 * }
 */
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { p1: null, p2: null, host: null, lastState: null });
  return rooms.get(id);
}

function safeSend(ws, obj) {
  if (!ws) return;
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws) => {
  ws.room = null;
  ws.player = null;

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === "join") {
      const roomId = (msg.room && String(msg.room)) || "default";
      const room = getRoom(roomId);

      ws.room = roomId;

      if (!room.p1) {
        room.p1 = ws; ws.player = 1;
      } else if (!room.p2) {
        room.p2 = ws; ws.player = 2;
      } else {
        safeSend(ws, { type: "full" });
        return;
      }

      if (!room.host) room.host = room.p1;

      safeSend(ws, { type: "role", player: ws.player, host: room.host === ws });

      // Let both players know who is connected
      safeSend(room.p1, { type: "presence", p1: !!room.p1, p2: !!room.p2 });
      safeSend(room.p2, { type: "presence", p1: !!room.p1, p2: !!room.p2 });

      // Send last state to late joiner
      if (room.lastState) safeSend(ws, { type: "state", ...room.lastState });

      // Tell host it may start (or pause) sim depending on presence
      safeSend(room.host, { type: "can_start", ok: !!room.p1 && !!room.p2 });

      return;
    }

    const roomId = ws.room || "default";
    const room = getRoom(roomId);

    // Host sends authoritative state
    if (msg.type === "state") {
      if (room.host !== ws) return;
      room.lastState = msg;
      safeSend(room.p1, msg);
      safeSend(room.p2, msg);
      return;
    }

    // Inputs forwarded to host
    if (msg.type === "input") {
      if (room.host && room.host.readyState === 1) {
        safeSend(room.host, { type: "input", from: ws.player, ...msg });
      }
      return;
    }

    if (msg.type === "action" || msg.type === "powerup") {
      if (room.host && room.host.readyState === 1) {
        safeSend(room.host, { type: msg.type, from: ws.player, key: msg.key });
      }
      return;
    }

    // Host migration: if p1 leaves, allow p2 to become host
    if (msg.type === "claim_host") {
      if (!room.host || room.host.readyState !== 1) {
        room.host = ws;
        safeSend(ws, { type: "role", player: ws.player, host: true });
        safeSend(room.p1, { type: "role", player: 1, host: room.host === room.p1 });
        safeSend(room.p2, { type: "role", player: 2, host: room.host === room.p2 });
        safeSend(room.host, { type: "can_start", ok: !!room.p1 && !!room.p2 });
      }
      return;
    }
  });

  ws.on("close", () => {
    const roomId = ws.room;
    if (!roomId) return;
    const room = getRoom(roomId);

    if (room.p1 === ws) room.p1 = null;
    if (room.p2 === ws) room.p2 = null;
    if (room.host === ws) room.host = room.p1 || room.p2 || null;

    safeSend(room.p1, { type: "presence", p1: !!room.p1, p2: !!room.p2 });
    safeSend(room.p2, { type: "presence", p1: !!room.p1, p2: !!room.p2 });
    safeSend(room.host, { type: "can_start", ok: !!room.p1 && !!room.p2 });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LAN Pong server listening on ws://0.0.0.0:${PORT}`);
});
