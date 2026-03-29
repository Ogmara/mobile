/**
 * i18n initialization — 6 languages, auto-detect from OS locale.
 *
 * Uses i18next + react-i18next. Locale files are static JSON imports
 * (no async loading needed — all bundled).
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'expo-localization';
import AsyncStorage from '@react-native-async-storage/async-storage';

import en from './locales/en.json';
import de from './locales/de.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import ja from './locales/ja.json';
import zh from './locales/zh.json';

/** Supported language codes. */
export const LANGUAGES = ['en', 'de', 'es', 'pt', 'ja', 'zh'] as const;
export type LanguageCode = (typeof LANGUAGES)[number];

/** Detect the user's preferred language from OS locale. */
function detectLanguage(): LanguageCode {
  const locales = getLocales();
  if (locales.length > 0) {
    const code = locales[0].languageCode;
    if (code && LANGUAGES.includes(code as LanguageCode)) {
      return code as LanguageCode;
    }
  }
  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    de: { translation: de },
    es: { translation: es },
    pt: { translation: pt },
    ja: { translation: ja },
    zh: { translation: zh },
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes
  },
});

// Load saved language preference (async, overrides detected language)
AsyncStorage.getItem('ogmara.lang')
  .then((saved) => {
    if (saved && LANGUAGES.includes(saved as LanguageCode)) {
      i18n.changeLanguage(saved);
    }
  })
  .catch(() => {}); // fallback to detected language on error

export default i18n;
