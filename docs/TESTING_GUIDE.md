# RusQ – Complete Testing Guide (Phase 1 + Phase 2)

Follow this top to bottom. It takes about **a day** with three phones (Parts 1–9 Phase 1, Part 10 Phase 2).
Record every real-phone result in [PHONE_TEST.md](PHONE_TEST.md) as **pass**, **fail** (with a note) or **not run**.

**Scope:** everything in Phase 1 and Phase 2. The optional AI writing helper (Llama) can only be tested on a device whose browser has WebGPU (row 27). Most phones don't, and that's expected.

---

## Part 0 – What you need

| Device | Role in the tests | Signed in as |
|--------|-------------------|--------------|
| **Laptop** (this PC) | runs the server; Chrome as the **admin** | `admin` |
| **Phone A** – Android, ideally low-end (~3 GB RAM), Chrome | **rescuer** | `team-a` (you create it in step 1.6) |
| **Phone B** – any Android, Chrome | second **rescuer**, and the **hotspot / gateway** in the relay test | `team-b` (step 1.6) |
| **Phone C** – iPhone, Safari (optional, best effort) | **person needing help** | registers itself in step 2.1 (user ID only, no password) |
| No spare phone? | Phone B can sign out and register as a person needing help for the victim tests | |

Only the **admin** account exists at the start (password `demo1234`). Rescue accounts get the password you choose in step 1.6.
People needing help never have a password: they type their **user ID** to sign in.

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
npm test                                   # expect: Test Files 8 passed, Tests 126 passed
npx playwright install chromium webkit     # once
npx playwright test                        # expect: 38 passed, 6 skipped, 0 failed (~5 min)
npx tsx tests/vision-eval/eval-node.ts     # expect: topHazardAccuracy ≈ 0.85
node tests/lighthouse/run-lighthouse.mjs   # expect: performance ≥ 90 (last run 97), accessibility 100
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
You should see 1 user (admin), the live stock and empty lists. Keep this window visible during every test: it's your proof of what really reached the server.

**1.6 Create the rescue-team accounts (laptop).** Open `http://localhost:8787`, sign in as `admin` / `demo1234` (you land on the dashboard). Open **People & teams** → *Create a rescuer or control-room account*:
- User ID `team-a`, a password you choose (8+ characters), name "Team Alpha", role rescuer, team `team-alpha`, skills Boat handling + First aid.
- User ID `team-b`, a password, name "Team Bravo", role rescuer, team `team-bravo`, skills Medical + Search & rescue.

The inspect window now lists 3 users.

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
| 2.1 | Open the test URL. A and B: sign in with `team-a` / `team-b` and their passwords. C: **Register as a person who may need help** – keep the suggested user ID (write it down), fill name, age, total number of people in the house, a family member to call → Register. | You land on **Ready for offline**. | |
| 2.2 | Android: Chrome menu ⋮ → **Install app** / **Add to Home screen**. iPhone: Share → **Add to Home Screen**. | A green **RusQ** icon appears on the home screen. | PHONE_TEST #1 |
| 2.3 | Open RusQ **from the icon**. | Opens full-screen, with no browser address bar. | |
| 2.4 | On Wi-Fi, tap **Download everything**. Allow location when asked. | Each line turns 🟢 only after it's been checked. Rescuers see 7 lines including **Photo helper** (~115 MB); victims see fewer. Sizes are shown. | PHONE_TEST #2 |
| 2.5 | Look at "Keep data safe". | Ideally **Protected**. If it says *Not protected*, write that down (it's the browser's choice). | PHONE_TEST #13 |
| 2.6 | Look at the storage box. | It shows "RusQ uses X MB of Y MB". | |
| 2.7 | iPhone: read the bottom card. | A reminder to open RusQ weekly (iOS can clear app data). | |

The header pill must say **Online** (green) here.

---

## Part 3 – Person needing help (Phone C, the registered person)

| # | Do this | Expected |
|---|---------|----------|
| 3.1 | Open Home. | The **big round red SOS button is the first thing on the screen**; every other option follows below it as a visible, labelled button, with no hidden menu. No button text sticks out of its box. |
| 3.2 | Tap the red circle. While the 3-2-1 countdown runs, tap **CANCEL – do not send**. | Nothing is sent. The inspect window shows **no new SOS**. |
| 3.3 | Tap the SOS button again and let the countdown finish (online). Allow notifications if asked. | Within seconds the message **right under the button** says ✅ **Your SOS reached the control room** with a reference like `SOS-000001`. The inspect window shows the same `SOS-000001` with the location. |
| 3.4 | Turn on **airplane mode**. | The header pill turns **Offline** (red) within about 10 s. While the connection works it must not flip to Offline by itself. |
| 3.5 | Send another SOS. | The message under the button says ⏳ **has NOT reached the control room yet** … **sent automatically as soon as there is a connection**. It must **never** say reached. The inspect window shows nothing new. → PHONE_TEST #6 |
| 3.6 | Phone settings → turn **Location off**, then send another SOS (still offline). | It says **"Last known location, X minutes ago"**, not a live location. |
| 3.7 | Look for a "Send now" button. | There is none – and no "Sent & waiting" page. Nothing has to be pressed. |
| 3.8 | Close RusQ completely (swipe it away), then reopen from the icon, still offline. | The app opens; the message under the SOS button still says NOT reached. → PHONE_TEST #5 |
| 3.9 | Leave the app (go to the phone's home screen) and turn airplane mode **off**. Do not touch RusQ. | Android: a notification **"Your SOS reached the control room – Reference SOS-…"** appears. Reopen RusQ: the message under the button says ✅ reached. The inspect window shows both offline SOS. → PHONE_TEST #11, #29, #31 |
| 3.10 | Android only: long-press the RusQ icon → **SOS**. | Opens the SOS screen directly. The inspect window later shows `source=shortcut`. → PHONE_TEST #14 |

---

## Part 4 – Rescue team (Phone A as `team-a`)

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
| 4.10 | Go **Home**. | Under **Your reports** the new report shows ⏸ waiting. (The allotment and photo travel with it.) |
| 4.11 | Airplane mode **off**. | All turn **Received** (`RPT-…`, `ALT-…`, `PHO-…`). The inspect window shows the report with `ai=<label> (wasm)` and the photo size. |
| 4.12 | **Settings** → turn on **Low-power mode** → new report → add a photo. | No automatic analysis. An **Analyse** button appears on the photo. |
| 4.13 | Settings → turn on **MOCK mode** → add a photo. | A red banner says MOCK; the result says "MOCK… not a real model". **Turn MOCK off afterwards.** |
| 4.14 | Try adding a non-photo file (e.g. a PDF renamed to `.jpg`). | A red message: "not a readable photo". The form keeps working. |

---

## Part 5 – Conflicts and admin decisions (Phones A + B, laptop admin)

This proves that two offline phones claiming the same stock are caught, and that the admin decides.

| # | Do this | Expected |
|---|---------|----------|
| 5.1 | Phone B (`team-b`): Download everything (Part 2), then airplane mode **on**. | |
| 5.2 | Phones A and B, both **offline**: each makes a report asking for **Boats = 4** (urgency 5). | Each phone shows it "can get" some boats on its own, without knowing about the other. |
| 5.3 | Turn both phones back **online**. | Both turn Received. |
| 5.4 | Laptop admin → **Allotments** → **Refresh**. | "Stock vs claims": boats claimed more than the 4 in stock, highlighted **OVER by N**. **Open conflicts** lists boats and both devices. The inspect window shows `open boats: claimed X > stock 4`. |
| 5.5 | On one allotment, **lower** the boats number, then **Approve**. On the other, **Reject** with a note. | The conflict disappears; live stock of boats drops by the approved amount; both show in **Decided**. |
| 5.6 | Try to approve an already-decided allotment again (refresh first). | Not possible (it's gone from Pending). |
| 5.7 | Scroll to **Audit log**. | Entries such as `conflict.created`, `allotment.approved`, `allotment.rejected`, `conflict.resolved`. |
| 5.8 | Access control: on Phone A (`team-a`) open `<test URL>/admin/reconcile`. | You're sent back Home. Rescuers can't decide allotments. |

---

## Part 6 – Phone-to-phone relay with NO internet (Phones A + B) – EXPERIMENTAL

This is the most important real-world test and **has never been run on real phones**.

| # | Do this | Expected |
|---|---------|----------|
| 6.1 | Both phones have finished Part 2 (team key 🟢). | |
| 6.2 | Phone B: turn on its **Wi-Fi hotspot** (mobile data still ON). Phone A: turn mobile data off and join B's hotspot. Both: open RusQ → **Nearby phones** and keep RusQ open. | Within about 10 s both show 🟢 **1 phone connected** – **(automatic)**. No code, no QR. → PHONE_TEST #30 |
| 6.3 | Phone B: turn **mobile data off** (hotspot stays on). | Both headers say **Offline**; the phones stay 🟢 connected. |
| 6.4 | Phone A: using the buttons inside RusQ (don't close or reload the app – the connection lives in the open app), send an SOS and save a short report, then go back to **Nearby phones**. | |
| 6.5 | Wait about 10 s. | B: "Messages this phone is carrying" lists A's SOS and report "from dev-…". A: the message under the SOS button says it was **passed to a nearby phone** – **never** "reached". → PHONE_TEST #10 |
| 6.6 | Phone B: turn **mobile data on** (the hotspot can stay on). Keep RusQ open on both. | Within about a minute B's header says Online and B uploads A's items. If B shows **Upload for the other phones now**, tap it. The inspect window shows them with `via=relay`. |
| 6.7 | Wait about 10 s more, then look at A's Home (A still has no internet). | ✅ **Your SOS reached the control room**, and the report shows ✔ Received. The server's signed confirmation travelled back through B. → PHONE_TEST #11 |
| 6.8 | Fallback only if 6.2 never connected: **Did not connect by itself? Use a code** – A: **1. I start – show my code**, send the text to B (SMS/chat before going offline), B pastes it and sends the reply code back, A pastes it. | Both show 🟢 connected **(by code)**. |

**If the phones never connect:**

1. On both phones open `chrome://flags`, search **"Anonymize local IPs exposed by WebRTC"**, set it to **Disabled**, restart Chrome and retry. Write down that you needed this.
2. Some hotspots block phone-to-phone traffic ("client isolation"). Try another phone as the hotspot, or a normal Wi-Fi router with the internet unplugged.
3. Record which combination worked or didn't. It's valuable information either way.

---

## Part 7 – Robustness

| # | Do this | Expected |
|---|---------|----------|
| 7.1 | Phone A: airplane mode on → **reboot** the phone → open RusQ. | Opens offline; queued items are still there. → PHONE_TEST #4 |
| 7.2 | Phone A: save a report and turn airplane mode on **immediately** (while it is being sent). | No crash. The item goes back to waiting. Later it's received **once**: the inspect window shows only one copy. |
| 7.3 | Battery: charge Phone A to 100 %, open Nearby phones connected to B, screen on, for **30 min**. Repeat the next day with RusQ closed for 30 min. | Write down both percentages. → PHONE_TEST #12 |
| 7.4 | Leave Phones A and C unused for **3 days**, then open RusQ offline. | Data still there. On iPhone this may fail; record it. → PHONE_TEST #13 |
| 7.5 | Use Phone A outside in **direct sunlight**. | All text and buttons readable. → PHONE_TEST #15 |
| 7.6 | Phone almost full (under ~200 MB free), then save a report with photos. | A clear "out of storage" message, no crash. Write down what happened. |
| 7.7 | Accessibility: Android **TalkBack** / iPhone **VoiceOver** on; try to send an SOS. | Every button is announced with a clear name. |
| 7.8 | Phone settings → largest **font size**. | Nothing overlaps or gets cut off. |

---

## Part 8 – Multi-hop without internet (3 phones) – proof on screen

**Why a phone on the same Wi-Fi in airplane mode is not a real test:** if that Wi-Fi has internet, the phone simply
sends directly as soon as Wi-Fi is on. For a real offline test, the network itself must have **no internet**. A phone
hotspot with its **mobile data switched off** works well.

**One rule to know:** web apps cannot search for nearby phones by themselves. Phones are introduced to each other
while they can reach the server; after that the link works without internet.

| # | Do this | Expected |
|---|---------|----------|
| 8.1 | Phones A (`team-a`), B (`team-b`), C (a third rescuer or a registered person) have done "Ready for offline". Phone C: turn on its **hotspot with mobile data ON**. A and B: turn mobile data off and join C's hotspot. All three: open RusQ → **Nearby phones** and keep RusQ open. | Within about 10 s each phone shows **2 phones connected (automatic)**, listed by **user ID**. |
| 8.2 | Phone C: turn **mobile data OFF** (hotspot stays on). | All headers say **Offline**. The links stay 🟢. |
| 8.3 | Phone A: tap **Disconnect** next to C's user ID. | A now has 1 link (to B). The only path from A to C is through B. |
| 8.4 | Phone A: inside RusQ (don't close or reload it), **New report** → save. | A shows **"📶 Connected to team-b and transferring your field report"**. |
| 8.5 | Look at B and C. | B: **"📥 Receiving from team-a: field report (team-alpha) – Hop 1"**, then **"Connected to C – passing on field report from other phones"**. C: **"📥 Receiving from team-b: field report (team-alpha) – Hop 2"**. Each phone's **Transfer log** (Nearby phones) lists the same, with hop numbers. → PHONE_TEST #34 |
| 8.6 | Phone C: turn **mobile data ON**. | C uploads. On the laptop, **Field reports** shows "phone-to-phone relay – **2 hops** between phones, uploaded by C's user ID", and a pop-up appears. |
| 8.7 | Wait about 10 s and look at A (still without internet). | **"✅ The control room confirmed your field report … came back through team-b's phone"**. A's Home shows it ✔ Received. → PHONE_TEST #35 |

---

## Part 9 – Automated security checks you can see yourself

The automated tests already cover authentication, roles, validation and rate limiting. To see it by hand:

- Sign out, then open `<test URL>/outbox`. You're sent to the sign-in page.
- Enter a wrong password 25 times quickly. You get "Too Many Requests" (rate limit).

---

## Part 10 – Phase 2 features (rows 16–37 in PHONE_TEST.md)

Do these after Parts 1–9, with the same server, tunnel and `inspect-db --watch` window.

**10.1 Register a new person (Phone C).** Sign out. On the sign-in page tap **Register as a person who may need
help**. There is **no username and no password**: keep the suggested user ID (or type your own), fill name, age, phone,
**Total number of people in the house**, tick a need, add a family member to call, your work → Register. Sign out and
sign in again typing **only the user ID**.
*Expect:* you land on "Ready for offline"; **My profile** shows the user ID and says "Saved on the server". `inspect-db` lists the new
user with the profile. → row 16.

**10.2 Profile offline (Phone C).** Airplane mode → My profile → change the contact's phone → Save.
*Expect:* "Saved on this phone only". Airplane mode off, wait about 30 s → "Saved on the server". → row 17.

**10.3 Offline map (Phones A and C).** Ready for offline → tap the **Map of your area** and **Shelters list**
lines until green. Airplane mode → **Shelters near me**. *Expect:* streets and the river (Kathmandu, Nepal) draw; shelters within 3 km are listed first under **Near you**, the rest of the 8 district shelters below, with free places,
"Map loaded from this phone". Pinch-zoom and drag. → row 18. Then turn off the phone's location (or remove
the site permission) and reopen: *expect* "**Last known location, X ago**". → row 19.

**10.4 SOS with profile and status back (Phone C + laptop).** Send an SOS as the new user. On the laptop admin:
**SOS monitor** → the card shows the name, tap-to-call contacts, needs, and an urgency level with reasons → row 20.
Press **Assign team** (Team Alpha). On Phone C, Home → under the SOS button: "A rescue team has been sent to you." → row 21.
Phone A (`team-a`) Home shows the SOS under **Tasks for your team**.

**10.5 iPhone SOS button (Phone C).** SOS → link **Add a separate SOS button to your home screen** → Share →
**Add to Home Screen**. *Expect:* a red "SOS" icon. In airplane mode it opens straight to the SOS button. → row 22.

**10.6 Missing person (Phone C + laptop).** Phone C: **Missing person** → name `Rina Shrestha`, age 8, female,
"red frock", last seen "Lainchaur", **add a photo** → Send (works offline; status like an SOS). Laptop admin: **Missing persons** →
the case shows a sample candidate with confidence. Phone C still says "searching" (nothing about the candidate)
→ row 23. Admin: **Start review** → try **Verify** without ticks (refused) → tick all 3, write a note → Verify →
**Announce**. *Expect:* Phone C shows "found at …"; everyone's Home lists it under Official announcements → row 24.

**10.7 Recommendations → rescuer task (laptop + Phone A).** Run `npm run demo` once for richer data
(optional). Laptop: **Recommendations** → read the "Why" list → **Approve** a "Team–skill match" for
Team Alpha. Phone A Home → **Tasks for your team** shows it; go offline and reopen → still shown with "Saved X ago". → row 25.

**10.8 Admin on a phone (Phone B as `admin`).** Dashboard (map, numbers), CCTV sample clips play. The menu has **no "Ready for offline"**, and **Shelters in district** lists all 8 shelters with totals. Airplane mode
→ reopen Dashboard. *Expect:* "Offline – showing data saved X ago", and approve buttons are disabled. → row 26.

**10.9 AI writing helper (optional).** Settings → "AI writing helper". Most phones say "no WebGPU" and the
switch is disabled: record that. If it's available, switch on → Download (~0.9 GB, Wi-Fi!) → New report →
"Tidy my notes" / "Explain my share". *Expect:* any reply that adds a number is discarded with a note. → row 27.

**10.13 Control-room pop-ups (laptop + any phone).** Keep the laptop on any admin screen. Send an SOS from a phone and
save a field report on another. *Expect:* within about 5 s a red pop-up "🆘 New SOS from …" (it stays until you close it) and a blue
"📝 New field report from …" with an **Open …** button. Optional: Dashboard → **Also show desktop notifications**, then put the tab in
the background and repeat. → row 36.

**10.11 CCTV footage (laptop).** Admin → **CCTV** → *Analyse a video file* → choose a short street video (for example
one filmed with a phone). *Expect:* it loads the models once (about 100 MB), then a time line and a summary (hazards with
how often they appear, people/boats at most), labelled ADVISORY; nothing is uploaded (Chrome DevTools → Network shows no
upload). → row 32.

**10.12 Badge and error messages (Phone A).** With the HTTPS tunnel running, stop the tunnel for 30 s, then start
it again (same address only if you use a named tunnel; with a quick tunnel just stop/start the laptop server instead).
*Expect:* Offline within about 10 s, Online again within about 5 s, and **never** a red box with "<!DOCTYPE …" text. → row 28.

**10.10 Accessibility and large text.** With the phone's font size at maximum, open Register, Shelters map,
Missing person, and (admin) SOS monitor. Every button must stay readable and tappable.

## Part 11 – Reporting back

1. Fill in every row of [PHONE_TEST.md](PHONE_TEST.md) (pass / fail / not run, device model, Android/iOS version).
2. For any failure, note the step number, a screenshot, and the inspect window at that moment.
3. Copy the final inspect output: `node scripts/inspect-db.mjs > test-run.txt`.

Send those back and I'll fix failures and update the Gate report with real-device results.
