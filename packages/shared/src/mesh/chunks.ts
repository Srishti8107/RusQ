/**
 * Photo chunking + reassembly (§8A). A photo travels as one `photo_thumb`
 * (≤ 320 px, high priority) and N `photo_chunk` messages (full image downscaled
 * to ≤ 1280 px by the caller). Every chunk is an independent envelope, so an
 * interrupted transfer resumes naturally: anti-entropy only re-sends the chunks
 * the peer lacks.
 */
import { fromBase64, sha256Hex, toBase64 } from '../canonical.ts';
import { CHUNK_BYTES, type ChunkInfo, type MeshMessage } from './envelope.ts';

export interface PhotoChunk {
  info: ChunkInfo;
  data: string; // base64
}

export async function splitPhoto(
  bytes: Uint8Array,
  photoId: string,
  reportId: string,
  chunkBytes = CHUNK_BYTES,
): Promise<PhotoChunk[]> {
  if (bytes.length === 0) throw new Error('empty photo');
  const sha256 = await sha256Hex(bytes);
  const total = Math.ceil(bytes.length / chunkBytes);
  const out: PhotoChunk[] = [];
  for (let i = 0; i < total; i++) {
    out.push({
      info: { photoId, reportId, index: i, total, totalBytes: bytes.length, sha256 },
      data: toBase64(bytes.subarray(i * chunkBytes, (i + 1) * chunkBytes)),
    });
  }
  return out;
}

export type ReassemblyResult =
  | { state: 'incomplete'; have: number; total: number }
  | { state: 'complete'; bytes: Uint8Array; photoId: string; reportId: string; sha256: string }
  | { state: 'corrupt'; reason: string };

/** Collects chunks per photo. Feed it every accepted `photo_chunk` message. */
export class Reassembler {
  private parts = new Map<string, { info: ChunkInfo; chunks: Map<number, Uint8Array> }>();
  private done = new Set<string>();

  async add(msg: Pick<MeshMessage, 'chunkInfo' | 'payload'>): Promise<ReassemblyResult> {
    const info = msg.chunkInfo;
    if (!info) return { state: 'corrupt', reason: 'no chunk info' };
    if (this.done.has(info.photoId)) return { state: 'incomplete', have: info.total, total: info.total };
    let entry = this.parts.get(info.photoId);
    if (!entry) {
      entry = { info, chunks: new Map() };
      this.parts.set(info.photoId, entry);
    } else if (entry.info.total !== info.total || entry.info.sha256 !== info.sha256 || entry.info.totalBytes !== info.totalBytes) {
      return { state: 'corrupt', reason: 'chunk metadata mismatch' };
    }
    entry.chunks.set(info.index, fromBase64((msg.payload as { data: string }).data));
    if (entry.chunks.size < info.total) return { state: 'incomplete', have: entry.chunks.size, total: info.total };

    const bytes = new Uint8Array(info.totalBytes);
    let off = 0;
    for (let i = 0; i < info.total; i++) {
      const c = entry.chunks.get(i)!;
      if (off + c.length > bytes.length) return this.fail(info.photoId, 'size overflow');
      bytes.set(c, off);
      off += c.length;
    }
    if (off !== info.totalBytes) return this.fail(info.photoId, 'size mismatch');
    const sha = await sha256Hex(bytes);
    if (sha !== info.sha256) return this.fail(info.photoId, 'sha256 mismatch');
    this.parts.delete(info.photoId);
    this.done.add(info.photoId);
    return { state: 'complete', bytes, photoId: info.photoId, reportId: info.reportId, sha256: sha };
  }

  progress(photoId: string): { have: number; total: number } | null {
    const e = this.parts.get(photoId);
    if (e) return { have: e.chunks.size, total: e.info.total };
    return this.done.has(photoId) ? { have: 1, total: 1 } : null;
  }

  private fail(photoId: string, reason: string): ReassemblyResult {
    this.parts.delete(photoId);
    return { state: 'corrupt', reason };
  }
}
