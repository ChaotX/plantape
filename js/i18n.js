import en from '../i18n/en.js';
import hu from '../i18n/hu.js';
import { storage } from './util.js';

const TABLES = { en, hu };
export const LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'hu', label: 'Magyar' }
];

let current = storage.get('plantape:lang') || ((navigator.language || '').toLowerCase().startsWith('hu') ? 'hu' : 'en');
if (!TABLES[current]) current = 'en';

export function getLanguage() {
    return current;
}

export function setLanguage(code) {
    if (!TABLES[code]) return;
    current = code;
    storage.set('plantape:lang', code);
    document.documentElement.lang = code;
    applyTranslations(document);
}

// t('key', { name: 'A' }) → string with {name} placeholders filled in; falls back to English, then the key.
export function t(key, params = {}) {
    const template = TABLES[current][key] ?? en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? `{${k}}`));
}

export function applyTranslations(root) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = t(el.dataset.i18nTitle);
    });
}
