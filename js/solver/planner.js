// Suggests the measurements that would improve the point positions the most.
//
// Adding one observation with row a and variance σ² changes the covariance by (Sherman–Morrison)
//     ΔQ = −Q·a·aᵀ·Q / (σ² + aᵀ·Q·a)
// so the variance reduction of unknown p is (Q·a)_p² / (σ² + aᵀ·Q·a).
// Plan (x, y) and height (z) reductions are scored separately, each relative to its own total variance,
// because heights are usually far less certain than plan positions and would otherwise dominate.

import { rowFor, rowForMeasurement, quadForm, qTimesRow, measurementSigma } from './adjust.js';
import { kindOf, observationSigma } from './observations.js';

export function pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Marks each unknown as plan (1) or height (2).
function parameterGroups(solution) {
    const group = new Uint8Array(solution.u);
    for (const idx of solution.index.values()) {
        if (idx[0] >= 0) group[idx[0]] = 1;
        if (idx[1] >= 0) group[idx[1]] = 1;
        if (idx[2] >= 0) group[idx[2]] = 2;
    }
    return group;
}

// Total variance of plan coordinates and of heights.
export function traces(solution) {
    const group = parameterGroups(solution);
    let xy = 0;
    let z = 0;
    for (let i = 0; i < solution.u; i++) {
        const q = solution.Q[i * solution.u + i];
        if (group[i] === 1) xy += q;
        else z += q;
    }
    return { xy, z };
}

// Variance reductions of one hypothetical observation (row, σ): { xyPct, zPct, score }.
function gainOf(solution, row, sigma, group, total, zWeight) {
    const denom = sigma * sigma + quadForm(solution, row);
    const qa = qTimesRow(solution, row);
    let numXY = 0;
    let numZ = 0;
    for (let k = 0; k < qa.length; k++) {
        if (group[k] === 1) numXY += qa[k] * qa[k];
        else numZ += qa[k] * qa[k];
    }
    const xyPct = total.xy > 0 ? (100 * numXY) / denom / total.xy : 0;
    const zPct = total.z > 0 ? (100 * numZ) / denom / total.z : 0;
    return { xyPct, zPct, score: xyPct + zWeight * zPct };
}

// Lines (point pairs) the garden already uses as references for offsets or angles: [[a, b]].
export function referenceLines(measurements) {
    const out = new Map();
    const add = (a, b) => {
        if (a && b && a !== b) out.set(pairKey(a, b), a < b ? [a, b] : [b, a]);
    };
    for (const m of measurements) {
        if (m.status === 'excluded') continue;
        const k = kindOf(m);
        if (k === 'offset') add(m.from, m.fromB);
        else if (k === 'angle') {
            add(m.from, m.fromB);
            add(m.to, m.toB);
        }
    }
    return [...out.values()];
}

// Suggested offsets of points from the given lines: [{ kind: 'offset', from, fromB, to, estimate, xyPct,
// zPct, score }] best first. options: { lines: [[a, b]], tapeLength, point (only offsets of this point),
// line ([a, b]: only offsets from this line), use3D, maxResults }.
export function suggestOffsets(solution, options = {}) {
    const { lines = [], tapeLength = 30, point = null, line = null, use3D = solution.is3D, maxResults = 10 } = options;
    const group = parameterGroups(solution);
    const total = traces(solution);
    const zWeight = use3D ? 0.5 : 0;
    const out = [];
    const candidatesLines = line ? [line] : lines;
    for (const [a, b] of candidatesLines) {
        for (const p of solution.index.keys()) {
            if (p === a || p === b || (point && p !== point)) continue;
            const m = { kind: 'offset', from: a, fromB: b, to: p, distance: 1 };
            const row = rowForMeasurement(solution, m);
            if (!row || row.value > tapeLength) continue;
            const gain = gainOf(solution, row, observationSigma({ ...m, distance: row.value }, solution.settings), group, total, zWeight);
            out.push({ kind: 'offset', from: a, fromB: b, to: p, estimate: row.value, ...gain });
        }
    }
    out.sort((p, q) => q.score - p.score);
    return out.slice(0, maxResults);
}

// options: { tapeLength, blocked: Set(pairKey), use3D, heights: [..], station, maxResults }
// Returns [{ from, fromH, to, toH, estimate, xyPct, zPct, score }] best first; xyPct / zPct are the
// percentages by which the total plan / height variance would shrink.
export function suggestMeasurements(solution, options = {}) {
    const { tapeLength = 30, blocked = new Set(), use3D = solution.is3D, station = null, maxResults = 10 } = options;
    const topHeight = Math.max(0, ...(options.heights || [0, 1, 2]));
    const heightPairs = use3D && topHeight > 0 ? [[0, 0], [0, topHeight], [topHeight, 0]] : [[0, 0]];
    const group = parameterGroups(solution);
    const total = traces(solution);
    const zWeight = use3D ? 0.5 : 0;
    const names = [...solution.index.keys()];
    const out = [];

    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            const a = names[i];
            const b = names[j];
            if (station && a !== station && b !== station) continue;
            if (blocked.has(pairKey(a, b))) continue;
            let best = null;
            for (const [ha, hb] of heightPairs) {
                const from = station && b === station ? b : a;
                const to = from === a ? b : a;
                const fromH = from === a ? ha : hb;
                const toH = from === a ? hb : ha;
                const row = rowFor(solution, from, fromH, to, toH);
                if (!row || row.dist > tapeLength) continue;
                const gain = gainOf(solution, row, measurementSigma(row.dist, solution.settings), group, total, zWeight);
                if (!best || gain.score > best.score) best = { kind: 'distance', from, fromH, to, toH, estimate: row.dist, ...gain };
            }
            if (best) out.push(best);
        }
    }
    out.sort((p, q) => q.score - p.score);
    return out.slice(0, maxResults);
}

// Points that still need links before they can be placed / de-ambiguated.
// Returns [{ name, status, needed }] with needed = additional links to placed points for an unambiguous
// position (2 links place a point, the 3rd decides which mirror side it is on).
export function underdeterminedPoints(solution) {
    const out = [];
    for (const [name, p] of solution.points) {
        if (p.status === 'unplaced' || p.status === 'weak') out.push({ name, status: p.status, needed: Math.max(3 - p.links, 1) });
    }
    return out;
}
