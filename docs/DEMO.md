# RusQ demo script – Bagmati flood in Kathmandu, Nepal (sample scenario)

About 15–20 minutes. Everything shown is **sample data**: fictional people, sample shelters at real Kathmandu
localities, and synthetic CCTV. Say so when you show it; the app labels it too.

## 0. Prepare (5 minutes, before the audience arrives)

```bash
npm run build
npm start                 # http://localhost:8787
npm run demo              # in a second window: fills the sample flood scenario
```

At the start the server has **only the admin account** (`admin` / `demo1234`). `npm run demo` is the explicit
choice to add sample accounts through the real API:
- three rescue teams, created by the admin like real staff: `demo-ravi` (Team Alpha), `demo-meena` (Team Bravo)
  and `demo-kiran` (Team Charlie), all with password `demo1234`;
- four people needing help, registered with a **user ID only**: `demo-sita`, `demo-laxmi`, `demo-rahim` and
  `demo-bijay`.

It then sends:
- 4 SOS (one has waited 45 minutes with nobody nearby);
- 3 field reports with their **provisional allotments**, which together claim more boats than exist;
- 2 missing-person reports.

Running it twice adds nothing.

Optional, for the phone part: give the phones an HTTPS address ([TESTING_GUIDE.md](TESTING_GUIDE.md), Part 1).

## 1. Before the disaster – a person prepares (phone or narrow browser window)

1. Open the app → **Register as a person who may need help**. There is no username or password: a user ID is
   suggested (keep it or type your own). Fill in:
   - name and age;
   - **total number of people in the house**;
   - tick "Elderly person";
   - add a family member to call;
   - your work.

   Then tap Register. Point out that signing in later needs **only the user ID** (shown on My profile).
2. You land on **Ready for offline**. Tap **Download everything**. Each line turns green only after the app has
   checked it's really stored: app, team key, **map of your area**, shelters, location, protected storage.
3. Open **Home**. The big round **SOS button comes first**; everything else is below it.
4. Open **Shelters near me**: "Map loaded from this phone (works offline)". Shelters within 3 km are listed first,
   then the rest of the district, with distances, free places and tap-to-call.

## 2. Disaster – no network

5. Turn on airplane mode (or stop the server). The header shows **Offline**.
6. **Shelters near me** still opens. If location is off: "**Last known location, X minutes ago**".
7. Home → **SOS** → 3-second countdown (show CANCEL) → under the button: "**has NOT reached the control room
   yet** … will be sent automatically". Explain the honesty rule: it never says "reached" until the control room
   replies with a reference.
8. Turn airplane mode off and **touch nothing**. The message changes by itself to "✅ Your SOS reached the control
   room". If the app was in the background, a notification says so.
9. iPhone users: **SOS → Add a separate SOS button to your home screen** (a red SOS icon that opens straight to the
   button).

## 3. Rescue team in the field (sign in as `demo-ravi` / `demo1234`, offline)

10. **New report**: take or choose a photo of a flooded street. The **photo helper** (on the phone, offline) suggests
    "flooded street" and a people count. It's labelled a suggestion, it **never changes urgency**, and hints like
    "Boats" are never ticked for you.
11. Tick Boats = 3. **Provisional share** shows what this phone may reserve from the cached snapshot, with its age.
    Tap **Explain my share in plain words**.
12. Save. Home → **Your reports** shows it waiting.
13. **Nearby phones** (EXPERIMENTAL): phones on the same Wi-Fi or hotspot **connect by themselves** while the server
    is reachable (no QR code), and stay connected when the internet goes. Saving a report offline shows
    **"Connected to {user ID} and transferring your field report"**; the other phone shows **"Receiving from …, hop 1"**.
    With three phones the hop numbers show multi-hop (TESTING_GUIDE Part 8).

## 4. Connectivity returns → control room (laptop, sign in as `admin`)

The admin lands straight on the dashboard: there is no "Ready for offline" for the always-online control room.

14. Keep any admin screen open: every new SOS pops up in red (it stays until closed), field reports in blue.
    **Dashboard** numbers: open SOS, critical areas, conflicts and so on. The **central map** (Kathmandu, Bagmati river)
    shows:
    - dark-red squares: critical areas;
    - the heatmap: people density;
    - red dots: SOS;
    - brown dots: reports;
    - green labels: shelters;
    - purple: the sample CCTV cameras.

    Turn layers on and off. The same information is in the tables below the map.
15. **SOS monitor**: sorted by urgency level **with the reasons** (elderly +1, medical +1, critical area +1, waiting
    > 60 min +1). Contacts are tap-to-call, and each card shows how the SOS arrived (direct or phone relay) and the
    delay. Press **Assign team** → Team Alpha.
    *On the person's phone:* under the SOS button, "A rescue team has been sent to you. Team: Team Alpha."
16. **Field reports**: photos, what the photo helper suggested vs what the rescuer decided, and the comparison of
    requests across locations.
17. **Allotments**: boats claimed by two teams exceed live stock → **conflict**. Nothing was overwritten. Approve one
    (you may lower it) and reject the other with a note. The conflict resolves itself.
18. **Recommendations**: each card shows **why** (the rule arithmetic) and the evidence it used. **Approve** a team
    assignment. *On that team's phone:* Home → **Tasks for your team** shows it.
19. **Shelters in district**: all 8 sample shelters with totals of free places, on a map fitted to the district.
20. **CCTV**:
    - **Analyse a video file**: choose a street video. The pre-trained on-device models list hazards and an estimate
      of people and boats, frame by frame. The video stays on this computer, and the result is advisory.
    - Below it are the **sample** cameras: synthetic clips with hand-labelled boxes. Switch them off and the
      recommendations change. Say clearly: **no real cameras, no real people.**

## 5. Recovery – missing persons

21. **Missing persons**: "Rina Shrestha" has a **candidate** from the sample registry, with confidence and every
    piece of evidence shown. The family's phone (`demo-sita`) still shows only "searching".
22. Start review → try **Verify** without ticking the checklist: refused. Tick the 3 checks, write a note → Verify
    (recorded with your name). The family's phone now shows "found at …". **Announce** → it appears under "Official
    announcements" on everyone's Home.
23. Point out that the steps cannot be skipped. The server refuses, and the automated tests prove it.

## 6. Proof

24. `npm run inspect-db` shows what the server really holds. **Allotments → audit log**, or `GET /api/admin/audit`:
    every decision has who, what and when.

## What to say about limits

Real-phone tests are still to be done ([PHONE_TEST.md](PHONE_TEST.md)). Be open about these:
- The phone-to-phone link is experimental, and it pairs automatically only while the server is reachable.
- The mesh is simulated.
- The CCTV cameras and the missing-person data are samples, and the footage analyser has not been measured on real
  CCTV.
- Recommendations are advisory.
- People needing help sign in with a user ID only, with no password (an owner's decision).

See [LIMITATIONS.md](../LIMITATIONS.md).
