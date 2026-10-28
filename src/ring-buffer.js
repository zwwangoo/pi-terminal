"use strict";
/**
 * Output ring for one terminal session.
 *
 * Why chunks and not a byte ring: a reader resumes by sequence number, so output is stored as a list
 * of chunk records, each carrying its own seq, and trimming drops whole chunks from the oldest end.
 * That keeps a trim from cutting inside a stored chunk — the cut lands on a chunk boundary. (A chunk
 * boundary itself comes from the producer: a pty read is byte-oriented, so whether a character
 * straddles two chunks is not something this layer can decide. It only guarantees it never makes a
 * new cut of its own.) When the reader's position has already been dropped, read() reports truncated
 * instead of quietly returning a shorter stream that looks complete.
 *
 * seq is monotonic per session and assigned once, at push time, so a reconnect or a second reader
 * resumes at the exact chunk it left off — no repeated prefix, no silent gap.
 */

class RingBuffer {
  constructor(limitBytes) {
    if (!(Number(limitBytes) >= 1024)) throw new Error("RingBuffer limit must be >= 1024 bytes");
    this.limitBytes = limitBytes;
    this.entries = []; // { seq, bytes }, oldest first
    this.bytes = 0;
    this.nextSeq = 1; // seq the next pushed chunk will get
    this.droppedBeforeSeq = 1; // a reader below this position has lost output
  }

  /** Highest seq pushed so far (0 when nothing has been pushed). */
  get latestSeq() {
    return this.nextSeq - 1;
  }

  /** Oldest seq still readable: everything below it has been trimmed away. */
  get earliestSeq() {
    return this.droppedBeforeSeq;
  }

  get totalBytes() {
    return this.bytes;
  }

  /** Append one chunk of output and return the seq it was given. */
  push(data) {
    if (!data || data.length === 0) return this.latestSeq;
    const seq = this.nextSeq++;
    this.entries.push({ seq, bytes: Buffer.from(data) });
    this.bytes += data.length;
    this.trim();
    return seq;
  }

  /** Drop the oldest chunks until the ring fits, but always keep the newest one. */
  trim() {
    while (this.bytes > this.limitBytes && this.entries.length > 1) {
      const dropped = this.entries.shift();
      this.bytes -= dropped.bytes.length;
      this.droppedBeforeSeq = dropped.seq + 1;
    }
  }

  /**
   * Chunks at or after `fromSeq`, up to `maxBytes`.
   *
   * `nextSeq` is where the caller resumes; entries are whole, so a single chunk larger than
   * `maxBytes` is still returned in full rather than cut. `truncated` means the requested position
   * is already gone — the caller must say so instead of presenting the rest as the whole output.
   */
  read(fromSeq, maxBytes) {
    const from = Math.max(1, Math.floor(Number(fromSeq)) || 1);
    const truncated = from < this.droppedBeforeSeq;
    const start = Math.max(from, this.droppedBeforeSeq);
    const chunks = [];
    let used = 0;
    for (const entry of this.entries) {
      if (entry.seq < start) continue;
      if (used + entry.bytes.length > maxBytes && chunks.length > 0) break;
      chunks.push({ seq: entry.seq, bytes: entry.bytes });
      used += entry.bytes.length;
    }
    // No chunks means the caller is already at (or past) the head. Report the head, never the caller's
    // position: a `from` beyond the end must not become a resume point that silently skips the output
    // that arrives afterwards.
    const nextSeq = chunks.length ? chunks[chunks.length - 1].seq + 1 : this.nextSeq;
    return { chunks, nextSeq, truncated };
  }

  /** Bytes retained at or after `fromSeq`: how far a reader at that position is behind. */
  bytesAfter(fromSeq) {
    const from = Math.max(1, Math.floor(Number(fromSeq)) || 1);
    let total = 0;
    for (const entry of this.entries) if (entry.seq >= from) total += entry.bytes.length;
    return total;
  }
}

module.exports = { RingBuffer };
