/**
 * Input validation utilities — shared across screens and deep links.
 */

/** Validate a Klever bech32 address (klv1... format, 62 chars). */
export function isValidKleverAddress(addr: string): boolean {
  return /^klv1[a-z0-9]{58}$/.test(addr);
}

/** Validate a hex string of expected length. */
export function isValidHex(hex: string, length: number): boolean {
  return new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex);
}
