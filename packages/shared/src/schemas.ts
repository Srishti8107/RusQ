/**
 * Zod schemas shared by client and server (§6, §7). The server validates every
 * request body with these; the client validates before writing to IndexedDB.
 */
import { z } from 'zod';
import { RESOURCE_KEYS, HAZARD_LABELS } from './resources.ts';
import { UUID_RE } from './uuid.ts';

export const Uuid = z.string().regex(UUID_RE, 'must be a lowercase UUID');
export const Lat = z.number().min(-90).max(90);
export const Lng = z.number().min(-180).max(180);
export const IsoDate = z.string().datetime({ offset: true });
export const Role = z.enum(['victim', 'rescuer', 'admin']);
export type Role = z.infer<typeof Role>;

const qty = z.number().int().min(0).max(1_000_000);
export const ResourceKeySchema = z.enum(RESOURCE_KEYS);
/** zod v3: a record with enum keys is a *partial* record (missing keys allowed, unknown keys rejected). */
export const ResourceQtySchema = z.record(ResourceKeySchema, qty);

export const Contact = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(3).max(32),
  relation: z.string().trim().max(40).optional(),
});

export const User = z.object({
  id: Uuid,
  role: Role,
  name: z.string().trim().min(1).max(80),
  contacts: z.array(Contact).max(5).default([]),
  details: z
    .object({
      age: z.number().int().min(0).max(130).optional(),
      medicalNotes: z.string().max(500).optional(),
      language: z.string().max(10).optional(),
      phone: z.string().max(32).optional(),
    })
    .default({}),
});
export type User = z.infer<typeof User>;

/**
 * Delivery status (§2.1). `received` may ONLY be set when an acknowledgement
 * carrying a server-side id has been verified – see delivery.ts.
 */
export const DeliveryStatus = z.enum(['queued', 'sent', 'received']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/** live GPS fix · last known fix (with its age) · typed in by the rescuer · nothing */
export const LocationSource = z.enum(['live', 'last_known', 'manual', 'none']);

export const Sos = z.object({
  id: Uuid,
  userId: Uuid,
  lat: Lat.nullable(),
  lng: Lng.nullable(),
  accuracy: z.number().min(0).max(1_000_000).nullable(),
  locationSource: LocationSource,
  locationAt: IsoDate.nullable().optional(),
  createdAt: IsoDate,
  source: z.enum(['app', 'shortcut', 'sos_entry']).default('app'),
  profile: z
    .object({
      name: z.string().max(80),
      contacts: z.array(Contact).max(5),
      medicalNotes: z.string().max(500).optional(),
      /* Phase 2 profile fields (all optional, so Phase 1 SOS stay valid) */
      age: z.number().int().min(0).max(130).optional(),
      phone: z.string().max(32).optional(),
      householdSize: z.number().int().min(1).max(50).optional(),
      needs: z.array(z.string().max(20)).max(6).optional(),
      occupation: z.string().max(80).optional(),
      workplace: z.string().max(200).optional(),
    })
    .optional(),
  note: z.string().max(500).optional(),
});
export type Sos = z.infer<typeof Sos>;

export const VisionSuggestion = z.object({
  labels: z.array(z.object({ label: z.string(), score: z.number().min(0).max(1) })),
  personCount: z.object({ estimate: z.number().int().min(0), confidence: z.number().min(0).max(1) }).optional(),
  boatCount: z.object({ estimate: z.number().int().min(0), confidence: z.number().min(0).max(1) }).optional(),
  hazards: z.array(z.enum(HAZARD_LABELS)),
  model: z.string(),
  version: z.string(),
  latencyMs: z.number().min(0),
  backend: z.enum(['webgpu', 'wasm', 'mock', 'none']),
  /** diagnostic split of latencyMs */
  timings: z.object({ clipMs: z.number(), detectMs: z.number(), threads: z.number().int().optional() }).optional(),
});
export type VisionSuggestion = z.infer<typeof VisionSuggestion>;

export const ReportFinal = z.object({
  hazards: z.array(z.enum(HAZARD_LABELS)),
  victimCount: z.number().int().min(0).max(100_000),
  urgency: z.number().int().min(1).max(5),
  requested: ResourceQtySchema,
});

export const FieldReport = z.object({
  id: Uuid,
  teamId: z.string().min(1).max(64),
  lat: Lat,
  lng: Lng,
  locationSource: LocationSource.default('live'),
  victimCount: z.number().int().min(0).max(100_000),
  urgency: z.number().int().min(1).max(5),
  notes: z.string().max(4000).default(''),
  photos: z.array(Uuid).max(10).default([]),
  requested: ResourceQtySchema,
  aiSuggestion: VisionSuggestion.nullable().default(null),
  humanFinal: ReportFinal,
  createdAt: IsoDate,
});
export type FieldReport = z.infer<typeof FieldReport>;

export const Site = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['shelter', 'incident']),
  name: z.string().max(120).optional(),
  lat: Lat,
  lng: Lng,
  /** Integer headcount (people at / near the site). Integers keep the engine exact. */
  density: z.number().int().min(0).max(10_000_000),
  /** 1–5. Shelters default to 1; incident sites carry the report's urgency. */
  urgency: z.number().int().min(1).max(5).default(1),
  needs: ResourceQtySchema,
  capacity: z.number().int().min(0).optional(),
});
export type Site = z.infer<typeof Site>;

export const Snapshot = z.object({
  version: z.number().int().min(1),
  createdAt: IsoDate,
  stock: ResourceQtySchema,
  sites: z.array(Site),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const Allotment = z.object({
  id: Uuid,
  deviceId: z.string().min(1).max(64),
  reportId: Uuid.nullable(),
  snapshotVersion: z.number().int().min(1),
  algorithmVersion: z.string(),
  provisional: z.boolean(),
  perSite: z.record(z.string(), ResourceQtySchema),
  /** What this device reserves: the allocation for the report's own incident site. */
  claim: ResourceQtySchema,
  shortfall: ResourceQtySchema,
  createdAt: IsoDate,
});
export type Allotment = z.infer<typeof Allotment>;

export const AuditEntry = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  target: z.string(),
  at: IsoDate,
  details: z.string().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/* ------------------------ missing persons (Phase 2) ------------------------ */

/**
 * A family's missing-person report (§10.6). Created on the phone and queued in
 * the outbox like an SOS (works offline, honest delivery status).
 */
export const MissingReport = z.object({
  id: Uuid,
  reporterId: Uuid,
  person: z.object({
    name: z.string().trim().min(1).max(80),
    age: z.number().int().min(0).max(130).optional(),
    gender: z.enum(['female', 'male', 'other', 'unknown']).default('unknown'),
    description: z.string().trim().max(1000).default(''),
  }),
  lastSeen: z.object({
    place: z.string().trim().min(1).max(200),
    lat: Lat.optional(),
    lng: Lng.optional(),
    at: IsoDate.optional(),
  }),
  contactPhone: z.string().trim().min(3).max(32),
  relation: z.string().trim().max(40).default(''),
  /** photos of the missing person (ids of photo uploads; the bytes travel like report photos) */
  photos: z.array(Uuid).max(3).default([]),
  createdAt: IsoDate,
});
export type MissingReport = z.infer<typeof MissingReport>;

/* ----------------------------- sync API ----------------------------- */

export const SyncItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sos'), data: Sos }),
  z.object({ kind: z.literal('report'), data: FieldReport }),
  z.object({ kind: z.literal('allotment'), data: Allotment }),
  z.object({ kind: z.literal('missing'), data: MissingReport }),
]);
export type SyncItem = z.infer<typeof SyncItem>;

export const SyncRequest = z.object({ items: z.array(SyncItem).min(1).max(50) });

/**
 * A server acknowledgement. `sig` is an ECDSA P-256 signature by the server
 * over canonicalJson({clientId, kind, serverId, receivedAt}); devices verify it
 * with the server public key cached during setup. This is what lets an ack that
 * was RELAYED through other phones still be trusted as a real server ack.
 */
export const Ack = z.object({
  clientId: Uuid,
  kind: z.enum(['sos', 'report', 'allotment', 'photo', 'missing']),
  serverId: z.string().min(1),
  receivedAt: IsoDate,
  duplicate: z.boolean().default(false),
  sig: z.string().min(1),
});
export type Ack = z.infer<typeof Ack>;

export const SyncResponse = z.object({
  acks: z.array(Ack),
  rejected: z.array(z.object({ clientId: z.string(), reason: z.string() })),
});
export type SyncResponse = z.infer<typeof SyncResponse>;
