# RusQ – Known Limitations (honest list)

Status as of **Gate 2** (Phase 1 and Phase 2 complete, both gates passed in emulation). Each item says what is
missing, why, and what would close it.

## 1. Not real / not verified on real devices

| # | Limitation | Detail |
|---|-----------|--------|
| 1.1 | **No real-phone results yet.** | Every phone test so far ran in **emulation**: Playwright Pixel 7 profile (Chromium) and iPhone 13 profile (WebKit on Windows). Emulation is not a real device. Every row in [docs/PHONE_TEST.md](docs/PHONE_TEST.md) is **"not run"** until you test on real phones. |
| 1.2 | **Multi-hop works only over Wi-Fi/hotspot links, not phone radios.** | Browsers cannot use Bluetooth mesh or Wi-Fi Direct. Messages hop over the WebRTC links between phones on the same Wi-Fi/hotspot (A → B → C → server, tested with 3 browsers on one PC; the hop alerts and counts make it checkable on real phones). The former Mesh Lab simulator was removed (decisions.md 13.2); the protocol stays covered by simulation/property tests. |
| 1.3 | **The real peer link is EXPERIMENTAL and was tested only on one machine.** | WebRTC with host candidates only, between two browser contexts on the same PC. Two phones on a hotspot were **not tested**. Known risks: Chrome hides local IPs behind mDNS `.local` names, and some hotspots block mDNS or client-to-client traffic, so the link may fail on some networks. Signalling is AUTOMATIC through the server while the phones can reach it (see 6.3), with a copy-paste code as fallback. |
| 1.4 | **Vision accuracy is measured on 52 public-domain photos, not real flood footage from the target region.** | Labels were assigned by eye before the model was run (no tuning). Small set: per-label results for 4–6 images are noisy. |
| 1.5 | **People/boat counts are unverified.** | The fixture set has no ground-truth counts. The detector's counts are shown as an *estimate with confidence*, and the rescuer must count. |
| 1.6 | **Vision performance on a 3 GB phone is unknown.** | Measured on a laptop (Chromium, 4 WASM threads): warm median **376 ms**, cold median 443 ms. A low-end phone CPU may be 3–8× slower. Peak memory **526 MB** was measured in **Node** (onnxruntime-node). The browser worker's memory could not be measured directly. |
| 1.7 | **Storage-full was tested by fault injection.** | Chromium's DevTools quota override did not make IndexedDB writes fail here. The test makes IndexedDB throw the real `QuotaExceededError` DOMException. A physically full phone has not been tested. |
| 1.8 | **WebKit (iPhone profile) coverage is partial.** | Passes on WebKit: offline flow, honesty, kill tab, storage full, byte-identical allocation (JavaScriptCore), axe, real-model vision offline, model-missing fallback. **Not covered:** the phone-to-phone link (Playwright's WebKit for Windows has **no WebRTC**; real iPhone Safari does, but it is untested), installability and persistent-profile cold start (Chromium-only test APIs). Playwright's WebKit on Windows is not Safari on iOS. |
| 1.10 | **On WebKit/older Safari, vision runs on a main-thread fallback.** | Workers there lack `OffscreenCanvas`, which transformers.js uses to decode and resize images. The fallback shims it with a normal canvas on the main thread. Inference still runs in ONNX Runtime's proxy worker, but image pre-processing (a few tens of ms) briefly uses the UI thread. ~0.6 s/photo on the laptop; iPhone speed unknown. |
| 1.9 | **Lighthouse has no PWA category any more.** | Lighthouse 12 removed it. Installability is checked with Chrome's own verdict (`Page.getInstallabilityErrors` → no errors), and offline behaviour by the E2E tests. Lighthouse covers performance, accessibility, best practices and SEO. |

## 2. Platform limits (cannot be fixed in a PWA)

- A PWA **cannot send without some path**: internet, a LAN/hotspot peer, or a gateway phone.
- **No background location** when the app is closed. The last known position is saved on every fix, on `online`/`offline` events and on app open, and is always labelled with its age.
- **iOS:** no Background Sync and no manifest shortcuts. Sync runs when the app opens or returns to the foreground. A separate "SOS" home-screen entry replaces them (see 5.2). iOS may clear site data after weeks without use, so the setup page shows a re-open reminder.
- Persistent storage is a *request*. The browser may still refuse (`persisted() === false` is shown to the user).

## 3. Security limits (prototype)

- **One shared team key (symmetric HMAC)** authenticates relay envelopes. Any registered device, victims included, holds it, so a malicious registered user could inject relay messages. Mitigations: the server re-validates every record, victims may only submit SOS for their own user id, rate limits apply, and **server acks are separately ECDSA-signed** so they cannot be forged with the team key. Fix: per-device signing keys registered while online.
- The `hops` field is outside the MAC by design (it changes at every hop). Tampering can only make a message expire sooner.
- Auth tokens last 14 days so rescuers stay signed in offline. There's no revocation list yet.
- The seeded `admin` account uses the password `demo1234` – change it (or set `RUSQ_SEED=0` and create your own) for any real deployment. No other accounts are created (decisions.md 12.13).
- Single SQLite file, no backups or replication (prototype).

## 4. Design limits

- **The provisional allotment is advisory.** Two offline phones cannot know each other's claims. The server flags conflicts and the admin decides, with no automatic overwrite.
- A device's "already allotted" counter only counts claims against the **current** snapshot version.
- The relay seen-set grows without bound (ids only, about 40 bytes each). Pruning old acked ids is future work.
- The production `dist/` also contains a bundler-emitted copy of the ONNX WASM (21.6 MB) that the app never loads (it uses `/ort/`). It's dead weight on the host and is **not** precached or downloaded by phones.
- The YOLOS detector input size was reduced (384/640 instead of 512/1333) for phone speed. It's a deliberate accuracy/speed trade-off for an estimate-only count.

## 5. Phase 2 limits

| # | Limitation | Detail |
|---|-----------|--------|
| 5.1 | **The AI writing helper was never run with the real model.** | No WebGPU in this environment's test browsers. Verified: it is off by default, the app works fully without it, the worker is not precached, and the guard (schema + "no new numbers") rejects invented numbers (unit + property tests). **Not verified:** model download (~0.9 GB), load time, reply quality, memory use on a phone (a 3 GB phone will very likely not cope). |
| 5.2 | **The iOS "SOS" home-screen entry was not tested on an iPhone.** | Tested in emulation: the page offers its own manifest (id `/sos-app`, start_url `/sos?source=sos_entry`), icon and title. Whether Safari uses the swapped manifest or the page URL, both open the SOS screen, but Add to Home Screen must be tried on a real iPhone. |
| 5.3 | **The map covers one sample region only** (central Kathmandu, Nepal, about 9 × 8 km, zoom 10–15). | Roads, water and railways only; no street names (no glyphs downloaded). Outside the region the map is blank. Another region needs `npm run build:map` with a new bounding box. |
| 5.4 | **The map needs WebGL.** | Without it a notice appears and the page falls back to the shelter list (always shown anyway). Tested only in emulated Chromium/WebKit. |
| 5.5 | **Decision-support rules are hand-made heuristics, not validated against real operations.** | Thresholds (score weights, 1 rescuer per 5/10 people, 1 boat per 6, 90 % shelter warning, 30 min "unattended") are documented in `decision.ts` and shown with every recommendation, but nobody from disaster management has reviewed them. |
| 5.6 | **Team positions are approximate.** | The server only knows a team's latest field-report location; team–skill matching uses that, or "position unknown". There is no live tracking. |
| 5.7 | **People counts per area can double-count.** | An SOS household and a field report from the same place are added together (max with the sample CCTV crowd). Shown as an estimate with its parts. |
| 5.8 | **The CCTV cameras are sample data.** | Synthetic clips, hand-written labels. The footage analyser (6.4) works on video files chosen by the admin, not on live cameras. |
| 5.9 | **Missing-person matching uses a fictional sample registry** and simple text similarity. | No faces, no photos, no real records. Confidence is a weighted heuristic, not a probability. |
| 5.10 | **Admin screens are read-only offline.** | Decisions need the server (audit log, ordering). Saved views show their age. |
| 5.11 | **Two admins deciding at once:** the second decision on the same item gets "already decided" (409). | There is no live push; screens refresh every 20–30 s or on demand. |
| 5.12 | **No password reset or account removal UI.** | An admin can create accounts; disabling exists as a DB column (`users.disabled`), not as a screen. |
| 5.13 | **Profile edits on two phones**: the newest `updatedAt` wins as a whole; there is no per-field merge. | |

## 6. Limits of the 2026-11-13 changes

| # | Limitation | Detail |
|---|-----------|--------|
| 6.1 | **Victims sign in with a user ID only – no password** (owner's decision). | Anyone who knows or guesses a person's user ID can sign in as that person and see their profile and missing-person cases, and send SOS in their name. Mitigations: the suggested IDs are random (`np-` + 6 characters, about 887 million combinations), the login is rate-limited (20 per minute per address), and rescuer/admin accounts still need a password. Not suitable where profiles hold sensitive data, unless a PIN is added later. |
| 6.2 | **The Online/Offline badge can still lag by a few seconds.** | It now needs two failed checks (about 8 s) before showing Offline, and checks every 4 s while offline. A very slow link (answers > 6 s) is shown as Offline, honestly: the server cannot be used then. |
| 6.3 | **Automatic phone linking needs the server once.** | Web apps cannot scan for nearby phones (no Bluetooth or Wi-Fi discovery in browsers). Phones are introduced while both can reach the server from the same network (same public address); the link then works without internet. Two phones that were never online together on the same Wi-Fi/hotspot still need the copy-paste code. Phones on mobile data behind the same carrier address may be introduced but cannot connect (harmless, retried). Tested only between browser contexts on one PC. |
| 6.4 | **The footage analyser is unmeasured on real CCTV.** | It uses the photo helper's pre-trained models (CLIP + YOLOS-tiny), which were checked on 52 still photos (accuracy 0.769), not on CCTV video. It looks at ≤ 20 frames, counts are estimates (crowds are under-counted), night/infra-red footage is untested, and only video formats the browser can play work (MP4 H.264 / WebM). It is NOT training: one clip cannot train a model. The automated test uses the MOCK detector. |
| 6.5 | **The "SOS reached the control room" notification was not shown on a real phone.** | Headless test browsers refuse notifications, so the test replaces `Notification` with a recorder (proves when and with what text). iPhone shows notifications only for an installed home-screen app (iOS 16.4+) and only after the person allowed them. The message under the SOS button always shows the same information. |
| 6.6 | **Nepal sample data is fictional.** | Shelter names, phone numbers and people are invented; the localities and coordinates are real places in Kathmandu district. |

## 7. Limits of the second change round

| # | Limitation | Detail |
|---|-----------|--------|
| 7.1 | **No face matching on missing-person photos.** | The control room compares photos by eye. Candidates are still proposed from text only (name, age, description, place). |
| 7.2 | **A phone that never reached the server together with the others cannot link automatically.** | Web apps cannot scan for nearby phones. The alerts make it visible whether a transfer happened; if none appears, use the code on Nearby phones. |
| 7.3 | **The "who" in alerts comes from the other phone.** | Each phone announces its own user ID when linking (inside the team-key-protected link); a phone with a modified app could announce a wrong name. The content itself is protected by the team key's MAC. |
| 7.4 | **Hop counts can be lowered, not faked upwards usefully.** | The hop counter is outside the signature by design (every phone increments it). A tampered count changes only the number shown and could expire a message sooner. |
| 7.5 | **Control-room pop-ups check every 5 s.** | So they appear up to about 5 s late; while the admin is offline none appear (they show up afterwards, one per item). Desktop notifications need the admin's permission. |
