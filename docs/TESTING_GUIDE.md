# RusQ – Complete Testing Guide (Phase 1)

Follow this top to bottom. It takes about **half a day** with three phones.
Record every real-phone result in [PHONE_TEST.md](PHONE_TEST.md) as **pass**, **fail** (with a note) or **not run**.

**Scope:** this tests what exists in **Phase 1**. Not built yet, so not testable: registration, profiles and emergency contacts, the shelter map, the admin SOS/report dashboard, decision support, CCTV, missing persons, and the Llama assistant.

---

## Part 0 – What you need

| Device | Role in the tests | Signed in as |
|--------|-------------------|--------------|
| **Laptop** (this PC) | runs the server; Chrome as the **admin** | `admin` |
| **Phone A** – Android, ideally low-end (~3 GB RAM), Chrome | **rescuer** | `ravi` |
| **Phone B** – any Android, Chrome | second **rescuer**, and the **hotspot / gateway** in the relay test | `meena` |
| **Phone C** – iPhone, Safari (optional, best effort) | **person needing help** | `asha` |
| No spare phone? | Phone B can sign out and sign in as `asha` for the victim tests | |

All demo passwords are `demo1234`.

You also need a USB cable for Android (optional), Wi-Fi for the first setup (the photo helper download is about 116 MB per rescuer phone), and the free **cloudflared** tool for HTTPS (step 1.4).

---

## Part 1 – Prepare the laptop

### 1.1 Install and build (once)
Open a terminal in `D:\RusQ`:
```bash
npm install
node apps/web/scripts/fetch-models.mjs     # downloads the vision models (~94 MB), once
npm run build
```

### 1.2 Run the automated tests first
If any of these fail, stop and report the output. There's no point testing phones on a broken build.
```bash
npm run typecheck                          # expect: no output, exit 0
npm test                                   # expect: Test Files 6 passed, Tests 85 passed
npx playwright install chromium webkit     # once
npx playwright test                        # expect: 23 passed, 5 skipped, 0 failed (~4 min)
npx tsx tests/vision-eval/eval-node.ts     # expect: topHazardAccuracy ≈ 0.85
node tests/lighthouse/run-lighthouse.mjs   # expect: performance ≥ 90, accessibility 100
```

### 1.3 Start the server with a clean database
```bash
del apps\server\data\rusq.db*              # PowerShell: Remove-Item apps\server\data\rusq.db*
npm start                                  # serves the app and API on http://localhost:8787
```
Leave it running. In a **second** terminal, watch what the server receives:
```bash
node scripts/inspect-db.mjs --watch
```
You should see 4 users, the live stock and empty lists. Keep this window visible during every test: it's your proof of what really reached the server.

### 1.4 Give the phones an HTTPS address
Phones need **HTTPS**. Offline mode, the camera and encryption don't work on `http://192.168.x.x`.

**Option A – Cloudflare quick tunnel (works for Android and iPhone; recommended)**
```bash
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8787
```
It prints an address like `https://something-random.trycloudflare.com`. That's **your test URL**.

- ⚠️ Keep this terminal running for the **whole test session**. If you restart it, the address changes and the installed app on the phones points to the old one, so you'd have to reinstall.
- ⚠️ The tunnel makes your laptop's server reachable from the internet while it runs. That's fine for demo data. Never put real people's data on it.
- "Offline" in this guide means the **phone** can't reach the server (airplane mode, or Wi-Fi with no internet). The laptop stays on.

**Option B – USB, Android only, no internet needed**

1. On the phone, enable Developer options → USB debugging.
2. Connect the cable.
3. On the laptop, open Chrome → `chrome://inspect/#devices` → **Port forwarding** → add `8787` → `localhost:8787` → tick "Enable".
4. On the phone, open `http://localhost:8787`. Localhost counts as secure.
5. To go offline, simply **unplug the cable**.

### 1.5 Admin browser on the laptop
Open `http://localhost:8787` in Chrome, sign in as `admin`, and open **Allotments**.

---

## Part 2 – Install and "Ready for offline" (every phone)

| # | Do this | Expected | Check |
|---|---------|----------|-------|
| 2.1 | Open the test URL. Sign in (A: `ravi`, B: `meena`, C: `asha`). | You land on **Ready for offline**. | |
| 2.2 | Android: Chrome menu ⋮ → **Install app** / **Add to Home screen**. iPhone: Share → **Add to Home Screen**. | A green **RusQ** icon appears on the home screen. | PHONE_TEST #1 |
| 2.3 | Open RusQ **from the icon**. | Opens full-screen, with no browser address bar. | |
| 2.4 | On Wi-Fi, tap **Download everything**. Allow location when asked. | Each line turns 🟢 only after it's been checked. Rescuers see 7 lines including **Photo helper** (~115 MB); victims see fewer. Sizes are shown. | PHONE_TEST #2 |
| 2.5 | Look at "Keep data safe". | Ideally **Protected**. If it says *Not protected*, write that down (it's the browser's choice). | PHONE_TEST #13 |
| 2.6 | Look at the storage box. | It shows "RusQ uses X MB of Y MB". | |
| 2.7 | iPhone: read the bottom card. | A reminder to open RusQ weekly (iOS can clear app data). | |

The header pill must say **Online** (green) here.

---

## Part 3 – Person needing help (Phone C as `asha`)

| # | Do this | Expected |
|---|---------|----------|
| 3.1 | Look at the screen. | Big red **SOS – I need help**. Every option is a visible, labelled button, with no hidden menu. |
| 3.2 | Tap **SOS**, then the red circle. While the 3-2-1 countdown runs, tap **CANCEL – do not send**. | Nothing is sent. The inspect window shows **no new SOS**. |
| 3.3 | Tap the SOS button again and let the countdown finish (online). | "Your SOS is saved". Within seconds the badge goes ⇢ **Sent** → ✔ **Received by server** with a reference like `SOS-000001`. The inspect window shows the same `SOS-000001` with the location. |
| 3.4 | Turn on **airplane mode**. | The header pill turns **Offline** (red) within about 20 s. |
| 3.5 | Send another SOS. | The badge stays ⏸ **Saved on this phone only. NOT sent yet.** It must **never** say Received. The inspect window shows nothing new. → PHONE_TEST #6 |
| 3.6 | Phone settings → turn **Location off**, then send another SOS (still offline). | It says **"Last known location, X minutes ago"**, not a live location. |
| 3.7 | Open **Sent & waiting**. | Two items waiting, one received. "Send now" is disabled and says it will send automatically. |
| 3.8 | Close RusQ completely (swipe it away), then reopen from the icon, still offline. | The app opens; both items are still there and still waiting. → PHONE_TEST #5 |
| 3.9 | Turn airplane mode **off**. | Within about a minute both turn ✔ **Received** with new reference numbers. The inspect window shows them. → PHONE_TEST #11 |
| 3.10 | Android only: long-press the RusQ icon → **SOS**. | Opens the SOS screen directly. The inspect window later shows `source=shortcut`. → PHONE_TEST #14 |

---

## Part 4 – Rescue team (Phone A as `ravi`)

| # | Do this | Expected |
|---|---------|----------|
| 4.1 | Airplane mode **on**. Tap **New report**. | The form opens offline. Location shows live or "Last known location, X ago". |
| 4.2 | Set people with **+** to 5, and urgency to **4**. | The urgency button turns red; the label says "4 – Severe". |
| 4.3 | **Take or add photo** → use the camera to photograph something (a bucket of water, a messy room, a street on a screen). | A thumbnail appears; "Analysing…" then **WASM · N ms**. Note N (seconds per photo) → PHONE_TEST #8. |
| 4.4 | Read the blue box. | **SUGGESTION ONLY** with the top 3 guesses and percentages. Suggested hazards are ticked and marked "suggested". **Urgency is still 4**: the photo helper must never change it. |
| 4.5 | Untick a wrong suggestion and tick the right hazard. | Your choice wins. |
| 4.6 | Look at section 5. | A blue **HINT** line (e.g. "Boats, Life jackets…"). The checkboxes are **not** ticked for you. |
| 4.7 | Tick **Boats**, quantity 3. Tick **Food and water**, quantity 100. | Section 7 shows a table: Asked / **Can get now** / Short, plus "Based on snapshot v1, saved X ago". → PHONE_TEST #9 |
| 4.8 | Tick "Attach my location to the photos". | (Checked later on the server.) |
| 4.9 | **Save report**. | "Report saved", with the badge **Saved on this phone only**. |
| 4.10 | **Sent & waiting**. | 3 items: report, provisional allotment, and the photo under "Photos". All waiting. |
| 4.11 | Airplane mode **off**. | All turn **Received** (`RPT-…`, `ALT-…`, `PHO-…`). The inspect window shows the report with `ai=<label> (wasm)` and the photo size. |
| 4.12 | **Settings** → turn on **Low-power mode** → new report → add a photo. | No automatic analysis. An **Analyse** button appears on the photo. |
| 4.13 | Settings → turn on **MOCK mode** → add a photo. | A red banner says MOCK; the result says "MOCK… not a real model". **Turn MOCK off afterwards.** |
| 4.14 | Try adding a non-photo file (e.g. a PDF renamed to `.jpg`). | A red message: "not a readable photo". The form keeps working. |

---

## Part 5 – Conflicts and admin decisions (Phones A + B, laptop admin)

This proves that two offline phones claiming the same stock are caught, and that the admin decides.

| # | Do this | Expected |
|---|---------|----------|
| 5.1 | Phone B (`meena`): Download everything (Part 2), then airplane mode **on**. | |
| 5.2 | Phones A and B, both **offline**: each makes a report asking for **Boats = 4** (urgency 5). | Each phone shows it "can get" some boats on its own, without knowing about the other. |
| 5.3 | Turn both phones back **online**. | Both turn Received. |
| 5.4 | Laptop admin → **Allotments** → **Refresh**. | "Stock vs claims": boats claimed more than the 4 in stock, highlighted **OVER by N**. **Open conflicts** lists boats and both devices. The inspect window shows `open boats: claimed X > stock 4`. |
| 5.5 | On one allotment, **lower** the boats number, then **Approve**. On the other, **Reject** with a note. | The conflict disappears; live stock of boats drops by the approved amount; both show in **Decided**. |
| 5.6 | Try to approve an already-decided allotment again (refresh first). | Not possible (it's gone from Pending). |
| 5.7 | Scroll to **Audit log**. | Entries such as `conflict.created`, `allotment.approved`, `allotment.rejected`, `conflict.resolved`. |
| 5.8 | Access control: on Phone A (`ravi`) open `<test URL>/admin/reconcile`. | You're sent back Home. Rescuers can't decide allotments. |

---

## Part 6 – Phone-to-phone relay with NO internet (Phones A + B) – EXPERIMENTAL

This is the most important real-world test and **has never been run on real phones**.

| # | Do this | Expected |
|---|---------|----------|
| 6.1 | Both phones have finished Part 2 (team key 🟢). | |
| 6.2 | Phone B: turn **mobile data off**, then turn on its **Wi-Fi hotspot**. Phone A: airplane mode on, then turn **Wi-Fi on** and join B's hotspot. | Both RusQ headers say **Offline** (no internet anywhere). |
| 6.3 | Phone A: send an SOS and save a short report. | Both **Saved on this phone only**. |
| 6.4 | Both phones: open **Nearby phones** and **stay on that screen** for the rest of this test. The connection lives in that open screen. | |
| 6.5 | Phone A: **1. I start – show my code**. | A QR code and a text code appear. |
| 6.6 | Phone B: **Scan QR** and point at A's screen. (Or copy the text code to B, e.g. via a messaging app before going offline.) | B shows a reply QR. |
| 6.7 | Phone A: **Scan QR** of B's reply. | Both show 🟢 **open** under Connected phones. |
| 6.8 | Wait about 10 s. | B: "Messages this phone is carrying" lists A's SOS and report "from dev-…". A: **Sent & waiting** shows those items as ⇢ **Sent – waiting for reply** (Passed to a nearby phone), **never** Received. → PHONE_TEST #10 |
| 6.9 | Phone B: turn **mobile data on** (the hotspot can stay on). Keep both on Nearby phones. | Within about a minute B's header says Online and B uploads A's items. If B shows **Upload for the other phones now**, tap it. The inspect window shows them with `via=relay`. |
| 6.10 | Wait about 10 s more, then check A's Sent & waiting (A is still offline). | A's items show ✔ **Received by server**. The server's signed confirmation travelled back through B. → PHONE_TEST #11 |

**If 6.7 never reaches "open":**

1. On both phones open `chrome://flags`, search **"Anonymize local IPs exposed by WebRTC"**, set it to **Disabled**, restart Chrome and retry. Write down that you needed this.
2. Some hotspots block phone-to-phone traffic ("client isolation"). Try another phone as the hotspot, or a normal Wi-Fi router with the internet unplugged.
3. Record which combination worked or didn't. It's valuable information either way.

---

## Part 7 – Robustness

| # | Do this | Expected |
|---|---------|----------|
| 7.1 | Phone A: airplane mode on → **reboot** the phone → open RusQ. | Opens offline; queued items are still there. → PHONE_TEST #4 |
| 7.2 | Phone A: start a report and turn airplane mode on **while it's sending** (tap Send now and immediately go offline). | No crash. The item goes back to waiting. Later it's received **once**: the inspect window shows only one copy. |
| 7.3 | Battery: charge Phone A to 100 %, open Nearby phones connected to B, screen on, for **30 min**. Repeat the next day with RusQ closed for 30 min. | Write down both percentages. → PHONE_TEST #12 |
| 7.4 | Leave Phones A and C unused for **3 days**, then open RusQ offline. | Data still there. On iPhone this may fail; record it. → PHONE_TEST #13 |
| 7.5 | Use Phone A outside in **direct sunlight**. | All text and buttons readable. → PHONE_TEST #15 |
| 7.6 | Phone almost full (under ~200 MB free), then save a report with photos. | A clear "out of storage" message, no crash. Write down what happened. |
| 7.7 | Accessibility: Android **TalkBack** / iPhone **VoiceOver** on; try to send an SOS. | Every button is announced with a clear name. |
| 7.8 | Phone settings → largest **font size**. | Nothing overlaps or gets cut off. |

---

## Part 8 – Mesh Lab (SIMULATED) – any rescuer or admin

| # | Do this | Expected |
|---|---------|----------|
| 8.1 | Open **Mesh Lab**. | A purple **SIMULATED** banner explaining it isn't a real radio. |
| 8.2 | **Choose a phone** → pick `n07` → **Send SOS from n07** → **Play**. | Dots turn red as messages hop. "delivered to server" becomes 1. |
| 8.3 | **Split left / right**, send an SOS from a phone on the side without a gateway, Play. | Not delivered while split. **Heal partition** → delivered. |
| 8.4 | Set packet loss to 50 %, send several SOS. | Slower, but all delivered if a path exists. |
| 8.5 | **Reset** with the same seed and repeat the same steps. | Identical behaviour (reproducible). |

---

## Part 9 – Automated security checks you can see yourself

The automated tests already cover authentication, roles, validation and rate limiting. To see it by hand:

- Sign out, then open `<test URL>/outbox`. You're sent to the sign-in page.
- Enter a wrong password 25 times quickly. You get "Too Many Requests" (rate limit).

---

## Part 10 – Reporting back

1. Fill in every row of [PHONE_TEST.md](PHONE_TEST.md) (pass / fail / not run, device model, Android/iOS version).
2. For any failure, note the step number, a screenshot, and the inspect window at that moment.
3. Copy the final inspect output: `node scripts/inspect-db.mjs > test-run.txt`.

Send those back and I'll fix failures and update the Gate report with real-device results.
