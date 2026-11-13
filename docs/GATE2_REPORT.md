# Gate 2 Report – RusQ (spec: ResQGrid), full regression + final report

All results are **actual runs** on 2026-11-13: Windows 11 laptop, Node 26.13.1,
Playwright 1.65 (Chromium + WebKit) and Lighthouse 12.8.2.
Re-run with: `npm run typecheck && npm test && npm run build && npx playwright test && node tests/lighthouse/run-lighthouse.mjs`.

## Gate 2 criteria (§11)

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Re-run every Gate 1 test | **PASS** | Vitest **126/126** (the 85 Gate 1 tests unchanged + 41 new). Playwright **38 passed, 0 failed, 0 flaky, 6 skipped by design** (the 5 Gate 1 skips + the flood scenario on WebKit, which has no WebRTC). Typecheck clean. Lighthouse (mobile, `/login`): performance **97**, accessibility **100**, best practices **100**, SEO **100** (Gate 1: 98/100/100/100) |
| 2 | Complete flood scenario end to end | **PASS (emulated, Chromium)** | `tests/e2e/flood.spec.ts`, 1 test, 3 browser contexts (victim + 2 rescuers) + admin: register and cache online → server down → offline SOS → offline map → offline reports with the **real** vision model (WASM) and provisional allotments → victim's SOS relayed to a rescuer phone over the **real WebRTC link** → server back, rescuer acts as gateway, signed ack returns over the link → both reports received → reconciliation **conflict** on boats (3 + 3 > 4) → admin approves one and rejects one in the UI, conflict resolved → admin approves a recommendation → missing-person case: announce refused (409) before verification, then review → checklist verify → announce → audit log contains every step |
| 3 | Role-based access (victim can't read admin data; rescuer can't approve allotments) | **PASS** | Server: every admin GET (12 routes) returns 403 for victim **and** rescuer and 401 unauthenticated. A rescuer gets 403 on allotment decisions, recommendation decisions, SOS status, missing-person actions, user creation and the CCTV switch. Team tasks: rescuer only. E2E: a victim is redirected from `/admin/*` and the browser's own API call gets **403** |
| 4 | Missing-person announcement impossible without manual verification | **PASS** | Shared property test (500 random action sequences × both roles): `announced` is reached only via `under_review → verify → announce`, a recorded verifier is always present, and the family view never contains candidate data before `verified`. Every illegal (state, action) pair throws. Server: announce/verify out of order → 409; incomplete checklist or missing note → 409; families see `reported` while the case is `candidate_found`/`under_review`. E2E (both engines) through the real UI |
| 5 | Final report: works / simulated / unverified / limitations | **DONE** | Below + [LIMITATIONS.md](../LIMITATIONS.md) |
| 6 | Phone tests re-run: emulated pass; real-device checklist shows results or "not run" | **PASS (emulated)** / **real devices: NOT RUN** | Pixel 7 profile with 4× CPU throttling and iPhone 13 profile (WebKit). [PHONE_TEST.md](PHONE_TEST.md): 27 rows (15 Gate 1 + 12 Phase 2), **all "not run"** |

## New tests in Phase 2

### Unit and property (`packages/shared/test/phase2.test.ts`, 25 tests)

| Area | Result |
|------|--------|
| Geo: polynomial cosine vs `Math.cos` (< 1e-6), distance within 0.5 % of haversine, symmetric, integer; grid cells | pass |
| Missing-person workflow: full legal path; **every** illegal edge rejected; verify preconditions (named admin, candidate on case, full checklist, note); **property** (500 runs): no skipping, no leak to families, non-admins can't move past `candidate_found` | pass |
| Matcher (sample registry): exact-name similarity 1; true match ranked first (> 0.8) with evidence and `sample: true`; gender mismatch penalised; deterministic and registry-order independent | pass |
| Decision support: **hand-computed** area score (2·23 + 10 + 10 + 40 + 15 = 121 → critical) and unattended-SOS rule; every recommendation has reasoning, severity order, all 6 kinds produced; boat-skilled team → flooded area; ≥ 90 % shelter warning; resource distribution **byte-identical** to an independent `allocate()` run, shortfall → critical unmet need; **property**: deterministic, independent of input order, never mutates input, each team suggested once; personnel formula; sample CCTV raises the area score | pass |
| SOS triage: base 3, +1 per rule, capped at 5, "no location" reason; vulnerability flags | pass |
| CCTV sample data: all `sample`, boxes and times valid, signal summary (crowd 13 on CAM-01) | pass |
| AI guard: copies-only output accepted; invented number, number words, bad JSON and unknown labels rejected; number normalisation; **property** (200 runs): the template explanation always names the request and passes its own guard, and an injected number is always rejected | pass |

### Server integration (`apps/server/test/phase2.test.ts`, 16 tests)

| Test | Result |
|------|--------|
| Register → victim token, profile stored, normal sign-in afterwards; taken username 409; short password / bad username 400; a `role` field in the request is ignored | pass |
| Profile last-write-wins by `updatedAt`; invalid contact 400 | pass |
| Shelters with details and free places | pass |
| RBAC matrix (3 tests above) | pass |
| SOS monitor: level 5 with reasons and contacts from the profile; assign needs a known team; the victim sees "assigned / Team Alpha"; only that team gets the SOS as a task; audit entry | pass |
| Decisions: recommendations with reasoning; approve → second decision 409, stale/unknown id 409; approved assignment becomes that team's task; audit | pass |
| CCTV sample switch removes the CCTV evidence from the rules | pass |
| Dashboard counts, 24 h timeline, resources, map layers | pass |
| Missing persons: signed `missing` ack; same id 5× → one record; candidate proposed; full workflow with refusals; reject → back to `reported`; no-match stays `reported`; a person can only report as themselves and see only their own cases | pass |
| Staff account created by an admin can sign in; duplicate 409; rescuer without team 400; no password hashes in the list; the new team joins team–skill matching | pass |
| **Database upgrade**: a Phase 1-shaped DB gets the new columns and tables and keeps its rows | pass |

### E2E (`tests/e2e/phase2.spec.ts` + `flood.spec.ts`, both phone profiles)

| Test | Pixel (Chromium, 4× CPU) | iPhone (WebKit) |
|------|------|------|
| Register online → cache map + shelters → **offline**: map from the phone's cache (MapLibre reports > 50 drawn road/water features), "Last known location, X ago" with permission removed, 5 shelters → offline SOS **carries the profile** → received only after the ack → admin assigns a team → victim sees "Team Alpha" | pass | pass |
| Missing person in the UI: family report queued offline → received; candidate proposed; verify not offered before review; family sees only "reported"; verify refused without the checklist; verify → family sees "found"; not announced until Announce; announcement on Home | pass | pass |
| Admin: dashboard (critical area, resources, map drawn), reports comparison, approve a recommendation → exactly one team task, CCTV page labelled SAMPLE, people list; **offline**: saved copy labelled with its age, approve disabled, dashboard map still draws | pass | pass |
| Role guards in the app + browser API call 403 | pass | pass |
| iOS SOS entry: swapped manifest `/sos.webmanifest` (`start_url /sos?source=sos_entry`, id `/sos-app`), SOS icon, restored on leaving | pass | pass |
| axe (WCAG 2.1 AA, serious/critical): register, victim home, profile, map, missing (family), SOS entry, dashboard, SOS monitor, reports, decisions, missing (admin), CCTV, people → **0 violations** | pass | pass |
| AI helper off by default; switch disabled without WebGPU; "Explain my share" works from the template; the helper worker is **not** precached | pass | pass |
| Flood scenario end to end (criterion 2) | pass | skipped (no WebRTC in Playwright WebKit on Windows) |

## Bugs found by the Phase 2 tests and fixed

| # | Found by | Problem | Fix |
|---|----------|---------|-----|
| 1 | axe | White text on the "high" shade (#B06B68) failed contrast; wide tables were not keyboard-scrollable | Black text on that shade; `tabIndex=0` on scrolling tables |
| 2 | WebKit E2E | Sign-in waited for the profile download, so the `/login` route redirected to `/` before navigating to setup | Navigate first, download the profile in the background (decision 11.21) |
| 3 | E2E + stronger property test | "Explain my share" said "Nothing was requested" when stock covered every need, or when stock was zero (the engine keeps per-site needs only in weighted mode) | Template and guard take the site's own request (`requested`) |
| 4 | WebKit full-suite run | The SOS-entry manifest was swapped *after* the first paint, so for a moment the main manifest was active | `useLayoutEffect` (swap before paint); 3 repeat runs pass on both engines |
| 5 | Demo script | Node's built-in TypeScript stripping can't load the shared code (parameter properties) | `npm run demo` runs through `tsx` |

(Test-only fixes, not product bugs: an ambiguous "Age" label selector; a sign-out race in the test; a WebGL pixel read-back that was replaced by MapLibre's rendered-feature count.)

## Final report

### What works (verified in emulation)
Everything in the Phase 1 report, plus:
- registration and profiles (phone first, server second, honest status)
- SOS with the profile and a status screen
- the offline shelter map (self-hosted PMTiles, last-known location)
- the iOS SOS entry (emulated only)
- the control-room dashboard: map with hot zones and heatmap, SOS monitor, reports with photos and comparisons, shelters, analytics, offline read-only mode
- rule-based decision support with reasoning, approve/reject and audit, and approved assignments becoming rescuer tasks
- the missing-person workflow with mandatory named-admin verification
- staff accounts, the demo seed script, and the in-place DB upgrade

### What is simulated or sample data
- Mesh Lab multi-hop mesh: **SIMULATED**
- WebRTC phone link: **EXPERIMENTAL**
- CCTV: **SAMPLE** synthetic clips with hand-written labels
- missing-person registry, shelters and demo people: **SAMPLE**, fictional
- decision rules: heuristics, **advisory**

### What is unverified
- **Every real-device row** (27, all "not run")
- the **AI writing helper with the real model** (no WebGPU here, so download, quality, speed and memory are unknown)
- the iOS home-screen SOS entry on a real iPhone
- the WebRTC link between two real phones on a hotspot
- vision speed on a 3 GB phone
- the decision thresholds, which no disaster-management expert has reviewed

### Known limitations
[LIMITATIONS.md](../LIMITATIONS.md) sections 1–5. Phase 2 specifics are in section 5 (one sample map region; WebGL needed for the map, with the list as fallback; approximate team positions; possible double counting in area people estimates; admin screens read-only offline; no password-reset UI).

## Change round 2026-11-13 (owner's change list – decisions.md section 12)

All results are actual runs on 2026-11-13, same machine and tools as above.

| Check | Result |
|-------|--------|
| Typecheck | clean |
| Vitest | **129/129** (was 126; new: passwordless victim sign-in and staff still needing a password, admin-only seed + one-time cleanup that never deletes later sign-ups, automatic pairing endpoint; the old registration tests were rewritten for the user ID) |
| Playwright, final full run | **50 passed, 0 failed, 8 skipped by design** (no-WebRTC notice on Chromium; on WebKit: both LAN tests, the flood scenario, the footage test (MediaRecorder WebM), installability, persistent cold start, vision latency) |
| `npm run demo` | run twice against a temporary server: second run creates nothing new |

New E2E file `tests/e2e/changes.spec.ts`:
- every screen of every role at **360 px**: no text wider than its box, nothing off the screen;
- SOS circle first on Home; no "Sent & waiting";
- **one slow health answer does not flip the badge**; a tunnel's HTML error page means Offline and the text "DOCTYPE" never reaches the screen (victim and admin);
- the SOS is **sent by itself** when the connection returns;
- footage analyser (MOCK detector);
- the delayed-SOS notification fires exactly once (with a recorded `Notification` – headless browsers refuse real ones).

`lan.spec.ts`: phones link **automatically** (no QR/code), the link survives the server stopping, and the ack returns over it. The code fallback is tested separately. `flood.spec.ts` now uses three automatically linked phones.

Bugs found by these tests and fixed:
1. **Text overflow** at 360 px: "Recommendations" (menu), "Transportation" (resource list), Mesh Lab and CCTV slider labels.
2. **A screen could miss a connectivity change**: it showed "You are offline" while the header said Online (`useReach` subscribed after its first read). This is one of the causes of the wrong-status reports.
3. **Ready for offline**: a check that started before a download finished could overwrite the fresh green result, so "Team key" stayed grey.

Earlier full runs in this round also had two failures that turned out to be test-environment limits, not product faults:
- the vision latency test under CPU contention (passes alone);
- WebKit letting a service-worker request escape a test's held response.

Both tests were adjusted, with the reason written in them.

Real devices: still **not run**. [PHONE_TEST.md](PHONE_TEST.md) now has 33 rows (6 new: badge, automatic sending, automatic linking, notification, footage analyser, passwordless registration).

## Change round 2 (decisions.md section 13) – after the owner's 3-phone test

Actual runs, same machine:

| Check | Result |
|-------|--------|
| Typecheck | clean |
| Vitest | **132/132** (new: missing-person photo rules, a report hopping A → B → C → server recorded with 2 hops + the uploading user, the admin feed) |
| Playwright, full run | **53 passed, 0 failed, 9 skipped by design** (Mesh Lab tests removed with the page; the new multi-hop test is Chromium-only like the other WebRTC tests) |

New `tests/e2e/round2.spec.ts`:
- **three browser phones**, no server: A → B → C. Checks every alert ("Connected to meena and transferring your field report", "Receiving from ravi … hop 1", "Receiving from meena … hop 2"), the transfer-log hop numbers, the server recording **2 hops, uploaded by kiran**, and the confirmation travelling back to A;
- a family's missing-person photo reaching the admin's case card;
- control-room pop-ups for a new SOS (stays until closed) and a field report.

Bug found by these tests and fixed: an old `.toast` CSS rule pinned every pop-up to the bottom of the screen, on top of each other (13.5).

Real devices: still **not run** – PHONE_TEST.md now has 37 rows (4 new: multi-hop alerts, confirmation back over the chain, pop-ups, missing-person photo).
