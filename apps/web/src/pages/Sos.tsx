/**
 * SOS screen (§4). The button, countdown and delivery message live in SosPanel (also at the
 * top of Home).
 * The same code runs from the in-app button, the Android shortcut
 * (/sos?source=shortcut) and the iOS "SOS" home-screen entry (?source=sos_entry).
 */
import { useLayoutEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Sos } from '@rusq/shared';
import { SosPanel } from '../components/SosPanel.tsx';

export function SosPage() {
  const [params] = useSearchParams();
  const source = (params.get('source') === 'shortcut' ? 'shortcut' : params.get('source') === 'sos_entry' ? 'sos_entry' : 'app') as Sos['source'];

  // iOS workaround (§4): on /sos?source=sos_entry the page offers its OWN manifest,
  // icon and title, so "Add to Home Screen" creates a separate red "SOS" app whose
  // start address is this SOS screen. Restored when leaving the page.
  const isEntry = source === 'sos_entry';
  // useLayoutEffect: swap BEFORE the first paint, so "Add to Home Screen" can never catch the main manifest.
  useLayoutEffect(() => {
    if (!isEntry) return;
    const swap = (sel: string, attr: string, value: string) => {
      const el = document.querySelector(sel);
      const old = el?.getAttribute(attr) ?? null;
      el?.setAttribute(attr, value);
      return () => (old === null ? el?.removeAttribute(attr) : el?.setAttribute(attr, old));
    };
    let link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
    let created = false;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
      created = true;
    }
    const oldHref = link.getAttribute('href');
    link.setAttribute('href', '/sos.webmanifest');
    const undo = [
      swap('link[rel="apple-touch-icon"]', 'href', '/icons/sos-apple-touch-icon.png'),
      swap('meta[name="apple-mobile-web-app-title"]', 'content', 'SOS'),
      swap('meta[name="theme-color"]', 'content', '#7F0000'),
    ];
    const oldTitle = document.title;
    document.title = 'SOS';
    return () => {
      if (created) link!.remove();
      else if (oldHref) link!.setAttribute('href', oldHref);
      undo.forEach((u) => u());
      document.title = oldTitle;
    };
  }, [isEntry]);
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

  return (
    <div className="sos-wrap">
      <h1>Emergency SOS</h1>
      <SosPanel source={source} />
      {isEntry && !standalone && (
        <div className="card" style={{ textAlign: 'left' }} data-testid="sos-entry-help">
          <h2>Put this SOS button on your home screen</h2>
          <p>
            <strong>iPhone:</strong> tap the Share button (square with an arrow) → <strong>Add to Home Screen</strong> → Add. A red “SOS” icon appears that opens
            straight to this button.
          </p>
          <p>
            <strong>Android:</strong> you can also press and hold the RusQ icon and drag the “SOS” shortcut to your home screen.
          </p>
        </div>
      )}
      {!isEntry && (
        <p className="small">
          <Link to="/sos?source=sos_entry">Add a separate SOS button to your home screen (iPhone)</Link>
        </p>
      )}
    </div>
  );
}
