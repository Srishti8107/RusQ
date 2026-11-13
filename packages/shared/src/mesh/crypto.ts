/**
 * WebCrypto helpers (identical in browsers and Node ≥ 20 via globalThis.crypto).
 *
 * - Team key: HMAC-SHA-256, provisioned from the server while online. Every
 *   relay envelope carries a MAC; nodes reject anything that does not verify.
 * - Server ack key: ECDSA P-256. Only the server holds the private key, devices
 *   cache the public key. Acks relayed through other phones stay trustworthy
 *   because a team member cannot forge a server ack.
 */
import { canonicalJson, fromBase64, toBase64, utf8 } from '../canonical.ts';
import type { Ack } from '../schemas.ts';

const subtle = () => globalThis.crypto.subtle;

export async function importTeamKey(rawB64: string): Promise<CryptoKey> {
  return subtle().importKey('raw', fromBase64(rawB64) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function generateTeamKeyB64(): Promise<string> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return toBase64(raw);
}

export async function hmacSign(key: CryptoKey, data: string): Promise<string> {
  const sig = await subtle().sign('HMAC', key, utf8(data) as BufferSource);
  return toBase64(new Uint8Array(sig));
}

export async function hmacVerify(key: CryptoKey, data: string, sigB64: string): Promise<boolean> {
  try {
    return await subtle().verify('HMAC', key, fromBase64(sigB64) as BufferSource, utf8(data) as BufferSource);
  } catch {
    return false;
  }
}

/* ------------------------- server ack signatures ------------------------- */

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export function ackSigningInput(a: Pick<Ack, 'clientId' | 'kind' | 'serverId' | 'receivedAt'>): string {
  return canonicalJson({ clientId: a.clientId, kind: a.kind, serverId: a.serverId, receivedAt: a.receivedAt });
}

export async function generateServerKeyPair(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const kp = (await subtle().generateKey(ECDSA, true, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    privateJwk: await subtle().exportKey('jwk', kp.privateKey),
    publicJwk: await subtle().exportKey('jwk', kp.publicKey),
  };
}

export async function importServerPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, ECDSA, false, ['sign']);
}

export async function importServerPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  const { kty, crv, x, y } = jwk;
  return subtle().importKey('jwk', { kty, crv, x, y, ext: true }, ECDSA, false, ['verify']);
}

export async function signAck(privateKey: CryptoKey, a: Omit<Ack, 'sig'>): Promise<Ack> {
  const sig = await subtle().sign(ECDSA_SIGN, privateKey, utf8(ackSigningInput(a)) as BufferSource);
  return { ...a, sig: toBase64(new Uint8Array(sig)) };
}

export async function verifyAck(publicKey: CryptoKey, a: Ack): Promise<boolean> {
  try {
    return await subtle().verify(ECDSA_SIGN, publicKey, fromBase64(a.sig) as BufferSource, utf8(ackSigningInput(a)) as BufferSource);
  } catch {
    return false;
  }
}
