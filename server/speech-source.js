import path from 'node:path';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Reads only the newest fresh JSONL transcript chunk from a private local directory. */
export function createSpeechSource({ file = '', root = path.resolve('data/transcripts'), now = Date.now, maxAgeMs = 15000 } = {}) {
  const directory = path.resolve(root);
  const filename = file ? path.resolve(file) : '';
  if (filename && (path.dirname(filename) !== directory || path.extname(filename) !== '.jsonl' || path.basename(filename).startsWith('.'))) throw Error('Transcript must be a JSONL file in the private transcripts directory');
  const maximumAge = Math.max(1, Math.min(15000, Number(maxAgeMs) || 15000));
  let closed = false, active = null, lastAt = -Infinity, lastId = null, reads = 0, failures = 0, status = file ? 'idle' : 'unconfigured';
  return {
    readTranscript() {
      if (closed || !filename) return Promise.resolve(null);
      if (active) return active;
      active = (async () => {
        let handle;
        try {
          if (await realpath(directory) !== directory) throw Error('Unavailable');
          const directoryInfo = await stat(directory);
          if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077)) throw Error('Unavailable');
          handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
          const info = await handle.stat();
          if (!info.isFile() || (info.mode & 0o077)) throw Error('Unavailable');
          const length = Math.min(info.size, 65536);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
          reads++;
          let tail = buffer.subarray(0, bytesRead);
          if (info.size > length) {
            // The bounded read can start inside a multibyte character in a partial record.
            const firstNewline = tail.indexOf(0x0a);
            tail = firstNewline < 0 ? tail.subarray(tail.length) : tail.subarray(firstNewline + 1);
          }
          const lines = new TextDecoder('utf-8', { fatal: true }).decode(tail).split('\n');
          lines.pop(); // Only complete JSONL records can be consumed.
          status = closed ? 'closed' : 'ready';
          for (const line of lines.slice(-64).reverse()) {
            if (!line || Buffer.byteLength(line) > 8192) continue;
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            if (!row || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 2000) continue;
            const at = typeof row.at === 'number' ? row.at : Date.parse(row.at);
            if (!Number.isFinite(at) || at > now() + 2000 || now() - at > maximumAge || at < lastAt) continue;
            const id = createHash('sha256').update(`${at}:${row.text}`).digest('hex').slice(0, 24);
            if (at === lastAt && id === lastId) return null;
            lastAt = at;
            lastId = id;
            return closed ? null : { id, at, text: row.text };
          }
          return null;
        } catch {
          failures++;
          status = closed ? 'closed' : 'unavailable';
          return null;
        } finally {
          await handle?.close();
          active = null;
        }
      })();
      return active;
    },
    state() { return { configured: !!filename, status, in_flight: !!active, reads, failures, max_age_ms: maximumAge, max_chunk_characters: 2000 }; },
    close() { closed = true; status = 'closed'; },
  };
}
