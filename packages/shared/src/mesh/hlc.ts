/**
 * Hybrid Logical Clock (Kulkarni et al. 2014).
 *
 * Gives every relay message a timestamp that is (a) close to wall-clock time and
 * (b) causally consistent even when phone clocks are skewed. Encoded as a
 * fixed-width string so lexical order == HLC order:
 *   "<wall ms, 15 digits>:<counter, 5 base-36 chars>:<nodeId>"
 *
 * The wall clock is injected (`now`) so simulations and tests are deterministic.
 */
export interface Hlc {
  l: number; // wall-clock component (ms)
  c: number; // logical counter
  n: string; // node id (tie-break)
}

/** If a remote timestamp is this far ahead of our clock we do NOT adopt it (bad clock). */
export const DEFAULT_MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

export class HybridLogicalClock {
  private l = 0;
  private c = 0;
  /** number of remote timestamps ignored because they were too far ahead */
  public driftRejections = 0;

  constructor(
    public readonly nodeId: string,
    private readonly now: () => number,
    private readonly maxDriftMs = DEFAULT_MAX_DRIFT_MS,
  ) {}

  /** Persist / restore (so a phone's clock survives an app restart). */
  state(): { l: number; c: number } {
    return { l: this.l, c: this.c };
  }
  restore(s: { l: number; c: number }) {
    if (s.l > this.l || (s.l === this.l && s.c > this.c)) {
      this.l = s.l;
      this.c = s.c;
    }
  }

  /** Timestamp for a local event / message send. */
  tick(): Hlc {
    const pt = this.now();
    if (pt > this.l) {
      this.l = pt;
      this.c = 0;
    } else {
      this.c += 1;
    }
    return { l: this.l, c: this.c, n: this.nodeId };
  }

  /** Merge a remote timestamp on message receipt. */
  receive(remote: Hlc): Hlc {
    const pt = this.now();
    if (remote.l - pt > this.maxDriftMs) {
      // Remote clock is wildly ahead – keep the message, do not poison our clock.
      this.driftRejections += 1;
      return this.tick();
    }
    const lNew = Math.max(this.l, remote.l, pt);
    if (lNew === this.l && lNew === remote.l) this.c = Math.max(this.c, remote.c) + 1;
    else if (lNew === this.l) this.c += 1;
    else if (lNew === remote.l) this.c = remote.c + 1;
    else this.c = 0;
    this.l = lNew;
    return { l: this.l, c: this.c, n: this.nodeId };
  }
}

export function encodeHlc(h: Hlc): string {
  return `${String(h.l).padStart(15, '0')}:${h.c.toString(36).padStart(5, '0')}:${h.n}`;
}

export function decodeHlc(s: string): Hlc {
  const m = /^(\d{15}):([0-9a-z]{5}):(.+)$/.exec(s);
  if (!m) throw new Error(`bad HLC: ${s}`);
  return { l: Number(m[1]), c: parseInt(m[2]!, 36), n: m[3]! };
}

export const HLC_RE = /^\d{15}:[0-9a-z]{5}:.{1,64}$/;

export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
