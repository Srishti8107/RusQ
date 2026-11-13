/**
 * Phone-to-phone transfer log (decisions.md 13.3): a visible record of what really went from
 * phone to phone, with the other phone's user ID and the hop number. Shown on Nearby phones and
 * kept on the phone (last 50 entries), so a tester can check afterwards that a report travelled
 * without internet.
 */
import { kvGet, kvSet } from './db.ts';

export interface TransferEntry {
  at: string;
  dir: 'out' | 'in' | 'confirm';
  peer: string;
  text: string;
  hops?: number;
}

const KEY = 'transferLog';
let cache: TransferEntry[] | null = null;
const listeners = new Set<(l: TransferEntry[]) => void>();

export async function transferLog(): Promise<TransferEntry[]> {
  if (!cache) cache = (await kvGet<TransferEntry[]>(KEY).catch(() => null)) ?? [];
  return cache;
}

export async function logTransfer(e: Omit<TransferEntry, 'at'>) {
  const l = [{ ...e, at: new Date().toISOString() }, ...(await transferLog())].slice(0, 50);
  cache = l;
  await kvSet(KEY, l).catch(() => {});
  for (const x of listeners) x(l);
}

export function onTransferLog(l: (x: TransferEntry[]) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
