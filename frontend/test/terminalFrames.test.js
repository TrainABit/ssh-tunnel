import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkBytes, MAX_INPUT_FRAME_BYTES } from '../src/utils/terminalFrames.js';

test('small input is sent as one frame, empty input as none', () => {
  const b = new TextEncoder().encode('ls -la\r');
  assert.deepEqual(chunkBytes(b), [b]);
  assert.deepEqual(chunkBytes(new Uint8Array(0)), []);
  assert.deepEqual(chunkBytes(null), []);
});

test('large pastes are split into <= 64 KiB frames that reassemble byte-exact', () => {
  assert.equal(MAX_INPUT_FRAME_BYTES, 64 * 1024);
  // 2.5 MiB of multi-byte UTF-8 (splits land inside sequences; the server forwards raw bytes)
  const text = 'äöü ✓ 🚀 '.repeat(200_000);
  const bytes = new TextEncoder().encode(text);
  assert.ok(bytes.length > 2 * 1024 * 1024);
  const chunks = chunkBytes(bytes);
  assert.equal(chunks.length, Math.ceil(bytes.length / MAX_INPUT_FRAME_BYTES));
  for (const c of chunks) {
    assert.ok(c.length > 0 && c.length <= MAX_INPUT_FRAME_BYTES);
    assert.equal(c.buffer, bytes.buffer, 'views, no copies');
  }
  const joined = new Uint8Array(bytes.length);
  let off = 0;
  for (const c of chunks) { joined.set(c, off); off += c.length; }
  assert.equal(new TextDecoder().decode(joined), text);
});

test('exact multiples and custom limits', () => {
  const bytes = new Uint8Array(MAX_INPUT_FRAME_BYTES * 2);
  assert.deepEqual(chunkBytes(bytes).map((c) => c.length), [MAX_INPUT_FRAME_BYTES, MAX_INPUT_FRAME_BYTES]);
  assert.deepEqual(chunkBytes(new Uint8Array(10), 4).map((c) => c.length), [4, 4, 2]);
});
