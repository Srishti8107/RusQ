/**
 * Server-side domain services. Routes stay thin; everything that touches the
 * database lives here so it can be integration-tested directly.
 */
import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  fromBase64,
  reconcile,
  Reassembler,
  RESOURCE_KEYS,
  parseShortCode,
  sha256Hex,
  shortCodeId,
  shortCodeToReport,
  shortRef,
  ShortCodeError,
  verifyShortCode,
  signAck,
  Snapshot,
  validateEnvelope,
  verifyEnvelope,
  type Ack,
  type Allotment,
  type FieldReport,
  type MissingReport,
  type MeshMessage,
  type ResourceQty,
  type Site,
  type Sos,
} from '@rusq/shared';
import { nextServerId, tx, kvGet, kvSet, type Db } from './db.ts';
import type { ServerKeys } from './keys.ts';
import { proposeCandidates } from './missing-service.ts';

export type Via = 'direct' | 'relay';

export type CodeResult =
  | { ok: true; ack: Ack; duplicate: boolean; code: ReturnType<typeof parseShortCode> }
  | { ok: false; reason: string };

export class Services {
  constructor(
    readonly db: Db,
    readonly keys: ServerKeys,
    readonly now: () => Date = () => new Date(),
  ) {}

  /* ------------------------------- audit ------------------------------- */

  audit(actor: string, action: string, target: string, details?: unknown) {
    this.db
      .prepare('INSERT INTO audit (id, actor, action, target, at, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), actor, action, target, this.now().toISOString(), details === undefined ? null : JSON.stringify(details));
  }

  listAudit(limit = 200) {
    return this.db.prepare('SELECT id, actor, action, target, at, details FROM audit ORDER BY seq DESC LIMIT ?').all(limit);
  }

  /* ------------------------------- acks -------------------------------- */

  private async ack(clientId: string, kind: Ack['kind'], serverId: string, receivedAt: string, duplicate: boolean): Promise<Ack> {
    return signAck(this.keys.ackPrivate, { clientId, kind, serverId, receivedAt, duplicate });
  }

  /* ------------------------------ records ------------------------------ */

  async ingestSos(sos: Sos, via: Via, actor: string): Promise<Ack> {
    const existing = this.db.prepare('SELECT server_id, received_at FROM sos WHERE id = ?').get(sos.id) as
      | { server_id: string; received_at: string }
      | undefined;
    if (existing) return this.ack(sos.id, 'sos', existing.server_id, existing.received_at, true);
    const at = this.now().toISOString();
    const serverId = tx(this.db, () => {
      const sid = nextServerId(this.db, 'SOS');
      this.db
        .prepare('INSERT INTO sos (id, server_id, user_id, data, via, received_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sos.id, sid, sos.userId, JSON.stringify(sos), via, at);
      return sid;
    });
    this.audit(actor, 'sos.received', sos.id, { serverId, via });
    return this.ack(sos.id, 'sos', serverId, at, false);
  }

  async ingestReport(r: FieldReport, via: Via, actor: string): Promise<Ack> {
    const existing = this.db.prepare('SELECT server_id, received_at FROM reports WHERE id = ?').get(r.id) as
      | { server_id: string; received_at: string }
      | undefined;
    if (existing) return this.ack(r.id, 'report', existing.server_id, existing.received_at, true);
    const at = this.now().toISOString();
    const ref = await shortRef(r.id);
    // The short code of this report arrived first: the full report replaces it (same RPT number).
    // received_at stays the time the code arrived: the control room already got the pop-up then.
    const code = this.db.prepare("SELECT id, server_id, received_at FROM reports WHERE team_id = ? AND short_ref = ? AND via = 'code'").get(r.teamId, ref) as
      | { id: string; server_id: string; received_at: string }
      | undefined;
    if (code) {
      this.db.prepare('UPDATE reports SET id = ?, data = ?, via = ?, relay_hops = NULL, relay_gateway = NULL WHERE id = ?').run(r.id, JSON.stringify(r), via, code.id);
      this.audit(actor, 'report.completed', r.id, { serverId: code.server_id, via, replacedShortCode: code.id, at });
      return this.ack(r.id, 'report', code.server_id, code.received_at, false);
    }
    const serverId = tx(this.db, () => {
      const sid = nextServerId(this.db, 'RPT');
      this.db
        .prepare('INSERT INTO reports (id, server_id, team_id, data, via, received_at, short_ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(r.id, sid, r.teamId, JSON.stringify(r), via, at, ref);
      return sid;
    });
    this.audit(actor, 'report.received', r.id, { serverId, via });
    return this.ack(r.id, 'report', serverId, at, false);
  }

  /**
   * A rescuer SHORT CODE (shared/shortcode.ts) typed in, pasted from an SMS, forwarded by an
   * SMS gateway or relayed between phones. Stored as a field report until the full report
   * arrives (ingestReport then replaces it). Copies of the same code – and a code arriving
   * after its full report – are duplicates.
   */
  async ingestCode(text: string, actor: string, extraHops = 0): Promise<CodeResult> {
    let c: ReturnType<typeof parseShortCode>;
    try {
      c = parseShortCode(text);
    } catch (e) {
      return { ok: false, reason: e instanceof ShortCodeError ? e.message : 'not a valid code' };
    }
    if (!(await verifyShortCode(c, this.keys.teamKey))) return { ok: false, reason: 'signature does not match (typing mistake, or not made with the RusQ team key)' };
    if (Date.parse(c.createdAt) > this.now().getTime() + 24 * 3600_000) return { ok: false, reason: 'the time in the code is in the future' };
    const id = await shortCodeId(c.teamId, c.ref);
    const existing = this.db.prepare('SELECT server_id, received_at FROM reports WHERE id = ? OR (team_id = ? AND short_ref = ?)').get(id, c.teamId, c.ref) as
      | { server_id: string; received_at: string }
      | undefined;
    if (existing) return { ok: true, duplicate: true, code: c, ack: await this.ack(id, 'report', existing.server_id, existing.received_at, true) };
    const at = this.now().toISOString();
    const u = this.db.prepare('SELECT username FROM users WHERE id = ?').get(actor) as { username: string } | undefined;
    const report = await shortCodeToReport(c);
    const serverId = tx(this.db, () => {
      const sid = nextServerId(this.db, 'RPT');
      this.db
        .prepare("INSERT INTO reports (id, server_id, team_id, data, via, received_at, short_ref, short_code_at, relay_hops, relay_gateway) VALUES (?, ?, ?, ?, 'code', ?, ?, ?, ?, ?)")
        .run(id, sid, c.teamId, JSON.stringify(report), at, c.ref, at, c.hops + extraHops, u?.username ?? actor);
      return sid;
    });
    this.audit(actor, 'report.short_code', id, { serverId, hops: c.hops + extraHops });
    return { ok: true, duplicate: false, code: c, ack: await this.ack(id, 'report', serverId, at, false) };
  }

  async ingestAllotment(a: Allotment, via: Via, actor: string): Promise<Ack> {
    const existing = this.db.prepare('SELECT server_id, received_at FROM allotments WHERE id = ?').get(a.id) as
      | { server_id: string; received_at: string }
      | undefined;
    if (existing) return this.ack(a.id, 'allotment', existing.server_id, existing.received_at, true);
    const at = this.now().toISOString();
    const serverId = tx(this.db, () => {
      const sid = nextServerId(this.db, 'ALT');
      this.db
        .prepare(
          'INSERT INTO allotments (id, server_id, device_id, report_id, snapshot_version, data, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(a.id, sid, a.deviceId, a.reportId, a.snapshotVersion, JSON.stringify(a), at);
      return sid;
    });
    this.audit(actor, 'allotment.received', a.id, { serverId, via, provisional: a.provisional });
    this.runReconciliation('system');
    return this.ack(a.id, 'allotment', serverId, at, false);
  }

  /** Family missing-person report (Phase 2). Idempotent; the system then proposes sample-registry candidates. */
  async ingestMissing(m: MissingReport, via: Via, actor: string): Promise<Ack> {
    const existing = this.db.prepare('SELECT server_id, received_at FROM missing_reports WHERE id = ?').get(m.id) as
      | { server_id: string; received_at: string }
      | undefined;
    if (existing) return this.ack(m.id, 'missing', existing.server_id, existing.received_at, true);
    const at = this.now().toISOString();
    const serverId = tx(this.db, () => {
      const sid = nextServerId(this.db, 'MIS');
      this.db
        .prepare('INSERT INTO missing_reports (id, server_id, reporter_id, data, via, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(m.id, sid, m.reporterId, JSON.stringify(m), via, at, at);
      return sid;
    });
    this.audit(actor, 'missing.reported', m.id, { serverId, via });
    proposeCandidates(this, m.id);
    return this.ack(m.id, 'missing', serverId, at, false);
  }

  async ingestPhoto(photoId: string, reportId: string, mime: string, bytes: Uint8Array, actor: string): Promise<Ack> {
    const existing = this.db.prepare('SELECT server_id, received_at FROM photos WHERE id = ?').get(photoId) as
      | { server_id: string; received_at: string }
      | undefined;
    if (existing) return this.ack(photoId, 'photo', existing.server_id, existing.received_at, true);
    const at = this.now().toISOString();
    const sha = await sha256Hex(bytes);
    const serverId = tx(this.db, () => {
      const sid = nextServerId(this.db, 'PHO');
      this.db
        .prepare('INSERT INTO photos (id, server_id, report_id, mime, bytes, sha256, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(photoId, sid, reportId, mime, bytes, sha, at);
      return sid;
    });
    this.audit(actor, 'photo.received', photoId, { serverId, reportId, bytes: bytes.length });
    return this.ack(photoId, 'photo', serverId, at, false);
  }

  /**
   * Gateway upload of relay envelopes. Each envelope must pass schema + team MAC.
   * Photo chunks are stored until complete, then verified (sha256) and saved.
   */
  async ingestEnvelopes(raw: unknown[], actor: string): Promise<{ acks: Ack[]; rejected: { id: string; reason: string }[] }> {
    const acks: Ack[] = [];
    const rejected: { id: string; reason: string }[] = [];
    for (const r of raw) {
      const id = (r as { id?: string })?.id ?? '?';
      const check = validateEnvelope(r);
      if (!check.ok) {
        rejected.push({ id, reason: check.reason });
        continue;
      }
      const m = check.msg;
      if (!(await verifyEnvelope(this.keys.teamKey, m))) {
        rejected.push({ id, reason: 'bad MAC' });
        continue;
      }
      try {
        const ack = await this.ingestEnvelope(m, actor);
        if (ack) acks.push(ack);
      } catch (e) {
        rejected.push({ id, reason: (e as Error).message });
      }
    }
    return { acks, rejected };
  }

  /** Remember how a relayed record travelled: hops between phones and who uploaded it (first arrival only). */
  private noteRelay(table: 'sos' | 'reports' | 'missing_reports', id: string, hops: number, actor: string) {
    const u = this.db.prepare('SELECT username FROM users WHERE id = ?').get(actor) as { username: string } | undefined;
    this.db.prepare(`UPDATE ${table} SET relay_hops = ?, relay_gateway = ? WHERE id = ? AND via = 'relay' AND relay_hops IS NULL`).run(hops, u?.username ?? actor, id);
  }

  private async ingestEnvelope(m: MeshMessage, actor: string): Promise<Ack | null> {
    switch (m.type) {
      case 'sos': {
        const ack = await this.ingestSos(m.payload as Sos, 'relay', actor);
        this.noteRelay('sos', (m.payload as Sos).id, m.hops, actor);
        return ack;
      }
      case 'report': {
        const ack = await this.ingestReport(m.payload as FieldReport, 'relay', actor);
        this.noteRelay('reports', (m.payload as FieldReport).id, m.hops, actor);
        return ack;
      }
      case 'allotment':
        return this.ingestAllotment(m.payload as Allotment, 'relay', actor);
      case 'missing': {
        const ack = await this.ingestMissing(m.payload as MissingReport, 'relay', actor);
        this.noteRelay('missing_reports', (m.payload as MissingReport).id, m.hops, actor);
        return ack;
      }
      case 'code': {
        const text = (m.payload as { text: string }).text;
        let id = '';
        try {
          const c = parseShortCode(text);
          id = await shortCodeId(c.teamId, c.ref);
        } catch {
          /* reported below */
        }
        if (id !== m.id) throw new Error('code envelope id does not match the code');
        const r = await this.ingestCode(text, actor, m.hops);
        if (!r.ok) throw new Error(r.reason);
        return r.ack;
      }
      case 'photo_chunk':
        return this.ingestChunk(m, actor);
      case 'photo_thumb':
      case 'ack':
        return null; // previews and acks are relay-internal
    }
  }

  private async ingestChunk(m: MeshMessage, actor: string): Promise<Ack | null> {
    const info = m.chunkInfo!;
    const done = this.db.prepare('SELECT server_id, received_at FROM photos WHERE id = ?').get(info.photoId) as
      | { server_id: string; received_at: string }
      | undefined;
    if (done) return this.ack(info.photoId, 'photo', done.server_id, done.received_at, true);
    const p = m.payload as { data: string; mime: string };
    this.db
      .prepare('INSERT OR IGNORE INTO photo_chunks (photo_id, idx, total, info, data) VALUES (?, ?, ?, ?, ?)')
      .run(info.photoId, info.index, info.total, JSON.stringify(info), p.data);
    const rows = this.db.prepare('SELECT info, data FROM photo_chunks WHERE photo_id = ?').all(info.photoId) as {
      info: string;
      data: string;
    }[];
    if (rows.length < info.total) return null;
    const re = new Reassembler();
    let result;
    for (const row of rows) result = await re.add({ chunkInfo: JSON.parse(row.info), payload: { data: row.data } });
    if (!result || result.state !== 'complete') {
      this.db.prepare('DELETE FROM photo_chunks WHERE photo_id = ?').run(info.photoId);
      throw new Error(`photo ${info.photoId} reassembly failed`);
    }
    const ack = await this.ingestPhoto(info.photoId, info.reportId, p.mime, result.bytes, actor);
    this.db.prepare('DELETE FROM photo_chunks WHERE photo_id = ?').run(info.photoId);
    return ack;
  }

  getPhoto(id: string) {
    return this.db.prepare('SELECT id, report_id, mime, bytes FROM photos WHERE id = ?').get(id) as
      | { id: string; report_id: string; mime: string; bytes: Uint8Array }
      | undefined;
  }

  /* -------------------------- stock & snapshots ------------------------ */

  liveStock(): ResourceQty {
    const out: ResourceQty = {};
    for (const row of this.db.prepare('SELECT resource, qty FROM stock').all() as { resource: string; qty: number }[]) {
      out[row.resource as keyof ResourceQty] = row.qty;
    }
    return out;
  }

  setLiveStock(stock: ResourceQty, actor: string) {
    tx(this.db, () => {
      for (const r of RESOURCE_KEYS) {
        if (stock[r] === undefined) continue;
        this.db.prepare('INSERT INTO stock (resource, qty) VALUES (?, ?) ON CONFLICT(resource) DO UPDATE SET qty = excluded.qty').run(r, stock[r]!);
      }
    });
    this.audit(actor, 'stock.set', 'stock', stock);
    this.runReconciliation(actor);
  }

  sites(): Site[] {
    return JSON.parse(kvGet(this.db, 'sites') ?? '[]') as Site[];
  }

  setSites(sites: Site[], actor: string) {
    kvSet(this.db, 'sites', JSON.stringify(sites));
    this.audit(actor, 'sites.set', 'sites', { count: sites.length });
  }

  /** Publish a new snapshot version from live stock + current sites. */
  publishSnapshot(actor: string): Snapshot {
    const prev = this.latestSnapshot();
    const snap = Snapshot.parse({
      version: (prev?.version ?? 0) + 1,
      createdAt: this.now().toISOString(),
      stock: this.liveStock(),
      sites: this.sites(),
    });
    this.db.prepare('INSERT INTO snapshots (version, created_at, data) VALUES (?, ?, ?)').run(snap.version, snap.createdAt, JSON.stringify(snap));
    this.audit(actor, 'snapshot.published', `snapshot:${snap.version}`);
    return snap;
  }

  latestSnapshot(): Snapshot | null {
    const row = this.db.prepare('SELECT data FROM snapshots ORDER BY version DESC LIMIT 1').get() as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Snapshot) : null;
  }

  /* --------------------------- reconciliation -------------------------- */

  pendingAllotments(): (Allotment & { serverId: string; status: string })[] {
    return (this.db.prepare("SELECT server_id, status, data FROM allotments WHERE status = 'pending' ORDER BY id").all() as {
      server_id: string;
      status: string;
      data: string;
    }[]).map((r) => ({ ...(JSON.parse(r.data) as Allotment), serverId: r.server_id, status: r.status }));
  }

  allAllotments() {
    return (this.db
      .prepare('SELECT server_id, status, data, approved_claim, decided_by, decided_at, note, received_at FROM allotments ORDER BY received_at DESC')
      .all() as Record<string, string | null>[]).map((r) => ({
      ...(JSON.parse(r.data!) as Allotment),
      serverId: r.server_id,
      status: r.status,
      approvedClaim: r.approved_claim ? JSON.parse(r.approved_claim) : null,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      note: r.note,
      receivedAt: r.received_at,
    }));
  }

  /**
   * Recompute claims of all PENDING provisional allotments against LIVE stock.
   * Over-allocation creates (or updates) an open conflict per resource. Nothing
   * is overwritten: allotments keep their device values until an admin decides.
   */
  runReconciliation(actor: string) {
    const live = this.liveStock();
    const result = reconcile(live, this.pendingAllotments());
    const at = this.now().toISOString();
    const conflicted = new Set(result.conflicts.map((c) => c.resource));
    tx(this.db, () => {
      for (const c of result.conflicts) {
        const open = this.db.prepare("SELECT id, allotment_ids, claimed, live_stock FROM conflicts WHERE resource = ? AND status = 'open'").get(c.resource) as
          | { id: string; allotment_ids: string; claimed: number; live_stock: number }
          | undefined;
        const ids = JSON.stringify(c.allotmentIds);
        if (!open) {
          const id = randomUUID();
          this.db
            .prepare(
              'INSERT INTO conflicts (id, resource, live_stock, claimed, allotment_ids, devices, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(id, c.resource, c.liveStock, c.claimed, ids, JSON.stringify(c.devices), at, at);
          this.audit(actor, 'conflict.created', id, c);
        } else if (open.allotment_ids !== ids || open.claimed !== c.claimed || open.live_stock !== c.liveStock) {
          this.db
            .prepare('UPDATE conflicts SET live_stock = ?, claimed = ?, allotment_ids = ?, devices = ?, updated_at = ? WHERE id = ?')
            .run(c.liveStock, c.claimed, ids, JSON.stringify(c.devices), at, open.id);
          this.audit(actor, 'conflict.updated', open.id, c);
        }
      }
      for (const open of this.db.prepare("SELECT id, resource FROM conflicts WHERE status = 'open'").all() as { id: string; resource: string }[]) {
        if (!conflicted.has(open.resource as never)) {
          this.db
            .prepare("UPDATE conflicts SET status = 'resolved', resolved_by = ?, resolution = ?, updated_at = ? WHERE id = ?")
            .run(actor, 'Pending claims now fit within live stock (after admin decisions or stock change).', at, open.id);
          this.audit(actor, 'conflict.resolved', open.id);
        }
      }
    });
    return result;
  }

  conflicts(status?: 'open' | 'resolved') {
    const rows = (status
      ? this.db.prepare('SELECT * FROM conflicts WHERE status = ? ORDER BY created_at').all(status)
      : this.db.prepare('SELECT * FROM conflicts ORDER BY created_at').all()) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id,
      resource: r.resource,
      liveStock: r.live_stock,
      claimed: r.claimed,
      overBy: (r.claimed as number) - (r.live_stock as number),
      allotmentIds: JSON.parse(r.allotment_ids as string),
      devices: JSON.parse(r.devices as string),
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      resolvedBy: r.resolved_by,
      resolution: r.resolution,
    }));
  }

  /**
   * Administrator decision on one allotment (final). Approving deducts the
   * approved claim (admin may lower it) from live stock; it can never take
   * stock below zero.
   */
  decideAllotment(id: string, decision: 'approve' | 'reject', actor: string, opts: { approvedClaim?: ResourceQty; note?: string } = {}) {
    const row = this.db.prepare('SELECT status, data FROM allotments WHERE id = ?').get(id) as { status: string; data: string } | undefined;
    if (!row) throw new HttpError(404, 'allotment not found');
    if (row.status !== 'pending') throw new HttpError(409, `allotment already ${row.status}`);
    const a = JSON.parse(row.data) as Allotment;
    const at = this.now().toISOString();
    if (decision === 'approve') {
      const claim = opts.approvedClaim ?? a.claim;
      for (const r of RESOURCE_KEYS) {
        const q = claim[r] ?? 0;
        if (q > (a.claim[r] ?? 0)) throw new HttpError(400, `approved ${r} exceeds the device claim`);
      }
      const live = this.liveStock();
      for (const r of RESOURCE_KEYS) {
        if ((claim[r] ?? 0) > (live[r] ?? 0)) throw new HttpError(409, `not enough live stock for ${r}: ${live[r] ?? 0} left, ${claim[r]} requested`);
      }
      tx(this.db, () => {
        for (const r of RESOURCE_KEYS) {
          if (!claim[r]) continue;
          this.db.prepare('UPDATE stock SET qty = qty - ? WHERE resource = ?').run(claim[r]!, r);
        }
        this.db
          .prepare("UPDATE allotments SET status = 'approved', approved_claim = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?")
          .run(canonicalJson(claim), actor, at, opts.note ?? null, id);
      });
      this.audit(actor, 'allotment.approved', id, { claim, note: opts.note });
    } else {
      this.db
        .prepare("UPDATE allotments SET status = 'rejected', decided_by = ?, decided_at = ?, note = ? WHERE id = ?")
        .run(actor, at, opts.note ?? null, id);
      this.audit(actor, 'allotment.rejected', id, { note: opts.note });
    }
    this.runReconciliation(actor);
  }

  /* ------------------------------ overview ----------------------------- */

  listSos(): (Sos & { serverId: string; via: string; receivedAt: string; status: string; assignedTeam: string | null; opsNote: string | null; statusBy: string | null; statusAt: string | null; relayHops: number | null; relayGateway: string | null })[] {
    return (
      this.db
        .prepare('SELECT server_id, data, via, received_at, status, assigned_team, ops_note, status_by, status_at, relay_hops, relay_gateway FROM sos ORDER BY received_at DESC')
        .all() as Record<string, string | null>[]
    ).map((r) => ({
      ...(JSON.parse(r.data!) as Sos),
      serverId: r.server_id!,
      via: r.via!,
      receivedAt: r.received_at!,
      status: r.status!,
      assignedTeam: r.assigned_team ?? null,
      opsNote: r.ops_note ?? null,
      statusBy: r.status_by ?? null,
      statusAt: r.status_at ?? null,
      relayHops: r.relay_hops === null || r.relay_hops === undefined ? null : Number(r.relay_hops),
      relayGateway: r.relay_gateway ?? null,
    }));
  }

  listReports() {
    return (this.db.prepare('SELECT server_id, data, via, received_at, relay_hops, relay_gateway, short_code_at FROM reports ORDER BY received_at DESC').all() as Record<string, string | number | null>[]).map((r) => ({
      ...(JSON.parse(r.data as string) as FieldReport),
      serverId: r.server_id as string,
      via: r.via as string,
      receivedAt: r.received_at as string,
      relayHops: r.relay_hops === null ? null : Number(r.relay_hops),
      relayGateway: (r.relay_gateway as string | null) ?? null,
      shortCodeAt: (r.short_code_at as string | null) ?? null,
    }));
  }

  count(table: 'sos' | 'reports' | 'allotments' | 'photos' | 'missing_reports' | 'users'): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export { fromBase64 };
