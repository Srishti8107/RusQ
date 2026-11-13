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
import { allocate, canonicalJson } from '@rusq/shared';

// Read-only handle to the shared engine, used by the cross-engine byte-identity
// test (browser JS engine vs server). Exposes no data and no secrets.
(window as unknown as { __rusq: unknown }).__rusq = { allocate, canonicalJson };

startConnectivityMonitor();
startSyncScheduler();
startLocationKeeper();
startUpdateWatcher();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
