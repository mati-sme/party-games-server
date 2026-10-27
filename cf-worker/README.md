# Cloudflare Worker + Durable Object (free path)

PartyKit CLI OAuth failed, so rooms run as Worker `party-games` on:

**Host:** `party-games.mati-sme.workers.dev`

Path (same as PartyKit clients): `/parties/main/{ptb|qc}-XXXX`

- `worker.js` — routes to `GameRoom` DO
- `room.js` — authoritative lobby/match, `TICK_MS=50` (20 Hz)
- `games/ptb.js`, `games/qc.js` — game logic

Redeploy via Cloudflare MCP `execute` (multipart PUT script) or Wrangler once CLI auth works.
Do not commit API tokens.
