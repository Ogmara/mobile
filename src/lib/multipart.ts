/**
 * Minimal multipart/form-data encoder.
 *
 * Expo SDK 58 replaced the global `fetch` with a WinterCG implementation that
 * no longer understands React Native's `{ uri, type, name }` FormData parts
 * ("Unsupported FormDataPart implementation"). Rather than depend on what any
 * given fetch does with FormData, uploads build the body bytes themselves and
 * post a plain `Uint8Array` with an explicit boundary header, which every
 * fetch implementation accepts.
 */

/** One multipart field: a text value, or a file with its bytes. */
export type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; type: string; bytes: Uint8Array };

const BOUNDARY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A random boundary; 32 chars of entropy makes a collision with the payload negligible. */
export function createBoundary(rand: () => number = Math.random): string {
  let b = '----OgmaraFormBoundary';
  for (let i = 0; i < 32; i++) b += BOUNDARY_CHARS.charAt(Math.floor(rand() * BOUNDARY_CHARS.length));
  return b;
}

/** Quote-safe header value: strips CR/LF and double quotes so a name cannot inject headers. */
function headerSafe(s: string): string {
  return s.replace(/[\r\n"\\]/g, '_');
}

/**
 * Encode `parts` as a multipart/form-data body.
 *
 * @returns the body bytes and the `Content-Type` header value to send with it.
 */
export function buildMultipart(
  parts: MultipartPart[],
  boundary: string = createBoundary(),
): { body: Uint8Array; contentType: string } {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${headerSafe(part.name)}"`;
    if ('bytes' in part) {
      head += `; filename="${headerSafe(part.filename)}"\r\nContent-Type: ${headerSafe(part.type)}`;
    }
    chunks.push(enc.encode(`${head}\r\n\r\n`));
    chunks.push('bytes' in part ? part.bytes : enc.encode(part.value));
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));

  let total = 0;
  for (const c of chunks) total += c.length;
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
