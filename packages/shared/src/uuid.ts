/**
 * UUIDv7 (RFC 9562): 48-bit unix-ms timestamp + random bits.
 * Client-generated ids make every upload idempotent (§7). Time-ordered ids also
 * keep SQLite indexes compact. NOT used inside the allocation engine (which
 * must not read clocks or randomness).
 */
export function uuidv7(nowMs: number = Date.now(), rand: Uint8Array = randomBytes(10)): string {
  const b = new Uint8Array(16);
  let ts = BigInt(Math.max(0, Math.floor(nowMs)));
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  b[6] = 0x70 | (rand[0]! & 0x0f);
  b[7] = rand[1]!;
  b[8] = 0x80 | (rand[2]! & 0x3f);
  for (let i = 9; i < 16; i++) b[i] = rand[i - 6]!;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
