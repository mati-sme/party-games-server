# Auth / deploy notes

PartyKit / Wrangler browser OAuth callback still fails in this environment.

**Live free path (2026-10-27):** Cloudflare Worker + Durable Object via MCP `execute`.

- Script: `party-games`
- Host: `party-games.mati-sme.workers.dev`
- Account subdomain: `mati-sme`
- Protocol: `/parties/main/{ptb|qc}-XXXX` (same as PartyKit clients)
- Tick: 50ms (20 Hz authoritative)

Sources under `cf-worker/`. Do not retry browser login unless Matias asks.
