/**
 * Rescuer SHORT CODES on the phone (format: packages/shared/src/shortcode.ts).
 *
 *  - codeFor(report)   : the one-line code of a report this phone made (for SMS / reading out)
 *  - addReceived(text) : codes another rescuer sent by SMS or read out. Each is checked with the
 *                        team key, counted as one hop, kept on the phone, passed on to linked
 *                        phones (relay `code` message) and uploaded as soon as this phone is online
 *  - uploadReceived()  : called by the sync loop
 *  - smsHref()         : opens the phone's SMS app with the code filled in (a web app cannot send
 *                        an SMS by itself – the rescuer taps Send)
 */
import {
  describeShortCode,
  encodeShortCode,
  extractShortCodes,
  formatShortCode,
  parseShortCode,
  RESOURCES,
  RESOURCE_KEYS,
  shortCodeId,
  ShortCodeError,
  SHORT_CODE_MAX_HOPS,
  verifyShortCode,
  type Ack,
  type FieldReport,
  type ResourceKey,
} from '@rusq/shared';
import { api } from './api.ts';
import { kvGet, kvSet } from './db.ts';
import { getTeamKey } from './keys.ts';

const KEY = 'receivedCodes';
const LABELS = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, RESOURCES[k].label.toLowerCase()])) as Record<ResourceKey, string>;

export interface ReceivedCode {
  id: string;
  /** canonical text, hop count already including the hop to this phone */
  text: string;
  summary: string;
  hops: number;
  receivedAt: string;
  status: 'waiting' | 'uploaded' | 'rejected';
  serverId?: string;
  reason?: string;
}

const listeners = new Set<() => void>();
export function onCodesChange(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const emit = () => listeners.forEach((l) => l());

export async function receivedCodes(): Promise<ReceivedCode[]> {
  return (await kvGet<ReceivedCode[]>(KEY)) ?? [];
}
async function save(list: ReceivedCode[]) {
  await kvSet(KEY, list.slice(0, 200));
  emit();
}

/** The code of a report made on this phone. Null if the team key is not on the phone yet. */
export async function codeFor(r: FieldReport): Promise<string | null> {
  const key = await getTeamKey();
  if (!key) return null;
  return encodeShortCode(r, key, 0);
}

export function smsHref(numbers: string, text: string): string {
  const to = numbers
    .split(/[,;\s]+/)
    .map((n) => n.replace(/[^\d+]/g, ''))
    .filter(Boolean)
    .join(',');
  return `sms:${to}?body=${encodeURIComponent(text)}`;
}

export type AddResult = { code: string; ok: true; item: ReceivedCode; duplicate: boolean } | { code: string; ok: false; reason: string };

/** Codes received from another rescuer (pasted from an SMS or typed while they read it out). */
export async function addReceived(text: string): Promise<AddResult[]> {
  const found = extractShortCodes(text);
  const candidates = found.length ? found : [text.trim()];
  const key = await getTeamKey();
  const list = await receivedCodes();
  const out: AddResult[] = [];
  for (const raw of candidates) {
    try {
      const c = parseShortCode(raw);
      if (key && !(await verifyShortCode(c, key))) {
        out.push({ code: raw, ok: false, reason: 'The signature does not match – check for a typing mistake.' });
        continue;
      }
      const id = await shortCodeId(c.teamId, c.ref);
      const known = list.find((x) => x.id === id);
      if (known) {
        out.push({ code: raw, ok: true, item: known, duplicate: true });
        continue;
      }
      if (c.hops + 1 > SHORT_CODE_MAX_HOPS) {
        out.push({ code: raw, ok: false, reason: `It has already been passed on ${c.hops} times – it is not passed on further.` });
        continue;
      }
      const item: ReceivedCode = {
        id,
        text: formatShortCode(c, c.hops + 1), // the hop to this phone
        summary: describeShortCode(c, LABELS),
        hops: c.hops + 1,
        receivedAt: new Date().toISOString(),
        status: 'waiting',
      };
      list.unshift(item);
      out.push({ code: raw, ok: true, item, duplicate: false });
      await relayOn(item);
    } catch (e) {
      out.push({ code: raw, ok: false, reason: e instanceof ShortCodeError ? `Not a valid code: ${e.message}.` : (e as Error).message });
    }
  }
  await save(list);
  if (out.some((r) => r.ok && !r.duplicate)) {
    const { requestSync } = await import('./sync.ts');
    requestSync('short code received');
  }
  return out;
}

/** Hand the code to the relay node so linked phones carry it too (they upload it if they get online first). */
async function relayOn(item: ReceivedCode) {
  try {
    const { getRelayNode, persistNow } = await import('./relay.ts');
    const n = await getRelayNode();
    if (!n || n.has(item.id)) return;
    await n.originate('code', { text: item.text }, { id: item.id });
    await persistNow();
  } catch {
    /* relay not provisioned – the code is still uploaded directly */
  }
}

/** Sync loop: upload waiting codes. Returns how many reached the server. */
export async function uploadReceived(): Promise<number> {
  const list = await receivedCodes();
  const waiting = list.filter((x) => x.status === 'waiting');
  if (!waiting.length) return 0;
  const r = await api<{ results: ({ code: string; ok: true; ack: Ack; duplicate: boolean } | { code: string; ok: false; reason: string })[] }>('/codes', {
    method: 'POST',
    body: JSON.stringify({ text: waiting.map((x) => x.text).join('\n') }),
    timeoutMs: 20_000,
  });
  let done = 0;
  const acks: Ack[] = [];
  r.results.forEach((res, i) => {
    const item = waiting[i];
    if (!item) return;
    if (res.ok) {
      item.status = 'uploaded';
      item.serverId = res.ack.serverId;
      acks.push(res.ack);
      done++;
    } else {
      item.status = 'rejected';
      item.reason = res.reason;
    }
  });
  await save(list);
  try {
    const { learnAcks } = await import('./relay.ts');
    await learnAcks(acks); // linked phones stop carrying these codes
  } catch {
    /* relay not provisioned */
  }
  return done;
}

/** A relayed ack for a code this phone holds (it reached the server through another phone). */
export async function markCodeAcked(ack: Ack) {
  const list = await receivedCodes();
  const item = list.find((x) => x.id === ack.clientId && x.status === 'waiting');
  if (!item) return;
  item.status = 'uploaded';
  item.serverId = ack.serverId;
  await save(list);
}
