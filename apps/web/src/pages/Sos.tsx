/**
 * SOS (§4): one huge button → 3-second countdown with a big CANCEL → saved to
 * the outbox FIRST (status "Saved on this phone only"), then synced.
 * The same code runs from the in-app button, the Android shortcut
 * (/sos?source=shortcut) and the iOS "SOS" home-screen entry (?source=sos_entry).
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { uuidv7, type Sos } from '@rusq/shared';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { db, kvGet, K, StorageFullError } from '../lib/db.ts';
import { useLive, useNow, useSession } from '../lib/hooks.ts';
import { agoText, getLocation, type LocationResult } from '../lib/location.ts';
import { queueSos } from '../lib/outbox.ts';

const COUNTDOWN_S = 3;

export function SosPage() {
  const session = useSession();
  const [params] = useSearchParams();
  const source = (params.get('source') === 'shortcut' ? 'shortcut' : params.get('source') === 'sos_entry' ? 'sos_entry' : 'app') as Sos['source'];
  const [phase, setPhase] = useState<'idle' | 'counting' | 'saving' | 'saved'>('idle');
  const [count, setCount] = useState(COUNTDOWN_S);
  const [sosId, setSosId] = useState<string | null>(null);
  const [loc, setLoc] = useState<LocationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const now = useNow(15_000);
  const row = useLive(() => (sosId ? db.outbox.get(sosId) : Promise.resolve(undefined)), [sosId], undefined);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  function start() {
    setError(null);
    setPhase('counting');
    setCount(COUNTDOWN_S);
    // start getting location during the countdown so no time is lost
    const locP = getLocation(8000);
    let n = COUNTDOWN_S;
    timer.current = setInterval(() => {
      n -= 1;
      setCount(n);
      if (n <= 0) {
        clearInterval(timer.current!);
        timer.current = null;
        void send(locP);
      }
    }, 1000);
  }

  function cancel() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setPhase('idle');
  }

  async function send(locP: Promise<LocationResult>) {
    setPhase('saving');
    try {
      const l = await locP;
      setLoc(l);
      const profile = await kvGet<Partial<NonNullable<Sos['profile']>>>(K.profile);
      const sos: Sos = {
        id: uuidv7(),
        userId: session!.user.id,
        lat: l.fix?.lat ?? null,
        lng: l.fix?.lng ?? null,
        accuracy: l.fix?.accuracy ?? null,
        locationSource: l.source,
        locationAt: l.fix?.at ?? null,
        createdAt: new Date().toISOString(),
        source,
        profile: { name: profile?.name ?? session!.user.name, contacts: profile?.contacts ?? [], medicalNotes: profile?.medicalNotes },
      };
      await queueSos(sos);
      setSosId(sos.id);
      setPhase('saved');
    } catch (e) {
      setError(e instanceof StorageFullError ? e.message : `Could not save the SOS: ${(e as Error).message}`);
      setPhase('idle');
    }
  }

  return (
    <div className="sos-wrap">
      <h1>Emergency SOS</h1>
      {phase === 'idle' && (
        <>
          <p>Press the red button. You will have {COUNTDOWN_S} seconds to cancel.</p>
          <button className="sos-button" onClick={start} data-testid="sos-button" aria-label="Send SOS">
            SOS
            <small>Press for help</small>
          </button>
        </>
      )}
      {phase === 'counting' && (
        <>
          <p style={{ fontSize: '1.3rem', fontWeight: 700 }}>Sending SOS in</p>
          <div className="countdown" aria-live="assertive" data-testid="sos-countdown">
            {count}
          </div>
          <button className="btn danger secondary block" style={{ maxWidth: 360, minHeight: 72, fontSize: '1.4rem' }} onClick={cancel} data-testid="sos-cancel">
            ✖ CANCEL – do not send
          </button>
        </>
      )}
      {phase === 'saving' && <p aria-live="polite">Saving your SOS…</p>}
      {phase === 'saved' && row && (
        <div className="card" style={{ width: '100%', textAlign: 'left' }} data-testid="sos-result">
          <h2>Your SOS is saved</h2>
          <StatusBadge s={row} long />
          <p className="small" style={{ marginTop: 10 }}>
            {loc?.source === 'live' && <>📍 Location included (accuracy about {loc.fix!.accuracy} m).</>}
            {loc?.source === 'last_known' && (
              <span data-testid="last-known">
                📍 <strong>Last known location, {agoText(loc.fix!.at, now)}</strong> – live location was not available ({loc.error}).
              </span>
            )}
            {loc?.source === 'none' && <>⚠ No location available ({loc.error}). Rescuers will see your name and contacts.</>}
          </p>
          <p>Stay where you are safe. Keep this phone on. RusQ keeps trying to send automatically.</p>
          <div className="row">
            <Link className="btn secondary" to="/outbox">
              See all messages
            </Link>
            <Link className="btn secondary" to="/nearby">
              Pass to a nearby phone
            </Link>
          </div>
        </div>
      )}
      {error && (
        <div className="banner bad" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
