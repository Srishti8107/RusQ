/**
 * RusQ field app (Android) – the same React app, packaged with Capacitor, plus the native
 * Nearby Connections plugin (android/app/src/main/java/org/rusq/field/NearbyPlugin.java) that
 * links phones over Bluetooth / Wi-Fi Direct without internet.
 *
 *   VITE_SERVER_URL=https://your-server npm run build:android   (then open android/ in Android Studio, or ./gradlew assembleDebug)
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.rusq.field',
  appName: 'RusQ',
  webDir: 'dist',
  android: {
    // pages are served from https://localhost inside the app; the server allows this origin (CORS)
    allowMixedContent: false,
  },
  server: { androidScheme: 'https' },
};

export default config;
