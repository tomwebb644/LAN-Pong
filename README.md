# LAN Pong (WebSockets)

This repo contains:
- `server/` a tiny Node.js WebSocket relay (LAN host)
- `client/` a Vite + React web app (Pong)

## Requirements
- Node.js 18+ recommended

## 1) Start the LAN server (on the host PC)
```bash
cd server
npm install
npm run start
```

By default it listens on port **8080** (ws://0.0.0.0:8080).

## 2) Start the client (on the host PC)
```bash
cd client
npm install
npm run dev -- --host
```

Vite will print a LAN URL like:
- http://192.168.1.50:5173

Open that URL on BOTH machines (host + friend).

## 3) Join a room
In the web app:
- Paste the server URL, e.g. `ws://192.168.1.50:8080`
- Set a room code (any short string), e.g. `abc`
- Click **Connect**

Player assignments:
- Player 1 = Left paddle (W/S)
- Player 2 = Right paddle (↑/↓)

## Notes
- Multiplayer mode runs **host-authoritative** simulation for low latency.
- Singleplayer mode is still available locally (no server needed).
