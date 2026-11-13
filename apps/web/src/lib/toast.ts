/**
 * Pop-up messages (toasts) shown on top of every screen (decisions.md 13.3 / 13.4):
 *  - phone-to-phone transfers ("Connected to team-b and transferring your report", "Receiving from …")
 *  - control room: every new SOS, field report and missing-person report.
 * Plain module + listeners so non-React code (lan.ts, the admin feed) can raise them.
 */
export type ToastKind = 'info' | 'ok' | 'warn' | 'sos';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  link?: { to: string; label: string };
  /** 0 = stays until closed (used for SOS) */
  ms: number;
  tag?: string;
}

let seq = 0;
let list: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();
const MAX = 3; // never cover the whole phone screen

function emit() {
  for (const l of listeners) l(list);
}

export function toast(t: Omit<Toast, 'id' | 'ms'> & { ms?: number }): number {
  const id = ++seq;
  const item: Toast = { ms: t.kind === 'sos' ? 0 : 8000, ...t, id };
  // the same tag replaces the older toast (e.g. repeated "receiving" updates from one phone)
  list = [...list.filter((x) => !t.tag || x.tag !== t.tag), item].slice(-MAX);
  emit();
  if (item.ms > 0) setTimeout(() => dismiss(id), item.ms);
  return id;
}

export function dismiss(id: number) {
  const before = list.length;
  list = list.filter((x) => x.id !== id);
  if (list.length !== before) emit();
}

export function currentToasts(): Toast[] {
  return list;
}

export function onToasts(l: (t: Toast[]) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
