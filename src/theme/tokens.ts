/**
 * Design tokens — shared color palette, spacing, typography.
 *
 * Values match the web frontend (global.css) and spec 06-frontend.md section 3.2.
 * Used by both light and dark themes.
 */

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  full: 9999,
} as const;

/** Light theme color palette. */
export const lightColors = {
  bgPrimary: '#ffffff',
  bgSecondary: '#f5f5f7',
  bgTertiary: '#e8e8ed',
  textPrimary: '#1a1a1a',
  textSecondary: '#6b6b6b',
  textInverse: '#ffffff',
  accentPrimary: '#6c5ce7',
  accentSecondary: '#a29bfe',
  border: '#e0e0e0',
  success: '#00b894',
  warning: '#fdcb6e',
  error: '#d63031',
  dm: '#e17055',
} as const;

/** Dark theme color palette. */
export const darkColors = {
  bgPrimary: '#1a1a2e',
  bgSecondary: '#16213e',
  bgTertiary: '#0f3460',
  textPrimary: '#e0e0e0',
  textSecondary: '#8b8b8b',
  textInverse: '#1a1a1a',
  accentPrimary: '#a29bfe',
  accentSecondary: '#6c5ce7',
  border: '#2a2a4a',
  success: '#55efc4',
  warning: '#ffeaa7',
  error: '#ff7675',
  dm: '#fab1a0',
} as const;

/** Color tokens interface — shared shape for both light and dark palettes. */
export interface ColorTokens {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  textPrimary: string;
  textSecondary: string;
  textInverse: string;
  accentPrimary: string;
  accentSecondary: string;
  border: string;
  success: string;
  warning: string;
  error: string;
  dm: string;
}
