# RusQ – File Flow & Connections

How the files talk to each other. Updated whenever a file is added or its role changes.

## 1. Big picture

```
┌──────────────────────────── packages/shared (TypeScript source, imported by both apps) ───────────────────────────┐
│ resources.ts  schemas.ts  delivery.ts  canonical.ts  uuid.ts  vision.ts                                          │
│ allocation/engine.ts  allocation/provisional.ts                                                                  │
│ mesh/hlc.ts  mesh/crypto.ts  mesh/envelope.ts  mesh/chunks.ts  mesh/node.ts  mesh/rng.ts  mesh/simulator.ts       │
└───────────────▲───────────────────────────────────────────────────────────────▲──────────────────────────────────┘
                │ import '@rusq/shared'                                           │ import '@rusq/shared'
┌───────────────┴──────────────── apps/web (PWA) ─────────┐        ┌───────────────┴──────── apps/server ───────────┐
│ UI pages → lib/db.ts (Dexie/IndexedDB)                    │  HTTPS │ index.ts → app.ts (routes, RBAC, rate limit)  │
│          → lib/sync.ts (outbox → /api/sync, acks)         │ ─────▶ │   → services.ts (ingest, reconcile, audit)     │
│          → lib/relay.ts (MeshNode + transports)           │ ◀───── │   → db.ts (node:sqlite)  keys.ts  auth.ts      │
│          → vision worker (transformers.js)                │  acks  │   → seed.ts (demo flood data)                 │
│ service worker (Workbox) precaches everything             │        │ serves apps/web/dist as static SPA            │
└───────────────────────────────────────────────────────────┘        └───────────────────────────────────────────────┘
```

## 2. packages/shared

| File | Role | Depends on | Used by |
|------|------|-----------|---------|
| `src/index.ts` | Barrel export of everything below. | all | web, server, tests |
| `src/resources.ts` | Resource catalogue (8 checklist items), hazard labels, hazard→resource **hints**. | – | schemas, engine, vision, UI |
| `src/canonical.ts` | Canonical JSON (sorted keys), base64, SHA-256. | – | envelope MACs, ack signatures, parity tests |
| `src/uuid.ts` | UUIDv7 generator + regex. | – | client record ids, schemas |
| `src/schemas.ts` | Zod schemas for User, SOS, FieldReport, Site, Snapshot, Allotment, AuditEntry, Ack, sync API. | resources, uuid | server validation, client validation, envelope payload checks |
| `src/delivery.ts` | **Delivery state machine** queued → sent → received (only on a verified ack), labels, backoff. | schemas (types) | web outbox/sync, tests |
| `src/allocation/engine.ts` | Pure deterministic `allocate()` (BigInt water-filling + largest remainder). | resources | provisional.ts, server `/api/allocate`, web allotment screen |
| `src/allocation/provisional.ts` | Snapshot+report → engine input, `computeProvisionalAllotment()`, `reconcile()`, staleness. | engine, schemas | web (offline allotment), server (reconciliation) |
| `src/mesh/hlc.ts` | Hybrid logical clock. | – | node.ts |
| `src/mesh/crypto.ts` | Team-key HMAC; server ECDSA ack sign/verify; key import/export. | canonical | envelope, node, server keys/services, web setup |
| `src/mesh/envelope.ts` | MeshMessage schema, validation, MAC sign/verify, priorities, send order. | schemas, hlc, crypto | node, simulator, server mesh upload, web relay |
| `src/mesh/chunks.ts` | Photo split into chunks + `Reassembler` (SHA-256 checked). | canonical, envelope | node users, simulator SimServer, server ingestChunk, web relay |
| `src/mesh/node.ts` | `MeshNode`: seen-set, store-and-forward, anti-entropy, gateway upload/acks. | envelope, hlc, crypto | simulator, web relay (LAN + Mesh Lab), server tests |
| `src/mesh/rng.ts` | Seeded PRNG + seeded UUIDs. | – | simulator, tests |
| `src/mesh/simulator.ts` | **SIMULATED** radio mesh + `SimServer` + topology builders. | node, chunks, crypto, rng | Mesh Lab page, simulation tests |
| `src/vision.ts` | CLIP prompts, hazard extraction, checklist hints (advisory). | resources, schemas | vision worker, report form, eval script |

### Data flow inside the relay
```
originate() ──sign MAC──▶ store ──messagesFor(peer.summary)──▶ transport ──▶ peer.receive()
                                                                           │ validate → verify MAC → seen? → (ack? verify ECDSA)
                                                                           ▼
                                                    gateway.pendingUploads() ──▶ POST /api/mesh/upload
                                                    server acks ──▶ gateway.ingestServerAcks() ──▶ 'ack' envelopes ──▶ back through the mesh
                                                    origin receives ack ──▶ delivery state → received (via delivery.ts)
```

## 3. apps/server

| File | Role | Depends on |
|------|------|-----------|
| `src/index.ts` | Entry point: reads env, calls `buildApp`, listens on 0.0.0.0:8787. | app.ts |
| `src/app.ts` | Fastify factory: rate limit, error handler, all routes, RBAC preHandlers, static SPA hosting. | services, auth, keys, db, seed, shared |
| `src/services.ts` | Domain logic: idempotent ingest (sos/report/allotment/photo/envelopes), photo chunk reassembly, stock, sites, snapshots, reconciliation, admin decisions, audit. | db, keys, shared |
| `src/db.ts` | `node:sqlite` open + schema, transactions, server-id counters, kv store. | node:sqlite |
| `src/keys.ts` | Loads or creates token secret, team key and ECDSA ack keypair. | db, shared crypto |
| `src/auth.ts` | scrypt passwords, HMAC tokens, `requireRole()` preHandler. | – |
| `src/seed.ts` | Demo users, Guwahati shelters, stock, first snapshot. | services, auth |
| `test/server.test.ts` | Integration tests via `app.inject()`. | app, shared |

### API map
| Route | Who | Purpose |
|-------|-----|---------|
| `GET /api/health` | public | reachability probe (real offline detection) |
| `GET /api/server-key` | public | ECDSA public key for verifying acks |
| `POST /api/auth/login` | public | token |
| `GET /api/setup/keys` | any role | team key + ack public key (offline provisioning) |
| `GET /api/snapshot` | any role | latest resource snapshot |
| `POST /api/sync` | any role (victims: SOS only, own userId) | outbox upload → signed acks |
| `POST /api/mesh/upload` | any role (gateway) | relay envelopes → signed acks |
| `PUT/GET /api/photos/:id` | rescuer, admin | idempotent photo upload / view |
| `POST /api/allocate` | any role | same engine on the server (parity) |
| `GET /api/admin/*`, `PUT /api/admin/stock`, `PUT /api/admin/sites`, `POST /api/admin/snapshot`, `POST /api/admin/allotments/:id/decision` | admin | overview, reconciliation, decisions, audit |

## 4. apps/web

### Entry and shell
| File | Role | Talks to |
|------|------|----------|
| `index.html` → `src/main.tsx` | Boot: fonts, CSS, starts the connectivity monitor, sync scheduler, location keeper and update watcher; exposes `window.__rusq` (engine, for parity tests) | lib/connectivity, lib/sync, lib/location, lib/update, App |
| `src/App.tsx` | Header (real Online/Offline pill, user), visible nav grid by role, routes (heavy pages lazy) | pages/*, lib/hooks, lib/session, lib/update |
| `src/sw.ts` | Service worker: precache shell, SPA navigation fallback, cache-first `/models` + `/ort`, Background Sync → `syncNow()` | lib/sync (bundled into sw.js) |
| `vite.config.ts` | PWA manifest (SOS shortcut), injectManifest, self-hosts ORT WASM into `public/ort`, COOP/COEP in dev | – |
| `src/styles.css` | Design tokens from the brand sheet | – |

### lib/ (logic, no React except hooks.ts)
| File | Role | Depends on |
|------|------|-----------|
| `db.ts` | Dexie schema: `outbox`, `photos` (ArrayBuffer), `kv`; quota-error mapping | shared types |
| `api.ts` | fetch wrapper: `/api`, bearer token, timeout | session |
| `session.ts` | token + user, device id, settings (low power, stale hours, mock vision) | db |
| `connectivity.ts` | **Real reachability**: `/api/health` probe (3 s) → online/offline | – |
| `keys.ts` | caches the team key + server ack public key (setup); imports CryptoKeys | db, api, shared crypto |
| `outbox.ts` | `queueSos/Report/Allotment/Photo` (IndexedDB first); **`applyAck()` = the only way to `received`** (verifies ECDSA then calls the shared state machine) | db, keys, shared delivery |
| `sync.ts` | `syncNow()`: probe → upload due items (SOS first) → verify acks → photos → gateway upload; backoff + jitter scheduler; Background Sync registration | api, connectivity, outbox, relay (dynamic) |
| `relay.ts` | the phone's real `MeshNode`: persisted state, self-heal from outbox, originate records/photos, `learnAcks`, `gatewayUpload` (others' messages only) | shared MeshNode, keys, outbox, db |
| `lan.ts` | **EXPERIMENTAL** WebRTC link: invite/accept/complete (copy-paste/QR), host-only SDP, data-channel anti-entropy (`summary`/`pull`/`msg`), gossip to all peers | relay, outbox |
| `location.ts` | live fix → last known (with age) → none; saves on every fix, app open, online/offline | db |
| `photos.ts` | downscale ≤ 1280 px + 320 px thumb, JPEG q0.7, strips EXIF, corrupt/huge handling | – |
| `vision-core.ts` | **shared with the Node eval**: load CLIP-vision + YOLOS, analyse → `VisionSuggestion` (+ timings); MOCK analyser | transformers.js, shared vision |
| `vision-env.ts` | shared transformers.js config (self-hosted models + ORT, threads, proxy) and model loading for both vision paths | vision-core |
| `vision-main.ts` | **fallback** when `OffscreenCanvas` is missing: canvas shim + same vision-core on the main thread, ORT in proxy worker | vision-env, vision-core |
| `vision.ts` | picks the path once (`VISION_MODE`: worker or main-thread); client for the worker; model manifest, prefetch into Cache API, **verify stored** | workers/vision.worker |
| `allotment.ts` | cached snapshot, staleness, this device's claims on the current snapshot, provisional allotment | shared engine, db, session |
| `setup.ts` | "Ready for offline" checklist: download step + independent verify step per item | keys, vision, location, api, relay |
| `update.ts` | SW registration; update check only when online + idle; "Update now" | connectivity |
| `hooks.ts` | React hooks: live queries, reach, session, clock | db, connectivity, session |

### workers/ and pages/
| File | Role |
|------|------|
| `workers/vision.worker.ts` | normal path: loads models via vision-env (WebGPU → WASM, threads if cross-origin isolated, 1 in low power), runs `analyzeImage` / `mockAnalyze` |
| `pages/Login.tsx` | sign-in (needs internet once) |
| `pages/Setup.tsx` | checklist UI, sizes, storage estimate, iOS reminder |
| `pages/Home.tsx` | big role-based actions |
| `pages/Sos.tsx` | SOS button → 3 s cancel countdown → `queueSos` (also `/sos?source=shortcut`) |
| `pages/Report.tsx` | rescue report: location, people, urgency, photos + vision suggestion, hazards, resources + hints, live provisional share, save (report + photos + allotment) |
| `pages/Outbox.tsx` | every item with its true status; "Send now" |
| `pages/PeerLink.tsx` | Nearby phones (EXPERIMENTAL): codes, QR show/scan, peers, carried messages, gateway upload; plain notice if the browser has no WebRTC |
| `pages/MeshLab.tsx` | Mesh Lab (SIMULATED): canvas + controls over `MeshSimulator` with throw-away keys |
| `pages/AdminReconcile.tsx` | live stock vs claims, conflicts, approve (may lower) / reject, audit log |
| `pages/Settings.tsx` | low power, stale threshold, MOCK vision switch |
| `components/StatusBadge.tsx` | the single place delivery wording is rendered |
| `scripts/fetch-models.mjs` | downloads served models, precomputes CLIP text embeddings, patches YOLOS size, writes `models/manifest.json` |
| `scripts/make-icons.mjs` | SVG → PNG icons (app + SOS) |

### Main runtime flows
```
SOS / Report (offline)
  page → outbox.queue*() → IndexedDB (status queued) ──┬─▶ relay.originateRecord() → MeshNode store (persisted)
                                                      └─▶ sync.requestSync() (+ Background Sync tag)

Back online
  sync.syncNow() → probe /api/health → POST /api/sync → acks → outbox.applyAck() [verify ECDSA] → received
                                                         └─▶ relay.learnAcks() → 'ack' envelopes for peers

Nearby phones (no internet)
  lan.ts data channel ⇄ MeshNode.summary()/messagesFor()/receive()  → own items marked "sent (relay)"
  peer with internet: relay.gatewayUpload() → POST /api/mesh/upload → acks → relayed back → origin applyAck() → received

Vision
  Report.tsx → photos.processPhoto() → vision.analyzePhoto() → worker (vision-core)          → suggestion (editable)
                                                            └▶ no OffscreenCanvas: vision-main (vision-core, ORT proxy worker)

Provisional allotment
  Report.tsx → shared computeProvisionalAllotment(cached snapshot, report, alreadyAllotted) → queueAllotment()
  server: ingestAllotment → runReconciliation → conflicts → AdminReconcile decisions → live stock
```

## 5. Tests

| File | Covers |
|------|--------|
| `packages/shared/test/delivery.test.ts` | §2.1 state machine + property "never received without verified ack" |
| `packages/shared/test/relay.test.ts` | envelope validation, MAC/ack signature rejection, TTL/hops, dedupe, priority, chunks, HLC |
| `packages/shared/test/simulation.test.ts` | seeded SIMULATED scenarios: line/star/random, loss, churn, partition, 2 gateways, late gateway, dup/out-of-order, photo resume, clock skew |
| `packages/shared/test/relay.property.test.ts` | eventual delivery / no duplicates / no infinite forwarding (+ coverage guard) |
| `packages/shared/test/allocation.test.ts` | hand-computed cases + fast-check properties |
| `apps/server/test/server.test.ts` | idempotency, ack round-trip, mesh upload, reconciliation, snapshots, parity, auth/RBAC/validation/rate-limit |
| `tests/e2e/helpers.ts` | spawns a real server per spec (stop/restart), login, setup checklist, CPU throttle |
| `tests/e2e/offline.spec.ts` | offline shell, queued → sent → received only after ack, honesty, kill tab, storage full |
| `tests/e2e/lan.spec.ts` | real WebRTC link with the server stopped; gateway; ack back over the link |
| `tests/e2e/vision.spec.ts` | real model offline, corrupt/huge images, missing-model fallback, browser latency |
| `tests/e2e/pwa.spec.ts` | byte-identical allocation per JS engine, axe, installability, cold start, Mesh Lab |
| `tests/vision-eval/eval-node.ts` | accuracy/latency/memory with the shipped `vision-core.ts` → `docs/vision-eval.json` |
| `tests/vision-eval/detect-sanity.ts` | detector still finds people/boats after the size change |
| `tests/lighthouse/run-lighthouse.mjs` | mobile Lighthouse → `docs/lighthouse.json` |
| `tests/fixtures/vision/` | 52 reviewed CC0/PDM images + `LABELS.json` (attribution) |
| `scripts/fetch-vision-candidates.mjs`, `contact-sheet.mjs`, `assemble-vision-fixtures.mjs` | fixture pipeline: fetch candidates → review sheets → copy reviewed set |

## 6. Docs
| File | Purpose |
|------|---------|
| `README.md` | setup, hosting, real vs simulated, platform matrix |
| `LIMITATIONS.md` | honest limits |
| `docs/GATE1_REPORT.md` | Gate 1 results table and evidence |
| `docs/PHONE_TEST.md` | real-device checklist (all "not run") |
| `decisions.md` / `flow.md` | this pair – decisions with reasons, and how files connect |
| `Dockerfile` | one-container hosting |

## 7. Manual testing tools
| File | Purpose |
|------|---------|
| `docs/TESTING_GUIDE.md` | step-by-step multi-device procedure (laptop, Android ×2, iPhone) |
| `scripts/inspect-db.mjs` | READ-ONLY view of the server DB (users, SOS, reports, photos, allotments, conflicts, audit); `--watch` refreshes every 3 s |
