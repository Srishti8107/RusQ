/**
 * Relay envelope (§7 MeshMessage, §8A). Transport-agnostic: the same bytes go
 * over the SIMULATED mesh, the EXPERIMENTAL WebRTC LAN link, and to the server
 * from a gateway.
 *
 * MAC = HMAC-SHA256(teamKey, canonicalJson(envelope without `hops` and `mac`)).
 * `hops` is excluded because every relay increments it; a tampered hop count
 * can only make a message expire sooner, never forge content.
 */
import { z } from 'zod';
import { canonicalJson } from '../canonical.ts';
import { Ack, Allotment, FieldReport, MissingReport, Sos, Uuid } from '../schemas.ts';
import { HLC_RE } from './hlc.ts';
import { hmacSign, hmacVerify } from './crypto.ts';

export const MESH_PROTOCOL_VERSION = 1;
export const MESH_TYPES = ['sos', 'ack', 'allotment', 'report', 'photo_thumb', 'photo_chunk', 'missing', 'code'] as const;
export type MeshType = (typeof MESH_TYPES)[number];

/** Lower number = sent first. SOS/acks/allotments are small and urgent; photos last. */
export const DEFAULT_PRIORITY: Record<MeshType, number> = {
  sos: 0,
  ack: 0,
  allotment: 1,
  report: 1,
  missing: 1,
  /** rescuer short code (shortcode.ts) received by SMS / read out – tiny, so it goes early */
  code: 1,
  photo_thumb: 2,
  photo_chunk: 3,
};

export const DEFAULT_TTL = 64;
export const MAX_ENVELOPE_BYTES = 96 * 1024;
export const CHUNK_BYTES = 16 * 1024;

export const ChunkInfo = z.object({
  photoId: Uuid,
  reportId: Uuid,
  index: z.number().int().min(0),
  total: z.number().int().min(1).max(4096),
  totalBytes: z.number().int().min(1).max(20 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ChunkInfo = z.infer<typeof ChunkInfo>;

/** A rescuer short code as text; the server checks its signature and that the envelope id is shortCodeId(team, ref). */
export const CodePayload = z.object({ text: z.string().min(10).max(200) });

export const PhotoPayload = z.object({
  data: z.string().max(MAX_ENVELOPE_BYTES), // base64 bytes
  mime: z.enum(['image/jpeg', 'image/webp', 'image/png']).default('image/jpeg'),
});

const EnvelopeBase = z.object({
  v: z.literal(MESH_PROTOCOL_VERSION),
  id: Uuid,
  type: z.enum(MESH_TYPES),
  originNodeId: z.string().min(1).max(64),
  createdAt: z.string().regex(HLC_RE),
  hops: z.number().int().min(0).max(255),
  ttl: z.number().int().min(1).max(255),
  priority: z.number().int().min(0).max(9),
  payload: z.unknown(),
  chunkInfo: ChunkInfo.optional(),
  mac: z.string().min(1),
});

export type MeshMessage = z.infer<typeof EnvelopeBase>;
export type UnsignedMessage = Omit<MeshMessage, 'mac'>;

const PAYLOAD_SCHEMA: Record<MeshType, z.ZodTypeAny> = {
  sos: Sos,
  report: FieldReport,
  allotment: Allotment,
  missing: MissingReport,
  ack: Ack,
  code: CodePayload,
  photo_thumb: PhotoPayload,
  photo_chunk: PhotoPayload,
};

export type EnvelopeCheck = { ok: true; msg: MeshMessage } | { ok: false; reason: string };

/** Structural validation (no crypto). */
export function validateEnvelope(raw: unknown): EnvelopeCheck {
  const base = EnvelopeBase.safeParse(raw);
  if (!base.success) return { ok: false, reason: `schema: ${base.error.issues[0]?.path.join('.')} ${base.error.issues[0]?.message}` };
  const m = base.data;
  const p = PAYLOAD_SCHEMA[m.type].safeParse(m.payload);
  if (!p.success) return { ok: false, reason: `payload: ${p.error.issues[0]?.path.join('.')} ${p.error.issues[0]?.message}` };
  const isPhoto = m.type === 'photo_chunk' || m.type === 'photo_thumb';
  if (isPhoto !== !!m.chunkInfo) return { ok: false, reason: 'chunkInfo required exactly for photo messages' };
  if (m.chunkInfo && m.chunkInfo.index >= m.chunkInfo.total) return { ok: false, reason: 'chunk index out of range' };
  if (m.hops > m.ttl) return { ok: false, reason: 'hops exceed ttl' };
  // For record-carrying messages the envelope id IS the record id → acks map 1:1.
  if ((m.type === 'sos' || m.type === 'report' || m.type === 'allotment' || m.type === 'missing') && (m.payload as { id: string }).id !== m.id) {
    return { ok: false, reason: 'envelope id must equal record id' };
  }
  if (approxSize(m) > MAX_ENVELOPE_BYTES) return { ok: false, reason: 'envelope too large' };
  return { ok: true, msg: { ...m, payload: p.data } };
}

function approxSize(m: MeshMessage): number {
  return JSON.stringify(m).length;
}

export function macInput(m: UnsignedMessage | MeshMessage): string {
  const { hops: _h, ...rest } = m as MeshMessage;
  const { mac: _m, ...unsigned } = rest as Partial<MeshMessage>;
  return canonicalJson(unsigned);
}

export async function signEnvelope(key: CryptoKey, m: UnsignedMessage): Promise<MeshMessage> {
  return { ...m, mac: await hmacSign(key, macInput(m)) };
}

export async function verifyEnvelope(key: CryptoKey, m: MeshMessage): Promise<boolean> {
  return hmacVerify(key, macInput(m), m.mac);
}

/** Sort order for sending: priority, then oldest HLC first, then id. */
export function sendOrder(a: MeshMessage, b: MeshMessage): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.chunkInfo && b.chunkInfo && a.chunkInfo.photoId === b.chunkInfo.photoId) return a.chunkInfo.index - b.chunkInfo.index;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
