import en from './locales/en';
import zhCN from './locales/zh-CN';

export type Locale = 'zh-CN' | 'en';

export const catalogs: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  en,
};

export const localeNames: Record<Locale, string> = {
  'zh-CN': '简体中文',
  en: 'English',
};

export const locales: Locale[] = ['zh-CN', 'en'];

export type MessageKey = keyof typeof en;

const STORAGE_KEY = 'squoosh-locale';
const DEFAULT_LOCALE: Locale = 'zh-CN';

function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

let current: Locale | undefined;

export function getLocale(): Locale {
  if (current) return current;

  if (__PRERENDER__) {
    current = DEFAULT_LOCALE;
    return current;
  }

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    current = isLocale(saved) ? saved : DEFAULT_LOCALE;
  } catch {
    current = DEFAULT_LOCALE;
  }
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage can be unavailable; the in-memory locale still applies.
  }
}

/** Look up a message in the active locale, falling back to English. */
export function t(
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const catalog = catalogs[getLocale()] || en;
  let message: string = catalog[key] ?? en[key] ?? key;
  if (vars) {
    for (const name of Object.keys(vars)) {
      message = message.split(`{${name}}`).join(String(vars[name]));
    }
  }
  return message;
}
