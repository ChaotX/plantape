// Start values for points the one-at-a-time placement cannot reach. Readings can fix a group of points only
// together: a point whose second reading is an angle or a distance from a line through a point that is not
// placed yet waits for that point, which may wait for the first (a rectangle tied to a fence by angles, for
// instance). Such a group is solved jointly, starting from the sketch, which also picks the solution meant
// when the readings allow several. A point is kept only when the readings fix it.

import { observe, observationSigma, pointsOfMeasurement } from './observations.js';
import { cholesky, cholSolve } from './linalg.js';

// measurements: usable readings. placed: Map name → {x, y} in the placement frame; the points fixed here are
// added to it. seeds: Map name → {x, y} start positions (sketches mapped into that frame).
// Returns the names added, in an order where each comes after the points it was solved with.
export function placeFromSeeds(measurements, placed, seeds, settings) {
    let free = [...seeds.keys()].filter(n => !placed.has(n));
    while (free.length) {
        const freeSet = new Set(free);
        const rows = measurements.filter(m => {
            const names = pointsOfMeasurement(m);
            return names.every(n => placed.has(n) || freeSet.has(n)) && names.some(n => freeSet.has(n));
        });
        // A point needs at least two readings; drop the ones that have fewer and look again.
        const count = new Map(free.map(n => [n, 0]));
        for (const m of rows) for (const n of pointsOfMeasurement(m)) if (count.has(n)) count.set(n, count.get(n) + 1);
        const thin = free.filter(n => count.get(n) < 2);
        if (thin.length) {
            free = free.filter(n => count.get(n) >= 2);
            continue;
        }
        const res = solveJointly(rows, placed, seeds, free, settings);
        if (res.ok) {
            for (const [n, p] of res.pos) placed.set(n, p);
            return free;
        }
        free = free.filter(n => n !== res.loose); // not fixed by the readings: leave it waiting
    }
    return [];
}

// Gauss–Newton with Levenberg–Marquardt damping over the plan positions of `free`, the placed points held.
// Returns { ok, pos } or { ok: false, loose: a point the readings do not fix }.
function solveJointly(rows, placed, seeds, free, settings) {
    const col = new Map(free.map((n, i) => [n, 2 * i]));
    const u = 2 * free.length;
    const pos = new Map(free.map(n => [n, { ...seeds.get(n) }]));
    const at = n => {
        const p = pos.get(n) || placed.get(n);
        return { x: p.x, y: p.y, z: 0 };
    };
    const sigmas = rows.map(m => observationSigma(m, settings));
    const linearise = () => {
        const N = new Float64Array(u * u);
        const g = new Float64Array(u);
        let cost = 0;
        rows.forEach((m, i) => {
            const r = observe(m, at);
            const w = 1 / (sigmas[i] * sigmas[i]);
            const a = new Map();
            for (const [n, k, v] of r.partials) if (k < 2 && col.has(n)) a.set(col.get(n) + k, (a.get(col.get(n) + k) || 0) + v);
            for (const [j, vj] of a) {
                g[j] += w * vj * r.residual;
                for (const [k, vk] of a) N[j * u + k] += w * vj * vk;
            }
            cost += w * r.residual * r.residual;
        });
        return { N, g, cost };
    };
    let cur = linearise();
    let lambda = 1e-3;
    for (let iter = 0; iter < 100; iter++) {
        const A = Float64Array.from(cur.N);
        for (let j = 0; j < u; j++) A[j * u + j] += lambda * (cur.N[j * u + j] + 1e-9);
        const L = cholesky(A, u);
        if (!L) {
            lambda *= 10;
            continue;
        }
        const dx = cholSolve(L, u, cur.g);
        const before = new Map([...pos].map(([n, p]) => [n, { ...p }]));
        for (const [n, c] of col) {
            const p = pos.get(n);
            p.x += dx[c];
            p.y += dx[c + 1];
        }
        const next = linearise();
        if (next.cost <= cur.cost) {
            cur = next;
            lambda = Math.max(lambda / 3, 1e-9);
            if (Math.max(...dx.map(Math.abs)) < 1e-7) break;
        } else {
            for (const [n, p] of before) pos.set(n, p);
            lambda *= 4;
            if (lambda > 1e8) break;
        }
    }
    // Fixed by the readings? The normal matrix, scaled to a unit diagonal, must be clearly positive definite.
    const loose = looseColumn(cur.N, u);
    if (loose >= 0) return { ok: false, loose: free[Math.floor(loose / 2)] };
    return { ok: true, pos };
}

// Index of a column the readings leave (nearly) free, or −1.
function looseColumn(N, u) {
    const d = Array.from({ length: u }, (_, j) => Math.sqrt(N[j * u + j]));
    if (d.some(v => !(v > 0))) return d.findIndex(v => !(v > 0));
    const S = new Float64Array(u * u);
    for (let i = 0; i < u; i++) for (let j = 0; j < u; j++) S[i * u + j] = N[i * u + j] / (d[i] * d[j]);
    // Cholesky with a pivot threshold: a tiny pivot means that column is a combination of the others.
    const L = new Float64Array(u * u);
    for (let j = 0; j < u; j++) {
        let sum = S[j * u + j];
        for (let k = 0; k < j; k++) sum -= L[j * u + k] * L[j * u + k];
        if (!(sum > 1e-8)) return j;
        const ljj = Math.sqrt(sum);
        L[j * u + j] = ljj;
        for (let i = j + 1; i < u; i++) {
            let s = S[i * u + j];
            for (let k = 0; k < j; k++) s -= L[i * u + k] * L[j * u + k];
            L[i * u + j] = s / ljj;
        }
    }
    return -1;
}
