# PartyKit auth blocker

`npx partykit whoami` / `npx wrangler whoami` on the box: **not logged in**.

`npx partykit deploy` starts interactive login and hangs waiting for a browser device code.

## What Matias must do (once)

In a terminal Matias can use (or via request_box_help so he can complete the device flow on his phone/browser):

```bash
cd /workspace/projects/party-games-server   # or clone https://github.com/mati-sme/party-games-server
npm install
npx partykit login
# Open the printed URL, enter the device code, approve Cloudflare/PartyKit free account
npx partykit deploy
```

Deploy prints a host like:

`party-games.<partykit-username>.partykit.dev`

Then update **both** clients and push:

1. `pass-the-boom/js/config.js` → `PARTYKIT_HOST_DEFAULT = 'party-games.<user>.partykit.dev'`
2. `quiet-courier/js/config.js` → same host
3. Bump `sw.js` CACHE to v3 on both
4. `git push` both repos

Until that host is set, Create/Join shows: “Multiplayer server not deployed yet…”
