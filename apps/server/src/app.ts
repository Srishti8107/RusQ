/**
 * Fastify application factory. `buildApp()` is used by the CLI entry point
 * (index.ts) and directly by integration tests via `app.inject()`.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  allocate,
  AllocationInputError,
  ResourceQtySchema,
  Site,
  SyncRequest,
  Uuid,
  type Ack,
  type AllocationInput,
} from '@rusq/shared';
import { openDb, type Db } from './db.ts';
import { loadKeys } from './keys.ts';
import { HttpError, Services } from './services.ts';
import { hashPassword, requireRole, signToken, verifyPassword } from './auth.ts';
import { seedDemo } from './seed.ts';

export interface AppOptions {
  dbPath?: string;
  db?: Db;
  seed?: boolean;
  staticDir?: string;
  logger?: boolean;
  /** login attempts per minute per IP (default 20) */
  loginRateLimitMax?: number;
  /** requests per minute per IP (global); tests can lower/raise it */
  rateLimitMax?: number;
  now?: () => Date;
}

export async function buildApp(opts: AppOptions = {}): Promise<{ app: FastifyInstance; services: Services }> {
  const db = opts.db ?? openDb(opts.dbPath ?? ':memory:');
  const keys = await loadKeys(db);
  const services = new Services(db, keys, opts.now);
  if (opts.seed) seedDemo(services);

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 12 * 1024 * 1024, trustProxy: true });

  // Brotli/gzip for text assets – first install over slow mobile data matters most.
  await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'] });

  await app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax ?? 600,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/api/health',
  });

  // Cross-origin isolation → SharedArrayBuffer → multi-threaded WASM for on-device vision.
  // Safe: every resource RusQ loads is same-origin (fonts, models and runtime are self-hosted).
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Embedder-Policy', 'require-corp');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'validation failed', issues: err.issues.slice(0, 5) });
    if (err instanceof AllocationInputError) return reply.code(400).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'internal error' : (err as Error).message });
  });

  const any = requireRole(keys.tokenSecret);
  const fieldOrAdmin = requireRole(keys.tokenSecret, 'rescuer', 'admin');
  const admin = requireRole(keys.tokenSecret, 'admin');

  /* ------------------------------ public ------------------------------ */

  // Reachability probe used by the client's "real offline detection" (§5).
  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  app.get('/api/server-key', async () => ({ ackPublicJwk: keys.ackPublicJwk }));

  app.post('/api/auth/login', { config: { rateLimit: { max: opts.loginRateLimitMax ?? 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) }).parse(req.body);
    const u = db.prepare('SELECT id, username, password_hash, role, name, team_id FROM users WHERE username = ?').get(body.username.toLowerCase()) as
      | { id: string; username: string; password_hash: string; role: 'victim' | 'rescuer' | 'admin'; name: string; team_id: string | null }
      | undefined;
    if (!u || !verifyPassword(body.password, u.password_hash)) {
      services.audit(body.username, 'auth.failed', 'login');
      return reply.code(401).send({ error: 'wrong username or password' });
    }
    const token = signToken(keys.tokenSecret, { sub: u.id, role: u.role, name: u.name, teamId: u.team_id });
    services.audit(u.username, 'auth.login', u.id);
    return { token, user: { id: u.id, username: u.username, role: u.role, name: u.name, teamId: u.team_id } };
  });

  /* ------------------------------ setup ------------------------------- */

  /**
   * Offline provisioning: the team key (relay MAC) and the server ack public key.
   * Handed to any signed-in user (victims relay SOS too). See LIMITATIONS.md
   * on the shared symmetric key.
   */
  app.get('/api/setup/keys', { preHandler: any }, async (req) => {
    services.audit(req.user!.sub, 'setup.keys', 'team_key');
    return { teamKey: keys.teamKeyB64, teamKeyId: keys.teamKeyId, ackPublicJwk: keys.ackPublicJwk, teamId: req.user!.teamId };
  });

  app.get('/api/snapshot', { preHandler: any }, async (_req, reply) => {
    const s = services.latestSnapshot();
    if (!s) return reply.code(404).send({ error: 'no snapshot published' });
    return s;
  });

  /* ------------------------------- sync ------------------------------- */

  app.post('/api/sync', { preHandler: any, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const user = req.user!;
    const raw = (req.body as { items?: unknown[] })?.items;
    if (!Array.isArray(raw)) throw new HttpError(400, 'items[] required');
    if (raw.length === 0 || raw.length > 50) throw new HttpError(400, 'items must have 1..50 entries');
    const acks: Ack[] = [];
    const rejected: { clientId: string; reason: string }[] = [];
    for (const item of raw) {
      const parsed = SyncRequest.shape.items.element.safeParse(item);
      const clientId = String((item as { data?: { id?: string } })?.data?.id ?? '?');
      if (!parsed.success) {
        rejected.push({ clientId, reason: `${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}` });
        continue;
      }
      const it = parsed.data;
      if (it.kind === 'sos') {
        if (user.role === 'victim' && it.data.userId !== user.sub) {
          rejected.push({ clientId, reason: 'SOS userId must match the signed-in user' });
          continue;
        }
        acks.push(await services.ingestSos(it.data, 'direct', user.sub));
      } else if (user.role === 'victim') {
        rejected.push({ clientId, reason: `role victim cannot submit ${it.kind}` });
      } else if (it.kind === 'report') {
        acks.push(await services.ingestReport(it.data, 'direct', user.sub));
      } else {
        acks.push(await services.ingestAllotment(it.data, 'direct', user.sub));
      }
    }
    return { acks, rejected };
  });

  /** Gateway upload: relay envelopes collected from other phones (any signed-in user can be a gateway). */
  app.post('/api/mesh/upload', { preHandler: any, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ envelopes: z.array(z.unknown()).min(1).max(200) }).parse(req.body);
    return services.ingestEnvelopes(body.envelopes, req.user!.sub);
  });

  app.addContentTypeParser(['image/jpeg', 'image/webp', 'image/png'], { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  app.put('/api/photos/:id', { preHandler: fieldOrAdmin }, async (req) => {
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const reportId = Uuid.parse(req.headers['x-report-id']);
    const mime = String(req.headers['content-type']).split(';')[0]!;
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'image body required');
    if (!looksLikeImage(body)) throw new HttpError(400, 'body is not a JPEG/PNG/WebP image');
    return services.ingestPhoto(id, reportId, mime, new Uint8Array(body), req.user!.sub);
  });

  app.get('/api/photos/:id', { preHandler: fieldOrAdmin }, async (req, reply) => {
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const p = services.getPhoto(id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    return reply.type(p.mime).send(Buffer.from(p.bytes));
  });

  /** Runs the SAME shared engine – used for the client/server byte-identical parity check. */
  app.post('/api/allocate', { preHandler: any }, async (req) => {
    return allocate(req.body as AllocationInput);
  });

  /* ------------------------------- admin ------------------------------ */

  app.get('/api/admin/overview', { preHandler: admin }, async () => ({
    counts: { sos: services.count('sos'), reports: services.count('reports'), allotments: services.count('allotments'), photos: services.count('photos') },
    liveStock: services.liveStock(),
    snapshot: services.latestSnapshot(),
  }));

  app.get('/api/admin/sos', { preHandler: admin }, async () => services.listSos());
  app.get('/api/admin/reports', { preHandler: admin }, async () => services.listReports());

  app.get('/api/admin/reconciliation', { preHandler: admin }, async () => {
    const result = services.runReconciliation('system');
    const snap = services.latestSnapshot();
    return {
      liveStock: services.liveStock(),
      pendingTotals: result.totals,
      conflicts: services.conflicts(),
      allotments: services.allAllotments().map((a) => ({ ...a, staleSnapshot: !!snap && a.snapshotVersion < snap.version })),
      snapshotVersion: snap?.version ?? null,
      serverRecompute: snap ? allocate({ snapshotVersion: snap.version, stock: services.liveStock(), sites: snap.sites, provisional: false }) : null,
    };
  });

  app.post('/api/admin/allotments/:id/decision', { preHandler: admin }, async (req) => {
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const body = z
      .object({ decision: z.enum(['approve', 'reject']), approvedClaim: ResourceQtySchema.optional(), note: z.string().max(500).optional() })
      .parse(req.body);
    services.decideAllotment(id, body.decision, req.user!.sub, body);
    return { ok: true };
  });

  app.put('/api/admin/stock', { preHandler: admin }, async (req) => {
    services.setLiveStock(ResourceQtySchema.parse(req.body), req.user!.sub);
    return services.liveStock();
  });

  app.put('/api/admin/sites', { preHandler: admin }, async (req) => {
    services.setSites(z.array(Site).max(500).parse(req.body), req.user!.sub);
    return { ok: true };
  });

  app.post('/api/admin/snapshot', { preHandler: admin }, async (req) => services.publishSnapshot(req.user!.sub));

  app.get('/api/admin/audit', { preHandler: admin }, async () => services.listAudit());

  /* ------------------------- static web app --------------------------- */

  if (opts.staticDir && existsSync(opts.staticDir)) {
    await app.register(fastifyStatic, { root: opts.staticDir, wildcard: false, index: ['index.html'] });
    // SPA fallback ONLY for page navigations (no file extension, not an asset dir).
    // A missing /models/x.onnx must be a real 404 – never index.html with status 200.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0]!;
      const isAssetDir = /^\/(api|models|ort|assets|icons|fixtures)\//.test(path);
      const hasExt = /\.[a-z0-9]{1,8}$/i.test(path);
      if (req.method === 'GET' && !isAssetDir && !hasExt) return reply.type('text/html').sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return { app, services };
}

function looksLikeImage(b: Buffer): boolean {
  if (b.length < 12) return false;
  const jpeg = b[0] === 0xff && b[1] === 0xd8;
  const png = b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP';
  return jpeg || png || webp;
}

export { hashPassword };
