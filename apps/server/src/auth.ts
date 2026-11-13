/**
 * Authentication + role-based access.
 *
 * Tokens: base64url(JSON {sub, role, name, teamId, exp}) + "." + HMAC-SHA256.
 * Long-lived (14 days) on purpose: a rescuer must stay signed in through days
 * offline. Passwords: scrypt with per-user salt.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@rusq/shared';

export interface TokenClaims {
  sub: string;
  role: Role;
  name: string;
  teamId: string | null;
  exp: number;
}

export const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, got);
}

export function signToken(secret: Buffer, claims: Omit<TokenClaims, 'exp'>, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...claims, exp: nowMs + TOKEN_TTL_MS })).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken(secret: Buffer, token: string, nowMs = Date.now()): TokenClaims | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenClaims;
    if (typeof claims.exp !== 'number' || claims.exp < nowMs) return null;
    return claims;
  } catch {
    return null;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: TokenClaims;
  }
}

/** preHandler factory: require a valid token and one of the given roles. */
export function requireRole(secret: Buffer, ...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    const claims = token ? verifyToken(secret, token) : null;
    if (!claims) return reply.code(401).send({ error: 'authentication required' });
    if (roles.length && !roles.includes(claims.role)) return reply.code(403).send({ error: 'forbidden for role ' + claims.role });
    req.user = claims;
  };
}
