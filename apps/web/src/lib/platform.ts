/**
 * Website or Android app (Capacitor)?
 *
 *  - Website: pages and API share one origin → relative "/api/…".
 *  - Android app: pages are served from https://localhost inside the app, so the API needs the
 *    control-room server's full address: VITE_SERVER_URL at build time, changeable on the
 *    sign-in screen (kept on the phone).
 *
 * Detection uses the global that Capacitor injects into its WebView, so the website bundle and
 * the service worker never load Capacitor code.
 */
const KEY = 'rusq.serverUrl';

export const isNativeApp: boolean =
  typeof window !== 'undefined' && !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

export function defaultServerUrl(): string {
  return (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/+$/, '') ?? '';
}

/** '' on the website (same origin); the configured server on the phone app. */
export function serverOrigin(): string {
  if (!isNativeApp) return '';
  try {
    return (localStorage.getItem(KEY) || defaultServerUrl()).replace(/\/+$/, '');
  } catch {
    return defaultServerUrl();
  }
}

export function setServerUrl(url: string) {
  try {
    localStorage.setItem(KEY, url.trim().replace(/\/+$/, ''));
  } catch {
    /* private mode – the default stays */
  }
}

/** Full URL of an API path ("/sync" → "https://server/api/sync" in the app, "/api/sync" on the web). */
export function apiUrl(path: string): string {
  return `${serverOrigin()}/api${path}`;
}

/**
 * Where the photo-helper MODELS are downloaded from: the website's own origin, or – in the Android app,
 * which does not carry the 94 MB models inside the APK – the control-room server. The ONNX runtime
 * (/ort/) is always local (website: same origin; app: inside the APK).
 */
export function modelOrigin(): string {
  return isNativeApp ? serverOrigin() : typeof location !== 'undefined' ? location.origin : '';
}
