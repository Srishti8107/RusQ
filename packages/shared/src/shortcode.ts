/**
 * Rescuer SHORT CODE – a whole field report squeezed into one SMS-sized line so it
 * can travel where only a weak mobile signal (2G) or a person reading it aloud works.
 *
 *   RQ1 Tteam-alpha Gtdr1y7q2 P40 U4 NF20A3B2 Z05 D1F3K2 R3K9QF2 H0 X7Q2MZ4PA
 *
 *   RQ1  format version 1
 *   T    team id (as in the account)
 *   G    location as an 8-character geohash (about ±20 m)
 *   P    people who need help
 *   U    urgency 1–5
 *   N    needs: one fixed letter per resource + amount (SHORT_CODE_LETTERS), optional
 *   Z    hazards seen, bit mask of HAZARD_LABELS (2 chars), optional
 *   D    time the report was made (minutes since 2025-01-01 UTC, base32)
 *   R    report reference: derived from the report's id, so every copy of the same
 *        report – and the full report that comes later over the internet – is counted once
 *   H    hop counter: every phone that passes the code on adds 1 (NOT signed, like the
 *        relay envelope's `hops`: a tampered value can only make it look further away)
 *   X    signature: first 40 bits of HMAC-SHA-256(team key, the code without H and X)
 *
 * Numbers in N use plain digits; R, D and X use Crockford base32 (no I, L, O, U) so the
 * code can be read out over a call without confusion. Case does not matter except in T.
 */
import { fromBase64, utf8 } from './canonical.ts';
import { hmacSign } from './mesh/crypto.ts';
import { HAZARD_LABELS, RESOURCE_KEYS, type HazardLabel, type ResourceKey, type ResourceQty } from './resources.ts';
import type { FieldReport } from './schemas.ts';

export const SHORT_CODE_PREFIX = 'RQ1';
/** One SMS with the GSM 7-bit alphabet. */
export const SMS_MAX_CHARS = 160;
export const SHORT_CODE_MAX_HOPS = 30;

/** Fixed one-letter codes (first letters clash: Food / First-aid, Boats / Blankets …). */
export const SHORT_CODE_LETTERS: Record<ResourceKey, string> = {
  food_water: 'F',
  medical_supplies: 'M',
  first_aid_kits: 'A',
  boats: 'B',
  rescue_equipment: 'R',
  clothing_blankets: 'C',
  transportation: 'V',
  other: 'O',
};
const LETTER_TO_KEY = Object.fromEntries(Object.entries(SHORT_CODE_LETTERS).map(([k, l]) => [l, k])) as Record<string, ResourceKey>;

const TIME_EPOCH_MS = Date.UTC(2025, 0, 1);
const TEAM_RE = /^[A-Za-z0-9_-]{1,24}$/;

export interface ShortCode {
  teamId: string;
  lat: number;
  lng: number;
  geohash: string;
  people: number;
  urgency: number;
  requested: ResourceQty;
  hazards: HazardLabel[];
  createdAt: string;
  ref: string;
  hops: number;
  mac: string;
}

/* ------------------------------- base32 ------------------------------- */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function crockNormalize(s: string): string {
  return s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}

function bitsToCrock(bytes: Uint8Array, chars: number): string {
  let out = '';
  let acc = 0;
  let n = 0;
  let i = 0;
  while (out.length < chars) {
    if (n < 5) {
      acc = (acc << 8) | (bytes[i++] ?? 0);
      n += 8;
    }
    n -= 5;
    out += CROCKFORD[(acc >> n) & 31];
    acc &= (1 << n) - 1;
  }
  return out;
}

function intToCrock(v: number, width: number): string {
  let s = '';
  for (let i = 0; i < width; i++) {
    s = CROCKFORD[v % 32] + s;
    v = Math.floor(v / 32);
  }
  return s;
}

function crockToInt(s: string): number | null {
  let v = 0;
  for (const ch of s) {
    const d = CROCKFORD.indexOf(ch);
    if (d < 0) return null;
    v = v * 32 + d;
  }
  return v;
}

/* ------------------------------- geohash ------------------------------- */

const GH = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(lat: number, lng: number, len = 8): string {
  let latR = [-90, 90];
  let lngR = [-180, 180];
  let s = '';
  let bit = 0;
  let ch = 0;
  let even = true;
  while (s.length < len) {
    const r = even ? lngR : latR;
    const v = even ? lng : lat;
    const mid = (r[0]! + r[1]!) / 2;
    if (v >= mid) {
      ch = (ch << 1) | 1;
      r[0] = mid;
    } else {
      ch <<= 1;
      r[1] = mid;
    }
    if (even) lngR = r;
    else latR = r;
    even = !even;
    if (++bit === 5) {
      s += GH[ch];
      bit = 0;
      ch = 0;
    }
  }
  return s;
}

/** Centre of the geohash cell, rounded to 5 decimals (about 1 m). */
export function geohashDecode(hash: string): { lat: number; lng: number } | null {
  const latR = [-90, 90];
  const lngR = [-180, 180];
  let even = true;
  for (const c of hash.toLowerCase()) {
    const d = GH.indexOf(c);
    if (d < 0) return null;
    for (let b = 4; b >= 0; b--) {
      const r = even ? lngR : latR;
      const mid = (r[0]! + r[1]!) / 2;
      if ((d >> b) & 1) r[0] = mid;
      else r[1] = mid;
      even = !even;
    }
  }
  const round = (x: number) => Math.round(x * 1e5) / 1e5;
  return { lat: round((latR[0]! + latR[1]!) / 2), lng: round((lngR[0]! + lngR[1]!) / 2) };
}

/* ------------------------------- helpers ------------------------------- */

/** Report reference (6 chars, 30 bits) derived from the report id – identical on every device. */
export async function shortRef(reportId: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(`rusq-ref|${reportId}`) as BufferSource));
  return bitsToCrock(d, 6);
}

/**
 * Stable record id for a short code (a UUID built from team + ref), so every phone and
 * the server use the same id for the same report → relay dedupe and acks work as usual.
 */
export async function shortCodeId(teamId: string, ref: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(`rusq-code|${teamId}|${ref}`) as BufferSource)).slice(0, 16);
  d[6] = 0x80 | (d[6]! & 0x0f); // version 8 (custom)
  d[8] = 0x80 | (d[8]! & 0x3f);
  const h = [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function needsToken(req: ResourceQty): string {
  return RESOURCE_KEYS.filter((k) => (req[k] ?? 0) > 0)
    .map((k) => `${SHORT_CODE_LETTERS[k]}${req[k]}`)
    .join('');
}

function hazardsToken(h: readonly HazardLabel[]): string {
  let mask = 0;
  HAZARD_LABELS.forEach((label, i) => {
    if (h.includes(label)) mask |= 1 << i;
  });
  return intToCrock(mask, 2);
}

/** The signed part, rebuilt from parsed fields so case/spacing differences never break the MAC. */
function signedBody(c: Omit<ShortCode, 'hops' | 'mac' | 'lat' | 'lng'>): string {
  const parts = [SHORT_CODE_PREFIX, `T${c.teamId}`, `G${c.geohash}`, `P${c.people}`, `U${c.urgency}`];
  const n = needsToken(c.requested);
  if (n) parts.push(`N${n}`);
  if (c.hazards.length) parts.push(`Z${hazardsToken(c.hazards)}`);
  const minutes = Math.max(0, Math.floor((Date.parse(c.createdAt) - TIME_EPOCH_MS) / 60_000));
  parts.push(`D${intToCrock(minutes, 5)}`, `R${c.ref}`);
  return parts.join(' ');
}

async function macFor(teamKey: CryptoKey, body: string): Promise<string> {
  return bitsToCrock(fromBase64(await hmacSign(teamKey, body)), 8);
}

/* ------------------------------- public API ------------------------------- */

export class ShortCodeError extends Error {}

/** Build the code for a saved field report. */
export async function encodeShortCode(r: Pick<FieldReport, 'id' | 'teamId' | 'lat' | 'lng' | 'createdAt' | 'humanFinal'>, teamKey: CryptoKey, hops = 0): Promise<string> {
  if (!TEAM_RE.test(r.teamId)) throw new ShortCodeError(`team id "${r.teamId}" cannot be put in a short code`);
  const geohash = geohashEncode(r.lat, r.lng, 8);
  const fields = {
    teamId: r.teamId,
    geohash,
    people: r.humanFinal.victimCount,
    urgency: r.humanFinal.urgency,
    requested: r.humanFinal.requested,
    hazards: r.humanFinal.hazards,
    createdAt: r.createdAt,
    ref: await shortRef(r.id),
  };
  const body = signedBody(fields);
  return `${body} H${hops} X${await macFor(teamKey, body)}`;
}

/** Find a code inside any text (an SMS may contain other words around it). */
export function extractShortCodes(text: string): string[] {
  const re = /RQ1\s.*?\sX[0-9A-Za-z]{8}\b/gis;
  return [...text.matchAll(re)].map((m) => m[0].replace(/\s+/g, ' ').trim());
}

/** Parse without checking the signature. Throws ShortCodeError with a plain reason. */
export function parseShortCode(text: string): ShortCode {
  const tokens = text.trim().split(/\s+/);
  if (tokens[0]?.toUpperCase() !== SHORT_CODE_PREFIX) throw new ShortCodeError('not a RusQ code (must start with RQ1)');
  const seen = new Map<string, string>();
  for (const t of tokens.slice(1)) {
    const tag = t[0]!.toUpperCase();
    if (seen.has(tag)) throw new ShortCodeError(`part ${tag} appears twice`);
    seen.set(tag, t.slice(1));
  }
  const need = (tag: string) => {
    const v = seen.get(tag);
    if (v === undefined || v === '') throw new ShortCodeError(`part ${tag} is missing`);
    return v;
  };
  const unknown = [...seen.keys()].filter((k) => !'TGPUNZDRHX'.includes(k));
  if (unknown.length) throw new ShortCodeError(`unknown part ${unknown[0]}`);

  const teamId = need('T');
  if (!TEAM_RE.test(teamId)) throw new ShortCodeError('team id is not valid');
  const geohash = need('G').toLowerCase();
  if (geohash.length !== 8) throw new ShortCodeError('location must have 8 characters');
  const pos = geohashDecode(geohash);
  if (!pos) throw new ShortCodeError('location is not valid');
  const int = (tag: string, max: number) => {
    const v = need(tag);
    if (!/^\d{1,7}$/.test(v) || Number(v) > max) throw new ShortCodeError(`part ${tag} must be a number up to ${max}`);
    return Number(v);
  };
  const people = int('P', 100_000);
  const urgency = int('U', 5);
  if (urgency < 1) throw new ShortCodeError('urgency must be 1–5');
  const hops = int('H', 255);

  const requested: ResourceQty = {};
  const n = seen.get('N');
  if (n !== undefined) {
    const items = [...n.toUpperCase().matchAll(/([A-Z])(\d{1,7})/g)];
    if (items.map((m) => m[0]).join('') !== n.toUpperCase() || items.length === 0) throw new ShortCodeError('needs must look like F20A3B2');
    for (const [, letter, amount] of items) {
      const key = LETTER_TO_KEY[letter!];
      if (!key) throw new ShortCodeError(`unknown need letter ${letter}`);
      if (requested[key] !== undefined) throw new ShortCodeError(`need ${letter} appears twice`);
      const q = Number(amount);
      if (q < 1 || q > 1_000_000) throw new ShortCodeError(`amount for ${letter} must be 1–1000000`);
      requested[key] = q;
    }
  }

  let hazards: HazardLabel[] = [];
  const z = seen.get('Z');
  if (z !== undefined) {
    const mask = crockToInt(crockNormalize(z));
    if (z.length !== 2 || mask === null || mask >= 1 << HAZARD_LABELS.length) throw new ShortCodeError('hazard part is not valid');
    hazards = HAZARD_LABELS.filter((_, i) => mask & (1 << i));
  }

  const d = crockToInt(crockNormalize(need('D')));
  if (d === null || need('D').length !== 5) throw new ShortCodeError('time part is not valid');
  const ref = crockNormalize(need('R'));
  if (!/^[0-9A-Z]{6}$/.test(ref) || crockToInt(ref) === null) throw new ShortCodeError('report reference is not valid');
  const mac = crockNormalize(need('X'));
  if (mac.length !== 8 || crockToInt(mac) === null) throw new ShortCodeError('signature is not valid');

  return { teamId, lat: pos.lat, lng: pos.lng, geohash, people, urgency, requested, hazards, createdAt: new Date(TIME_EPOCH_MS + d * 60_000).toISOString(), ref, hops, mac };
}

/** True if the signature matches the team key. */
export async function verifyShortCode(c: ShortCode, teamKey: CryptoKey): Promise<boolean> {
  return (await macFor(teamKey, signedBody(c))) === c.mac;
}

/** Canonical text of a parsed code with a new hop count (the signature stays valid). */
export function formatShortCode(c: ShortCode, hops = c.hops): string {
  return `${signedBody(c)} H${hops} X${c.mac}`;
}

/** The field report the server stores for a code (until the full report replaces it). */
export async function shortCodeToReport(c: ShortCode): Promise<FieldReport> {
  return {
    id: await shortCodeId(c.teamId, c.ref),
    teamId: c.teamId,
    lat: c.lat,
    lng: c.lng,
    locationSource: 'manual',
    victimCount: c.people,
    urgency: c.urgency,
    notes: `Received as a short code (SMS / read out). Location is accurate to about 20 m. Code: ${formatShortCode(c)}`,
    photos: [],
    requested: c.requested,
    aiSuggestion: null,
    humanFinal: { hazards: c.hazards, victimCount: c.people, urgency: c.urgency, requested: c.requested },
    createdAt: c.createdAt,
  };
}

/** Plain-language summary, e.g. for the phone that received a code. */
export function describeShortCode(c: ShortCode, labels: Record<ResourceKey, string>): string {
  const needs = RESOURCE_KEYS.filter((k) => c.requested[k]).map((k) => `${c.requested[k]} ${labels[k]}`);
  return `${c.teamId}: ${c.people} people, urgency ${c.urgency}${needs.length ? `, needs ${needs.join(', ')}` : ', no supplies asked'}${c.hazards.length ? `; seen: ${c.hazards.join(', ')}` : ''}`;
}
