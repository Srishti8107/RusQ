/**
 * The SOS button + its status line (decisions.md 12.11 / 12.12). Used at the TOP of Home and on
 * the /sos screen (Android shortcut, iPhone SOS icon).
 *
 * One huge round button → 3-second countdown with a big CANCEL → the SOS is saved on the phone
 * FIRST, then sent automatically (no "Send now" button). Directly below the button, one plain
 * message says whether the latest SOS has reached the control room. If it could not be sent
 * at once, the phone shows a notification when the server confirms it.
 */
import { useEffect, useRef, useState } from 'react';
import { isDelivered, uuidv7, type Sos } from '@rusq/shared';
import { db, StorageFullError, type OutboxRow } from '../lib/db.ts';
import { useCachedApi } from '../lib/cache.ts';
import { sosProfile } from '../lib/profile.ts';
import { useLive, useNow, useReach, useSession } from '../lib/hooks.ts';
import { agoText, getLocation, type LocationResult } from '../lib/location.ts';
import { queueSos } from '../lib/outbox.ts';
import { friendlyError } from '../lib/api.ts';

const COUNTDOWN_S = 3;

const OPS_TEXT: Record<string, string> = {
  open: 'The control room has your SOS and will act on it.',
  acknowledged: 'The control room has seen your SOS and is arranging help.',
  assigned: 'A rescue team has been sent to you.',
  resolved: 'Marked as resolved by the control room.',
};

function time(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Ask once, while the person is pressing the button (browsers only allow it after a tap). */
function askNotificationPermission() {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().catch(() => {});
  } catch {
    /* not supported (e.g. iPhone Safari outside the home-screen app) */
  }
}

export function SosPanel({ source = 'app' }: { source?: Sos['source'] }) {
  const session = useSession();
  const reach = useReach();
  const [phase, setPhase] = useState<'idle' | 'counting' | 'saving'>('idle');
  const [count, setCount] = useState(COUNTDOWN_S);
  const [loc, setLoc] = useState<LocationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const now = useNow(15_000);
  const latest = useLive<OutboxRow | undefined>(
    async () => (await db.outbox.where('kind').equals('sos').toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    [],
    undefined,
  );
  const delivered = !!latest && isDelivered(latest);
  // What the control room is DOING about the SOS (once it has it).
  const ops = useCachedApi<{ id: string; status: string; assignedTeam: string | null; statusAt: string | null }[]>(delivered ? '/me/sos' : null, 30_000);
  const op = latest ? ops.data?.find((x) => x.id === latest.id) : undefined;

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  function start() {
    askNotificationPermission();
    setError(null);
    setPhase('counting');
    setCount(COUNTDOWN_S);
    const locP = getLocation(8000); // find the location during the countdown – no time lost
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
        profile: await sosProfile(session!.user.name),
      };
      await queueSos(sos); // saved first, then sent automatically
      setPhase('idle');
    } catch (e) {
      setError(e instanceof StorageFullError ? e.message : `Could not save the SOS: ${friendlyError(e)}`);
      setPhase('idle');
    }
  }

  return (
    <section className="sos-wrap" aria-label="Emergency SOS">
      {phase === 'idle' && (
        <>
          <button className="sos-button" onClick={start} data-testid="sos-button" aria-label="Send SOS">
            SOS
            <small>Press for help</small>
          </button>
          <p className="small" style={{ margin: 0 }}>
            Press the red button. You have {COUNTDOWN_S} seconds to cancel.
          </p>
        </>
      )}
      {phase === 'counting' && (
        <>
          <p style={{ fontSize: '1.3rem', fontWeight: 700, margin: 0 }}>Sending SOS in</p>
          <div className="countdown" aria-live="assertive" data-testid="sos-countdown">
            {count}
          </div>
          <button className="btn danger secondary block" style={{ maxWidth: 360, minHeight: 72, fontSize: '1.4rem' }} onClick={cancel} data-testid="sos-cancel">
            ✖ CANCEL – do not send
          </button>
        </>
      )}
      {phase === 'saving' && <p aria-live="polite">Saving your SOS…</p>}

      {latest && phase === 'idle' && (
        <div
          className={`banner ${delivered ? 'ok' : 'warn'} sos-status`}
          role="status"
          aria-live="polite"
          data-testid="sos-result"
          data-delivered={delivered ? 'yes' : 'no'}
        >
          <span data-testid="delivery-status" data-status={delivered ? 'received' : latest.status === 'sent' ? 'sent' : 'queued'} hidden />
          {delivered ? (
            <>
              <strong>✅ Your SOS reached the control room</strong> at {time(latest.ack!.receivedAt)} (reference {latest.ack!.serverId}).
              {op && (
                <span className="block-line" data-testid="ops-status" data-status={op.status}>
                  {OPS_TEXT[op.status] ?? op.status}
                  {op.assignedTeam && (
                    <>
                      {' '}
                      Team: <strong>{op.assignedTeam}</strong>.
                    </>
                  )}
                  {!ops.live && ops.at && <span className="small"> (status saved {agoText(ops.at, now)}, no connection now)</span>}
                </span>
              )}
            </>
          ) : (
            <>
              <strong>⏳ Your SOS from {time(latest.createdAt)} has NOT reached the control room yet.</strong>{' '}
              {latest.status === 'sent' && latest.via === 'relay'
                ? 'It was passed to a nearby phone, which will deliver it when it reaches the internet.'
                : reach === 'online'
                  ? 'Sending now…'
                  : 'It is saved on this phone and will be sent automatically as soon as there is a connection.'}{' '}
              You will get a notification when it arrives.
            </>
          )}
          <span className="block-line small" data-testid="sos-location">
            {sosLocationText(latest.data as Sos, loc, now)}
          </span>
        </div>
      )}
      {error && (
        <div className="banner bad" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

function sosLocationText(s: Sos, loc: LocationResult | null, now: number) {
  if (s.locationSource === 'live') return `📍 Location sent with it (accuracy about ${s.accuracy ?? '?'} m).`;
  if (s.locationSource === 'last_known' && s.locationAt)
    return (
      <span data-testid="last-known">
        📍 <strong>Last known location, {agoText(s.locationAt, now)}</strong> – live location was not available{loc?.error ? ` (${loc.error})` : ''}.
      </span>
    );
  return `⚠ No location available${loc?.error ? ` (${loc.error})` : ''}. Rescuers will see your name and family contacts.`;
}
