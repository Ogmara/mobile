/**
 * E2E trace recorder (mobile) — a small always-on in-memory ring buffer of every
 * step in the encryption flow (binding, establish, wrap, publish, fetch, unwrap,
 * decode, decrypt). Surfaced in the Debug screen for support without a console.
 *
 * Ported from the desktop `e2eDebug.ts`, minus the browser-only console helpers
 * (window/localStorage/Blob/document) which don't exist on Hermes.
 */

export interface TraceEvent {
  /** epoch ms */
  t: number;
  /** monotonic sequence within this session */
  seq: number;
  step: string;
  data?: Record<string, unknown>;
}

const TRACE_MAX = 2000;
const traceBuf: TraceEvent[] = [];
let seq = 0;

/** When true, steps ALSO mirror to the JS console live (off by default). */
let consoleMirror = false;

/** Toggle live console mirroring of trace steps (e.g. from the Debug screen). */
export function setE2EConsoleMirror(on: boolean): void {
  consoleMirror = on;
}

/** Record one step into the always-on trace buffer (+ console if mirroring). */
export function e2elog(step: string, data?: Record<string, unknown>): void {
  const ev: TraceEvent = { t: Date.now(), seq: seq++, step, data };
  traceBuf.push(ev);
  if (traceBuf.length > TRACE_MAX) traceBuf.splice(0, traceBuf.length - TRACE_MAX);
  if (consoleMirror) {
    // eslint-disable-next-line no-console
    console.info(`[e2e] ${step}`, data ?? {});
  }
}

/** The full trace, oldest→newest (a copy). */
export function getE2ETrace(): TraceEvent[] {
  return traceBuf.slice();
}

/** Clear the buffer — call right before reproducing the step you want to capture. */
export function clearE2ETrace(): void {
  traceBuf.length = 0;
  seq = 0;
}

/** True if an error looks like an HTTP 429 / rate-limit rejection. */
export function isRateLimit(e: unknown): boolean {
  const msg = (e as { message?: string })?.message || String(e);
  return msg.includes('429') || /too many requests/i.test(msg);
}

/**
 * Run `fn`, retrying ONLY on 429 with linear backoff (default 3 tries:
 * ~0.8s, 1.6s). Any non-rate-limit error propagates immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRateLimit(e)) throw e;
      const backoff = 800 * (attempt + 1);
      e2elog(`${label}: 429, retry ${attempt + 1}/${tries} in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}
