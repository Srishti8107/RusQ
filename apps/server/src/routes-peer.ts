/**
 * Automatic pairing of nearby phones (decisions.md 12.10) – replaces the QR / copy-paste step.
 *
 * Browsers cannot discover each other on a Wi-Fi network by themselves, so while a phone can
 * reach the server it "checks in" here. Phones that check in from the SAME network (same
 * public IP address = same Wi-Fi / hotspot behind one router) are told about each other and
 * swap their WebRTC connection offers through a short-lived mailbox. The resulting
 * phone-to-phone link uses only local (host) addresses, so it KEEPS WORKING after the
 * internet or the server goes away.
 *
 * Memory only (nothing stored in the database): presence expires after 25 s, mail after 60 s.
 *
 *   POST /api/peer/poll  { nodeId, out?: [{ to, type: 'offer'|'answer', sdp, linkId }] }
 *        → { peers: [nodeId…], inbox: [{ from, type, sdp, linkId }] }
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from './auth.ts';
import type { ServerKeys } from './keys.ts';

const PRESENCE_MS = 25_000;
const MAIL_MS = 60_000;

interface Mail {
  from: string;
  type: 'offer' | 'answer';
  sdp: string;
  linkId: string;
  at: number;
  group: string;
}

const Poll = z.object({
  nodeId: z.string().min(1).max(80),
  out: z
    .array(z.object({ to: z.string().min(1).max(80), type: z.enum(['offer', 'answer']), sdp: z.string().min(1).max(30_000), linkId: z.string().min(1).max(80) }))
    .max(10)
    .default([]),
});

export async function registerPeerRoutes(app: FastifyInstance, keys: ServerKeys, now: () => number = Date.now) {
  const any = requireRole(keys.tokenSecret);
  const presence = new Map<string, { group: string; at: number }>();
  const mailbox = new Map<string, Mail[]>();

  const sweep = (t: number) => {
    for (const [id, p] of presence) if (t - p.at > PRESENCE_MS) presence.delete(id);
    for (const [id, list] of mailbox) {
      const kept = list.filter((m) => t - m.at <= MAIL_MS);
      if (kept.length) mailbox.set(id, kept);
      else mailbox.delete(id);
    }
  };

  app.post('/api/peer/poll', { preHandler: any }, async (req) => {
    const body = Poll.parse(req.body);
    const t = now();
    sweep(t);
    const group = req.ip; // same public address ≈ same Wi-Fi / hotspot
    presence.set(body.nodeId, { group, at: t });
    for (const m of body.out) {
      const target = presence.get(m.to);
      if (!target || target.group !== group) continue; // only phones on the same network
      const list = mailbox.get(m.to) ?? [];
      list.push({ from: body.nodeId, type: m.type, sdp: m.sdp, linkId: m.linkId, at: t, group });
      mailbox.set(m.to, list.slice(-20));
    }
    const inbox = (mailbox.get(body.nodeId) ?? []).filter((m) => m.group === group).map(({ from, type, sdp, linkId }) => ({ from, type, sdp, linkId }));
    mailbox.delete(body.nodeId);
    const peers = [...presence.entries()].filter(([id, p]) => id !== body.nodeId && p.group === group).map(([id]) => id);
    return { peers, inbox };
  });
}
