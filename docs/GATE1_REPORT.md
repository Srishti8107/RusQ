# Gate 1 Report – RusQ (spec: ResQGrid), Phase 1

All results are **actual runs** on 2026-11-13, on a Windows 11 laptop with Node 26.13.1,
Playwright 1.65 (Chromium and WebKit) and Lighthouse 12.8.2.
Re-run with: `npm run typecheck && npm test && npx playwright test && node tests/lighthouse/run-lighthouse.mjs`.

## Exit criteria

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | All unit, property, simulation, integration and E2E tests pass | **PASS** | Vitest **85/85**. Playwright **23 passed, 0 failed, 5 skipped by design** (13 Pixel + 10 iPhone/WebKit) |
| 2 | No code path shows delivered/received without a server ack | **PASS** | `delivery.test.ts` property test (random event sequences never reach `received` without a verified, matching, server-signed ack). E2E "honesty": empty, forged and mismatched acks never show Received, on **both** engines |
| 3 | Allocation byte-identical client vs server | **PASS** | E2E: 200 seeded random inputs, `JSON.stringify` equal between the browser engine and `/api/allocate`, in **V8 (Pixel)** and **JavaScriptCore (iPhone/WebKit)**. Plus a server integration parity test |
| 4 | Offline-to-offline relay delivers in every connected-path scenario | **PASS** | `simulation.test.ts` (15 seeded scenarios) + `relay.property.test.ts` (100 random graphs: 304 deliveries, 141 multi-hop, 147 correctly-undelivered no-path cases). **Real** WebRTC E2E: report hops A→B with the server down, B acts as gateway, the signed ack returns over the link |
| 5 | Vision works fully offline after setup, or limitation documented and fallback verified | **PASS** | E2E: real CLIP + YOLOS in the Web Worker with the network blocked (WASM). Corrupt and huge images handled. Missing model → manual-tagging notice, and the report still saves |
| 6 | Known limitations listed honestly | **PASS** | [LIMITATIONS.md](../LIMITATIONS.md) |
| 7 | Emulated phone tests pass; real-device checklist delivered with every item pass or not run | **PASS (emulated)** / **real devices: NOT RUN** | Pixel profile with 4× CPU throttle and iPhone profile. [PHONE_TEST.md](PHONE_TEST.md): all 15 rows "not run" |

## Test table

### Unit and property (Vitest)

| Area | Tests | Result |
|------|-------|--------|
| Delivery state machine (incl. property: never received without verified ack; backoff bounds) | 7 | pass |
| Relay protocol: envelope validation, MAC rejection, forged server-ack rejection, TTL/hops, duplicate suppression, anti-entropy, priority, chunk reassembly/corruption, HLC | 21 | pass |
| Allocation hand-computed cases: full, density, urgency, cap and redistribution, largest remainder, ties, zero stock, zero need, single site, indivisibles, extreme densities (10 M vs 0), all-zero density, alreadyAllotted, invalid input | 16 | pass |
| Allocation properties (400–600 runs each): ≤ stock and uses all stock or meets all needs; ≤ need, integers; deterministic; order-independent; density monotone; urgency monotone; all needs met when stock suffices | 7 | pass |
| Provisional/claim, staleness, reconciliation | 3 | pass |
| Relay properties: eventual delivery, no duplicates, no infinite forwarding (+ coverage guard) | 1 (100 graphs) | pass |

### Seeded mesh simulations (SIMULATED)

| Scenario | Result |
|----------|--------|
| Line, 20 nodes, no loss, ack returns to origin (< 60 ticks), quiesces | pass |
| Line, 30 nodes at 10 %, 25 % and 40 % loss | pass |
| Star, 25 nodes, gateway on a leaf, 20 % loss | pass |
| Random geometric, 50 nodes, 3 seeds, 15 % loss, 10 % duplicates. Unreachable nodes correctly NOT delivered | pass |
| Node churn (intermediate nodes toggling) | pass |
| Partition then heal (nothing crosses during the partition) | pass |
| Two gateways (stored once, acks deduplicated) | pass |
| Gateway appearing late | pass |
| Out-of-order + 50 % duplicated delivery | pass |
| Photo interrupted mid-transfer then resumed (only missing chunks re-sent) | pass |
| Clock skew of ±hours between nodes | pass |

### Integration (server, `app.inject`)

| Test | Result |
|------|--------|
| Same SOS id ×5 → one record, same server id, `duplicate` flag | pass |
| Ack ECDSA signature verifies with the published key; a tampered ack fails | pass |
| Same report ×5 in one batch and across batches → one record | pass |
| Photo PUT idempotent; non-image rejected | pass |
| Mesh gateway upload: MAC-valid accepted, forged rejected; ack relayed back to origin | pass |
| Photo chunks out of order across uploads → reassembled, byte-exact | pass |
| Two devices over-allocate → conflict record; device values not overwritten; admin reject + approve-reduced resolves it; decisions final; audit trail | pass |
| Approval cannot exceed the device claim or live stock | pass |
| Snapshot versioning; older allotments flagged stale | pass |
| `/api/allocate` byte-identical to the in-process engine | pass |
| Auth required on all data endpoints; forged token rejected | pass |
| RBAC: victim can't read admin data or submit reports/others' SOS; rescuer can't decide allotments | pass |
| Schema validation rejects bad input, creates no records | pass |
| Login rate limit → 429 | pass |
| No secrets in client-facing responses | pass |

### End-to-end (Playwright)

| Test | Pixel 7 (Chromium, 4× CPU) | iPhone 13 (WebKit) |
|------|----------------------------|--------------------|
| Offline: shell from SW, SOS + report queued, persists across reload and new tab, "sent" while in flight, received only after ack, exactly one server record each | pass | pass |
| Honesty: empty / forged / mismatched ack never shows Received; nothing reached the server | pass | pass |
| Kill tab mid-sync (server processed, response lost) → resume → received, still one record | pass | pass |
| Storage full (fault injection) → clear message, nothing crashes (report and SOS) | pass | pass |
| Allocation byte-identical, browser vs server, 200 inputs | pass (V8) | pass (JSC) |
| axe: 0 serious/critical violations on 10 Phase 1 screens | pass | pass |
| Installability (Chrome's own verdict) + SOS shortcut in manifest | pass | skipped (Chrome-only API) |
| Cold start offline after the browser was fully closed (persistent profile) | pass | skipped (Chromium API) |
| Mesh Lab UI delivers an SOS | pass | pass |
| Real LAN link with the server stopped; ack returns over the link | pass | skipped – **this WebKit build has no WebRTC** (`RTCPeerConnection` undefined) |
| Browser without WebRTC → plain-language notice, connect disabled | skipped (has WebRTC) | pass |
| Real vision offline; corrupt + huge image | pass (Web Worker) | **pass** (main-thread fallback, ~0.6 s/photo) |
| Model missing → manual fallback, report saves (SW blocked so the 404 is airtight) | pass | pass |
| Browser vision latency over 52 fixtures | pass (measured) | skipped |

## Vision evaluation

The fixture set is **52 images, CC0 / Public Domain Mark** (Openverse), labelled by eye *before*
the model was run, with attribution in `tests/fixtures/vision/LABELS.json`.
Models: CLIP ViT-B/32 vision tower (q8) with precomputed text embeddings, plus YOLOS-tiny (q8).

| Metric | Browser (shipped worker, WASM, 4 threads, network blocked) | Node (onnxruntime CPU, same `vision-core.ts`) | Target |
|--------|---------------------------------|----------------------|--------|
| Top hazard correct | **76.9 %** | 84.6 % | ≥ 70 % → **met** |
| Hazard-tag recall (non-normal) | – | 90.7 % | – |
| Cold analysis (median) | 443 ms | 212 ms (+ 532 ms model load) | – |
| Warm analysis (median / p90) | **376 / 440 ms** | 194 / 227 ms | ≤ 5 s → **met (laptop)** |
| Peak memory | not measurable in the browser worker | 526 MB RSS | – |

The browser figure is lower because the shipped path re-encodes photos (≤ 1280 px, JPEG q0.7) before analysis. It's the number that matters for users.

**Per label, top-1 precision / recall (browser):**

| Label | Precision | Recall |
|-------|-----------|--------|
| flooded street | 1.00 | 0.90 |
| collapsed building | 0.50 | 0.83 |
| blocked road | 0.88 | 0.88 |
| fire or smoke | 1.00 | 0.80 |
| landslide debris | 0.43 | 0.75 |
| damaged bridge | 0.60 | **0.50** (weakest) |
| people waiting for rescue | 1.00 | 1.00 |
| normal street | 1.00 | 0.56 |

**Performance history (real measurements, not tuning the test):**

| Change | Warm median | Peak RSS |
|--------|-------------|----------|
| Initial: 1 WASM thread | 9.5 s (**missed target**) | 2.2 GB |
| + cross-origin isolation, 4 threads | 3.5 s (split: CLIP 64 ms, detector 3.45 s) | – |
| + detector input 384/640 instead of 512/1333 | **376 ms** (accuracy unchanged) | 526 MB |

## Lighthouse (mobile emulation, 4× CPU, slow 4G) – `/login`

| | Before | After (compression + lazy routes) |
|-|--------|-------|
| Performance | 75 | **98** |
| Accessibility | 100 | 100 |
| Best practices | 100 | 100 |
| SEO | 100 | 100 |
| FCP / LCP | 4.0 s / 4.4 s | 1.75 s / 2.15 s |

Lighthouse 12 has no PWA category (removed upstream). See criterion 7 and the installability E2E test.

## Bugs found by the gate and fixed

1. Missing `/models/*` files returned the SPA's `index.html` with status 200 → now a real 404.
2. A phone acted as gateway for its *own* items too (duplicate upload) → the gateway now uploads only other phones' messages.
3. Relay state was persisted with a debounce and lost if the app closed quickly → immediate persist, plus self-heal from the outbox on start.
4. `navigator.onLine` stuck at `false` in WebKit kept the app "Offline" → only the health probe decides.
5. WebKit geolocation timestamp produced an invalid date and the server rejected the SOS → implausible timestamps replaced with now.
6. WebKit failed to store Blobs in IndexedDB → photos stored as ArrayBuffer.
7. Sign-out raced the IndexedDB delete → awaited, then redirects to login.
8. Mesh Lab phone selection was canvas-only → visible "Choose a phone" selector.
9. Vision missed the 5 s target (9.5 s) → threads + detector size → 376 ms.
10. WebKit workers have no `OffscreenCanvas`, which transformers.js needs for image decode/resize → vision failed ("Helper unavailable", manual fallback worked). Added a **main-thread fallback** with a canvas shim; inference still runs in ONNX Runtime's proxy worker. Now passes offline on WebKit.
11. Without WebRTC the Nearby-phones page showed a raw `RTCPeerConnection` error → plain-language notice, buttons disabled.
12. The model-missing test was silently satisfied by the service worker serving real models on WebKit (interception bypassed) → test now blocks SWs; result verified on both engines.

## Unverified

- Real phones, real hotspot relay, battery drain and storage eviction (see [PHONE_TEST.md](PHONE_TEST.md)).
- Vision speed on a 3 GB phone; browser memory; people/boat count accuracy.
- WebKit: the LAN link (this WebKit build lacks WebRTC; real iPhone Safari has it – untested). WebKit vision works in emulation via the main-thread fallback; real iPhone speed is untested.

## Decision

All mandatory Gate 1 items pass in emulation, and the real-device checklist is delivered with every row "not run".
**Phase 2 may start**, carrying the unverified items above. Real-device results should be filled in as soon as phones are available.
