/**
 * Server entry point. Environment:
 *   PORT (default 8787) · HOST (default 0.0.0.0, so phones on the LAN can reach it)
 *   RUSQ_DB (default ./data/rusq.db) · RUSQ_STATIC (built web app dir)
 *   RUSQ_SEED=0 disables the sample data and the admin account seed
 *   RUSQ_TEST_USERS=1 adds the automated-test fixture accounts (tests only)
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildApp } from './app.ts';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
const dbPath = process.env.RUSQ_DB ? resolve(process.env.RUSQ_DB) : resolve(here, '../data/rusq.db');
const staticDir = process.env.RUSQ_STATIC ? resolve(process.env.RUSQ_STATIC) : resolve(here, '../../web/dist');

const { app } = await buildApp({
  dbPath,
  seed: process.env.RUSQ_SEED !== '0',
  testUsers: process.env.RUSQ_TEST_USERS === '1',
  staticDir,
  logger: process.env.NODE_ENV !== 'test',
  rateLimitMax: process.env.RUSQ_RATE_LIMIT ? Number(process.env.RUSQ_RATE_LIMIT) : undefined,
  loginRateLimitMax: process.env.RUSQ_LOGIN_RATE_LIMIT ? Number(process.env.RUSQ_LOGIN_RATE_LIMIT) : undefined,
  registerRateLimitMax: process.env.RUSQ_REGISTER_RATE_LIMIT ? Number(process.env.RUSQ_REGISTER_RATE_LIMIT) : undefined,
});
await app.listen({ port, host });
