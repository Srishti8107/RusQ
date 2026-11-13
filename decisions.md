# RusQ – Decision Log

Every specific decision taken while building RusQ (spec name: **ResQGrid**), with the reason.
Newest decisions are appended at the bottom of each section. Status: **D** = decided, **R** = revised later (see note).

---

## 0. Environment & tooling

| # | Decision | Why |
|---|----------|-----|
| 0.1 | Installed **Node.js LTS via winget** (system-wide, v26.13.1). | Node wasn't installed. You asked for "what makes it easier to host later". A standard system install is what hosting CLIs (Docker, Render, Fly, Vercel) expect locally. Portability for hosting comes from the repo instead (`.nvmrc`, `engines`, Dockerfile). |
| 0.2 | `engines.node >= 22.13`, `.nvmrc = 22`. | 22.13 is the first LTS where `node:sqlite` works without a flag. Any host on Node 22+ runs the server. |
| 0.3 | **npm workspaces** monorepo (`packages/shared`, `apps/server`, `apps/web`). | The spec (§6) asks for this layout. npm workspaces ship with Node, so there's no extra tool (pnpm/yarn) to install on a host. |
| 0.4 | `packages/shared` is consumed as **TypeScript source** (no build step). The server is bundled with esbuild for production. | One engine and one relay protocol (§12.4) with zero drift: web (Vite) and server (tsx/esbuild) compile the *same files*. |
| 0.5 | Pinned major versions I know well (TS 5, Vitest 3, fast-check 3, Zod 3, Fastify 5, React 18, Vite 6). | Avoids surprise API breaks from brand-new majors in a prototype that must pass hard gates. |

## 1. Brand & design

| # | Decision | Why |
|---|----------|-----|
| 1.1 | Display name **"RusQ"** (from your logo); "ResQGrid" stays the spec/codename in docs. | Your design sheet's logo says RusQ, and the repo folder is RusQ. |
| 1.2 | Colours: neutral `#DDE5E3`, SOS/urgent red `#7F0000`, brand green `#0B4A22`; map shades `#3D0C0C`, `#B06B68`, `#F5E3E3`. | Taken from the colour-palette sheet. Red is reserved for SOS and anything needing sudden access. The three map shades mark area intensity. |
| 1.3 | Font: **Atkinson Hyperlegible**, self-hosted (bundled, precached). | It's on your list and designed for low-vision readers. Self-hosting means it works offline (a CDN font would fail in airplane mode). |
| 1.4 | **No hidden options**: no hamburger menus, no icon-only buttons, no hover-only controls. Every action is a visible, labelled button (icon + text), ≥ 48 px, base font 18 px. | Your instruction: everything visible and obvious for elderly people, children and non-technical users. |

## 2. Honesty rules (§2) – how they are enforced in code

| # | Decision | Why |
|---|----------|-----|
| 2.1 | A single state machine (`packages/shared/src/delivery.ts`) is the **only** code that can set `received`. It requires a **server-signed** ack whose `clientId`, `kind` and `serverId` match. | §2.1: never show success for something stored only on the device. One choke point is testable exhaustively (property test). |
| 2.2 | The server signs every ack with **ECDSA P-256**. Devices cache the public key during setup. | An ack relayed through other phones must still be trustworthy. A team member holding the shared team key cannot forge a server ack. |
| 2.3 | The "queued" label literally says *"Saved on this phone only. NOT sent yet."* | Plain language. The user must not mistake "saved" for "sent". |
| 2.4 | Simulated mesh code, UI and tests are named and labelled **SIMULATED**. The WebRTC link is labelled **EXPERIMENTAL**. | §2.2. |

## 3. Relay protocol (8A)

| # | Decision | Why |
|---|----------|-----|
| 3.1 | Envelope id **=** record id for `sos`/`report`/`allotment`. | Server acks map 1:1 to the item and to its delivery state. No lookup table needed. |
| 3.2 | Team key MAC = **HMAC-SHA-256** over canonical JSON of the envelope **excluding `hops`** (and `mac`). | `hops` changes at every relay. Tampering with it can only make a message expire sooner; it can't forge content. |
| 3.3 | Seen-set holds every accepted id. Anti-entropy sends the peer's `seen` list and the other side returns what's missing. | Simple, provably loop-free: a node never accepts an id twice, so it never re-forwards. |
| 3.4 | Default TTL = **64 hops**, reject if `hops ≥ ttl` on receipt, don't offer if `hops ≥ ttl`. | Larger than the biggest tested mesh (50 nodes), so TTL never blocks a real path, but it still bounds runaway forwarding. |
| 3.5 | Priority: `sos`=`ack`=0, `allotment`=`report`=1, `photo_thumb`=2, `photo_chunk`=3. Then HLC, then id. | §8A: small, urgent things first. Acks are tiny and stop wasteful forwarding, so they ride with SOS. |
| 3.6 | Photos = one thumbnail envelope + N chunk envelopes (16 KiB raw each) with a SHA-256 of the whole image. | Each chunk is independent, so an interrupted transfer resumes by only re-sending missing chunks. The hash catches corruption. |
| 3.7 | **HLC** encoded as fixed-width string `wall(15):counter(5, base36):node`. Remote clocks more than 24 h ahead are not adopted (the message is still accepted). | Lexical order = causal order. A phone with a wildly wrong clock can't poison everyone else's clock. |
| 3.8 | Gateway = any node with internet. It uploads held messages to `/api/mesh/upload`, verifies the returned acks, wraps them in `ack` envelopes and relays them back. | §8A gateway behaviour. Every node then drops acked items from its store. |
| 3.9 | Store cap 5000 messages, evicting the lowest-priority, newest item. | Bounded memory on a 3 GB phone. SOS and acks survive longest. |
| 3.10 | The **team key goes to any signed-in user**, victims included. | Victims' SOS must be able to hop over other phones. Known weakness: a shared symmetric key means any registered device can inject messages. Mitigated by server-side re-validation, rate limits and per-user ownership checks. Listed in LIMITATIONS.md. |
| 3.11 | Simulator: discrete ticks, seeded `mulberry32`, real `MeshNode`s and real crypto. A summary exchange can itself be lost. Packets are shuffled on arrival (out-of-order) and may be duplicated. | Reproducible runs (§8A) that exercise the *production* protocol code, not a model of it. |
| 3.12 | The relay property test has a **coverage guard** (min deliveries, multi-hop cases, no-path cases). | The first generator was too sparse and the property passed almost vacuously (only 89 deliveries, 19 multi-hop). The guard caught it and the generator was made denser. |

## 4. Allocation engine (8B)

| # | Decision | Why |
|---|----------|-----|
| 4.1 | **Exact integer arithmetic with BigInt.** The spec's weight is proportional to `W = need × (maxD + 2·density) × (urgency + 3)`, so every comparison and share uses W. | Guarantees byte-identical output on every device and the server (Gate 1 criterion 3) with no float drift. Floats appear only in the human-readable explanation. |
| 4.2 | Every quantity is an integer in the resource's unit (packs, boxes, boats…). Divisible goods use small units. | Integer largest-remainder stays exact. Indivisible items are never split by construction. |
| 4.3 | Cap and redistribution is done as **water-filling**: repeatedly cap every site whose proportional share ≥ need, then apply largest remainder to the uncapped sites (ties → smaller id, plain code-unit comparison, not locale). | An uncapped share is strictly < need, so the +1 from rounding can never exceed need. Proven by the property tests, including density/urgency monotonicity. |
| 4.4 | `densityNorm = 0` when every density is 0. | Avoids divide-by-zero. The density factor is then neutral, which matches the spirit of the rule. |
| 4.5 | **Density is an integer headcount.** An incident site's density = the report's victim count. | Keeps W integral. A headcount is what a rescuer can actually observe. |
| 4.6 | A provisional allotment covers *all* demand sites (the full plan), but its **`claim`** is only the share for the report's own incident site. Reconciliation sums **claims**. | If every device's full plan were summed, every shelter would be counted once per device and false conflicts would appear. A claim is what the device actually reserves. |
| 4.7 | A device subtracts its own earlier provisional claims (`alreadyAllotted`) from the snapshot stock. | §8B "track how much stock this device has already provisionally allotted". Stops one phone over-claiming against itself. |
| 4.8 | The engine never generates ids or reads clocks. The caller supplies `id` and `createdAt`. | §8B purity. |
| 4.9 | Server reconciliation: one **open conflict per resource**, updated as claims change. It auto-resolves (audit-logged) once pending claims fit live stock. Admin decisions (approve, approve-reduced, reject) are final and deduct live stock. Device values are never overwritten. | §8B "never silently overwrite; administrator's decision is final". |
| 4.10 | Stale-snapshot default threshold **6 h** (configurable). | A flood situation changes within hours. |

## 5. Server

| # | Decision | Why |
|---|----------|-----|
| 5.1 | **Fastify 5 + `node:sqlite`** (built into Node). | No native addon to compile (better-sqlite3 needs build tools on Windows), so it's easier to host anywhere Node 22+ runs. |
| 5.2 | Idempotency via the client UUID primary key. A repeat upload returns the *original* server id with `duplicate: true`. | §7. The client can retry blindly. |
| 5.3 | Human-friendly server ids `SOS-000001`, `RPT-…`, `ALT-…`, `PHO-…`. | Readable reference numbers for victims and the control room. |
| 5.4 | Auth tokens = HMAC-signed JSON with a 14-day expiry. Passwords use scrypt. | Rescuers may be offline for days and must not be logged out mid-disaster. No extra dependency. |
| 5.5 | Key material is created on first boot and stored in the DB, or supplied via env vars (`RUSQ_TOKEN_SECRET`, `RUSQ_TEAM_KEY`, `RUSQ_ACK_*_JWK`). | Works out of the box locally. Env vars for hosting. |
| 5.6 | Rate limits: global 600/min/IP, login 20/min, sync and mesh upload 120/min. `/api/health` is exempt. | Health is polled for reachability detection, so it must never be throttled. |
| 5.7 | The server serves the built web app (SPA fallback) from the same origin. | One service to host. The service worker and API share an origin, so there's no CORS. |
| 5.8 | Photo upload accepts only real JPEG/PNG/WebP magic bytes, max 8 MB. | Input validation. |
| 5.9 | Demo seed uses fictional people and shelters at real coordinates in **Guwahati, Assam** (a flood-prone city). Demo password `demo1234`, seeded only into an empty DB and disabled with `RUSQ_SEED=0`. | §10.8 flood scenario. |

## 6. Web app (PWA)

| # | Decision | Why |
|---|----------|-----|
| 6.1 | **Custom service worker** (vite-plugin-pwa `injectManifest`) with `registerType: 'prompt'`. Update checks run only when the health probe says online **and** the page is idle. | §5: a half-updated cache must never break the offline app. Workbox precaching installs atomically, so if any file fails the old version keeps serving. Nothing activates until the user taps "Update now". |
| 6.2 | Online/offline is decided by a 3 s `/api/health` probe only. `navigator.onLine` is trusted in **neither** direction. | §5 says don't trust it alone. Gate 1 showed WebKit keeping `onLine === false` after reconnecting, so trusting it for "offline" was also wrong (R: the first version short-circuited on `false`). |
| 6.3 | `delivery.ts` labels are the only delivery wording in the UI, via one `StatusBadge` component. | §2.1: no other code can print "Received". |
| 6.4 | Outbox items are uploaded **directly** (`/api/sync`, photo `PUT`). The phone's relay node only uploads **other phones'** messages when acting as gateway. | Gate 1 found the phone also re-uploaded its own items through the gateway path (wasteful duplicate). |
| 6.5 | Relay state is persisted **immediately** for originated and small accepted messages (photo chunks debounced). On start the node **self-heals** from the outbox. | Gate 1 found state lost when the app was closed within the debounce window. The outbox is the source of truth. |
| 6.6 | Photos are stored in IndexedDB as **ArrayBuffer, not Blob**. | WebKit failed with "Error preparing Blob/File data to be stored". |
| 6.7 | Implausible geolocation timestamps (> 24 h from now) are replaced with "now". | WebKit returned a non-epoch timestamp, the server (rightly) rejected the SOS, and an SOS must never fail on a clock quirk. |
| 6.8 | Location sources: `live`, `last_known` (always shown with "X ago"), `manual` (typed by the rescuer), `none`. | Typed coordinates must not be labelled as a live GPS fix. |
| 6.9 | WebRTC link: no ICE servers, SDP filtered to `typ host`, signalling text = deflate-raw + base64url (fits a QR code). Anti-entropy messages carry a `pull` flag so new local items are *pushed* too. | §8A host-only signalling. Without `pull`, a phone's new item only moved when the *other* phone asked. |
| 6.10 | Heavy screens (Mesh Lab, Nearby phones, Admin) are lazy-loaded but still **precached**. Server uses Brotli/gzip. | Lighthouse mobile performance went 75 → 98 on first install over slow 4G, and the screens still open offline. |
| 6.11 | Mesh Lab has a visible "Choose a phone" selector as well as canvas tapping. | Canvas-only selection was a hidden, inaccessible control, which breaks the "nothing hidden" rule. |
| 6.12 | Sign-out awaits the IndexedDB delete, then goes to the login screen. | Gate 1 found sign-out could be undone by quick navigation. |
| 6.13 | Login is needed **once online**. Tokens last 14 days. | Rescuers must keep working through days offline. |
| 6.15 | Nearby phones checks `RTCPeerConnection`. If it is missing, it shows a plain-language notice and disables connect. | Found on WebKit for Windows (no WebRTC): the page showed a raw technical error. Messages are still saved and sent later. |
| 6.14 | `window.__rusq = { allocate, canonicalJson }` is exposed (read-only, no data). | Lets the E2E test prove byte-identical output in each browser engine (V8 and JavaScriptCore). |

## 7. Vision (8C)

| # | Decision | Why |
|---|----------|-----|
| 7.1 | Models are **self-hosted** under `/models/` (downloaded by `fetch-models.mjs`). The ONNX runtime is self-hosted under `/ort/`. Both are runtime-cached cache-first by the SW and also prefetched in setup. | Phones never depend on Hugging Face or a CDN, which would fail offline. Hosting is self-contained. |
| 7.2 | CLIP **text embeddings precomputed at build time** for the 8 fixed prompts. Phones download only the vision tower (85 MB q8). | Saves 61–242 MB per phone and all text-model compute. The prompts are fixed by the spec anyway. |
| 7.3 | Detector: **YOLOS-tiny q8** (9 MB) for people/boats, counts shown as an estimate with confidence. | Smallest COCO detector available as ONNX. COCO has `person` and `boat`. |
| 7.4 | WASM **multithreading** via cross-origin isolation (COOP `same-origin`, COEP `require-corp`, CORP `same-origin`). Up to 4 threads, and **1 thread in low-power mode**. | Measured 9.5 s → 3.5 s per photo. Safe because everything RusQ loads is same-origin. |
| 7.5 | YOLOS input reduced to **384 / 640** (from 512 / 1333) in our served config. | Measured 3.5 s → 0.38 s warm and 2.2 GB → 526 MB peak RSS, with top-hazard accuracy unchanged. Count accuracy is unverified either way. |
| 7.10 | **Main-thread vision fallback** when `OffscreenCanvas` is missing (decided once at startup, before the shim is installed). It shims `OffscreenCanvas` with a `<canvas>` (+ `convertToBlob`) and sets ONNX Runtime `proxy: true` so inference still runs off the UI thread. | Found by running the real WebKit engine: transformers.js needs `OffscreenCanvas` for image decode/resize, and WebKit workers (and Safari < iOS 16.4) lack it. The alternative of re-implementing CLIP/YOLOS pre-processing would duplicate code and change accuracy. |
| 7.11 | One `vision-env.ts` configures transformers.js for both paths (worker and main thread). | Identical model files, thread policy and fallbacks on every path. |
| 7.6 | WebGPU is tried first and falls back to WASM. If models are missing, a manual-tagging notice is shown. A **MOCK** backend exists only behind a Settings switch and is always labelled MOCK. | §8C fallbacks. The mock is never used silently. |
| 7.7 | Vision pre-fills hazard tags (marked "suggested") and the people count (only if the rescuer hasn't touched it). It **never** changes urgency and **never** ticks resources. Hazard→resource hints are shown as text only. | §8B/§8C: advisory only. |
| 7.8 | Fixture set: 52 CC0/PDM images from Openverse, **every candidate reviewed by eye**. Rejected candidates are postcards, portraits, satellite images, cartoons and ambiguous scenes. Close-up crowds with identifiable faces were avoided where possible. | §9 needs ≥ 30 labelled CC0 images. Search-query labels are not ground truth. |
| 7.9 | Re-encoding through a canvas strips all EXIF (including GPS). Location is attached only via a visible checkbox, as a separate field. | §8C "strip or keep EXIF location only as an explicit, visible option". |

## 8. Testing

| # | Decision | Why |
|---|----------|-----|
| 8.1 | Each Playwright spec starts its **own** server process (fresh DB, free port) with `stop()`/`restart()`. | The LAN test needs the server **stopped** and then restarted (same DB and keys). |
| 8.2 | Honesty, kill-tab and model-missing E2E run with **service workers blocked**. | Playwright cannot intercept requests from a SW-controlled page or Background Sync. With SWs blocked, interception is airtight and the test asserts the interceptor really fired. The SW runs the identical `syncNow()` code, covered by unit/property tests. |
| 8.3 | Storage-full E2E uses **fault injection** (IndexedDB throws a real `QuotaExceededError`). | Chromium's quota override did not make IDB writes fail here. Documented in LIMITATIONS.md. |
| 8.4 | Low-end phone = Pixel 7 profile + **4× CPU throttling** (CDP). | §5 baseline device. |
| 8.5 | Lighthouse 12 without a PWA category. Installability comes from Chrome's `Page.getInstallabilityErrors`. | The PWA category was removed upstream. |
| 8.6 | The `node:sqlite`, Fastify and Playwright versions installed are recorded in the Gate 1 report. | Reproducibility. |

## 9. Hosting

| # | Decision | Why |
|---|----------|-----|
| 9.1 | A single **Dockerfile**: build stage downloads models and builds; runtime is Node 22 slim with a volume for the DB. | You asked for "easier to host later". One container, any Docker host. |
| 9.2 | `RUSQ_DB` / `RUSQ_STATIC` resolved to absolute paths. | A relative path crashed `@fastify/static` (found while smoke-testing the production bundle). |
| 9.3 | HTTPS is required in production (documented in the README). | Service workers, WebCrypto and the camera need a secure context. |

## 10. Manual testing

| # | Decision | Why |
|---|----------|-----|
| 10.1 | `scripts/inspect-db.mjs` opens the DB **read-only** to show what the server really received. | The Phase 1 admin UI has no SOS/report list (that dashboard is Phase 2), but testers need independent proof of delivery. |
| 10.2 | Phones reach the laptop through a **Cloudflare quick tunnel** (HTTPS) or **USB port forwarding** (`localhost`). | Service workers, WebCrypto and the camera need a secure context. A plain LAN IP over HTTP fails. |
