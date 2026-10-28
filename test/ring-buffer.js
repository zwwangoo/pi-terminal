// Unit tests for the per-session output ring (src/ring-buffer.js).
// The ring decides three things the panel depends on, so each is pinned here:
//   1. seq addressing — a reader resumes at the exact chunk it left off, never a prefix;
//   2. trimming drops WHOLE chunks — a half multi-byte character renders as garbage;
//   3. when the reader's position is already gone, read() says truncated instead of pretending.
const path = require("path");
const { RingBuffer } = require(path.resolve(__dirname, "..", "src", "ring-buffer.js"));

let ok = true;
const check = (name, cond, extra = "") => { if (!cond) ok = false; console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); };
const text = (r) => Buffer.concat(r.chunks.map((c) => c.bytes)).toString("utf8");
const seqs = (r) => r.chunks.map((c) => c.seq).join(",");

// empty
{
  const r = new RingBuffer(4096);
  const read = r.read(1, 1024);
  check("empty: read returns nothing, nextSeq 1, not truncated",
    read.chunks.length === 0 && read.nextSeq === 1 && read.truncated === false);
  check("empty: latest 0 / earliest 1 / 0 bytes",
    r.latestSeq === 0 && r.earliestSeq === 1 && r.totalBytes === 0);
}

// seq addressing: push assigns 1,2,3...; read(from) starts AT from
{
  const r = new RingBuffer(4096);
  check("push returns assigned seq", r.push(Buffer.from("a")) === 1 && r.push(Buffer.from("b")) === 2 && r.push(Buffer.from("c")) === 3);
  check("latestSeq follows pushes", r.latestSeq === 3);
  const all = r.read(1, 1024);
  check("read(1) returns every chunk in order", seqs(all) === "1,2,3" && text(all) === "abc" && all.nextSeq === 4);
  const tail = r.read(3, 1024);
  check("read(3) resumes at chunk 3 only", seqs(tail) === "3" && text(tail) === "c" && tail.nextSeq === 4);
  const caughtUp = r.read(4, 1024);
  check("read at the head returns nothing and keeps nextSeq", caughtUp.chunks.length === 0 && caughtUp.nextSeq === 4 && !caughtUp.truncated);
}

// maxBytes is a budget, but never splits a chunk
{
  const r = new RingBuffer(4096);
  r.push(Buffer.alloc(100, 0x61));
  r.push(Buffer.alloc(100, 0x62));
  const first = r.read(1, 100);
  check("maxBytes stops after the first chunk", first.chunks.length === 1 && first.nextSeq === 2, `next=${first.nextSeq}`);
  const second = r.read(2, 100);
  check("the next read gets the rest", second.chunks.length === 1 && second.nextSeq === 3);
  const r2 = new RingBuffer(4096);
  r2.push(Buffer.alloc(1000, 0x61));
  const big = r2.read(1, 10);
  check("a chunk larger than maxBytes is returned whole, not cut", big.chunks.length === 1 && big.chunks[0].bytes.length === 1000);
}

// trimming drops whole oldest chunks, keeps at least one
{
  const r = new RingBuffer(4096);
  for (let i = 0; i < 4; i++) r.push(Buffer.alloc(2048, 0x61 + i));
  check("trim keeps the newest chunks within the limit", r.totalBytes === 4096 && r.earliestSeq === 3, `bytes=${r.totalBytes} earliest=${r.earliestSeq}`);
  const read = r.read(1, 99999);
  check("reading a dropped position reports truncated", read.truncated === true);
  check("truncated read still returns what is retained, from the earliest seq", seqs(read) === "3,4" && read.nextSeq === 5);
  const after = r.read(3, 99999);
  check("reading the earliest retained seq is NOT truncated", after.truncated === false);

  const one = new RingBuffer(4096);
  one.push(Buffer.alloc(10000, 0x61));
  check("a single oversized chunk is kept (never an empty buffer)", one.totalBytes === 10000 && one.earliestSeq === 1);
}

// multi-byte safety: a cut must land on a chunk boundary, not inside a character
{
  const r = new RingBuffer(4096);
  const chunk = (ch) => Buffer.from(ch + "a".repeat(1997), "utf8"); // 2000 bytes, starts with a 3-byte char
  r.push(chunk("你"));
  r.push(chunk("好"));
  r.push(chunk("終"));
  const read = r.read(1, 999999);
  const got = text(read);
  check("trimming starts on a chunk boundary, never inside a stored chunk", got.length === 3996 && got.startsWith("好") && got.includes("終"),
    `len=${got.length} head=${JSON.stringify(got.slice(0, 2))}`);
  check("retained text is valid UTF-8 (round trip)", Buffer.from(got, "utf8").length === 4000);
}

// bytesAfter: how far a reader at that position is behind (drives pty back-pressure)
{
  const r = new RingBuffer(4096);
  r.push(Buffer.alloc(100, 0x61));
  r.push(Buffer.alloc(200, 0x62));
  r.push(Buffer.alloc(300, 0x63));
  check("bytesAfter counts unread bytes", r.bytesAfter(1) === 600 && r.bytesAfter(2) === 500 && r.bytesAfter(4) === 0);
  const r2 = new RingBuffer(4096);
  for (let i = 0; i < 4; i++) r2.push(Buffer.alloc(2048, 0x61));
  check("bytesAfter clamps to what is still retained", r2.bytesAfter(1) === 4096, String(r2.bytesAfter(1)));
}

// a `from` past the head must not turn into a resume point in the future (it would skip what arrives next)
{
  const r = new RingBuffer(4096);
  r.push(Buffer.from("a"));
  r.push(Buffer.from("b"));
  const ahead = r.read(99, 1024);
  check("read past the head reports the head, not the caller's position", ahead.chunks.length === 0 && ahead.nextSeq === 3, String(ahead.nextSeq));
  r.push(Buffer.from("c"));
  const next = r.read(ahead.nextSeq, 1024);
  check("a read past the head still sees the chunk that arrives after it", seqs(next) === "3" && next.nextSeq === 4);
}

console.log(ok ? "\nALL PASS" : "\nSOME FAILED");
process.exit(ok ? 0 : 1);
