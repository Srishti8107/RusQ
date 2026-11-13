# RusQ – offline-first disaster response (spec: ResQGrid)

A Progressive Web App connecting **victims**, **rescue teams** and **administrators** when
networks fail. The guiding principle: **the system assists, humans decide.**

> **Status: Phase 1 and Phase 2 complete. Gate 1 and Gate 2 passed in emulation**
> ([Gate 1](docs/GATE1_REPORT.md), [Gate 2 + final report](docs/GATE2_REPORT.md)).
> Real-device testing: **not run yet** ([checklist](docs/PHONE_TEST.md), [how to test](docs/TESTING_GUIDE.md)).
> Read [LIMITATIONS.md](LIMITATIONS.md).

## What is real, what is simulated, what is sample data

| Feature | Status |
|---------|--------|
| Offline outbox, honest delivery status (Saved on this phone → Sent → Received by server) | real |
| Server-signed acks (ECDSA), idempotent sync, reconciliation, audit log | real |
| Registration, profile with emergency contacts (phone + server), SOS carries the profile | real |
| Offline shelter map (self-hosted vector tiles of a **sample region**, Kathmandu, Nepal) | real map engine; **sample** shelters |
| Admin dashboard: central map with hot zones + heatmap, SOS monitor, reports with photos, analytics, **pop-up alerts for every new SOS / report** | real |
| Rule-based decision support with reasoning, approve/reject, team tasks | real, **advisory**; the admin decides |
| Peer-to-peer link between phones on the same Wi-Fi/hotspot (WebRTC, no internet) – phones connect **automatically** while the server is reachable, the link survives losing it | **EXPERIMENTAL** (real, tested only between browsers on one PC) |
| Multi-hop relay between phones (A → B → C → server) with on-screen "Connected to / Receiving from {user ID}" alerts, a transfer log and hop counts on the control-room screens | **EXPERIMENTAL** (real WebRTC links; multi-hop tested with 3 browsers on one PC) |
| On-device vision (CLIP + YOLOS-tiny, in a Web Worker, offline) | real, **advisory only** |
| Provisional resource allotment on the phone | real, **provisional**; the admin decides |
| CCTV demo | **SAMPLE DATA**: synthetic animated clips + hand-labelled detections; no cameras, no faces |
| CCTV footage analyser (video file → hazards, people/boat counts, on the admin's computer) | real pre-trained models, **ADVISORY**, unmeasured on real CCTV |
| Missing persons: family report with up to 3 photos, matching + verification workflow | real workflow (photos seen only by the control room and the family; no face matching); **SAMPLE** registry of fictional people |
| AI writing helper (Llama 3.2 1B, on the phone) | **EXPERIMENTAL, OPTIONAL, off by default**; never touches numbers; **not run on a real GPU here** |

## Quick start (development)

Requirements: Node ≥ 22.13 (see `.nvmrc`).

```bash
npm install
node apps/web/scripts/fetch-models.mjs   # once: downloads ~94 MB of vision models into apps/web/public/models
npm run dev:server                        # API on :8787 (demo data seeded)
npm run dev:web                           # app on :5173
```

Only one account exists at the start: `admin` / `demo1234` (control room – change the password for real use).
People needing help **register** themselves on the sign-in page with a **user ID only** (no password) and sign
in again with that user ID. Rescue-team accounts are created by the admin under **People & teams** (they use a
password). `npm run demo` adds clearly named sample accounts (`demo-…`).

## Demo (flood scenario)

```bash
npm run build && npm start      # http://localhost:8787
npm run demo                    # fills it with a SAMPLE flood: SOS, reports, a stock conflict, missing persons
```

Then follow [docs/DEMO.md](docs/DEMO.md) (about 15 minutes, laptop + optional phones).

## Production / hosting

```bash
npm run build      # builds the PWA into apps/web/dist and bundles the server
npm start          # one Node process serves the API and the app on :8787
```

Or use Docker: `docker build -t rusq . && docker run -p 8787:8787 -v rusq-data:/app/apps/server/data rusq`.

**HTTPS is required in production.** Service workers, WebCrypto and the camera only work in a secure
context (`https://` or `localhost`). Put RusQ behind any HTTPS host or reverse proxy.

| Env var | Purpose |
|---------|---------|
| `PORT`, `HOST` | listen address (default `0.0.0.0:8787`) |
| `RUSQ_DB` | SQLite file (default `apps/server/data/rusq.db`). Keep it on a persistent volume. A Phase 1 database is upgraded in place |
| `RUSQ_SEED=0` | **disable the admin seed and the sample data** (do this for any real deployment) |
| `RUSQ_TEST_USERS=1` | automated tests only: adds fixture accounts (asha / ravi / meena / kiran). Never set it in a real deployment |
| `RUSQ_TOKEN_SECRET`, `RUSQ_TEAM_KEY`, `RUSQ_ACK_PRIVATE_JWK`, `RUSQ_ACK_PUBLIC_JWK` | supply keys from a secret store instead of generating them into the DB |
| `RUSQ_RATE_LIMIT`, `RUSQ_LOGIN_RATE_LIMIT`, `RUSQ_REGISTER_RATE_LIMIT` | per-IP limits per minute (defaults 600 / 20 / 10) |

The offline map is `apps/web/public/map/region.pmtiles` (committed, 0.8 MB). To rebuild it or change
the region, edit `REGION` in `scripts/build-map.mjs` and run `npm run build:map` (one small
OpenStreetMap data extract via Overpass; no tile scraping).

## Architecture

```
packages/shared   one allocation engine + one relay protocol + Zod schemas
                  + Phase 2: decision rules, missing-person state machine + matcher,
                    CCTV sample data, profile schemas, AI-output guard
apps/server       Fastify + node:sqlite: sync/acks, mesh gateway upload, reconciliation, RBAC, audit,
                  registration/profiles, SOS monitor, decisions, missing persons, dashboard
apps/web          React PWA: Dexie outbox, sync engine, relay node, WebRTC link + transfer alerts, vision worker,
                  offline MapLibre + PMTiles map, control-room screens, optional LLM worker
```

See [flow.md](flow.md) for how the files connect and [decisions.md](decisions.md) for every design decision and its reason.

## Screens by role

| Victim | Rescue team | Control room (admin) |
|--------|-------------|----------------------|
| Big round SOS button first on Home, with the message whether it reached the control room right below it (sent automatically; notification when a delayed SOS arrives), Shelters near me, Missing person, My profile, Nearby phones (connect by themselves), Ready for offline, Settings, announcements | everything a victim has + New report (photos, vision, provisional share, explain my share) + Tasks for your team + Your reports (status) | Dashboard (central map, numbers, analytics), SOS monitor, Field reports, Recommendations, Allotments, Missing persons, CCTV (footage analyser + sample cameras), People & teams, Shelters in the district, Settings (no "Ready for offline" – always online); pop-ups for every new SOS, report and missing-person report |

## Testing

```bash
npm run typecheck
npm test                                   # Vitest: unit, property (fast-check), simulations, server integration
npx playwright install chromium webkit     # once
npx playwright test                        # E2E on emulated Pixel 7 (4× CPU) and iPhone 13, incl. the full flood scenario
npx tsx tests/vision-eval/eval-node.ts     # vision accuracy/latency on 52 public-domain fixtures
node tests/lighthouse/run-lighthouse.mjs   # mobile Lighthouse
npm run inspect-db -- --watch              # read-only view of what the server really received
```

## Platform support

| Platform | Support |
|----------|---------|
| **Android Chrome** | Primary target. Install, offline, Background Sync, home-screen SOS shortcut (long-press icon). |
| **iOS Safari / home-screen app** | Best effort. No Background Sync (sync runs when the app opens or comes to the foreground). No manifest shortcuts: open **SOS → "Add a separate SOS button to your home screen"**, then Share → Add to Home Screen. iOS may clear data after weeks unused: open RusQ regularly and check "Ready for offline". |
| Desktop Chrome/Edge | Works (admin use). |
| AI writing helper | Only on browsers with WebGPU; untested on phones. |

## Design

Colours from the brand sheet (SOS red `#7F0000`, green `#0B4A22`, neutral `#DDE5E3`, area shades
`#3D0C0C` / `#B06B68` / `#F5E3E3`, used for the hot zones). Font: Atkinson Hyperlegible (self-hosted). Every option is visible
(no hidden menus), every control is ≥ 48 px, the base font is 18 px, every map also has a list or table,
and axe finds no serious issues on any screen.

## Sample data and attribution

Shelters, people, the found-person registry and CCTV clips in the demo are **fictional sample data**
(real localities in Kathmandu district, Nepal). Map data © OpenStreetMap contributors, ODbL 1.0 (shown on the map).
Vision fixtures are CC0 / Public Domain Mark images from Openverse, with attribution in
`tests/fixtures/vision/LABELS.json`. Models: `Xenova/clip-vit-base-patch32` and `Xenova/yolos-tiny`
(ONNX ports on Hugging Face). Optional assistant: `Llama-3.2-1B-Instruct-q4f16_1-MLC` via WebLLM
(Llama 3.2 Community License), downloaded only if a user switches it on.
