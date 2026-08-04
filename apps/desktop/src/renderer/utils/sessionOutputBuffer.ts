export interface SessionOutputChunk {
  text: string;
  bytes: number;
}

export interface SessionOutputBuffer {
  chunks: SessionOutputChunk[];
  totalBytes: number;
}

export const MAX_SESSION_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * Byte budget for one tab-switch replay.
 *
 * A session keeps up to {@link MAX_SESSION_OUTPUT_BYTES} of raw stream, but the
 * whole ring buffer used to go back through xterm's parser on every switch, and
 * that parse *is* the cost of a switch — a session that dumped megabytes while
 * in the background made landing on it visibly slow.
 *
 * The tradeoff: fidelity of the *deepest* scrollback (only reachable by
 * scrolling up, and only ever that deep for high-output background sessions)
 * against switch latency. The ring buffer itself is untouched — nothing is
 * dropped from the stream, from the search index of the live session, or from
 * the backlog handed to monitor grids; only the slice re-parsed on a switch is
 * capped.
 */
export const REPLAY_MAX_BYTES = 512 * 1024;

/**
 * Dim marker that replaces the scrollback a capped replay could not carry, so
 * the top of the buffer is not mistaken for the true start of the stream.
 */
export const REPLAY_TRUNCATION_NOTICE =
  "\x1b[2m[NextShell] 更早的输出已省略(缓冲过长),完整滚动缓冲以此处为起点\x1b[0m\r\n";

export interface ReplayPayload {
  /** Exactly what should be handed to the parser, notice line included. */
  text: string;
  /** Whether any buffered output was left out of `text`. */
  truncated: boolean;
  /** Bytes the ring buffer holds (matches `SessionOutputBuffer.totalBytes`). */
  totalBytes: number;
  /** Buffered bytes that survived into `text`, excluding the notice line. */
  writtenBytes: number;
  /** Chunks that survived; a partially skipped head chunk still counts as one. */
  chunkCount: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// UTF-8 continuation bytes are 0b10xxxxxx; a cut landing in front of one is
// mid-sequence, so the decoder will emit replacement characters there.
const isContinuationByte = (byte: number): boolean => {
  return (byte & 0xc0) === 0x80;
};

/**
 * Drop `bytesToTrim` UTF-8 bytes from the front of an encoded chunk and
 * return the remaining text with its exact byte count. When the cut lands on
 * a sequence boundary the byte count is simply the remaining encoded length
 * (TextEncoder output is always valid UTF-8, so the decode round-trips
 * byte-identically); only a mid-sequence cut — which makes the decoder emit
 * replacement characters — requires re-encoding to stay exact.
 */
const trimLeadingEncodedBytes = (encoded: Uint8Array, bytesToTrim: number): SessionOutputChunk => {
  const remaining = encoded.subarray(bytesToTrim);
  const text = decoder.decode(remaining);
  const firstByte = remaining[0];
  const bytes =
    firstByte !== undefined && isContinuationByte(firstByte)
      ? encoder.encode(text).length
      : remaining.length;

  return { text, bytes };
};

export const createEmptyBuffer = (): SessionOutputBuffer => {
  return {
    chunks: [],
    totalBytes: 0
  };
};

/**
 * Append `text`, evicting the oldest content beyond `maxBytes`.
 *
 * The buffer is mutated in place and returned: callers own their buffers
 * privately (TerminalPane keeps them in a ref Map that is never
 * identity-compared by React), and this runs per terminal data frame, so no
 * copies or re-encodes of previously stored chunks happen on the hot path —
 * each incoming chunk is encoded exactly once.
 */
export const appendWithLimit = (
  buffer: SessionOutputBuffer,
  text: string,
  maxBytes: number = MAX_SESSION_OUTPUT_BYTES
): SessionOutputBuffer => {
  if (!text) {
    return buffer;
  }

  if (maxBytes <= 0) {
    buffer.chunks.length = 0;
    buffer.totalBytes = 0;
    return buffer;
  }

  // Encode the incoming chunk once and reuse the bytes for both the
  // oversized-chunk truncation and the stored byte count.
  const encoded = encoder.encode(text);
  const chunk: SessionOutputChunk =
    encoded.length <= maxBytes
      ? { text, bytes: encoded.length }
      : trimLeadingEncodedBytes(encoded, encoded.length - maxBytes);
  if (chunk.bytes <= 0) {
    return buffer;
  }

  const chunks = buffer.chunks;
  chunks.push(chunk);
  let totalBytes = buffer.totalBytes + chunk.bytes;

  let dropCount = 0;
  while (totalBytes > maxBytes && dropCount < chunks.length) {
    const first = chunks[dropCount];
    if (!first) {
      break;
    }

    const overflow = totalBytes - maxBytes;
    if (first.bytes <= overflow) {
      dropCount += 1;
      totalBytes -= first.bytes;
      continue;
    }

    // Partial trim of the oldest chunk; only this single chunk is re-encoded.
    const trimmed = trimLeadingEncodedBytes(encoder.encode(first.text), overflow);
    if (trimmed.bytes >= first.bytes) {
      // A mid-sequence cut can inflate the remainder with replacement
      // characters until it cancels (or exceeds) the bytes removed; without
      // strict progress this loop would never terminate, so evict the whole
      // chunk instead.
      dropCount += 1;
      totalBytes -= first.bytes;
      continue;
    }

    chunks[dropCount] = trimmed;
    totalBytes = totalBytes - first.bytes + trimmed.bytes;
  }

  if (dropCount > 0) {
    chunks.splice(0, dropCount);
  }

  buffer.totalBytes = totalBytes;
  return buffer;
};

export const toReplayChunks = (buffer: SessionOutputBuffer): string[] => {
  return buffer.chunks.map((chunk) => chunk.text);
};

const joinChunkText = (chunks: readonly SessionOutputChunk[]): string => {
  let text = "";
  for (const chunk of chunks) {
    text += chunk.text;
  }
  return text;
};

/**
 * Build the text a tab switch should replay, keeping the newest `maxBytes` of
 * buffered output.
 *
 * Chunks are kept whole from the tail: each one is a single data event and may
 * already begin mid escape sequence, so cutting *inside* one buys nothing — it
 * only strands a second half-parsed sequence. Once the cut is chosen, the first
 * kept chunk is advanced past its first newline so the replay starts on a line
 * boundary (a chunk with no newline is kept whole rather than dropped).
 *
 * The newest chunk is always kept, even alone over budget: it holds the screen
 * the user is switching to. In that case nothing is actually dropped, so the
 * result reports `truncated: false` and carries no notice.
 *
 * Byte counts come from the chunks' own `bytes` fields — encoded UTF-8 bytes,
 * the same unit `appendWithLimit` caps the ring buffer with — so no re-encode of
 * the backlog happens here; only a skipped head prefix is measured.
 */
export const buildReplayPayload = (
  chunks: readonly SessionOutputChunk[],
  maxBytes: number = REPLAY_MAX_BYTES
): ReplayPayload => {
  let totalBytes = 0;
  for (const chunk of chunks) {
    totalBytes += chunk.bytes;
  }

  if (chunks.length === 0) {
    return { text: "", truncated: false, totalBytes: 0, writtenBytes: 0, chunkCount: 0 };
  }

  if (totalBytes <= maxBytes) {
    return {
      text: joinChunkText(chunks),
      truncated: false,
      totalBytes,
      writtenBytes: totalBytes,
      chunkCount: chunks.length
    };
  }

  let startIndex = chunks.length - 1;
  let keptBytes = chunks[startIndex]?.bytes ?? 0;
  while (startIndex > 0) {
    const previous = chunks[startIndex - 1];
    if (!previous || keptBytes + previous.bytes > maxBytes) {
      break;
    }
    keptBytes += previous.bytes;
    startIndex -= 1;
  }

  const kept = chunks.slice(startIndex);
  if (startIndex === 0) {
    // A single chunk larger than the whole budget: kept intact, nothing lost.
    return {
      text: joinChunkText(kept),
      truncated: false,
      totalBytes,
      writtenBytes: keptBytes,
      chunkCount: kept.length
    };
  }

  const head = kept[0];
  let headText = head?.text ?? "";
  let writtenBytes = keptBytes;
  const newlineIndex = headText.indexOf("\n");
  if (newlineIndex >= 0) {
    const skipped = headText.slice(0, newlineIndex + 1);
    headText = headText.slice(newlineIndex + 1);
    writtenBytes -= encoder.encode(skipped).length;
  }

  const parts: string[] = [REPLAY_TRUNCATION_NOTICE, headText];
  for (let index = 1; index < kept.length; index += 1) {
    const chunk = kept[index];
    if (chunk) {
      parts.push(chunk.text);
    }
  }

  return {
    text: parts.join(""),
    truncated: true,
    totalBytes,
    writtenBytes,
    chunkCount: kept.length
  };
};
