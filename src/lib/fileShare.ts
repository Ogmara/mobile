/**
 * fileShare — "download" for non-image attachments (PDFs, docs, etc.) on mobile.
 *
 * There's no Files-app write access without either `expo-media-library`
 * (images/video/audio only) or a native "save as" picker (SAF, more
 * involved). The pragmatic middle ground — and the one Android/iOS both
 * support out of the box — is writing the bytes to a cache file and handing
 * it to the native share sheet, where "Save to Files" / "Save to Drive" /
 * any other target is just one more tap.
 */
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { base64ToBytes } from './mediaCrypto';
import { sanitizeFilename } from './sanitize';

/** Write `uri` (a `data:` URI or a remote `http(s)` URL) to a cache file named
 *  `filename` (attacker-controlled — a peer's `MediaDescriptor.name`/attachment
 *  `filename` — sanitized before use as a path segment) and open the native
 *  share sheet on it. Swallows failures (bad fetch, sanitized-to-empty name,
 *  sharing unavailable) rather than rejecting, since callers fire this from a
 *  bare `onPress` with no `.catch`.
 *
 * The temp cache file is deliberately NOT deleted after sharing: `shareAsync`
 * typically resolves once the OS share sheet/Intent is dispatched, not once
 * the receiving app has finished reading the file — deleting immediately
 * would race a slower receiving app. It's cleaned up on the OS's normal
 * cache-eviction schedule instead. */
export async function shareFileFromUri(uri: string, filename: string): Promise<void> {
  try {
    const safeName = sanitizeFilename(filename);
    let localUri = uri;
    if (uri.startsWith('data:')) {
      const commaIdx = uri.indexOf(',');
      const bytes = base64ToBytes(uri.slice(commaIdx + 1));
      const file = new File(Paths.cache, safeName);
      file.write(bytes);
      localUri = file.uri;
    } else if (uri.startsWith('http')) {
      const resp = await fetch(uri);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const file = new File(Paths.cache, safeName);
      file.write(bytes);
      localUri = file.uri;
    }
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(localUri);
    }
  } catch {
    // Best-effort — no UI feedback path from here (fire-and-forget onPress).
  }
}
