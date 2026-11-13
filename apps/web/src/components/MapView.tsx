/**
 * Offline vector map (MapLibre GL + PMTiles, §4/§6). Tiles come from ONE
 * self-hosted PMTiles archive held in memory (loaded from the Cache API), so
 * the map works in airplane mode. No glyphs/sprites are used (they would need
 * extra downloads): labels live in DOM markers and in the lists next to the map.
 *
 * If WebGL is unavailable the component says so – every page that shows a map
 * also shows the same information as a list, so nothing is lost.
 */
import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSourceSpecification, type LayerSpecification, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { PMTiles, Protocol, type RangeResponse, type Source } from 'pmtiles';
import type { GeoJSON as GeoJSONData } from 'geojson';
import { loadRegionBuffer, regionInfo, type RegionInfo } from '../lib/offline-map.ts';

class BufferSource implements Source {
  constructor(
    private readonly key: string,
    private readonly buf: ArrayBuffer,
  ) {}
  getKey() {
    return this.key;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: this.buf.slice(offset, offset + length) };
  }
}

let protocolReady: Promise<{ fromCache: boolean; info: RegionInfo | null }> | null = null;

function ensureProtocol() {
  if (!protocolReady) {
    protocolReady = (async () => {
      const [{ buf, fromCache }, info] = await Promise.all([loadRegionBuffer(), regionInfo()]);
      const protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
      protocol.add(new PMTiles(new BufferSource('region', buf)));
      return { fromCache, info };
    })().catch((e) => {
      protocolReady = null;
      throw e;
    });
  }
  return protocolReady;
}

function baseStyle(attribution: string): StyleSpecification {
  const w = (a: number, b: number): maplibregl.ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], 11, a, 17, b];
  return {
    version: 8,
    sources: { base: { type: 'vector', url: 'pmtiles://region', attribution } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#EEF2EF' } },
      { id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', paint: { 'fill-color': '#A8CDE0' } },
      { id: 'waterway', type: 'line', source: 'base', 'source-layer': 'waterway', paint: { 'line-color': '#7DB1CE', 'line-width': ['match', ['get', 'class'], 'large', 3, 1.2] } },
      { id: 'rail', type: 'line', source: 'base', 'source-layer': 'rail', paint: { 'line-color': '#8D9894', 'line-width': 1.2, 'line-dasharray': [3, 2] } },
      { id: 'road-minor', type: 'line', source: 'base', 'source-layer': 'roads', filter: ['==', ['get', 'class'], 'minor'], paint: { 'line-color': '#FFFFFF', 'line-width': w(0.4, 6) } },
      { id: 'road-medium-case', type: 'line', source: 'base', 'source-layer': 'roads', filter: ['==', ['get', 'class'], 'medium'], paint: { 'line-color': '#B9C4C0', 'line-width': w(1.5, 10) } },
      { id: 'road-medium', type: 'line', source: 'base', 'source-layer': 'roads', filter: ['==', ['get', 'class'], 'medium'], paint: { 'line-color': '#FFFFFF', 'line-width': w(1, 8) } },
      { id: 'road-major-case', type: 'line', source: 'base', 'source-layer': 'roads', filter: ['==', ['get', 'class'], 'major'], paint: { 'line-color': '#9C8A6E', 'line-width': w(2.5, 13) } },
      { id: 'road-major', type: 'line', source: 'base', 'source-layer': 'roads', filter: ['==', ['get', 'class'], 'major'], paint: { 'line-color': '#F6E7C1', 'line-width': w(1.8, 11) } },
    ],
  };
}

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  /** short visible text on the marker */
  label: string;
  kind: 'shelter' | 'me' | 'me-old' | 'sos' | 'report' | 'cctv';
  title: string;
  onClick?: () => void;
}

export interface MapLayers {
  sources: Record<string, GeoJSONSourceSpecification>;
  layers: LayerSpecification[];
  /** layer id → builds the popup text for a clicked feature */
  popups?: Record<string, (props: Record<string, unknown>) => string>;
}

export function MapView({
  markers = [],
  overlay,
  center,
  zoom = 13,
  height = 380,
  ariaLabel,
  focus,
  fitMarkers = false,
  offlineHint = true,
}: {
  markers?: MapMarker[];
  overlay?: MapLayers;
  center?: { lat: number; lng: number };
  zoom?: number;
  height?: number | string;
  ariaLabel: string;
  focus?: { lat: number; lng: number; zoom?: number } | null;
  /** zoom so every marker is visible (district overview) */
  fitMarkers?: boolean;
  /** show the "save it for offline" hint (not for the always-online control room) */
  offlineHint?: boolean;
}) {
  const fitted = useRef(false);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const domMarkers = useRef<maplibregl.Marker[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState<boolean | null>(null);
  const [styleLoaded, setStyleLoaded] = useState(false);

  // create the map once
  useEffect(() => {
    let cancelled = false;
    void ensureProtocol()
      .then(({ fromCache, info }) => {
        if (cancelled || !el.current) return;
        setFromCache(fromCache);
        const b = info?.bounds ?? [85.28, 27.67, 85.37, 27.745];
        const pad = 0.04;
        try {
          const m = new maplibregl.Map({
            container: el.current,
            style: baseStyle(info?.attribution ?? '© OpenStreetMap contributors'),
            center: center ? [center.lng, center.lat] : [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2],
            zoom,
            minZoom: 10,
            maxZoom: 18,
            maxBounds: [
              [b[0] - pad, b[1] - pad],
              [b[2] + pad, b[3] + pad],
            ],
            attributionControl: { compact: false },
            dragRotate: false,
            pitchWithRotate: false,
          });
          m.touchZoomRotate.disableRotation();
          m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
          m.on('load', () => {
            if (!cancelled) {
              setStatus('ready');
              setStyleLoaded(true);
            }
          });
          m.on('error', (e) => console.warn('map', e.error?.message));
          // How many base-map features are on screen (tests + a cheap "the map really drew" signal).
          m.on('idle', () => {
            try {
              const n = m.queryRenderedFeatures({ layers: ['water', 'road-minor', 'road-medium', 'road-major'] }).length;
              el.current?.setAttribute('data-rendered-features', String(n));
            } catch {
              /* style not ready */
            }
          });
          map.current = m;
        } catch (e) {
          setStatus('error');
          setError(/webgl/i.test(String(e)) ? 'This phone cannot draw the map (no WebGL). Use the list below.' : (e as Error).message);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setStatus('error');
          setError((e as Error).message);
        }
      });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // DOM markers (accessible buttons with a visible text label)
  useEffect(() => {
    const m = map.current;
    if (!m || status !== 'ready') return;
    for (const d of domMarkers.current) d.remove();
    domMarkers.current = markers.map((mk) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `map-marker ${mk.kind}`;
      b.title = mk.title;
      b.setAttribute('aria-label', mk.title);
      b.textContent = mk.label;
      if (mk.onClick) b.addEventListener('click', mk.onClick);
      else b.tabIndex = -1;
      return new maplibregl.Marker({ element: b, anchor: 'bottom' }).setLngLat([mk.lng, mk.lat]).addTo(m);
    });
  }, [markers, status]);

  // GeoJSON overlay (admin: heat zones, heatmap, points)
  useEffect(() => {
    const m = map.current;
    if (!m || !styleLoaded || !overlay) return;
    for (const l of overlay.layers) if (m.getLayer(l.id)) m.removeLayer(l.id);
    for (const [id, src] of Object.entries(overlay.sources)) {
      const existing = m.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (existing) existing.setData(src.data as GeoJSONData);
      else m.addSource(id, src);
    }
    for (const l of overlay.layers) m.addLayer(l);
    const handlers: [string, (e: maplibregl.MapLayerMouseEvent) => void][] = [];
    for (const [layerId, text] of Object.entries(overlay.popups ?? {})) {
      const h = (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        const div = document.createElement('div');
        div.className = 'map-popup';
        div.textContent = text(f.properties as Record<string, unknown>);
        new maplibregl.Popup({ closeButton: true, maxWidth: '260px' }).setLngLat(e.lngLat).setDOMContent(div).addTo(m);
      };
      m.on('click', layerId, h);
      handlers.push([layerId, h]);
    }
    return () => {
      for (const [id, h] of handlers) m.off('click', id, h);
    };
  }, [overlay, styleLoaded]);

  useEffect(() => {
    if (fitMarkers && !fitted.current && map.current && status === 'ready' && markers.length > 1) {
      fitted.current = true;
      const lngs = markers.map((m) => m.lng);
      const lats = markers.map((m) => m.lat);
      map.current.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        { padding: 40, maxZoom: 15, duration: 0 },
      );
    }
    if (focus && map.current && status === 'ready') map.current.flyTo({ center: [focus.lng, focus.lat], zoom: focus.zoom ?? 15 });
  }, [focus, status, fitMarkers, markers]);

  return (
    <div className="map-wrap">
      <div ref={el} className="map" style={{ height }} role="region" aria-label={ariaLabel} data-testid="map" data-map-status={status} />
      {status === 'loading' && <p className="small muted">Loading the map…</p>}
      {status === 'error' && (
        <div className="banner warn" role="status" data-testid="map-error">
          Map not available: {error}
        </div>
      )}
      {status === 'ready' && (
        <p className="small muted" data-testid="map-source">
          {fromCache ? 'Map loaded from this phone (works offline).' : offlineHint ? 'Map loaded from the internet – open “Ready for offline” to save it on this phone.' : 'Map loaded from the internet.'}
        </p>
      )}
    </div>
  );
}

export default MapView;
