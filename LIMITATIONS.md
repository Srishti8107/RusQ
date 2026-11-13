# RusQ – Known Limitations (honest list)

Status as of **Gate 1** (Phase 1 complete, Phase 2 not started). Each item says what is
missing, why, and what would close it.

## 1. Not real / not verified on real devices

| # | Limitation | Detail |
|---|-----------|--------|
| 1.1 | **No real-phone results yet.** | Every phone test so far ran in **emulation**: Playwright Pixel 7 profile (Chromium) and iPhone 13 profile (WebKit on Windows). Emulation is not a real device. Every row in [docs/PHONE_TEST.md](docs/PHONE_TEST.md) is **"not run"** until you test on real phones. |
| 1.2 | **The multi-hop mesh is SIMULATED.** | Browsers cannot use phone radios (Bluetooth mesh, Wi-Fi Direct). The Mesh Lab runs the real protocol code over a *virtual* radio. It proves the protocol logic, not radio behaviour. |
| 1.3 | **The real peer link is EXPERIMENTAL and was tested only on one machine.** | WebRTC with host candidates only, between two browser contexts on the same PC. Two phones on a hotspot were **not tested**. Known risks: Chrome hides local IPs behind mDNS `.local` names, and some hotspots block mDNS or client-to-client traffic, so the link may fail on some networks. Signalling is manual (copy-paste or QR). |
| 1.4 | **Vision accuracy is measured on 52 public-domain photos, not real flood footage from the target region.** | Labels were assigned by eye before the model was run (no tuning). Small set: per-label results for 4–6 images are noisy. |
| 1.5 | **People/boat counts are unverified.** | The fixture set has no ground-truth counts. The detector's counts are shown as an *estimate with confidence*, and the rescuer must count. |
| 1.6 | **Vision performance on a 3 GB phone is unknown.** | Measured on a laptop (Chromium, 4 WASM threads): warm median **376 ms**, cold median 443 ms. A low-end phone CPU may be 3–8× slower. Peak memory **526 MB** was measured in **Node** (onnxruntime-node). The browser worker's memory could not be measured directly. |
| 1.7 | **Storage-full was tested by fault injection.** | Chromium's DevTools quota override did not make IndexedDB writes fail here. The test makes IndexedDB throw the real `QuotaExceededError` DOMException. A physically full phone has not been tested. |
| 1.8 | **WebKit (iPhone profile) coverage is partial.** | Passes on WebKit: offline flow, honesty, kill tab, storage full, byte-identical allocation (JavaScriptCore), axe, Mesh Lab, real-model vision offline, model-missing fallback. **Not covered:** the phone-to-phone link (Playwright's WebKit for Windows has **no WebRTC**; real iPhone Safari does, but it is untested), installability and persistent-profile cold start (Chromium-only test APIs). Playwright's WebKit on Windows is not Safari on iOS. |
| 1.10 | **On WebKit/older Safari, vision runs on a main-thread fallback.** | Workers there lack `OffscreenCanvas`, which transformers.js uses to decode and resize images. The fallback shims it with a normal canvas on the main thread. Inference still runs in ONNX Runtime's proxy worker, but image pre-processing (a few tens of ms) briefly uses the UI thread. ~0.6 s/photo on the laptop; iPhone speed unknown. |
| 1.9 | **Lighthouse has no PWA category any more.** | Lighthouse 12 removed it. Installability is checked with Chrome's own verdict (`Page.getInstallabilityErrors` → no errors), and offline behaviour by the E2E tests. Lighthouse covers performance, accessibility, best practices and SEO. |

## 2. Platform limits (cannot be fixed in a PWA)

- A PWA **cannot send without some path**: internet, a LAN/hotspot peer, or a gateway phone.
- **No background location** when the app is closed. The last known position is saved on every fix, on `online`/`offline` events and on app open, and is always labelled with its age.
- **iOS:** no Background Sync and no manifest shortcuts. Sync runs when the app opens or returns to the foreground. A separate "SOS" home-screen entry is planned for Phase 2. iOS may clear site data after weeks without use, so the setup page shows a re-open reminder.
- Persistent storage is a *request*. The browser may still refuse (`persisted() === false` is shown to the user).

## 3. Security limits (prototype)

- **One shared team key (symmetric HMAC)** authenticates relay envelopes. Any registered device, victims included, holds it, so a malicious registered user could inject relay messages. Mitigations: the server re-validates every record, victims may only submit SOS for their own user id, rate limits apply, and **server acks are separately ECDSA-signed** so they cannot be forged with the team key. Fix: per-device signing keys registered while online.
- The `hops` field is outside the MAC by design (it changes at every hop). Tampering can only make a message expire sooner.
- Auth tokens last 14 days so rescuers stay signed in offline. There's no revocation list yet.
- Demo accounts use the password `demo1234`. Set `RUSQ_SEED=0` for any real deployment.
- Single SQLite file, no backups or replication (prototype).

## 4. Design limits

- **The provisional allotment is advisory.** Two offline phones cannot know each other's claims. The server flags conflicts and the admin decides, with no automatic overwrite.
- A device's "already allotted" counter only counts claims against the **current** snapshot version.
- The relay seen-set grows without bound (ids only, about 40 bytes each). Pruning old acked ids is future work.
- The production `dist/` also contains a bundler-emitted copy of the ONNX WASM (21.6 MB) that the app never loads (it uses `/ort/`). It's dead weight on the host and is **not** precached or downloaded by phones.
- The YOLOS detector input size was reduced (384/640 instead of 512/1333) for phone speed. It's a deliberate accuracy/speed trade-off for an estimate-only count.

## 5. Not built yet (Phase 2, by design)

Victim registration/profile UI, iOS SOS home-screen entry, offline shelter map (MapLibre + PMTiles), admin central map/heatmap, decision support, CCTV demo, missing-person workflow, optional Llama assistant. The setup checklist has no "map region" item until the map exists.
