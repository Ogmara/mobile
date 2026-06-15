/**
 * Design tokens — shared color palette, spacing, typography.
 *
 * Colors match the desktop app's "Modern" (Telegram-inspired) style — the sole
 * design language on mobile. Only color values differ between light/dark; the
 * spacing/typography/radius scales are theme-independent (project rule).
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

/** Light theme color palette (desktop Modern light). */
export const lightColors = {
  bgPrimary: '#FFFFFF',
  bgSecondary: '#F4F4F5',
  bgTertiary: '#EBEDF0',
  textPrimary: '#0F1419',
  textSecondary: '#707579',
  textInverse: '#FFFFFF',
  accentPrimary: '#3390EC',
  accentSecondary: '#4FB3F6',
  border: '#E5E8EC',
  success: '#4DCD5E',
  warning: '#E8A93C',
  error: '#E53935',
  dm: '#3390EC',
} as const;

/** Dark theme color palette (desktop Modern dark — Telegram blue). */
export const darkColors = {
  bgPrimary: '#0E1621',
  bgSecondary: '#0E1621',
  bgTertiary: '#182533',
  textPrimary: '#FFFFFF',
  textSecondary: '#708499',
  textInverse: '#FFFFFF',
  accentPrimary: '#5288C1',
  accentSecondary: '#6AB2F2',
  border: '#1F2C3A',
  success: '#4DCD5E',
  warning: '#E8A93C',
  error: '#E53935',
  dm: '#6AB2F2',
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
