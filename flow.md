# RusQ – File Flow & Connections

How the files talk to each other. Updated whenever a file is added or its role changes.

## 1. Big picture

```
┌──────────────────────────── packages/shared (TypeScript source, imported by both apps) ───────────────────────────┐
│ resources.ts  schemas.ts  delivery.ts  canonical.ts  uuid.ts  vision.ts                                          │
│ allocation/engine.ts  allocation/provisional.ts                                                                  │
│ mesh/hlc.ts  mesh/crypto.ts  mesh/envelope.ts  mesh/chunks.ts  mesh/node.ts  mesh/rng.ts  mesh/simulator.ts       │
│ Phase 2: geo.ts  profile.ts  missing.ts  cctv.ts  decision.ts  assist.ts                                          │
└───────────────▲───────────────────────────────────────────────────────────────▲──────────────────────────────────┘
                │ import '@rusq/shared'                                           │ import '@rusq/shared'
┌───────────────┴──────────────── apps/web (PWA) ─────────┐        ┌───────────────┴──────── apps/server ───────────┐
│ UI pages → lib/db.ts (Dexie/IndexedDB)                    │  HTTPS │ index.ts → app.ts (routes, RBAC, rate limit)  │
│          → lib/sync.ts (outbox → /api/sync, acks)         │ ─────▶ │   → services.ts (ingest, reconcile, audit)     │
│          → lib/relay.ts (MeshNode + transports)           │ ◀───── │   → db.ts (node:sqlite)  keys.ts  auth.ts      │
│          → vision worker (transformers.js)                │  acks  │   → seed.ts (demo flood data)                 │
│          → MapView (MapLibre + cached PMTiles)            │        │   → routes-phase2.ts → ops-service.ts         │
│          → llm worker (OPTIONAL, off by default)          │        │                      missing-service.ts       │
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
| `src/mesh/node.ts` | `MeshNode`: seen-set, store-and-forward, anti-entropy, gateway upload/acks. | envelope, hlc, crypto | simulator, web relay (LAN links), server tests |
| `src/mesh/rng.ts` | Seeded PRNG + seeded UUIDs. | – | simulator, tests |
| `src/mesh/simulator.ts` | **SIMULATED** radio mesh + `SimServer` + topology builders (tests only since the Mesh Lab page was removed, 13.2). | node, chunks, crypto, rng | simulation tests |
| `src/vision.ts` | CLIP prompts, hazard extraction, checklist hints (advisory). | resources, schemas | vision worker, report form, eval script |
| `src/geo.ts` (P2) | Engine-independent distance (`distanceM`, polynomial cosine), ≈1 km grid cells, FNV-1a content hash. | – | decision, missing matcher, shelter map, server |
| `src/profile.ts` (P2) | Profile / Registration / StaffAccount schemas, need flags, skills, `sosProfileFrom`, `isVulnerable`, `hasMedicalNeed`. | schemas | web register/profile/SOS, server routes, decision inputs |
| `src/missing.ts` (P2) | Missing-person **state machine** `transition()` (no skipping), verify checklist, `familyView` redaction, sample-registry matcher `matchCandidates()`. | geo, schemas | server missing-service, web admin/family pages, tests |
| `src/cctv.ts` (P2) | **SAMPLE** cameras: synthetic scene + hand-labelled detections; `cctvSignals()` summary for the rules. | – | server decision input, web CCTV player |
| `src/decision.ts` (P2) | Rule-based **decision support** `decide()`: area scores, priority areas, concentrations, personnel, team–skill matching, resource distribution (calls `allocate()`), unmet needs; `sosTriage()`. | geo, allocation engine, cctv, canonical | server ops-service, tests |
| `src/assist.ts` (P2) | Guard for the OPTIONAL language model: output schemas, "no new numbers" check, deterministic `templateExplanation()`. | resources, allocation types | web assistant + report helpers, tests |

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
| `src/seed.ts` | **Only the admin account** (12.13), 8 SAMPLE shelters in Kathmandu district, stock, first snapshot; `seedPhase2` (idempotent, upgrades old DBs): shelter details, SAMPLE found-person registry, ONE-TIME removal of the old demo profiles and switch of a Guwahati-sample DB; `seedTestUsers` only with `RUSQ_TEST_USERS=1` / `testUsers` (automated tests). | services, auth, db |
| `src/routes-phase2.ts` (P2) | Phase 2 HTTP routes with role checks (see API map). Registration = user ID + profile, no password (12.2). | ops-service, missing-service, auth, shared |
| `src/routes-peer.ts` (12.10) | `POST /api/peer/poll`: automatic nearby-phone pairing – memory-only presence per network (same public IP) + offer/answer mailbox. | auth |
| `src/ops-service.ts` (P2) | Profiles (last-write-wins), shelters, teams, decision input + decisions (stored as shown), team tasks, SOS monitor/status, dashboard aggregates, staff accounts. | services, shared decision/profile/cctv |
| `src/missing-service.ts` (P2) | Missing-person workflow on the DB, always through shared `transition()`; candidate proposal; family view; announcements. | services, shared missing |
| `test/server.test.ts` | Integration tests via `app.inject()`. | app, shared |
| `test/phase2.test.ts` (P2) | Registration by user ID + passwordless victim sign-in (staff still need a password), profile, RBAC matrix, SOS monitor, decisions, CCTV toggle, dashboard, missing-person workflow, staff, admin-only seed + one-time cleanup, automatic pairing, DB upgrade. | app, shared |

### API map
| Route | Who | Purpose |
|-------|-----|---------|
| `GET /api/health` | public | reachability probe (real offline detection) |
| `GET /api/server-key` | public | ECDSA public key for verifying acks |
| `POST /api/auth/login` | public | token. Victims: user ID only; rescuers/admin: user ID + password (12.2) |
| `GET /api/setup/keys` | any role | team key + ack public key (offline provisioning) |
| `GET /api/snapshot` | any role | latest resource snapshot |
| `POST /api/sync` | any role (victims: SOS only, own userId) | outbox upload → signed acks |
| `POST /api/mesh/upload` | any role (gateway) | relay envelopes → signed acks |
| `PUT/GET /api/photos/:id` | rescuer, admin | idempotent photo upload / view |
| `POST /api/allocate` | any role | same engine on the server (parity) |
| `GET /api/admin/*`, `PUT /api/admin/stock`, `PUT /api/admin/sites`, `POST /api/admin/snapshot`, `POST /api/admin/allotments/:id/decision` | admin | overview, reconciliation, decisions, audit |
| `POST /api/auth/register` (P2) | public, rate-limited | victim self-registration: `{ userId, profile }`, no password, always role victim |
| `GET /api/admin/feed?since=` (13.4) | admin | new SOS / field reports / missing reports since a time (for the pop-ups) |
| `PUT /api/photos/:id`, `GET /api/photos/:id` (13.1) | any role, checked | victims: only photos of their OWN missing-person report (after it arrived); missing-person photos visible to admin + that family only |
| `POST /api/peer/poll` (12.10) | any role | automatic nearby-phone pairing: phones on the same network + WebRTC offers/answers (memory only) |
| `GET /api/me`, `PUT /api/me/profile`, `GET /api/me/sos`, `GET /api/me/missing` (P2) | any role | own profile; control-room status of own SOS; REDACTED own missing-person cases |
| `GET /api/shelters`, `GET /api/announcements` (P2) | any role | shelter list for the offline map; verified + announced cases only |
| `GET /api/team/tasks` (P2) | rescuer | approved team assignments + SOS assigned to the team |
| `GET /api/admin/dashboard`, `/sos-monitor`, `/reports-view`, `/decisions`, `/cctv`, `/missing`, `/found-registry`, `/users` (P2) | admin | control-room views |
| `POST /api/admin/sos/:id/status`, `POST /api/admin/decisions/:id`, `PUT /api/admin/cctv`, `POST /api/admin/missing/:id/action`, `POST /api/admin/missing/:id/match`, `POST /api/admin/users` (P2) | admin | decisions (all audit-logged) |
| `POST /api/sync` kind `missing` (P2) | any role, own reporterId | family missing-person report → signed ack (kind `missing`); also relayable as mesh type `missing` |

## 4. apps/web

### Entry and shell
| File | Role | Talks to |
|------|------|----------|
| `index.html` → `src/main.tsx` | Boot: fonts, CSS, starts the connectivity monitor, sync scheduler, location keeper, update watcher and the automatic nearby-phone linking; exposes `window.__rusq` (engine, for parity tests) | lib/connectivity, lib/sync, lib/location, lib/update, lib/autolink, App |
| `src/App.tsx` | Header (real Online/Offline pill, user), visible nav grid by role (labels per role, e.g. "Shelters in district" / "Shelters near me"; no "Ready for offline" for admin; no "Sent & waiting"), routes (heavy pages lazy; `/outbox` → Home; admin `/setup` → `/admin`). On Home for victims/rescuers the nav is rendered BELOW the page so the SOS circle comes first | pages/*, lib/hooks, lib/session, lib/update |
| `src/sw.ts` | Service worker: precache shell, SPA navigation fallback, cache-first `/models` + `/ort` + the optional `llm.worker` chunk, Background Sync → `syncNow()` (which also shows the "SOS reached" notification), notification click → open RusQ | lib/sync (bundled into sw.js) |
| `vite.config.ts` | PWA manifest (SOS shortcut), injectManifest (not precached: models, ORT, map file, llm worker), self-hosts ORT WASM into `public/ort`, COOP/COEP in dev | – |
| `public/sos.webmanifest` (P2) | separate installable "SOS" app (iOS workaround): own id, start_url `/sos?source=sos_entry`, red icons | swapped in by pages/Sos.tsx |
| `public/map/region.pmtiles` + `region.json` (P2) | offline vector tiles of the sample region (built by `scripts/build-map.mjs`; © OpenStreetMap contributors) | lib/offline-map |
| `src/styles.css` | Design tokens from the brand sheet; "labels stay inside their boxes" rules (12.6) | – |

### lib/ (logic, no React except hooks.ts)
| File | Role | Depends on |
|------|------|-----------|
| `db.ts` | Dexie schema: `outbox` (sos/report/allotment/missing), `photos` (ArrayBuffer), `kv`, `shelters` (v2); quota-error mapping | shared types |
| `api.ts` | fetch wrapper: `/api`, bearer token, timeout; any non-JSON answer (proxy/tunnel error page) = "no connection"; reports every result to connectivity; `friendlyError()` – never raw HTML on screen (12.3) | session |
| `session.ts` | token + user, device id, settings (low power, stale hours, mock vision) | db |
| `connectivity.ts` | **Real reachability** (12.1): `/api/health` probe (6 s, JSON only), Offline only after 2 failed checks, checks every 4 s offline / 15 s online, browser events only trigger a check, every API result counts | api (reporter callback) |
| `keys.ts` | caches the team key + server ack public key (setup); imports CryptoKeys | db, api, shared crypto |
| `outbox.ts` | `queueSos/Report/Allotment/Photo` (IndexedDB first); **`applyAck()` = the only way to `received`** (verifies ECDSA then calls the shared state machine) | db, keys, shared delivery |
| `sync.ts` | `syncNow()`: probe → upload due items (SOS first) → verify acks → photos → gateway upload. **Automatic** (12.4): on offline→online `makeAllDue()` + send at once; every 5 s while something waits; Background Sync registration. `notifyDelivered()`: one notification when a delayed SOS is confirmed (12.12) | api, connectivity, outbox, relay (dynamic) |
| `relay.ts` | the phone's real `MeshNode`: persisted state, self-heal from outbox, originate records/photos, `learnAcks`, `gatewayUpload` (others' messages only) | shared MeshNode, keys, outbox, db |
| `lan.ts` | **EXPERIMENTAL** WebRTC link: invite/accept/complete (signalled automatically by autolink, or by a copy-paste code as fallback; no QR), host-only SDP, data-channel anti-entropy (`summary`/`pull`/`msg`), gossip to all peers; `hello` carries the user ID; **transfer alerts** "Connected to … and transferring …" / "Receiving from … hop N" / confirmation came back through … (13.3) | relay, outbox, toast, transferlog, session |
| `toast.ts` (13.3/13.4) | pop-up message bus (`toast()`, `dismiss()`), max 3 on screen; SOS ones stay until closed | – |
| `transferlog.ts` (13.3) | phone-to-phone transfer log (direction, other phone's user ID, hop), kept in kv | db |
| `adminfeed.ts` (13.4) | admin only: every 5 s `GET /api/admin/feed?since=` → a pop-up per new SOS / report / missing report (+ optional desktop notification); tells open admin screens to refresh | api, connectivity, session, toast |
| `autolink.ts` (12.10) | **automatic nearby-phone links**: every 4 s while online, check in at `/api/peer/poll`; offer to phones on the same network (smaller id offers), answer offers, retry dead links; links survive losing the server | api, connectivity, lan, relay, session |
| `location.ts` | live fix → last known (with age) → none; saves on every fix, app open, online/offline | db |
| `photos.ts` | downscale ≤ 1280 px + 320 px thumb, JPEG q0.7, strips EXIF, corrupt/huge handling | – |
| `vision-core.ts` | **shared with the Node eval**: load CLIP-vision + YOLOS, analyse → `VisionSuggestion` (+ timings); MOCK analyser | transformers.js, shared vision |
| `vision-env.ts` | shared transformers.js config (self-hosted models + ORT, threads, proxy) and model loading for both vision paths | vision-core |
| `vision-main.ts` | **fallback** when `OffscreenCanvas` is missing: canvas shim + same vision-core on the main thread, ORT in proxy worker | vision-env, vision-core |
| `vision.ts` | picks the path once (`VISION_MODE`: worker or main-thread); client for the worker; model manifest, prefetch into Cache API, **verify stored** | workers/vision.worker |
| `allotment.ts` | cached snapshot, staleness, this device's claims on the current snapshot, provisional allotment | shared engine, db, session |
| `setup.ts` | "Ready for offline" checklist (victims and rescuers only – not the control room, 12.5): download step + independent verify step per item (P2 adds "Map of your area" and a real shelters download) | keys, vision, location, api, relay, offline-map |
| `update.ts` | SW registration; update check only when online + idle; "Update now" | connectivity |
| `hooks.ts` | React hooks: live queries, reach, session, clock | db, connectivity, session |
| `profile.ts` (P2) | profile saved locally first, honest "saved on phone / on server" state, upload in sync, pull after sign-in, compact SOS copy | api, db, shared profile |
| `offline-map.ts` (P2) | download/verify the PMTiles file into Cache API `rusq-map`, read it back whole; shelters into Dexie `shelters` | api, db |
| `cache.ts` (P2) | `useCachedApi`: server views saved in kv with their age; shown as "saved X ago" offline, never as live | api, db, hooks |
| `assistant.ts` (P2) | OPTIONAL AI helper client: WebGPU check, load/unload worker, `structureNotes`, `explainShare` – every reply through the shared guard, template fallback | workers/llm.worker, shared assist, session |

### workers/ and pages/
| File | Role |
|------|------|
| `workers/vision.worker.ts` | normal path: loads models via vision-env (WebGPU → WASM, threads if cross-origin isolated, 1 in low power), runs `analyzeImage` / `mockAnalyze` |
| `workers/llm.worker.ts` (P2) | OPTIONAL Llama 3.2 1B via WebLLM (WebGPU); text in → text out only; not precached |
| `pages/Register.tsx` (P2) | victim registration: suggested user ID (no password) + profile form (12.2) |
| `pages/Profile.tsx` (P2) | edit profile offline; honest upload status; shows the user ID needed to sign in |
| `pages/ShelterMap.tsx` (P2) | admin: "Shelters in the district" (all, totals, map fitted to all); victims/rescuers: "Shelters near me" (within 3 km first, rest of the district below); live / "Last known location, X ago"; refreshes the list when online (12.8) |
| `pages/MissingFamily.tsx` (P2) | family report with up to 3 photos (processed like report photos, queued + relayed) (13.1), honest status, own photos with "received" count, redacted case status |
| `pages/admin/Dashboard.tsx` (P2) | central map (hot zones, heatmap, SOS, reports, shelters, sample CCTV) + every layer as a table, resources, 24 h analytics |
| `pages/admin/SosMonitor.tsx` (P2) | SOS by urgency level with reasons, contacts, delivery path/delay, acknowledge/assign/resolve |
| `pages/admin/Reports.tsx` (P2) | reports with photos (AuthImage), AI vs human answer, cross-location comparison table |
| `pages/admin/Decisions.tsx` (P2) | recommendations with reasoning/evidence, approve/reject + note, decision log |
| `pages/admin/Cctv.tsx` (P2) | footage analyser (12.7) + SAMPLE synthetic clip player with hand-labelled boxes, signals table, on/off for the rules |
| `components/FootageAnalyser.tsx` (12.7) | ADVISORY: a chosen video file is sampled (≤ 20 frames) and analysed on this computer with the photo helper's pre-trained models → time line + summary; nothing uploaded, not fed to the rules |
| `pages/admin/Missing.tsx` (P2) | case state steps, family photos (13.1), candidates with breakdown/evidence, review → checklist verify → announce; sample registry |
| `pages/admin/People.tsx` (P2) | all accounts; create rescuer/admin accounts with team + skills |
| `components/MapView.tsx` (P2) | MapLibre map over the in-memory PMTiles (custom `Source`), DOM markers, GeoJSON overlays + popups, WebGL-failure notice, `data-rendered-features` |
| `components/ProfileForm.tsx` (P2) | shared profile fields: about you · your family (total people in the house, needs, medical, family contacts) · your work |
| `components/Toasts.tsx` (13.3/13.4) | renders the pop-ups on every screen (`.popups` / `.popup`) with Open and Close buttons |
| `components/SosPanel.tsx` (12.11/12.12) | the big round SOS button + countdown + the ONE message below it: reached the control room (reference, control-room status) or saved and sent automatically; asks notification permission on press |
| `components/AdminBits.tsx` (P2) | Freshness ("live" / "saved X ago"), offline-actions note, severity badge, action helper, AuthImage (photo cache) |
| `components/AssistPanels.tsx` (P2) | "Explain my share" (template always) + "Tidy my notes" (only if the helper is on) |
| `pages/Login.tsx` | sign-in with user ID (+ password for staff only); admin → `/admin`, others → `/setup`; pulls the profile in the background; link to Register |
| `pages/Setup.tsx` | checklist UI, sizes, storage estimate, iOS reminder |
| `pages/Home.tsx` | victims/rescuers: SosPanel FIRST; then rescuer "Tasks for your team" and "Your reports" (status), big role-based actions, verified announcements |
| `pages/Sos.tsx` | SosPanel on its own screen (also `/sos?source=shortcut`; on `?source=sos_entry` swaps in `sos.webmanifest` + SOS icon/title for the iOS home-screen entry) |
| `pages/Report.tsx` | rescue report: location, people, urgency, photos + vision suggestion, hazards, resources + hints, live provisional share, save (report + photos + allotment) |
| `pages/PeerLink.tsx` | Nearby phones (EXPERIMENTAL): automatic connection status (phones by user ID), carried messages, **transfer log with hop numbers** (13.3), gateway upload, copy-paste code as fallback (no QR); plain notice if the browser has no WebRTC |
| `pages/AdminReconcile.tsx` | live stock vs claims, conflicts, approve (may lower) / reject, audit log |
| `pages/Settings.tsx` | low power, stale threshold, MOCK vision switch, OPTIONAL AI writing helper (off by default) |
| `components/StatusBadge.tsx` | the single place delivery wording is rendered |
| `scripts/fetch-models.mjs` | downloads served models, precomputes CLIP text embeddings, patches YOLOS size, writes `models/manifest.json` |
| `scripts/make-icons.mjs` | SVG → PNG icons (app + SOS) |

### Main runtime flows
```
SOS / Report (offline)
  page → outbox.queue*() → IndexedDB (status queued) ──┬─▶ relay.originateRecord() → MeshNode store (persisted)
                                                      └─▶ sync.requestSync() (+ Background Sync tag)

Back online (automatic – no button)
  connectivity: offline → online → sync.makeAllDue() → sync.syncNow() → probe /api/health → POST /api/sync → acks → outbox.applyAck() [verify ECDSA] → received
                                                         └─▶ relay.learnAcks() → 'ack' envelopes for peers

Nearby phones – linking (while the server is reachable, automatic)
  autolink → POST /api/peer/poll (same network) → offer/answer → lan.ts link (local addresses only) → stays up offline

Nearby phones (no internet)
  lan.ts data channel ⇄ MeshNode.summary()/messagesFor()/receive()  → own items marked "sent (relay)"
  sender: "📶 Connected to {user} and transferring …" · receiver: "📥 Receiving from {user} … hop N" · both → transfer log
  peer with internet: relay.gatewayUpload() → POST /api/mesh/upload (server records hops + uploading user) → acks → relayed back → origin applyAck() → received ("confirmation came back through {user}")

Vision
  Report.tsx → photos.processPhoto() → vision.analyzePhoto() → worker (vision-core)          → suggestion (editable)
                                                            └▶ no OffscreenCanvas: vision-main (vision-core, ORT proxy worker)

Provisional allotment
  Report.tsx → shared computeProvisionalAllotment(cached snapshot, report, alreadyAllotted) → queueAllotment()
  server: ingestAllotment → runReconciliation → conflicts → AdminReconcile decisions → live stock

Phase 2 – profile & SOS
  Register/Profile → kv profile (+ profileDirty) → sync uploads PUT /api/me/profile
  SosPanel (Home / Sos.tsx) → profile.sosProfile() (local copy) → SOS → … → admin SOS monitor (triage, contacts) → status → /api/me/sos → message under the SOS button
  delayed SOS confirmed → sync.notifyDelivered() → one system notification

Phase 2 – offline map
  Setup "map" → offline-map.downloadMapRegion() → Cache "rusq-map"     Setup "shelters" → /api/shelters → Dexie shelters
  ShelterMap.tsx / admin Dashboard → MapView → loadRegionBuffer() → PMTiles(BufferSource) → maplibre pmtiles:// protocol

Control-room pop-ups (13.4)
  adminfeed (every 5 s) → GET /api/admin/feed?since → toast per new SOS/report/missing → Toasts on every admin screen; event → admin screens reload

Phase 2 – decisions
  ops-service.decisionInput(): SOS + reports + shelters + live stock + teams + (SAMPLE) CCTV signals
    → shared decide() → recommendations (id = kind:key:contentHash) → admin approve/reject → rec_decisions + audit
    → approved team_assignment → GET /api/team/tasks → rescuer Home

Phase 2 – missing persons
  MissingFamily.tsx → queueMissing() → /api/sync (kind missing) → ingestMissing → proposeCandidates (sample registry)
  admin: start_review → verify (named admin, checklist, note) → announce   – every step via shared transition()
  family: /api/me/missing = familyView() (nothing before verified) · everyone: /api/announcements (announced only)

Phase 2 – optional AI helper (off by default)
  Settings toggle → assistant.loadAssistant() → llm.worker (WebLLM) ; Report notes / explanation → guard → else template
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
| `tests/e2e/helpers.ts` | spawns a real server per spec (stop/restart, `RUSQ_TEST_USERS=1`), login (user ID; password for staff), setup checklist, CPU throttle, outbox statuses from IndexedDB, SOS status under the button |
| `tests/e2e/offline.spec.ts` | offline shell, queued → sent → received only after ack, honesty, kill tab, storage full |
| `tests/e2e/lan.spec.ts` | phones link AUTOMATICALLY, real WebRTC link survives the server stopping; gateway; ack back over the link; code fallback (no QR) |
| `tests/e2e/changes.spec.ts` (12.x) | owner's change list: labels inside boxes on every screen at 360 px, SOS first on Home, badge robustness, no raw error pages, footage analyser, delayed-SOS notification |
| `tests/e2e/vision.spec.ts` | real model offline, corrupt/huge images, missing-model fallback, browser latency |
| `tests/e2e/pwa.spec.ts` | byte-identical allocation per JS engine, axe, installability, cold start |
| `tests/e2e/round2.spec.ts` (13.x) | 3-phone multi-hop A → B → C → server with the transfer alerts, hop numbers, 2 hops recorded on the server and the confirmation back to A; missing-person photo end to end; control-room pop-ups |
| `packages/shared/test/phase2.test.ts` (P2) | geo, missing workflow (+ property: no skipping / no leak), matcher, decision rules (hand-computed, determinism, order independence), triage, CCTV data, AI guard (+ property) |
| `apps/server/test/phase2.test.ts` (P2) | see apps/server table |
| `tests/e2e/phase2.spec.ts` (P2) | register → offline map + last-known → SOS with profile → status back; missing-person UI flow; admin screens incl. offline; role guards; iOS SOS entry; axe on Phase 2 screens; AI helper off by default |
| `tests/e2e/flood.spec.ts` (P2) | **Gate 2** full flood scenario end to end (phones link automatically) |
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
| `docs/GATE2_REPORT.md` (P2) | Gate 2 full regression + final report |
| `docs/DEMO.md` (P2) | demo script for the flood scenario |
| `docs/PHONE_TEST.md` | real-device checklist (all "not run") |
| `decisions.md` / `flow.md` | this pair – decisions with reasons, and how files connect |
| `Dockerfile` | one-container hosting |

## 7. Manual testing tools
| File | Purpose |
|------|---------|
| `docs/TESTING_GUIDE.md` | step-by-step multi-device procedure (laptop, Android ×2, iPhone) |
| `scripts/inspect-db.mjs` | READ-ONLY view of the server DB (users, SOS, reports, photos, allotments, conflicts, SOS handling, missing-person cases, recommendation decisions, audit); `--watch` refreshes every 3 s (`npm run inspect-db`) |
| `scripts/demo-flood.mjs` (P2) | `npm run demo`: fills a running server with the SAMPLE Kathmandu flood scenario through the real API (creates `demo-…` sample team accounts via the admin and `demo-…` sample people by user ID; idempotent) |
| `scripts/build-map.mjs` (P2) | `npm run build:map`: one Overpass extract (Kathmandu sample region) → own vector tiles → PMTiles v3 writer → `public/map/` |
