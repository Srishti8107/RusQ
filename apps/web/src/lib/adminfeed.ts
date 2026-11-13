/**
 * Control-room alerts (decisions.md 13.4). While an admin is signed in, every 5 s ask the server
 * what arrived since the last check, and pop up a message for each new SOS (stays until closed),
 * field report and missing-person report – on whatever admin screen is open. If the admin allowed
 * desktop notifications, they also appear when the tab is in the background. Open admin screens
 * are told to refresh (event "rusq:admin-feed").
 */
import { api } from './api.ts';
import { currentReach } from './connectivity.ts';
import { getSession } from './session.ts';
import { toast } from './toast.ts';

export const FEED_MS = 5000;

export interface FeedItem {
  kind: 'sos' | 'report' | 'missing';
  id: string;
  serverId: string;
  receivedAt: string;
  title: string;
  detail: string;
  relay: { hops: number | null; gateway: string | null } | null;
}

let since: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const LINK = { sos: { to: '/admin/sos', label: 'Open SOS monitor' }, report: { to: '/admin/reports', label: 'Open field reports' }, missing: { to: '/admin/missing', label: 'Open missing persons' } };
const ICON = { sos: '🆘', report: '📝', missing: '🔎' };

function relayLine(r: FeedItem['relay']): string {
  if (!r) return '';
  return r.hops !== null ? ` · came through ${r.hops} phone hop${r.hops === 1 ? '' : 's'}, uploaded by ${r.gateway ?? 'a nearby phone'}` : ' · came through nearby phones';
}

export function showFeedItem(it: FeedItem) {
  const what = it.kind === 'sos' ? it.title : it.title.charAt(0).toLowerCase() + it.title.slice(1);
  toast({
    kind: it.kind === 'sos' ? 'sos' : 'info',
    title: `${ICON[it.kind]} New ${what} (${it.serverId})`,
    body: `${it.detail}${relayLine(it.relay)}`,
    link: LINK[it.kind],
    ms: it.kind === 'sos' ? 0 : 15_000,
    tag: `feed-${it.id}`,
  });
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
      new Notification(`${ICON[it.kind]} New ${what}`, { body: it.detail, tag: it.id, requireInteraction: it.kind === 'sos' });
    }
  } catch {
    /* notifications not available */
  }
}

/** One poll. Exported for tests. */
export async function pollAdminFeed(): Promise<FeedItem[]> {
  const s = await getSession();
  if (!s || s.user.role !== 'admin') {
    since = null;
    return [];
  }
  if (currentReach() !== 'online') return [];
  const r = await api<{ now: string; items: FeedItem[] }>(`/admin/feed${since ? `?since=${encodeURIComponent(since)}` : ''}`, { timeoutMs: 8000 });
  since = r.now;
  for (const it of r.items) showFeedItem(it);
  if (r.items.length) window.dispatchEvent(new CustomEvent('rusq:admin-feed', { detail: r.items }));
  return r.items;
}

export function startAdminFeed() {
  if (timer) return;
  const loop = async () => {
    await pollAdminFeed().catch(() => {});
    timer = setTimeout(loop, FEED_MS);
  };
  timer = setTimeout(loop, 1000);
}
