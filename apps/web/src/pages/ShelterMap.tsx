/**
 * Offline shelter map (§4 victim app). Uses live location when it is on;
 * otherwise the last known position with a visible "Last known location, X ago"
 * label. Shelters come from IndexedDB, tiles from the cached PMTiles file, so
 * this page works in airplane mode. The same shelters are always listed below
 * the map (sorted by distance) – nothing depends on seeing the map.
 *
 * decisions.md 12.8: the control room sees "Shelters in the district" (every shelter, totals);
 * people needing help and rescuers see "Shelters near me" (nearest first, those within
 * NEAR_KM first, the rest of the district below). Same shelter list for everyone.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { distanceM, kmText } from '@rusq/shared';
import { db, type ShelterRow } from '../lib/db.ts';
import { useLive, useNow, useSession } from '../lib/hooks.ts';
import { agoText, getLocation, type LocationResult } from '../lib/location.ts';
import { downloadShelters, sheltersFetchedAt } from '../lib/offline-map.ts';
import type { MapMarker } from '../components/MapView.tsx';

const MapView = lazy(() => import('../components/MapView.tsx'));

/** "Near you" radius for people needing help and rescuers. */
export const NEAR_KM = 3;

export function ShelterMapPage() {
  const session = useSession();
  const isAdmin = session?.user.role === 'admin';
  const shelters = useLive(() => db.shelters.toArray(), [], []);
  const [loc, setLoc] = useState<LocationResult | null>(null);
  const [locBusy, setLocBusy] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number } | null>(null);
  const now = useNow(15_000);

  async function locate() {
    setLocBusy(true);
    setLoc(await getLocation(8000));
    setLocBusy(false);
  }

  useEffect(() => {
    if (!isAdmin) void locate();
    void sheltersFetchedAt().then(setFetchedAt);
    // Online: refresh the list (free places change). Offline: the saved list is used.
    void downloadShelters()
      .then(() => sheltersFetchedAt().then(setFetchedAt))
      .catch(() => {});
    void navigator.storage?.persist?.().catch(() => {}); // keep the map cache from being evicted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const me = isAdmin ? null : (loc?.fix ?? null);
  const sorted = useMemo(
    () =>
      shelters
        .map((s) => ({ s, d: me ? distanceM(me, s) : null }))
        .sort((a, b) => (a.d ?? 0) - (b.d ?? 0) || a.s.name.localeCompare(b.s.name)),
    [shelters, me],
  );
  const near = me ? sorted.filter((x) => x.d! <= NEAR_KM * 1000) : [];
  const rest = me ? sorted.filter((x) => x.d! > NEAR_KM * 1000) : sorted;
  const totals = shelters.reduce((t, s) => ({ cap: t.cap + (s.capacity ?? 0), used: t.used + (s.occupancy ?? 0), free: t.free + (s.free ?? 0) }), { cap: 0, used: 0, free: 0 });

  const markers: MapMarker[] = useMemo(() => {
    const list: MapMarker[] = shelters.map((s) => ({
      id: s.id,
      lat: s.lat,
      lng: s.lng,
      kind: 'shelter',
      label: `🏠 ${s.name.split(',').pop()!.trim()}`, // the locality: short and unique
      title: `Shelter: ${s.name}${s.free !== null ? `, ${s.free} free places` : ''}`,
      onClick: () => document.getElementById(`shelter-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    }));
    if (me) list.push({ id: 'me', lat: me.lat, lng: me.lng, kind: loc?.source === 'live' ? 'me' : 'me-old', label: loc?.source === 'live' ? '📍 You' : '📍 You (last known)', title: 'Your position' });
    return list;
  }, [shelters, me, loc?.source]);

  return (
    <div>
      <h1>{isAdmin ? 'Shelters in the district' : 'Shelters near me'}</h1>
      <p className="small muted">
        <span className="label-sample">SAMPLE DATA</span> Sample shelters in Kathmandu district, Nepal (names and phone numbers are made up). Map data ©
        OpenStreetMap contributors.
      </p>

      {isAdmin && (
        <div className="card" data-testid="district-totals">
          <p style={{ margin: 0 }}>
            <strong>{shelters.length}</strong> shelters · <strong>{totals.free}</strong> free places · {totals.used} of {totals.cap} places used
          </p>
        </div>
      )}

      {!isAdmin && (
      <div className="card" data-testid="my-location">
        {locBusy && <p>Finding your location…</p>}
        {!locBusy && loc?.source === 'live' && <p>📍 Using your live location (accuracy about {loc.fix!.accuracy} m).</p>}
        {!locBusy && loc?.source === 'last_known' && (
          <p data-testid="map-last-known">
            📍 <strong>Last known location, {agoText(loc.fix!.at, now)}</strong> – live location is not available ({loc.error}).
          </p>
        )}
        {!locBusy && loc?.source === 'none' && <p>⚠ No location available ({loc.error}). Shelters are listed by name.</p>}
        <button className="btn secondary small" onClick={() => void locate()} disabled={locBusy}>
          Update my location
        </button>
      </div>
      )}

      {shelters.length === 0 ? (
        <div className="banner warn">
          {isAdmin ? (
            'Loading the shelter list…'
          ) : (
            <>
              No shelters are saved on this phone yet. <Link to="/setup">Open “Ready for offline”</Link> while connected.
            </>
          )}
        </div>
      ) : (
        <Suspense fallback={<p>Loading the map…</p>}>
          <MapView markers={markers} center={me ?? undefined} zoom={me ? 14 : 12} ariaLabel="Map of shelters" focus={focus} fitMarkers={isAdmin} offlineHint={!isAdmin} />
        </Suspense>
      )}

      {fetchedAt && <p className="small muted">Shelter list saved {agoText(fetchedAt, now)}. Free places may have changed since.</p>}
      {me && (
        <>
          <h2>Near you (within {NEAR_KM} km)</h2>
          {near.length === 0 && <p data-testid="none-near">No shelter within {NEAR_KM} km. The nearest ones are listed below.</p>}
          {near.map(({ s, d }) => (
            <ShelterCard key={s.id} s={s} d={d} near onShow={() => setFocus({ lat: s.lat, lng: s.lng })} />
          ))}
        </>
      )}
      <h2>{isAdmin ? `All ${shelters.length} shelters` : me ? 'Other shelters in the district (nearest first)' : 'All shelters in the district'}</h2>
      {rest.map(({ s, d }) => (
        <ShelterCard key={s.id} s={s} d={d} onShow={() => setFocus({ lat: s.lat, lng: s.lng })} />
      ))}
    </div>
  );
}

function ShelterCard({ s, d, near = false, onShow }: { s: ShelterRow; d: number | null; near?: boolean; onShow: () => void }) {
  return (
        <div className="card" id={`shelter-${s.id}`} data-testid="shelter-row" data-near={near ? 'yes' : 'no'}>
          <div className="row between">
            <h3 style={{ margin: 0 }}>🏠 {s.name}</h3>
            {d !== null && <strong>{kmText(d)}</strong>}
          </div>
          <p className="small">{s.address}</p>
          <p className="small">
            {s.free !== null ? (
              <>
                <strong>{s.free}</strong> free places ({s.occupancy} of {s.capacity} used)
              </>
            ) : (
              'Capacity unknown'
            )}
          </p>
          {s.facilities.length > 0 && <p className="small">Has: {s.facilities.join(', ')}</p>}
          <div className="row">
            {s.phone && (
              <a className="btn secondary small" href={`tel:${s.phone.replace(/\s/g, '')}`}>
                📞 Call {s.phone}
              </a>
            )}
            <button className="btn secondary small" onClick={onShow}>
              Show on map
            </button>
          </div>
        </div>
  );
}
