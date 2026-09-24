// Distance entry unit (cm or m). Everything is stored and computed in metres; only entry and the
// measuring screens use the chosen unit.

import { parseDistance } from './solver/blunders.js';

export const ENTRY_UNITS = ['cm', 'm'];

function trimZeros(s) {
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

// Metres → the string to put into the entry field (no unit), e.g. 12.45 → "1245" (cm) or "12.45" (m).
export function toEntry(metres, unit) {
    if (!Number.isFinite(metres)) return '';
    if (unit === 'cm') return trimZeros((Math.round(metres * 1000) / 10).toFixed(1));
    const s = trimZeros(metres.toFixed(3));
    return s.includes('.') && s.split('.')[1].length === 1 ? `${s}0` : s;
}

// Metres → display text with unit, e.g. "1245 cm" or "12.45 m".
export function formatDistance(metres, unit) {
    const s = toEntry(metres, unit);
    return s ? `${s} ${unit === 'cm' ? 'cm' : 'm'}` : '–';
}

// Moves the decimal point of a typed number two places left without touching its digits, so typo
// detection sees the same digit sequence: "1245" → "12.45", "85" → "0.85", "1245,5" → "12.455".
function centimetreStringToMetres(s) {
    const [int = '', frac = ''] = s.replace(',', '.').split('.');
    const digits = (int.replace(/^0+(?=\d)/, '') || '0').padStart(3, '0');
    return `${digits.slice(0, -2).replace(/^0+(?=\d)/, '')}.${digits.slice(-2)}${frac}`;
}

// Typed entry → { distance (m), raw (metre string with the typed digits) }.
export function fromEntry(text, unit) {
    const typed = String(text ?? '').trim();
    const value = parseDistance(typed);
    if (!Number.isFinite(value)) return { distance: NaN, raw: typed };
    if (unit !== 'cm') return { distance: value, raw: typed.replace(',', '.') };
    return { distance: value / 100, raw: centimetreStringToMetres(typed) };
}
