/**
 * Server key material, created on first boot and persisted in the kv table
 * (or supplied via environment variables when hosting):
 *  - token secret       (HMAC for auth tokens)          RUSQ_TOKEN_SECRET
 *  - team key           (HMAC for relay envelopes)       RUSQ_TEAM_KEY
 *  - ack signing keypair (ECDSA P-256, signs every ack)  RUSQ_ACK_PRIVATE_JWK / _PUBLIC_JWK
 * None of these private values is ever sent to a client except the team key,
 * which is handed to authenticated users during offline setup.
 */
import { randomBytes } from 'node:crypto';
import {
  generateServerKeyPair,
  generateTeamKeyB64,
  importServerPrivateKey,
  importServerPublicKey,
  importTeamKey,
} from '@rusq/shared';
import { kvGet, kvSet, type Db } from './db.ts';

export interface ServerKeys {
  tokenSecret: Buffer;
  teamKeyB64: string;
  teamKey: CryptoKey;
  teamKeyId: string;
  ackPrivate: CryptoKey;
  ackPublic: CryptoKey;
  ackPublicJwk: JsonWebKey;
}

export async function loadKeys(db: Db): Promise<ServerKeys> {
  let tokenSecret = process.env.RUSQ_TOKEN_SECRET ?? kvGet(db, 'token_secret');
  if (!tokenSecret) {
    tokenSecret = randomBytes(32).toString('base64');
    kvSet(db, 'token_secret', tokenSecret);
  }
  let teamKeyB64 = process.env.RUSQ_TEAM_KEY ?? kvGet(db, 'team_key');
  if (!teamKeyB64) {
    teamKeyB64 = await generateTeamKeyB64();
    kvSet(db, 'team_key', teamKeyB64);
  }
  let priv = process.env.RUSQ_ACK_PRIVATE_JWK ?? kvGet(db, 'ack_private_jwk');
  let pub = process.env.RUSQ_ACK_PUBLIC_JWK ?? kvGet(db, 'ack_public_jwk');
  if (!priv || !pub) {
    const kp = await generateServerKeyPair();
    priv = JSON.stringify(kp.privateJwk);
    pub = JSON.stringify(kp.publicJwk);
    kvSet(db, 'ack_private_jwk', priv);
    kvSet(db, 'ack_public_jwk', pub);
  }
  const ackPublicJwk = JSON.parse(pub) as JsonWebKey;
  const { createHash } = await import('node:crypto');
  return {
    tokenSecret: Buffer.from(tokenSecret, 'base64'),
    teamKeyB64,
    teamKey: await importTeamKey(teamKeyB64),
    teamKeyId: createHash('sha256').update(teamKeyB64).digest('hex').slice(0, 12),
    ackPrivate: await importServerPrivateKey(JSON.parse(priv) as JsonWebKey),
    ackPublic: await importServerPublicKey(ackPublicJwk),
    ackPublicJwk: { kty: ackPublicJwk.kty, crv: ackPublicJwk.crv, x: ackPublicJwk.x, y: ackPublicJwk.y },
  };
}
