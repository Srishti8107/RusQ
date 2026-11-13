/** Cached key material for offline use: team key (relay MAC) + server ack public key. */
import { importServerPublicKey, importTeamKey } from '@rusq/shared';
import { kvGet, kvSet, K } from './db.ts';
import { api } from './api.ts';

let ackKey: CryptoKey | null = null;
let teamKey: CryptoKey | null = null;

export async function getAckPublicKey(): Promise<CryptoKey | null> {
  if (ackKey) return ackKey;
  const jwk = await kvGet<JsonWebKey>(K.ackPublicJwk);
  if (!jwk) return null;
  ackKey = await importServerPublicKey(jwk);
  return ackKey;
}

export async function getTeamKey(): Promise<CryptoKey | null> {
  if (teamKey) return teamKey;
  const raw = await kvGet<string>(K.teamKey);
  if (!raw) return null;
  teamKey = await importTeamKey(raw);
  return teamKey;
}

/** Online-only: fetch and cache both keys (setup step "team key"). */
export async function provisionKeys(): Promise<{ teamKeyId: string }> {
  const r = await api<{ teamKey: string; teamKeyId: string; ackPublicJwk: JsonWebKey }>('/setup/keys');
  await kvSet(K.teamKey, r.teamKey);
  await kvSet(K.ackPublicJwk, r.ackPublicJwk);
  ackKey = null;
  teamKey = null;
  await getAckPublicKey();
  await getTeamKey();
  return { teamKeyId: r.teamKeyId };
}

/** The public ack key alone can be fetched without login (needed to verify acks). */
export async function ensureAckKey(): Promise<CryptoKey | null> {
  const k = await getAckPublicKey();
  if (k) return k;
  try {
    const r = await api<{ ackPublicJwk: JsonWebKey }>('/server-key', { auth: false, timeoutMs: 5000 });
    await kvSet(K.ackPublicJwk, r.ackPublicJwk);
    return getAckPublicKey();
  } catch {
    return null;
  }
}
