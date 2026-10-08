// Detection of mistyped / misread tape measurements.
//
// 1. On entry: compare a new distance with the distance predicted from the current solution.
// 2. After adjustment: Baarda data snooping on standardized residuals, iteratively removing the worst.
// In both cases the typo variants of the entered number that fit the prediction are offered as corrections.

import { solveNetwork, rowForMeasurement, quadForm } from './adjust.js';
import { kindOf, observationSigma, pointsOfMeasurement, angleDiff, normalizeAngle, toDisplayUnits } from './observations.js';

export const CRITICAL_W = 3.29; // two-sided 0.1 % test value of the normal distribution

// Inverse of the standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9).
export function normalQuantile(p) {
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const lo = 0.02425;
    if (p < lo) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - lo) return -normalQuantile(1 - p);
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Critical value for testing n standardized residuals at once: 5 % family-wise error (Bonferroni),
// but never below the classic 3.29, so small networks keep the usual per-measurement test.
export function criticalW(n) {
    if (n <= 1) return CRITICAL_W;
    return Math.max(CRITICAL_W, -normalQuantile(0.05 / (2 * n)));
}

// Kinds in order of how likely such a slip is; the first kind producing a value wins on duplicates.
export const TYPO_KINDS = ['transpose', 'decimal', 'sixNine', 'meter', 'decimeter', 'drop', 'insert', 'digit'];

export function parseDistance(raw) {
    if (typeof raw === 'number') return raw;
    const s = String(raw ?? '').trim().replace(',', '.');
    if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return NaN;
    return parseFloat(s);
}

function formatRaw(raw) {
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim().replace(',', '.');
    const n = Number(raw);
    return Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : '';
}

// All plausible typo variants of a typed distance: [{ value, kind }].
export function typoCandidates(raw) {
    const s = formatRaw(raw);
    const value = parseFloat(s);
    if (!s || !Number.isFinite(value)) return [];
    const byKind = Object.fromEntries(TYPO_KINDS.map(k => [k, []]));
    const push = (kind, v) => {
        if (Number.isFinite(v) && v > 0 && Math.abs(v - value) > 1e-9) byKind[kind].push(v);
    };
    const pushStr = (kind, str) => {
        if (/^\d*\.?\d*$/.test(str) && /\d/.test(str)) push(kind, parseFloat(str));
    };
    const chars = [...s];
    const digitPositions = chars.map((c, i) => (c >= '0' && c <= '9' ? i : -1)).filter(i => i >= 0);

    // Neighbouring digits, also across the decimal point (typed in cm, "751" is "7.51" m here).
    for (let k = 0; k + 1 < digitPositions.length; k++) {
        const i = digitPositions[k];
        const j = digitPositions[k + 1];
        if (chars[i] === chars[j]) continue;
        const c = chars.slice();
        [c[i], c[j]] = [c[j], c[i]];
        pushStr('transpose', c.join(''));
    }
    for (const f of [10, 100, 0.1, 0.01]) push('decimal', value * f);
    for (const i of digitPositions) {
        if (chars[i] === '6' || chars[i] === '9') {
            const c = chars.slice();
            c[i] = chars[i] === '6' ? '9' : '6';
            pushStr('sixNine', c.join(''));
        }
    }
    push('meter', value + 1);
    push('meter', value - 1);
    push('decimeter', value + 0.1);
    push('decimeter', value - 0.1);
    for (const i of digitPositions) pushStr('drop', s.slice(0, i) + s.slice(i + 1));
    for (let i = 0; i <= s.length; i++) {
        for (let d = 0; d <= 9; d++) pushStr('insert', s.slice(0, i) + d + s.slice(i));
    }
    for (const i of digitPositions) {
        for (let d = 0; d <= 9; d++) {
            if (String(d) === chars[i]) continue;
            const c = chars.slice();
            c[i] = String(d);
            pushStr('digit', c.join(''));
        }
    }

    const seen = new Set();
    const out = [];
    for (const kind of TYPO_KINDS) {
        for (const v of byKind[kind]) {
            const key = Math.round(v * 1e6);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ value: Math.round(v * 1e6) / 1e6, kind });
        }
    }
    return out;
}

// Typo variants of raw that agree with the predicted distance within tol, most likely first.
export function suggestCorrections(raw, predicted, tol, max = 3) {
    return typoCandidates(raw)
        .filter(c => Math.abs(c.value - predicted) <= tol)
        .map(c => ({ ...c, rank: TYPO_KINDS.indexOf(c.kind), off: Math.abs(c.value - predicted) }))
        .sort((a, b) => a.rank - b.rank || a.off - b.off)
        .slice(0, max)
        .map(({ value, kind }) => ({ value, kind }));
}

// Predicted value of a measurement from the solution, in display units (m, or ° for angles):
// { predicted, sigmaPred, sigma (a priori σ of the measurement) } or null when a point is not placed.
function predict(solution, m) {
    const row = rowForMeasurement(solution, m);
    if (!row) return null;
    return {
        predicted: row.value,
        sigmaPred: toDisplayUnits(m, Math.sqrt(quadForm(solution, row))),
        sigma: toDisplayUnits(m, observationSigma(m, solution.settings))
    };
}

// Measured minus predicted, in display units (angles are compared modulo 180°).
function deviationOf(m, predicted) {
    return kindOf(m) === 'angle' ? angleDiff(m.distance, predicted) : m.distance - predicted;
}

// Likely corrections of a value that does not fit. Angles: the mirror value 180° − θ (the shape was the
// other way round when it was saved); distances and offsets: typing slips.
function corrections(m, predicted, tol) {
    if (kindOf(m) !== 'angle') return suggestCorrections(m.raw ?? m.distance, predicted, tol);
    const mirror = normalizeAngle(180 - m.distance);
    return Math.abs(angleDiff(mirror, predicted)) <= tol && Math.abs(angleDiff(mirror, m.distance)) > 1e-9 ? [{ value: mirror, kind: 'mirror' }] : [];
}

// Checks a new measurement (any kind: { kind, from, fromB, fromH, to, toB, toH, distance, raw? }) against the
// current solution. Returns { status: 'ok' | 'suspect' | 'unknown', reason?, predicted?, tol?, deviation?,
// suggestions? }, values in display units.
export function checkMeasurement(solution, m, { k = CRITICAL_W, maxPredSigma = 0.25, maxPredSigmaAngle = 10 } = {}) {
    const pts = pointsOfMeasurement(m).map(n => solution.points.get(n));
    if (pts.some(p => !p?.placed)) return { status: 'unknown', reason: 'unplaced' };
    if (pts.some(p => p.status === 'weak')) return { status: 'unknown', reason: 'weak' };
    const p = predict(solution, m);
    const limit = kindOf(m) === 'angle' ? maxPredSigmaAngle : maxPredSigma;
    if (!p || !(p.sigmaPred <= limit)) return { status: 'unknown', reason: 'uncertain' };
    const tol = k * Math.sqrt(p.sigma * p.sigma + p.sigmaPred * p.sigmaPred);
    const deviation = deviationOf(m, p.predicted);
    if (Math.abs(deviation) <= tol) return { status: 'ok', predicted: p.predicted, tol, deviation };
    return { status: 'suspect', predicted: p.predicted, tol, deviation, suggestions: corrections(m, p.predicted, tol) };
}

// Iterative data snooping. Returns { solution, initial, suspects: [{ id, w, r, predicted, tol, suggestions }] }
// where solution is computed without the suspects and initial with all active measurements.
export function snoop(input, { critical = null, maxRemovals = 5, minRedundancy = 0.05, solve = solveNetwork } = {}) {
    const exclude = new Set();
    const found = [];
    const initial = solve(input, { exclude });
    let solution = initial;
    if (critical === null) {
        let tested = 0;
        for (const r of initial.measurements.values()) if (r.used && r.w !== null && r.r >= minRedundancy) tested++;
        critical = criticalW(tested);
    }
    for (let iter = 0; iter < maxRemovals; iter++) {
        let worst = null;
        for (const [id, r] of solution.measurements) {
            if (!r.used || r.w === null || r.r < minRedundancy) continue;
            if (!worst || Math.abs(r.w) > Math.abs(worst.w)) worst = { id, w: r.w, r: r.r };
        }
        if (!worst || Math.abs(worst.w) <= critical) break;
        found.push(worst);
        exclude.add(worst.id);
        solution = solve(input, { exclude });
    }
    const byId = new Map(input.measurements.map(m => [m.id, m]));
    const suspects = found.map(f => {
        const m = byId.get(f.id);
        const p = predict(solution, m);
        if (!p) return { ...f, predicted: null, suggestions: [] };
        const tol = CRITICAL_W * Math.sqrt(p.sigma * p.sigma + p.sigmaPred * p.sigmaPred);
        return { ...f, predicted: p.predicted, tol, suggestions: corrections(m, p.predicted, tol) };
    });
    return { solution, initial, suspects };
}
