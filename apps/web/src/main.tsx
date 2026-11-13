import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './styles.css';
import { App } from './App.tsx';
import { startConnectivityMonitor } from './lib/connectivity.ts';
import { startSyncScheduler } from './lib/sync.ts';
import { startLocationKeeper } from './lib/location.ts';
import { startUpdateWatcher } from './lib/update.ts';
import { startAutoLink } from './lib/autolink.ts';
import { startAdminFeed } from './lib/adminfeed.ts';
import { isNativeApp } from './lib/platform.ts';
import { startNearbyKeeper } from './lib/nearby.ts';
import { allocate, canonicalJson } from '@rusq/shared';

// Read-only handle to the shared engine, used by the cross-engine byte-identity
// test (browser JS engine vs server). Exposes no data and no secrets.
(window as unknown as { __rusq: unknown }).__rusq = { allocate, canonicalJson };

startConnectivityMonitor();
void import('./lib/outbox.ts').then((o) => o.pruneReceivedPhotos()).catch(() => {}); // free space taken by already-confirmed photos
startSyncScheduler();
startLocationKeeper();
if (isNativeApp) {
  // Android app: pages are inside the app (no service worker / web updates); phones link over
  // Bluetooth + Wi-Fi Direct with Google Nearby Connections – no hotspot, no server needed.
  startNearbyKeeper();
} else {
  startUpdateWatcher();
  startAutoLink(); // website: nearby phones on the same Wi-Fi connect by themselves (decisions.md 12.10)
  startAdminFeed(); // control room: pop-up for every new SOS / report (decisions.md 13.4)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
