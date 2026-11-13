# RusQ – offline-first disaster response (spec: ResQGrid)

A Progressive Web App connecting **victims**, **rescue teams** and **administrators** when
networks fail. The guiding principle: **the system assists, humans decide.**

> **Status: Phase 1 complete, Gate 1 passed in emulation** ([report](docs/GATE1_REPORT.md)).
> Phase 2 (victim profile/map, admin dashboard, decision support, CCTV demo, missing persons) has not started.
> Real-device testing: **not run yet** ([checklist](docs/PHONE_TEST.md)). Read [LIMITATIONS.md](LIMITATIONS.md).

## What is real, what is simulated

| Feature | Status |
|---------|--------|
| Offline outbox, honest delivery status (Saved on this phone → Sent → Received by server) | real |
| Server-signed acks (ECDSA), idempotent sync, reconciliation, audit log | real |
| Peer-to-peer link between phones on the same Wi-Fi/hotspot (WebRTC, no internet) | **EXPERIMENTAL** (real, tested only between two browsers on one PC) |
| Multi-hop mesh (Mesh Lab) | **SIMULATED** (real protocol code, virtual radio) |
| On-device vision (CLIP + YOLOS-tiny, in a Web Worker, offline) | real, **advisory only** |
| Provisional resource allotment on the phone | real, **provisional**; the admin decides |

## Quick start (development)

Requirements: Node ≥ 22.13 (see `.nvmrc`).

```bash
npm install
node apps/web/scripts/fetch-models.mjs   # once: downloads ~94 MB of vision models into apps/web/public/models
npm run dev:server                        # API on :8787 (demo data seeded)
npm run dev:web                           # app on :5173
```

Demo accounts (password `demo1234`): `asha` (person needing help), `ravi` / `meena` (rescue teams), `admin` (control room).

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
| `RUSQ_DB` | SQLite file (default `apps/server/data/rusq.db`). Keep it on a persistent volume |
| `RUSQ_SEED=0` | **disable demo users and data** (do this for any real deployment) |
| `RUSQ_TOKEN_SECRET`, `RUSQ_TEAM_KEY`, `RUSQ_ACK_PRIVATE_JWK`, `RUSQ_ACK_PUBLIC_JWK` | supply keys from a secret store instead of generating them into the DB |

## Architecture

```
packages/shared   one allocation engine + one relay protocol + Zod schemas (used by both apps)
apps/server       Fastify + node:sqlite: sync/acks, mesh gateway upload, reconciliation, RBAC, audit
apps/web          React PWA: Dexie outbox, sync engine, relay node, WebRTC link, vision worker, Mesh Lab
```

See [flow.md](flow.md) for how the files connect and [decisions.md](decisions.md) for every design decision and its reason.

## Testing

```bash
npm run typecheck
npm test                                   # Vitest: unit, property (fast-check), simulations, server integration
npx playwright install chromium webkit     # once
npx playwright test                        # E2E on emulated Pixel 7 (4× CPU) and iPhone 13
npx tsx tests/vision-eval/eval-node.ts     # vision accuracy/latency on 52 public-domain fixtures
node tests/lighthouse/run-lighthouse.mjs   # mobile Lighthouse
```

## Platform support

| Platform | Support |
|----------|---------|
| **Android Chrome** | Primary target. Install, offline, Background Sync, home-screen SOS shortcut (long-press icon). |
| **iOS Safari / home-screen app** | Best effort. No Background Sync (sync runs when the app opens or comes to the foreground). No manifest shortcuts (a separate "SOS" home-screen entry comes in Phase 2). iOS may clear data after weeks unused: open RusQ regularly and check "Ready for offline". |
| Desktop Chrome/Edge | Works (admin use). |

## Design

Colours from the brand sheet (SOS red `#7F0000`, green `#0B4A22`, neutral `#DDE5E3`, area shades
`#3D0C0C` / `#B06B68` / `#F5E3E3`). Font: Atkinson Hyperlegible (self-hosted). Every option is visible
(no hidden menus), every control is ≥ 48 px, the base font is 18 px, and axe finds no serious issues.

## Sample data and attribution

Shelters and people in the demo seed are fictional (real coordinates in Guwahati, Assam).
Vision fixtures are CC0 / Public Domain Mark images from Openverse, with attribution in
`tests/fixtures/vision/LABELS.json`. Models: `Xenova/clip-vit-base-patch32` and `Xenova/yolos-tiny`
(ONNX ports on Hugging Face).
