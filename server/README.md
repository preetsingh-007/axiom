# Axiom relay

A tiny, stateless WebSocket hub that lets your devices sync in realtime. It forwards opaque,
end-to-end encrypted frames between devices in the same *room* and stores nothing. The room id
is a one-way hash of your vault's sync secret, so the relay can't read your notes or tell which
vault a room belongs to. Git persistence and local storage keep working with no relay at all.
The relay only adds live, multi-device sync.

```sh
npm run relay                     # same as: node server/relay.mjs --port 8787
PORT=9000 node server/relay.mjs   # PORT / HOST env vars are also honoured
```

- `GET /health` returns `{"ok":true,"rooms":N,"connections":N}`.
- WebSocket endpoint: `ws(s)://<host>/?room=<64 hex chars>`.
- Built-in limits: 8 MiB max frame, 32 devices per room, 2000 connections, per-connection rate
  limiting (applied as TCP backpressure, so no frames are dropped), and a 30 s ping/pong keepalive.
- The only dependency is `ws`. Needs Node 20 or newer.

In Axiom, open **Settings → Sync** and set the relay URL (for example `wss://axiom-relay.fly.dev`).

## Free ways to host it

| Option | Notes |
| --- | --- |
| **Home machine or Raspberry Pi + Cloudflare Tunnel** | `node server/relay.mjs` and `cloudflared tunnel --url http://localhost:8787` give you a `https://….trycloudflare.com` URL. Use it as `wss://…`. No port forwarding needed. |
| **Fly.io** | `fly launch` with a Node image and `CMD ["node","server/relay.mjs"]`, `internal_port = 8787`. A single small machine is enough. |
| **Render / Railway / Koyeb free web services** | Create a Node web service, set the start command to `node server/relay.mjs`, and let the platform set `PORT`. Free instances may sleep when idle. Clients reconnect automatically, and nothing is lost because the relay holds no state. |
| **LAN only** | Run it on any machine and use `ws://<lan-ip>:8787`. |

Always use `wss://` (TLS) on the public internet. Frames are end-to-end encrypted anyway, but
TLS also hides the room id and the traffic pattern from the network.
