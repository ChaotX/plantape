// Selections (a point or a line = two points) and human-readable descriptions of measurements of any kind.

import { fmt } from '../util.js';
import { formatDistance } from '../units.js';
import { kindOf } from '../solver/observations.js';

// A selection is a point name, or a line encoded as "A<TAB>B" (names never contain tabs).
const SEP = '\t';

export function lineKey(a, b) {
    return `${a}${SEP}${b}`;
}

export function isLine(key) {
    return typeof key === 'string' && key.includes(SEP);
}

export function lineEnds(key) {
    return key.split(SEP);
}

export function lineLabel(a, b) {
    return `${a}–${b}`;
}

export function selectionLabel(key) {
    return isLine(key) ? lineLabel(...lineEnds(key)) : key;
}

export function sameLine(a1, b1, a2, b2) {
    return (a1 === a2 && b1 === b2) || (a1 === b2 && b1 === a2);
}

export function selectionHas(key, name) {
    return isLine(key) ? lineEnds(key).includes(name) : key === name;
}

// Lines that can be measured from: every measured pair (active distances) and every line already used
// as a reference. [[a, b]] sorted by label.
export function availableLines(garden) {
    const out = new Map();
    const add = (a, b) => {
        if (!a || !b || a === b) return;
        const [x, y] = a < b ? [a, b] : [b, a];
        out.set(`${x}${SEP}${y}`, [x, y]);
    };
    for (const m of garden.measurements) {
        if (m.status === 'excluded') continue;
        const k = kindOf(m);
        if (k === 'distance') add(m.from, m.to);
        else {
            add(m.from, m.fromB);
            if (k === 'angle') add(m.to, m.toB);
        }
    }
    return [...out.values()].sort((p, q) => lineLabel(...p).localeCompare(lineLabel(...q)));
}

// The measured value with its unit: "1245 cm", "0 cm", "90.0°".
export function formatValue(m, unit) {
    return kindOf(m) === 'angle' ? `${fmt(m.distance, 1)}°` : formatDistance(m.distance, unit);
}

// What was measured, as plain text: "A (0.0) → B (2.0)", "A–B ⊥ P", "A–B ∠ C–D".
export function describeMeasurement(m, { heights = true } = {}) {
    const k = kindOf(m);
    if (k === 'offset') return `${lineLabel(m.from, m.fromB)} ⊥ ${m.to}`;
    if (k === 'angle') return `${lineLabel(m.from, m.fromB)} ∠ ${lineLabel(m.to, m.toB)}`;
    return heights ? `${m.from} (${fmt(m.fromH || 0, 1)}) → ${m.to} (${fmt(m.toH || 0, 1)})` : `${m.from} → ${m.to}`;
}

// Residual text: mm for lengths, degrees for angles.
export function formatResidual(m, residual) {
    if (!Number.isFinite(residual)) return '–';
    return kindOf(m) === 'angle' ? `${fmt(residual, 2)}°` : `${fmt(residual * 1000, 0)} mm`;
}

// Label of a suspect / check message: expected value in the measurement's unit.
export function formatExpected(m, value, unit) {
    return kindOf(m) === 'angle' ? `${fmt(value, 1)}°` : formatDistance(value, unit);
}
