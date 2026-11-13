# Real-device phone test checklist

**Status: NOT RUN.** Nothing below has been tested on a physical phone. Emulated results are in
[GATE1_REPORT.md](GATE1_REPORT.md) and do **not** count as passes here. Fill in each row only
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
| 2 | Ready for offline | Sign in as `ravi`, open "Ready for offline", tap "Download everything" | Every line green, including the vision models (~116 MB) | A | not run | |
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

Fill in the device model and Android/iOS version for each run:

- A: ______________________
- B: ______________________
- C: ______________________
