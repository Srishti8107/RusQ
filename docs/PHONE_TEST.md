# Real-device phone test checklist

**Status: NOT RUN.** Nothing below has been tested on a physical phone. Emulated results are in
[GATE1_REPORT.md](GATE1_REPORT.md) and [GATE2_REPORT.md](GATE2_REPORT.md) and do **not** count as passes here.
The full procedure (HTTPS address, accounts, order of tests) is in [TESTING_GUIDE.md](TESTING_GUIDE.md). Fill in each row only
after testing on a real device. Never mark a row "pass" from emulation.

**Devices to use**

- **A:** low-end Android, about 3 GB RAM, Chrome (primary target)
- **B:** a second Android phone (for the relay test)
- **C:** iPhone, Safari (best effort)

**Before you start**

1. Run the server on a laptop that is on the same Wi-Fi as the phones (`npm run build && npm start`; it listens on `0.0.0.0:8787`).
2. Open `http://<laptop-ip>:8787` on each phone.
3. Note: service workers, WebCrypto and the camera need a **secure context**. On a LAN IP over plain HTTP they won't work. Use HTTPS (for example a tunnel or a self-signed certificate the phones trust) or `localhost` port-forwarding (`chrome://inspect` → Port forwarding).

| # | Test | Steps | Expected | Device | Result (pass / fail / not run) | Notes |
|---|------|-------|----------|--------|-------------------------------|-------|
| 1 | Install | Chrome menu → Install app (iOS: Share → Add to Home Screen) | RusQ icon on home screen; opens without browser bars | A, C | not run | |
| 2 | Ready for offline | Sign in as a rescuer account created by the admin (People & teams), open "Ready for offline", tap "Download everything" | Every line green, including the vision models (~116 MB) | A | not run | |
| 3 | Airplane mode | Turn on airplane mode, open RusQ from the icon | App opens; header shows **Offline** | A, C | not run | |
| 4 | Reboot | Reboot the phone, keep airplane mode on, open RusQ | App opens offline; earlier data still there | A | not run | |
| 5 | Cold start offline | Swipe RusQ away (close), reopen in airplane mode | Opens offline | A, C | not run | |
| 6 | SOS offline | SOS → wait 3 s | "Saved on this phone only" + location (live, or "Last known location, X ago") | A, C | not run | |
| 7 | Report with photo | New report → take photo with the camera → save, offline | Photo thumbnail shown, report saved as queued | A | not run | |
| 8 | Vision offline | Same as 7, low-power mode OFF | Hazard suggestion appears, labelled SUGGESTION ONLY. Record seconds per photo. | A | not run | time: ___ s |
| 9 | Provisional allotment | Tick "Boats", qty 3 | "Can get now" column shows a number; snapshot age shown | A | not run | |
| 10 | Relay between two phones on a hotspot | Phone B makes a hotspot, A joins (no SIM data). Nearby phones → invite → paste/scan → reply → connect | Both show "open". B lists A's report under "from other phones". A shows "Sent – waiting for reply" (NOT received) | A, B | not run | |
| 11 | Reconnect and sync | Turn off airplane mode on A (or let B reach the server) | Items move to **Received by server** with a reference number. If B uploaded, A gets the ack over the link | A, B | not run | |
| 12 | 30-minute battery drain | Full charge, RusQ open on "Nearby phones" with one peer connected, screen on, 30 min | Record battery % used vs a 30-min idle baseline | A | not run | used: ___ % |
| 13 | Storage persistence | Setup page → "Keep data safe" | Shows "Protected"; data survives 3 days unused | A, C | not run | |
| 14 | Android shortcut | Long-press the RusQ icon → "SOS" | Opens the SOS screen directly | A | not run | |
| 15 | Sunlight readability | Use outdoors in direct sun | All text and buttons readable | A | not run | |

**Gate 2 additions (Phase 2 features) – all not run**

| # | Test | Steps | Expected | Device | Result (pass / fail / not run) | Notes |
|---|------|-------|----------|--------|-------------------------------|-------|
| 16 | Register | Sign-in page → "Register…", fill name, age, 1 emergency contact | Lands on "Ready for offline"; My profile shows "Saved on the server" | A, C | not run | |
| 17 | Profile edit offline | Airplane mode → My profile → change a contact → Save | "Saved on this phone only"; after reconnecting it changes to "Saved on the server" | A | not run | |
| 18 | Offline map | Ready for offline → "Map of your area" + "Shelters list" green → airplane mode → Shelters map | Streets and rivers draw; 5 shelters; "Map loaded from this phone" | A, C | not run | |
| 19 | Last-known location on the map | Turn off phone location (or deny permission) → Shelters map | "Last known location, X ago" with a sensible age | A, C | not run | |
| 20 | SOS carries the profile | Send SOS as a registered user; admin opens SOS monitor | Name, contacts (tap to call), needs, urgency level with reasons | A + laptop | not run | |
| 21 | Status back to the victim | Admin: Assign team on that SOS → victim looks at the message under the SOS button on Home | "A rescue team has been sent to you. Team: …" | A + laptop | not run | |
| 22 | iPhone SOS home-screen entry | SOS → "Add a separate SOS button to your home screen" → Share → Add to Home Screen | A red "SOS" icon; opening it goes straight to the SOS button, also in airplane mode | C | not run | |
| 23 | Missing person, family side | Missing person → report (offline OK) → reconnect | Status "received"; family sees only "searching" until the admin verifies | A | not run | |
| 24 | Missing person, admin side | Laptop: Missing persons → Start review → tick 3 checks + note → Verify → Announce | Family phone shows "verified"; Home announcements list the person | laptop + A | not run | |
| 25 | Rescuer task | Admin approves a "Team–skill match" recommendation → rescuer Home | "Tasks for your team" shows it (also after going offline: saved copy) | A + laptop | not run | |
| 26 | Admin dashboard on a phone | Sign in as admin on a phone, open Dashboard, then airplane mode | Map + numbers; offline shows "showing data saved X ago", buttons disabled | A | not run | |
| 27 | AI writing helper (optional) | Settings → AI writing helper (only if WebGPU is shown as available) → download | Either "no WebGPU" (expected on most phones) or the helper loads; record time and memory | A | not run | |
| 28 | Online/Offline badge | Phone on Wi-Fi via the tunnel; walk to the edge of the Wi-Fi, then back; also airplane mode on/off | Offline appears within about 10 s of really losing the server, Online within about 5 s of getting it back; no flipping while the connection works | A | not run | |
| 29 | SOS sent by itself | Airplane mode → SOS → wait 1 min → airplane mode off, do NOT touch the phone | The message under the SOS button changes to "reached the control room" by itself | A | not run | |
| 30 | Phones link by themselves | Two phones on the same hotspot, both open RusQ (signed in, Ready for offline done) while the laptop is reachable; then stop the tunnel | Nearby phones shows "1 phone connected (automatic)" without any code; it stays connected and passes an SOS after the tunnel is stopped | A + B | not run | |
| 31 | Notification for a delayed SOS | Allow notifications when pressing SOS (iPhone: installed home-screen app, iOS 16.4+); SOS in airplane mode; leave the app; airplane mode off | A notification "Your SOS reached the control room – Reference SOS-…" appears once | A, iPhone | not run | |
| 32 | Footage analyser | Admin laptop: CCTV → choose a real phone video of a street | Time line + summary appear; nothing uploaded (check the network panel) | laptop | not run | |
| 33 | Register without password | New phone: Register (keep or change the suggested user ID) → sign out → sign in with the user ID only | Works; the user ID is shown on My profile | A | not run | |
| 34 | Multi-hop alerts | TESTING_GUIDE Part 8: A → B → C on a hotspot WITHOUT internet | Sender: "Connected to {user ID} and transferring your field report"; B and C: "Receiving from {user ID} … Hop 1 / Hop 2"; transfer logs match | A + B + C | not run | |
| 35 | Confirmation back over the chain | Part 8.6–8.7 | Admin shows "2 hops, uploaded by …"; A shows "confirmed … came back through …" without ever having internet | A + B + C + laptop | not run | |
| 36 | Control-room pop-ups | Laptop on any admin screen; SOS and a field report from phones | Pop-ups within ~5 s; the SOS one stays until closed; Open button goes to the right screen | laptop + A | not run | |
| 37 | Missing-person photo | Family adds a phone photo to a missing-person report (also offline, then online) | Admin case shows the photo; another family and rescuers cannot open it | C + laptop | not run | |

Fill in the device model and Android/iOS version for each run:

- A: ______________________
- B: ______________________
- C: ______________________
