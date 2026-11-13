/**
 * READ-ONLY look into the server database, for manual testing.
 * Shows users, SOS, reports, photos, allotments, conflicts, live stock and the
 * latest audit entries. Never writes anything.
 *
 *   node scripts/inspect-db.mjs                 # default DB: apps/server/data/rusq.db
 *   node scripts/inspect-db.mjs path/to/rusq.db
 *   node scripts/inspect-db.mjs --watch         # refresh every 3 s
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const path = resolve(args.find((a) => !a.startsWith('--')) ?? 'apps/server/data/rusq.db');
if (!existsSync(path)) {
  console.error(`No database at ${path}. Start the server once (npm start) to create it.`);
  process.exit(1);
}

function show() {
  const db = new DatabaseSync(path, { readOnly: true });
  const all = (sql) => db.prepare(sql).all();
  const out = [];
  out.push(`RusQ database: ${path}   (${new Date().toLocaleTimeString()})`);

  out.push('\n== Users (registered profiles)');
  for (const u of all('SELECT username, role, name, team_id, skills, profile, created_at FROM users ORDER BY role, username'))
    out.push(`  ${u.role.padEnd(8)} ${u.username.padEnd(10)} ${u.name}${u.team_id ? '  team=' + u.team_id : ''}  skills=${u.skills}  profile=${u.profile}`);

  out.push('\n== SOS received');
  for (const r of all('SELECT server_id, data, via, received_at, status FROM sos ORDER BY received_at')) {
    const d = JSON.parse(r.data);
    const loc = d.lat != null ? `${d.lat.toFixed(4)},${d.lng.toFixed(4)} (${d.locationSource})` : 'no location';
    out.push(`  ${r.server_id}  ${r.received_at}  via=${r.via.padEnd(6)} from=${d.profile?.name ?? d.userId.slice(0, 8)}  ${loc}  source=${d.source}`);
  }

  out.push('\n== Field reports received');
  for (const r of all('SELECT server_id, data, via, received_at FROM reports ORDER BY received_at')) {
    const d = JSON.parse(r.data);
    out.push(`  ${r.server_id}  team=${d.teamId}  via=${r.via.padEnd(6)} people=${d.victimCount} urgency=${d.urgency} hazards=[${d.humanFinal.hazards.join(', ')}] photos=${d.photos.length} ai=${d.aiSuggestion ? d.aiSuggestion.labels[0].label + ' (' + d.aiSuggestion.backend + ')' : 'none'}`);
  }

  out.push('\n== Photos received');
  for (const r of all('SELECT server_id, report_id, length(bytes) AS n, received_at FROM photos ORDER BY received_at'))
    out.push(`  ${r.server_id}  report=${r.report_id.slice(-8)}  ${Math.round(r.n / 1024)} KB`);
  const partial = all('SELECT photo_id, COUNT(*) AS have, MAX(total) AS total FROM photo_chunks GROUP BY photo_id');
  for (const p of partial) out.push(`  (incomplete via relay) ${p.photo_id.slice(-8)}: ${p.have}/${p.total} chunks`);

  out.push('\n== Live stock');
  out.push('  ' + all('SELECT resource, qty FROM stock ORDER BY resource').map((r) => `${r.resource}=${r.qty}`).join('  '));

  out.push('\n== Provisional allotments');
  for (const r of all('SELECT server_id, device_id, snapshot_version, status, data, approved_claim, decided_by FROM allotments ORDER BY received_at')) {
    const claim = Object.entries(JSON.parse(r.data).claim).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ');
    out.push(`  ${r.server_id}  device=${r.device_id}  v${r.snapshot_version}  ${r.status.padEnd(8)} claim: ${claim || '-'}${r.approved_claim ? '  approved: ' + r.approved_claim : ''}`);
  }

  out.push('\n== Conflicts');
  for (const c of all('SELECT resource, live_stock, claimed, status, devices FROM conflicts ORDER BY created_at'))
    out.push(`  ${c.status.padEnd(8)} ${c.resource}: claimed ${c.claimed} > stock ${c.live_stock}  devices=${c.devices}`);

  out.push('\n== Last 15 audit entries');
  for (const a of all('SELECT at, actor, action, target FROM audit ORDER BY seq DESC LIMIT 15'))
    out.push(`  ${a.at}  ${a.action.padEnd(20)} ${a.target.slice(0, 24).padEnd(24)} by ${a.actor.slice(0, 12)}`);

  db.close();
  return out.join('\n');
}

if (watch) {
  const tick = () => {
    console.clear();
    console.log(show());
  };
  tick();
  setInterval(tick, 3000);
} else console.log(show());
