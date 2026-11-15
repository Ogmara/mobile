/**
 * Authenticated media upload (`POST /api/v1/media/upload`).
 *
 * Builds the multipart body in JS (see `multipart.ts`) because Expo SDK 58's
 * global fetch rejects React Native `{ uri, type, name }` FormData parts.
 */
import { File } from 'expo-file-system';
import { buildMultipart } from './multipart';

/** Minimal client surface needed to sign the upload request. */
export interface UploadClient {
  authHeaders(method: string, path: string): Promise<Record<string, string>>;
  nodeUrl?: string;
}

/** What to upload: the bytes themselves, or a local `file://` uri to read them from. */
export interface UploadSource {
  /** Local file uri (e.g. from the image picker). Read fully into memory. */
  uri?: string;
  /** In-memory bytes (used for encrypted blobs that never exist on disk). */
  bytes?: Uint8Array;
  mimeType: string;
  fileName: string;
  /** Refuse anything larger (default 50 MB). Checked before the read when a size is known, and again on the bytes. */
  maxBytes?: number;
  /** The picker's reported size, used when the file system cannot report one (it returns 0 then). */
  sizeHint?: number;
  /** Extra text fields, e.g. `{ encrypted: '1' }`. */
  fields?: Record<string, string>;
}

/** Default client-side upload cap (matches the node's `max_upload_size_mb` default). */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** The node's upload response. Callers still validate `cid` (a node may omit it). */
export interface UploadResult {
  cid: string;
  size: number;
  /** Present when the node generated a thumbnail. */
  thumbnail_cid?: string;
  [k: string]: unknown;
}

/**
 * Upload one file and return the node's JSON response.
 *
 * @throws Error `Upload failed (<status>): <text>` on a non-2xx response.
 */
export async function uploadMedia(
  client: UploadClient,
  src: UploadSource,
  signed: boolean = true,
): Promise<UploadResult> {
  const max = src.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  let bytes: Uint8Array | null = src.bytes ?? null;
  if (!bytes && src.uri) {
    const file = new File(src.uri);
    // The file system reports 0 (never null) when it cannot tell the size, so
    // take the larger of its value and the picker's hint. If both are unknown
    // the file is read and the length check below still rejects it; that case
    // costs memory but cannot upload an oversize file.
    const known = Math.max(file.size ?? 0, src.sizeHint ?? 0);
    if (known > max) throw new Error('FILE_TOO_LARGE');
    bytes = await file.bytes();
  }
  if (!bytes) throw new Error('nothing to upload');
  if (bytes.length > max) throw new Error('FILE_TOO_LARGE');
  const { body, contentType } = buildMultipart([
    { name: 'file', filename: src.fileName, type: src.mimeType, bytes },
    ...Object.entries(src.fields ?? {}).map(([name, value]) => ({ name, value })),
  ]);
  const headers = signed ? await client.authHeaders('POST', '/api/v1/media/upload') : {};
  const resp = await fetch(`${client.nodeUrl || ''}/api/v1/media/upload`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': contentType },
    // Expo's fetch takes a Uint8Array body; the DOM lib's BodyInit type omits it.
    body: body as unknown as BodyInit,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Upload failed (${resp.status}): ${text.slice(0, 150)}`);
  }
  return (await resp.json()) as UploadResult;
}
