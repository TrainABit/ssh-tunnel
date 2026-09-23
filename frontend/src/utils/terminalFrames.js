/**
 * Web terminal input framing.
 *
 * /ws/ssh accepts frames of at most 1 MiB (larger frames close the socket with
 * 1009), so keystrokes and pastes are sent as binary frames of at most 64 KiB.
 * Splitting inside a multi-byte UTF-8 sequence is fine: the server writes the
 * raw bytes to the SSH channel in order.
 */
export const MAX_INPUT_FRAME_BYTES = 64 * 1024;

/**
 * Split bytes into views of at most maxBytes (no copies). Empty input -> [].
 * @param {Uint8Array} bytes
 * @param {number} [maxBytes]
 * @returns {Uint8Array[]}
 */
export function chunkBytes(bytes, maxBytes = MAX_INPUT_FRAME_BYTES) {
  const max = Math.max(1, Math.floor(maxBytes) || MAX_INPUT_FRAME_BYTES);
  if (!bytes || bytes.length === 0) return [];
  if (bytes.length <= max) return [bytes];
  const chunks = [];
  for (let off = 0; off < bytes.length; off += max) {
    chunks.push(bytes.subarray(off, Math.min(off + max, bytes.length)));
  }
  return chunks;
}
