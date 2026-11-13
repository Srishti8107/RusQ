# RusQ Android app (field app)

The **website is for the control room**. People needing help and rescue teams use the **Android app** – the same
React app packaged with Capacitor, plus a native plugin that links phones **without internet, hotspot or pairing**
over Bluetooth / BLE / Wi-Fi Direct (Google Nearby Connections).

| | Website | Android app |
|---|---|---|
| Control room (admin) | ✅ | – (uses the website) |
| Victims / rescuers | only if the server sets `RUSQ_WEB_FIELD_ROLES=1` (e.g. for iPhones) – otherwise an “Install the app” page | ✅ |
| Phone-to-phone without internet | WebRTC on a shared Wi-Fi / hotspot only (unreliable – browsers cannot use Bluetooth or Wi-Fi Direct) | ✅ Nearby Connections: phones in range (≈ 50–100 m) find and link to each other by themselves |

## How the phone link works

- `android/app/src/main/java/org/rusq/field/NearbyPlugin.java`: every signed-in phone advertises **and** discovers
  (strategy `P2P_CLUSTER`, many-to-many), dials every RusQ phone it finds (the phone with the smaller name dials
  first; the other retries after 8 s), and accepts incoming links.
- `apps/web/src/lib/nearby.ts`: speaks the **same protocol** as the WebRTC link (`lan.ts`: hello / summary / msg)
  over each link, so the relay, hop counts, signed confirmations, “Connected to … / Receiving from …” alerts and the
  transfer log work unchanged. Messages over 24 000 characters (photo chunks) are sent in frames (Nearby BYTES
  payloads hold at most 32 KB).
- Security: links are accepted without a PIN; the protection is the relay itself – every message must carry the
  team-key MAC, every confirmation the server's signature.
- The app talks to the server by URL (`VITE_SERVER_URL` at build time, changeable on the sign-in screen); the server
  allows the app's origin `https://localhost` (CORS). Everything else (offline saving, maps, photo helper models,
  sync) is the same code as the website.

## Build

Needs JDK 21 and the Android SDK (platform 36). On this PC they are in `.tools/` (git-ignored).

```bash
cd apps/web
VITE_SERVER_URL=https://your-server.example npm run build:android   # vite build + cap sync + prune source maps
cd android
# Windows (PowerShell): $env:JAVA_HOME='D:\RusQ\.tools\jdk-21.0.13+9'; $env:JAVA_TOOL_OPTIONS='-Djava.net.preferIPv4Stack=true'
./gradlew clean assembleDebug      # → app/build/outputs/apk/debug/app-debug.apk (≈ 15 MB; the photo models, ≈ 95 MB, are downloaded from the server in “Ready for offline”)
```

Put the APK at `apps/server/data/rusq.apk` (or set `RUSQ_APK`): the website's “Install the app” page then offers
it at `/rusq.apk`. For a store / signed release use `./gradlew assembleRelease` with your own keystore.

Without `VITE_SERVER_URL` the sign-in screen asks for the server address once.

## Test on two (or three) real phones – not done yet

Nearby Connections needs real radios; emulators do not support it. Checklist:

1. Install the APK on 2–3 Android phones (Android 7+; Google Play services required).
2. On each: sign in with internet, open **Ready for offline**, allow **Nearby devices** and **location**.
3. Turn **mobile data and Wi-Fi off** on phone A (Bluetooth on). Keep the app open on all phones.
4. **Nearby phones** should show “Bluetooth / Wi-Fi Direct link: on · 1 phone linked” within ~10–30 s.
5. On A, send an SOS or a field report → A shows “Connected to … and transferring”, B shows “Receiving from … hop 1”.
6. Give B internet → the control room receives it (relay, hop count, uploaded by B), and A gets
   “The control room confirmed your … – the confirmation came back through B”.
7. Multi-hop: A ↔ B ↔ C in a line (A and C out of range of each other), only C online.

Record results in `docs/PHONE_TEST.md`.

## In the app, “Ready for offline” differs from the website

- **App works offline** and **Keep data safe** are always green: the app files are inside the installed app and its data is kept until it is uninstalled.
- **Location and nearby devices** asks Android for location + “Nearby devices” (Bluetooth / Wi-Fi) at once.
- **Photo helper** downloads the models from the control-room server (`/models/`, CORS for the app only).
- Photos the control room has confirmed are shrunk to their thumbnail on the phone, so the app does not keep growing.

## Known limits

- Links run while the app is open (foreground). Keeping them alive with the screen off needs an Android
  foreground service – a next step.
- iPhones: no Android app; use the website with `RUSQ_WEB_FIELD_ROLES=1` (WebRTC on a shared hotspot only).
- Range per hop ≈ 50–100 m outdoors (less indoors); multi-hop needs phones spread across the area.
