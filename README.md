# party-games-server

Authoritative multiplayer rooms for **Pass the Boom** and **Quiet Courier** on [PartyKit](https://partykit.io) (Cloudflare free tier).

No phone is the host brain — the Durable Object runs the sim at ~20 Hz. Clients send input and receive snapshots. Room codes stay 4 letters.

## Room IDs

| Game | Room id | Example |
| --- | --- | --- |
| Pass the Boom | `ptb-XXXX` | `ptb-K7MQ` |
| Quiet Courier | `qc-XXXX` | `qc-H4NP` |

Clients connect with WebSocket to:

`wss://<host>/parties/main/<roomId>`

## Deploy (one-time login)

PartyKit/Wrangler auth was **not** available on the build box. On a machine where Matias can complete the device login:

```bash
cd /workspace/projects/party-games-server   # or clone of this repo
npm install
npx partykit login
# Follow the printed URL + device code in a browser (Cloudflare / PartyKit account — free)
npx partykit deploy
```

After deploy, note the URL printed, typically:

`https://party-games.<your-partykit-user>.partykit.dev`

Then set that host (no `https://`) in both game clients:

- `pass-the-boom/js/config.js` → `PARTYKIT_HOST`
- `quiet-courier/js/config.js` → `PARTYKIT_HOST`

Bump each game’s `sw.js` `CACHE` and push to GitHub Pages.

### Local dev

```bash
npm install
npm run dev
# listens on localhost:1999 — point clients at that host for testing
```

## Protocol (JSON over WebSocket)

Client → server:

- `{ type:"hello", intent:"create"|"join", name }`
- `{ type:"kids", kidsMode:boolean }` (host only, lobby)
- `{ type:"start", kidsMode:boolean }` (host only)
- `{ type:"input", dx, dy, action? }` (~10–20 Hz while playing)
- `{ type:"again" }` (host only, back to lobby)

Server → client:

- `{ type:"welcome", id, name, code, isHost, players, kidsMode, game }`
- `{ type:"lobby", players, code, kidsMode, hostId }`
- `{ type:"start", kidsMode, snapshot, localId }`
- `{ type:"state", snapshot, events }` (~20 Hz)
- `{ type:"again" }`
- `{ type:"error", message }`

## Free tier

Uses PartyKit / Cloudflare Workers free allowances only. No paid APIs. Ephemeral in-memory rooms (no persistence needed for party nights).
