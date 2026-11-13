/**
 * ANDROID APP ONLY: phone-to-phone link with NO internet and NO hotspot, through Google Nearby
 * Connections (Bluetooth + Bluetooth LE + Wi-Fi Direct / hotspot chosen by Android). Native code:
 * android/app/src/main/java/org/rusq/field/NearbyPlugin.java.
 *
 *  - Every signed-in phone both advertises and discovers (strategy P2P_CLUSTER: many-to-many),
 *    connects to every RusQ phone it finds and accepts every incoming connection.
 *  - Over each link it speaks the SAME protocol as the WebRTC link (lan.ts: hello / summary / msg),
 *    so relay, hop counts, signed acks, transfer alerts and the transfer log all work unchanged.
 *  - Trust comes from the relay itself: every message carries the team-key MAC and every
 *    confirmation the server's signature; a stranger's phone can connect but cannot inject data.
 *  - A Nearby BYTES payload holds at most 32 KB, so protocol messages are cut into frames.
 */
import type { PluginListenerHandle } from '@capacitor/core';
import { closeExternalPeer, externalMessage, listPeers, openExternalPeer } from './lan.ts';
import { getRelayNode } from './relay.ts';
import { getSession } from './session.ts';
import { isNativeApp } from './platform.ts';

interface NearbyPlugin {
  start(o: { name: string; serviceId: string }): Promise<void>;
  stop(): Promise<void>;
  send(o: { endpointId: string; data: string }): Promise<void>;
  checkPermissions(): Promise<Record<string, string>>;
  requestPermissions(): Promise<Record<string, string>>;
  addListener(e: 'connected', f: (x: { endpointId: string; name: string }) => void): Promise<PluginListenerHandle>;
  addListener(e: 'disconnected', f: (x: { endpointId: string }) => void): Promise<PluginListenerHandle>;
  addListener(e: 'message', f: (x: { endpointId: string; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(e: 'status', f: (x: { state: string; detail?: string }) => void): Promise<PluginListenerHandle>;
}

export const SERVICE_ID = 'org.rusq.field.relay.v1';
const FRAME = 24_000; // characters per frame (UTF-8 ≤ 3 bytes each would still fit 72 KB – payloads are ASCII JSON in practice)

export type NearbyState = 'unavailable' | 'off' | 'permissions' | 'starting' | 'on' | 'error';
let state: NearbyState = isNativeApp ? 'off' : 'unavailable';
let detail = '';
let plugin: NearbyPlugin | null = null;
const listeners = new Set<() => void>();
const set = (s: NearbyState, d = '') => {
  state = s;
  detail = d;
  listeners.forEach((l) => l());
};
export function nearbyState() {
  return { state, detail, links: listPeers().filter((p) => p.how === 'nearby' && p.state === 'open').length };
}
export function onNearbyChange(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/* ------------------------------- framing ------------------------------- */

let seq = 0;
function sendFramed(endpointId: string, text: string) {
  if (!plugin) return;
  if (text.length <= FRAME) {
    void plugin.send({ endpointId, data: text }).catch(() => {});
    return;
  }
  const id = `${Date.now().toString(36)}${(seq++).toString(36)}`;
  const n = Math.ceil(text.length / FRAME);
  for (let i = 0; i < n; i++) void plugin.send({ endpointId, data: JSON.stringify({ t: 'frag', f: id, i, n, d: text.slice(i * FRAME, (i + 1) * FRAME) }) }).catch(() => {});
}

const partial = new Map<string, { parts: string[]; got: number; at: number }>();
function onRaw(endpointId: string, data: string) {
  if (data.startsWith('{"t":"frag"')) {
    let f: { f: string; i: number; n: number; d: string };
    try {
      f = JSON.parse(data);
    } catch {
      return;
    }
    if (!(f.n > 0 && f.n <= 64 && f.i >= 0 && f.i < f.n)) return;
    const key = `${endpointId}|${f.f}`;
    const cur = partial.get(key) ?? { parts: new Array<string>(f.n), got: 0, at: Date.now() };
    if (cur.parts[f.i] === undefined) cur.got++;
    cur.parts[f.i] = f.d;
    partial.set(key, cur);
    if (cur.got === f.n) {
      partial.delete(key);
      externalMessage(`nb:${endpointId}`, cur.parts.join(''));
    }
    // forget incomplete messages after 2 minutes
    for (const [k, v] of partial) if (Date.now() - v.at > 120_000) partial.delete(k);
    return;
  }
  externalMessage(`nb:${endpointId}`, data);
}

/* ------------------------------- start / stop ------------------------------- */

let handles: PluginListenerHandle[] = [];

/** Starts advertising + discovery once the phone is signed in and holds the team key. Safe to call repeatedly. */
export async function startNearby(): Promise<void> {
  if (!isNativeApp || state === 'starting' || state === 'on') return;
  const [session, node] = await Promise.all([getSession(), getRelayNode()]);
  if (!session) return set('off', 'Sign in first.');
  if (!node) return set('off', 'Open “Ready for offline” once while online to get the team key.');
  if (session.user.role === 'admin') return set('off', 'The control room uses the website.');
  set('starting');
  try {
    const { registerPlugin } = await import('@capacitor/core');
    plugin ??= registerPlugin<NearbyPlugin>('Nearby');
    const perm = await plugin.requestPermissions();
    if (Object.values(perm).some((v) => v !== 'granted')) {
      set('permissions', 'Allow “Nearby devices” and location for RusQ in Android settings so phones can find each other.');
      return;
    }
    for (const h of handles) await h.remove();
    handles = [
      await plugin.addListener('connected', (e) => void openExternalPeer(`nb:${e.endpointId}`, 'nearby', (text) => sendFramed(e.endpointId, text)).then(() => set('on'))),
      await plugin.addListener('disconnected', (e) => {
        closeExternalPeer(`nb:${e.endpointId}`);
        set('on');
      }),
      await plugin.addListener('message', (e) => onRaw(e.endpointId, e.data)),
      await plugin.addListener('status', (e) => (e.state === 'error' ? set('error', e.detail ?? '') : undefined)),
    ];
    await plugin.start({ name: `${session.user.username}|${node.id.slice(0, 8)}`, serviceId: SERVICE_ID });
    set('on');
  } catch (e) {
    set('error', (e as Error).message);
  }
}

export async function stopNearby(): Promise<void> {
  if (!plugin) return;
  await plugin.stop().catch(() => {});
  for (const h of handles) await h.remove();
  handles = [];
  for (const p of listPeers()) if (p.how === 'nearby') closeExternalPeer(p.id);
  set('off');
}

/** Keep trying: after sign-in / setup the conditions change; every 15 s is cheap. */
export function startNearbyKeeper() {
  if (!isNativeApp) return;
  void startNearby();
  setInterval(() => {
    if (state === 'off' || state === 'error') void startNearby();
  }, 15_000);
}

/* ------------------- Android permissions (used by "Ready for offline") ------------------- */

async function getPlugin(): Promise<NearbyPlugin | null> {
  if (!isNativeApp) return null;
  const { registerPlugin } = await import('@capacitor/core');
  plugin ??= registerPlugin<NearbyPlugin>('Nearby');
  return plugin;
}

/** Android app: location + "Nearby devices" (Bluetooth / Wi-Fi) permissions. null on the website. */
export async function nativePermissions(): Promise<{ granted: boolean; denied: boolean } | null> {
  const p = await getPlugin();
  if (!p) return null;
  const r = await Promise.race([p.checkPermissions(), new Promise<null>((res) => setTimeout(() => res(null), 5000))]);
  if (!r) return { granted: false, denied: false };
  const s = Object.values(r);
  return { granted: s.length > 0 && s.every((v) => v === 'granted'), denied: s.some((v) => v === 'denied') };
}

export async function requestNativePermissions(): Promise<boolean> {
  const p = await getPlugin();
  if (!p) return false;
  const s = Object.values(await p.requestPermissions());
  const ok = s.every((v) => v === 'granted');
  if (ok) void startNearby();
  return ok;
}
