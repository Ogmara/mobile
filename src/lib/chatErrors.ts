/**
 * Map a write/API error message to a user-facing i18n key.
 *
 * The L2 node gates edits/deletes/reactions on a verified wallet and rate-limits
 * proof-of-work challenges; both must be surfaced clearly instead of failing silently.
 * Returns an i18n key, or null when the raw message should be shown.
 */
export function chatErrorKey(msg: string): 'verify_wallet_required' | 'pow_busy' | null {
  const m = (msg || '').toLowerCase();
  if (/verif|identity|registered|requires_verified/.test(m)) return 'verify_wallet_required';
  if (/pending challenge|\bpow\b|503|too many/.test(m)) return 'pow_busy';
  return null;
}
