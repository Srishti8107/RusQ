/**
 * Control-room dashboard (§10.3): central map (hot zones, density heatmap,
 * SOS, reports, shelters, sample CCTV), key numbers, resource summary,
 * analytics. Every map layer is ALSO shown as a table – nothing is map-only.
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Feature, FeatureCollection } from 'geojson';
import { cellPolygon, HAZARD_LABELS, kmText, RESOURCES, type CellSummary, type ResourceKey } from '@rusq/shared';
import { useCachedApi } from '../../lib/cache.ts';
import { Freshness, SevBadge } from '../../components/AdminBits.tsx';
import type { MapLayers, MapMarker } from '../../components/MapView.tsx';

const MapView = lazy(() => import('../../components/MapView.tsx'));

export interface DashboardData {
  generatedAt: string;
  counts: Record<string, number>;
  sosDelay: { medianMs: number | null; maxMs: number | null };
  resources: { resource: ResourceKey; stock: number; requested: number; approved: number; shortfall: number }[];
  byHazard: Record<string, number>;
  timeline: { hourStart: string; sos: number; reports: number }[];
  cells: CellSummary[];
  shelters: { id: string; name: string; lat: number; lng: number; capacity: number | null; occupancy: number; free: number | null }[];
  map: {
    sos: { id: string; serverId: string; lat: number | null; lng: number | null; status: string; name: string }[];
    reports: { id: string; serverId: string; lat: number; lng: number; urgency: number; victims: number; hazards: string[]; teamId: string }[];
    cctv: { id: string; name: string; lat: number; lng: number }[];
  };
}

const SEV_COLOR = { critical: '#3D0C0C', high: '#B06B68', medium: '#F5E3E3', low: '#FFFFFF' };
const FLOOD_COLOR = '#1f6fb2';
const RIVER_COLOR = '#0b3d91';

/** Real Nepal background data (server: WorldPop 2024, Copernicus DEM + OSM rivers, OSM hospitals) + official 2024 figures. */
export interface NepalContext {
  region: { name: string; bounds: [number, number, number, number] };
  sources: Record<'residents' | 'terrain' | 'health', { title: string; url: string; license: string; caution: string }>;
  totals: { residents: number; residentsFloodProne: number; floodProneKm2: number; moderateKm2: number };
  hospitals: { id: string; name: string; kind: 'hospital' | 'clinic'; lat: number; lng: number; emergency?: boolean; floodProne?: boolean }[];
  rivers: FeatureCollection;
  floodProneImage: { url: string; coordinates: [number, number][] };
  reference: {
    title: string;
    source: string;
    url: string;
    deaths: number;
    missing: number;
    injured: number;
    rescued: string;
    emergencyMunicipalities: number;
    emergencyDistricts: number;
    kathmanduRainfall: string;
    bagmatiHouseholds: { fully: number; partially: number };
    rainfallPeriod: string;
    caution: string;
  };
}

export function AdminDashboard() {
  const q = useCachedApi<DashboardData>('/admin/dashboard', 30_000);
  const d = q.data;
  const nepal = useCachedApi<NepalContext>('/admin/nepal-context');
  const n = nepal.data;
  const [show, setShow] = useState({ floodProne: true, rivers: true, zones: true, heat: true, sos: true, reports: true, shelters: true, hospitals: false, cctv: true });

  const overlay: MapLayers | undefined = useMemo(() => {
    if (!d) return undefined;
    const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
    const zones = fc(
      d.cells
        .filter((c) => c.severity !== 'low')
        .map((c) => ({ type: 'Feature', properties: { severity: c.severity, score: c.score, people: c.people, sos: c.openSos }, geometry: { type: 'Polygon', coordinates: [cellPolygon(c.cellId)] } })),
    );
    const heat = fc([
      ...d.map.reports.map((r) => ({ type: 'Feature' as const, properties: { w: r.victims }, geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] } })),
      ...d.map.sos.filter((s) => s.lat !== null && s.status !== 'resolved').map((s) => ({ type: 'Feature' as const, properties: { w: 3 }, geometry: { type: 'Point' as const, coordinates: [s.lng!, s.lat!] } })),
    ]);
    const sos = fc(d.map.sos.filter((s) => s.lat !== null).map((s) => ({ type: 'Feature', properties: { id: s.serverId, status: s.status, name: s.name }, geometry: { type: 'Point', coordinates: [s.lng!, s.lat!] } })));
    const reps = fc(
      d.map.reports.map((r) => ({ type: 'Feature', properties: { id: r.serverId, urgency: r.urgency, victims: r.victims, hazards: r.hazards.join(', '), team: r.teamId }, geometry: { type: 'Point', coordinates: [r.lng, r.lat] } })),
    );
    const vis = (on: boolean) => ({ visibility: on ? 'visible' : 'none' }) as { visibility: 'visible' | 'none' };
    return {
      sources: {
        ...(n ? { floodProne: { type: 'image' as const, url: n.floodProneImage.url, coordinates: n.floodProneImage.coordinates as [[number, number], [number, number], [number, number], [number, number]] } } : {}),
        rivers: { type: 'geojson', data: n?.rivers ?? fc([]) },
        zones: { type: 'geojson', data: zones },
        heat: { type: 'geojson', data: heat }, sos: { type: 'geojson', data: sos }, reps: { type: 'geojson', data: reps } },
      layers: [
        ...(n ? [{ id: 'floodProne', type: 'raster' as const, source: 'floodProne', layout: vis(show.floodProne), paint: { 'raster-opacity': 0.85, 'raster-resampling': 'nearest' as const } }] : []),
        { id: 'rivers', type: 'line', source: 'rivers', layout: vis(show.rivers), paint: { 'line-color': RIVER_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 16, 4] } },
        {
          id: 'zones-fill',
          type: 'fill',
          source: 'zones',
          layout: vis(show.zones),
          paint: { 'fill-color': ['match', ['get', 'severity'], 'critical', SEV_COLOR.critical, 'high', SEV_COLOR.high, SEV_COLOR.medium], 'fill-opacity': 0.45 },
        },
        { id: 'zones-line', type: 'line', source: 'zones', layout: vis(show.zones), paint: { 'line-color': '#3D0C0C', 'line-width': 1 } },
        {
          id: 'heat',
          type: 'heatmap',
          source: 'heat',
          layout: vis(show.heat),
          paint: {
            'heatmap-weight': ['interpolate', ['linear'], ['get', 'w'], 0, 0, 30, 1],
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 10, 15, 16, 45],
            'heatmap-opacity': 0.7,
            'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(245,227,227,0)', 0.3, '#F5E3E3', 0.6, '#B06B68', 1, '#3D0C0C'],
          },
        },
        {
          id: 'reps',
          type: 'circle',
          source: 'reps',
          layout: vis(show.reports),
          paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'urgency'], 1, 6, 5, 12], 'circle-color': '#5C3A1A', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
        },
        {
          id: 'sos',
          type: 'circle',
          source: 'sos',
          layout: vis(show.sos),
          paint: {
            'circle-radius': 8,
            'circle-color': ['match', ['get', 'status'], 'resolved', '#7d8a86', 'assigned', '#123c7a', '#7F0000'],
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 3,
          },
        },
      ],
      popups: {
        sos: (p) => `SOS ${p.id}\n${p.name}\nStatus: ${p.status}`,
        reps: (p) => `Report ${p.id} (${p.team})\n${p.victims} people · urgency ${p.urgency}\n${p.hazards || 'no hazard tags'}`,
        'zones-fill': (p) => `Area: ${String(p.severity).toUpperCase()}\nScore ${p.score} · ${p.people} people · ${p.sos} open SOS`,
        rivers: (p) => `${p.name} (OpenStreetMap)`,
      },
    };
  }, [d, show, n]);

  const markers: MapMarker[] = useMemo(() => {
    if (!d) return [];
    return [
      ...(show.shelters ? d.shelters.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, kind: 'shelter' as const, label: `🏠 ${s.free ?? '?'} free`, title: `${s.name}: ${s.occupancy}/${s.capacity ?? '?'}` })) : []),
      ...(show.cctv ? d.map.cctv.map((c) => ({ id: c.id, lat: c.lat, lng: c.lng, kind: 'cctv' as const, label: `📹 ${c.id}`, title: `${c.name} – SAMPLE CCTV` })) : []),
      ...(show.hospitals && n ? n.hospitals.filter((h) => h.kind === 'hospital').map((h) => ({ id: h.id, lat: h.lat, lng: h.lng, kind: 'hospital' as const, label: '🏥', title: `${h.name} (OpenStreetMap)${h.floodProne ? ' – on low-lying flood-prone land' : ''}` })) : []),
    ];
  }, [d, show, n]);

  const c = d?.counts;
  const maxBar = Math.max(1, ...(d?.timeline.map((t) => t.sos + t.reports) ?? [1]));
  const maxRes = Math.max(1, ...(d?.resources.map((r) => Math.max(r.stock, r.requested)) ?? [1]));

  return (
    <div>
      <h1>Control-room dashboard</h1>
      <AlertsNote />
      <Freshness q={q} />
      {c && (
        <div className="stats" data-testid="stats">
          <Stat n={c.sosOpen!} t="open SOS" alert={c.sosOpen! > 0} to="/admin/sos" />
          <Stat n={c.sosInProgress!} t="SOS being handled" to="/admin/sos" />
          <Stat n={c.sosResolved!} t="SOS resolved" to="/admin/sos" />
          <Stat n={c.reports!} t="field reports" to="/admin/reports" />
          <Stat n={c.peopleReported!} t="people reported" to="/admin/reports" />
          <Stat n={c.criticalAreas!} t="critical areas" alert={c.criticalAreas! > 0} to="/admin/decisions" />
          <Stat n={c.pendingAllotments!} t="allotments to decide" to="/admin/reconcile" />
          <Stat n={c.openConflicts!} t="stock conflicts" alert={c.openConflicts! > 0} to="/admin/reconcile" />
          <Stat n={c.missingOpen!} t="missing-person cases" to="/admin/missing" />
          <Stat n={c.viaRelay!} t="arrived via phone relay" to="/admin/sos" />
        </div>
      )}

      <h2>Central map</h2>
      <fieldset className="card legend" aria-label="Map layers">
        {(
          [
            ['floodProne', 'Flood-prone land near rivers (terrain model – dark: ≤ 3 m above the river, light: ≤ 6 m)', FLOOD_COLOR],
            ['rivers', 'Rivers (OpenStreetMap)', RIVER_COLOR],
            ['zones', 'Hot zones (area score)', '#B06B68'],
            ['heat', 'People density (heatmap)', '#3D0C0C'],
            ['sos', 'SOS (red open · blue assigned · grey resolved)', '#7F0000'],
            ['reports', 'Field reports (bigger = more urgent)', '#5C3A1A'],
            ['shelters', 'Shelters (free places)', '#0B4A22'],
            ['hospitals', `Hospitals (OpenStreetMap – real${n ? `, ${n.hospitals.filter((h) => h.kind === 'hospital').length}` : ''})`, '#0b5d7a'],
            ['cctv', 'Sample CCTV cameras', '#4B2A7A'],
          ] as const
        ).map(([k, label, col]) => (
          <label key={k} className="check" style={{ minHeight: 48, margin: 0 }}>
            <input type="checkbox" checked={show[k]} onChange={(e) => setShow((s) => ({ ...s, [k]: e.target.checked }))} />
            <i style={{ background: col }} aria-hidden="true" /> {label}
          </label>
        ))}
      </fieldset>
      {d && (
        <Suspense fallback={<p>Loading the map…</p>}>
          <MapView overlay={overlay} markers={markers} zoom={12} height="min(70vh, 520px)" ariaLabel="Central map of SOS, reports, hot zones and shelters" fitMarkers offlineHint={false} />
        </Suspense>
      )}
      <div className="legend">
        <span><i style={{ background: SEV_COLOR.critical }} /> critical</span>
        <span><i style={{ background: SEV_COLOR.high }} /> high</span>
        <span><i style={{ background: SEV_COLOR.medium }} /> medium</span>
        <span className="small muted">Areas ≈ 1 km squares. Tap a point or area for details.</span>
      </div>

      {d && (
        <div className="card table-wrap" data-testid="areas" tabIndex={0}>
          <h2>Areas by priority</h2>
          <table>
            <thead>
              <tr>
                <th>Level</th>
                <th>Where</th>
                <th>People</th>
                <th>Open SOS</th>
                <th>Hazards</th>
                <th title="WorldPop 2020 estimate of people living in this ≈1 km area – not people needing help">Residents (est.)</th>
                <th title="Share of the area that is low-lying land next to a river (≤ 3 m above it) – terrain model">Flood-prone land</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {d.cells.filter((x) => x.severity !== 'low').length === 0 && (
                <tr>
                  <td colSpan={8}>No area above “low” yet.</td>
                </tr>
              )}
              {d.cells
                .filter((x) => x.severity !== 'low')
                .map((x) => (
                  <tr key={x.cellId}>
                    <td>
                      <SevBadge s={x.severity} />
                    </td>
                    <td>{x.nearestShelter ? `${kmText(x.nearestShelter.distanceM)} from ${x.nearestShelter.name}` : `${x.lat.toFixed(3)}, ${x.lng.toFixed(3)}`}</td>
                    <td>{x.people}</td>
                    <td>{x.openSos}</td>
                    <td>{[...x.hazards, ...(x.evidence.cctv.length ? ['CCTV sample'] : [])].join(', ') || '–'}</td>
                    <td>{x.context ? x.context.residents.toLocaleString() : '–'}</td>
                    <td>{x.context ? `${Math.round(x.context.floodProneShare * 100)} %` : '–'}</td>
                    <td>{x.score}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <Link to="/admin/decisions">See recommendations and the reasons →</Link>
        </div>
      )}

      {n && <NepalReference n={n} />}

      {d && (
        <div className="card table-wrap" data-testid="resources" tabIndex={0}>
          <h2>Resources: stock vs requests</h2>
          <table>
            <thead>
              <tr>
                <th>Resource</th>
                <th>Live stock</th>
                <th>Requested in reports</th>
                <th>Approved</th>
                <th>Short</th>
                <th style={{ width: '30%' }}>Compare</th>
              </tr>
            </thead>
            <tbody>
              {d.resources
                .filter((r) => r.stock || r.requested || r.approved)
                .map((r) => (
                  <tr key={r.resource} style={r.shortfall ? { background: 'var(--area-affected)' } : undefined}>
                    <td>{RESOURCES[r.resource].label}</td>
                    <td>{r.stock}</td>
                    <td>{r.requested}</td>
                    <td>{r.approved}</td>
                    <td>{r.shortfall ? <strong>{r.shortfall}</strong> : '–'}</td>
                    <td aria-hidden="true">
                      <span className="hbar" style={{ width: `${(100 * r.stock) / maxRes}%` }} />
                      <span className="hbar req" style={{ width: `${(100 * r.requested) / maxRes}%`, marginTop: 2 }} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="small muted">Green bar = stock, red bar = requested.</p>
        </div>
      )}

      {d && (
        <div className="card">
          <h2>Last 24 hours</h2>
          <div className="bars" role="img" aria-label={`SOS and reports per hour. Total ${d.timeline.reduce((n, t) => n + t.sos, 0)} SOS and ${d.timeline.reduce((n, t) => n + t.reports, 0)} reports.`}>
            {d.timeline.map((t) => (
              <div key={t.hourStart} title={`${new Date(t.hourStart).getHours()}:00 – ${t.sos} SOS, ${t.reports} reports`}>
                <span className="b-sos" style={{ height: `${(100 * t.sos) / maxBar}px` }} />
                <span className="b-rep" style={{ height: `${(100 * t.reports) / maxBar}px` }} />
              </div>
            ))}
          </div>
          <div className="legend">
            <span><i style={{ background: 'var(--sos)' }} /> SOS per hour</span>
            <span><i style={{ background: 'var(--brand)' }} /> reports per hour</span>
          </div>
          <h3>Hazards reported</h3>
          <p>{HAZARD_LABELS.filter((h) => d.byHazard[h]).map((h) => `${h}: ${d.byHazard[h]}`).join(' · ') || 'none yet'}</p>
          <h3>Delivery delay (SOS created → received)</h3>
          <p>
            Median {d.sosDelay.medianMs !== null ? fmtDelay(d.sosDelay.medianMs) : '–'}, longest {d.sosDelay.maxMs !== null ? fmtDelay(d.sosDelay.maxMs) : '–'}. Long delays mean the SOS
            waited offline or travelled through other phones.
          </p>
        </div>
      )}

      {d && (
        <div className="card table-wrap" tabIndex={0}>
          <h2>Shelters</h2>
          <table>
            <thead>
              <tr>
                <th>Shelter</th>
                <th>People</th>
                <th>Capacity</th>
                <th>Free</th>
              </tr>
            </thead>
            <tbody>
              {d.shelters.map((s) => (
                <tr key={s.id} style={s.capacity && s.occupancy / s.capacity >= 0.9 ? { background: 'var(--area-affected)' } : undefined}>
                  <td>{s.name}</td>
                  <td>{s.occupancy}</td>
                  <td>{s.capacity ?? '?'}</td>
                  <td>{s.free ?? '?'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ n, t, alert = false, to }: { n: number; t: string; alert?: boolean; to: string }) {
  return (
    <Link to={to} className={`stat${alert ? ' alert' : ''}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <b>{n}</b>
      <span>{t}</span>
    </Link>
  );
}

function fmtDelay(ms: number) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute' : m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** New SOS / reports pop up on every admin screen (adminfeed.ts); desktop notifications are optional. */
function AlertsNote() {
  const supported = typeof Notification !== 'undefined';
  const [perm, setPerm] = useState(supported ? Notification.permission : 'denied');
  return (
    <div className="banner info" data-testid="alerts-note">
      🔔 New SOS, field reports and missing-person reports pop up on every control-room screen within a few seconds.{' '}
      {supported && perm === 'default' && (
        <button className="btn small" onClick={() => void Notification.requestPermission().then(setPerm)}>
          Also show desktop notifications
        </button>
      )}
      {perm === 'granted' && <span>Desktop notifications are on (shown when this tab is in the background).</span>}
    </div>
  );
}

/** Official figures and the real data sources behind the map layers (Nepal sample region). */
function NepalReference({ n }: { n: NepalContext }) {
  const r = n.reference;
  const hosp = n.hospitals.filter((h) => h.kind === 'hospital').length;
  const clin = n.hospitals.filter((h) => h.kind === 'clinic').length;
  const wet = n.hospitals.filter((h) => h.floodProne).length;
  return (
    <div className="card" data-testid="nepal-reference">
      <h2>Reference: {r.title}</h2>
      <p className="small">
        Official figures from{' '}
        <a href={r.url} target="_blank" rel="noreferrer">
          {r.source}
        </a>
        . Rainfall {r.rainfallPeriod}. {r.kathmanduRainfall}.
      </p>
      <div className="ref-grid">
        <div>
          <strong>{r.deaths}</strong>deaths
        </div>
        <div>
          <strong>{r.missing}</strong>missing
        </div>
        <div>
          <strong>{r.injured}</strong>injured
        </div>
        <div>
          <strong>{r.rescued}</strong>people rescued
        </div>
        <div>
          <strong>{r.emergencyMunicipalities}</strong>municipalities in {r.emergencyDistricts} districts declared emergency zones
        </div>
        <div>
          <strong>{r.bagmatiHouseholds.fully.toLocaleString()}</strong>households fully affected in Bagmati ({r.bagmatiHouseholds.partially.toLocaleString()} partially)
        </div>
      </div>
      <p className="small muted">{r.caution}</p>
      <h3>In this map region ({n.region.name})</h3>
      <p className="small" data-testid="nepal-exposure">
        About <strong>{n.totals.residents.toLocaleString()}</strong> people live in this map region (WorldPop 2024 estimate). <strong>{n.totals.floodProneKm2} km²</strong> is low-lying land next to a river
        (≤ 3 m above it) and another {n.totals.moderateKm2} km² is ≤ 6 m above it; about <strong>{n.totals.residentsFloodProne.toLocaleString()}</strong> people live on the low-lying land. {hosp} hospitals and{' '}
        {clin} clinics are mapped in OpenStreetMap{wet ? `; ${wet} of them are on low-lying flood-prone land` : ''}.
      </p>
      <ul className="small muted">
        {Object.values(n.sources).map((x) => (
          <li key={x.title}>
            <a href={x.url} target="_blank" rel="noreferrer">
              {x.title}
            </a>{' '}
            – {x.license}. {x.caution}
          </li>
        ))}
      </ul>
    </div>
  );
}
