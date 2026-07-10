# Zomboid-Mod-Manager

A local Node.js tool for managing and auditing Project Zomboid Workshop mods. No external dependencies — just Node.js.

## Setup

```bash
node server.js
```

Server runs at `http://localhost:3000`.

## Tools

### Mod Existence Checker — `http://localhost:3000`

Paste a list of Workshop IDs and check whether each one still exists on the Steam Workshop. Results stream in real time via SSE.

- Batches up to 100 IDs per Steam API request
- Streams results as they arrive — progress visible immediately
- Cancel in-flight checks at any time
- Flags missing/deleted mods vs. confirmed existing ones

### Mod Detail Checker — `http://localhost:3000/mod-list`

Paste a list of Workshop IDs and get a rich scrollable card list with full mod metadata pulled from the Steam API.

- Mod name, thumbnail, tags, subscriber count, last updated, file size
- Steam Workshop link on every card
- **Build 42 compatibility badge** based on mod tags:
  - **B42** (green) — mod is tagged `Build 42` or `B42`
  - **B41 Only** (red) — mod is tagged `Build 41`/`B41` but not B42
  - **Unknown** (gray) — no version tags; last updated date shown as a signal
  - **Not Found** — mod has been deleted or never existed
- Filter cards by compatibility tier

> Note: B42 detection relies on mod authors tagging their workshop items correctly. "Unknown" mods may still work on B42 — check the last updated date and the mod page directly.

## How it works

Both tools use the Steam Web API (`ISteamRemoteStorage/GetPublishedFileDetails/v1/`) — no API key required, batches of 100 IDs per request. The server also serves the HTML pages directly so all fetch calls are same-origin (no CORS issues).
