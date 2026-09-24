// Weighted least-squares adjustment of a tape-distance network (Levenberg–Marquardt).
//
// Unknowns: ground position P = (x, y, z) of every placed point, z vertical.
// Observation: distance between the tape ends, held fromH / toH metres above the ground points:
//     d = |(P_to + toH·ez) − (P_from + fromH·ez)|
// Datum: origin = (0,0,0), axis point has y = 0, side point at y > 0 (or y < 0 when flipped).
// Only measurements with different tape heights at the two ends make z observable. To keep heights of
// points without such measurements bounded (and from leaking into x/y through the linearisation), every
// measured pair (unless their height difference is measured) gets a weak terrain-smoothness pseudo-observation
// z_to − z_from ≈ 0 with
//     σ = slopeSigma0 + slopeSigma · horizontal distance.

import { cholesky, cholSolve, cholInverse, ellipse2 } from './linalg.js';
import { initialPlacement } from './initial.js';

export const DEFAULT_SOLVER_SETTINGS = {
    sigmaConst: 0.005,
    sigmaRel: 0.002,
    slopeSigma0: 0.1,     // smoothness prior: constant part [m]
    slopeSigma: 0.15,     // smoothness prior: expected terrain slope (15 %)
    origin: '',
    axis: '',
    side: '',
    flip: false
};

export function measurementSigma(distance, settings) {
    return settings.sigmaConst + settings.sigmaRel * Math.abs(distance);
}

export function isActive(m) {
    return (m.status || 'active') !== 'excluded';
}

// input: { points: [{name}], measurements: [{id, from, fromH, to, toH, distance, status}], settings }
// options.exclude: Set of measurement ids to leave out in addition to excluded ones.
export function solveNetwork(input, options = {}) {
    const settings = { ...DEFAULT_SOLVER_SETTINGS, ...(input.settings || {}) };
    const exclude = options.exclude || new Set();
    const warnings = [];

    const usable = input.measurements.filter(m =>
        isActive(m) && !exclude.has(m.id) && m.from && m.to && m.from !== m.to &&
        Number.isFinite(m.distance) && m.distance > 0);

    const init = initialPlacement(usable, settings);
    const placed = init.placed;
    if (settings.flip) for (const p of placed.values()) p.y = -p.y;

    const used = usable.filter(m => placed.has(m.from) && placed.has(m.to));
    const is3D = used.some(m => Math.abs((m.toH || 0) - (m.fromH || 0)) > 1e-9);

    // Parameter indexing: -1 marks a coordinate fixed by the datum.
    const index = new Map();
    let u = 0;
    for (const name of init.order) {
        if (name === init.origin) index.set(name, [-1, -1, -1]);
        else if (name === init.axis) index.set(name, [u++, -1, u++]);
        else index.set(name, [u++, u++, u++]);
    }
    const x = new Float64Array(u);
    for (const [name, idx] of index) {
        const p = placed.get(name);
        if (idx[0] >= 0) x[idx[0]] = p.x;
        if (idx[1] >= 0) x[idx[1]] = p.y;
    }

    const coord = (vec, idx, k) => (idx[k] >= 0 ? vec[idx[k]] : 0);
    const obs = used.map(m => {
        const sigma = measurementSigma(m.distance, settings);
        return { m, a: index.get(m.from), b: index.get(m.to), sigma, weight: 1 / (sigma * sigma) };
    });
    // Groups of points whose relative heights are measured: connected by measurements with a tape
    // height difference (union–find). Independent of the datum.
    const parent = new Map();
    const find = n => {
        while (parent.has(n) && parent.get(n) !== n) n = parent.get(n);
        return n;
    };
    for (const o of obs) {
        if (Math.abs((o.m.toH || 0) - (o.m.fromH || 0)) < 1e-9) continue;
        for (const n of [o.m.from, o.m.to]) if (!parent.has(n)) parent.set(n, n);
        parent.set(find(o.m.from), find(o.m.to));
    }
    const sameHeightGroup = (a, b) => parent.has(a) && parent.has(b) && find(a) === find(b);

    // One smoothness pseudo-observation per distinct measured pair, unless both heights are measured.
    const smooth = [];
    const seenPairs = new Set();
    for (const o of obs) {
        const key = o.m.from < o.m.to ? `${o.m.from}|${o.m.to}` : `${o.m.to}|${o.m.from}`;
        if (seenPairs.has(key) || sameHeightGroup(o.m.from, o.m.to)) continue;
        seenPairs.add(key);
        const pa = placed.get(o.m.from);
        const pb = placed.get(o.m.to);
        const sigma = settings.slopeSigma0 + settings.slopeSigma * Math.hypot(pb.x - pa.x, pb.y - pa.y);
        const za = o.a[2];
        const zb = o.b[2];
        if (za >= 0 || zb >= 0) smooth.push({ za, zb, weight: 1 / (sigma * sigma) });
    }
    const zOf = (vec, i) => (i >= 0 ? vec[i] : 0);
    initialHeights();

    // Starting heights: with the trilaterated horizontal positions fixed, each measurement with a tape height
    // difference gives Δz = √(d² − h²) − Δh directly; solve those together with the smoothness terms as a
    // linear least-squares problem. Starting from z = 0 instead can end in a folded (tilted) local minimum.
    function initialHeights() {
        const zIdx = [];
        for (const idx of index.values()) if (idx[2] >= 0) zIdx.push(idx[2]);
        if (!zIdx.length || !is3D) return;
        const pos = new Map(zIdx.map((iz, k) => [iz, k]));
        const n = zIdx.length;
        const N = new Float64Array(n * n);
        const g = new Float64Array(n);
        const add = (ia, ib, value, w) => { // observation z_b − z_a = value
            const ka = ia >= 0 ? pos.get(ia) : -1;
            const kb = ib >= 0 ? pos.get(ib) : -1;
            if (kb >= 0) { N[kb * n + kb] += w; g[kb] += w * value; }
            if (ka >= 0) { N[ka * n + ka] += w; g[ka] -= w * value; }
            if (ka >= 0 && kb >= 0) { N[ka * n + kb] -= w; N[kb * n + ka] -= w; }
        };
        for (const s of smooth) add(s.za, s.zb, 0, s.weight);
        for (const o of obs) {
            const dh = (o.m.toH || 0) - (o.m.fromH || 0);
            if (Math.abs(dh) < 1e-9) continue;
            const pa = placed.get(o.m.from);
            const pb = placed.get(o.m.to);
            const h = Math.hypot(pb.x - pa.x, pb.y - pa.y);
            const vz2 = o.m.distance * o.m.distance - h * h;
            if (vz2 <= 0) continue;
            const vz = Math.sign(dh) * Math.sqrt(vz2);
            const sigma = Math.max(o.sigma * o.m.distance / Math.abs(vz), 0.02) + 0.05 * h / Math.abs(vz);
            add(o.a[2], o.b[2], vz - dh, 1 / (sigma * sigma));
        }
        const L = cholesky(N, n);
        if (!L) return;
        const z = cholSolve(L, n, g);
        zIdx.forEach((iz, k) => { x[iz] = z[k]; });
    }

    // Geometry of one observation at parameter vector vec: computed distance and unit vector from → to.
    function geometry(o, vec) {
        const vx = coord(vec, o.b, 0) - coord(vec, o.a, 0);
        const vy = coord(vec, o.b, 1) - coord(vec, o.a, 1);
        const vz = coord(vec, o.b, 2) + (o.m.toH || 0) - coord(vec, o.a, 2) - (o.m.fromH || 0);
        const len = Math.hypot(vx, vy, vz);
        if (len < 1e-12) return { len, ux: 1, uy: 0, uz: 0 };
        return { len, ux: vx / len, uy: vy / len, uz: vz / len };
    }

    function costOf(vec) {
        let c = 0;
        for (const o of obs) {
            const r = o.m.distance - geometry(o, vec).len;
            c += o.weight * r * r;
        }
        for (const s of smooth) c += s.weight * (zOf(vec, s.zb) - zOf(vec, s.za)) ** 2;
        return c;
    }

    // Normal equations N·δ = g. With newton = true, N also contains the second-order term −w·r·∇²d
    // (∇²d = (I − u·uᵀ)/d for each end): heights enter ground-to-ground distances only quadratically, and
    // without this curvature Gauss–Newton crawls along the nearly flat height directions.
    function normalEquations(vec, newton = false) {
        const N = new Float64Array(u * u);
        const g = new Float64Array(u);
        const diagGN = new Float64Array(u);
        for (const o of obs) {
            const geo = geometry(o, vec);
            const r = o.m.distance - geo.len;
            const ids = [o.b[0], o.b[1], o.b[2], o.a[0], o.a[1], o.a[2]];
            const vals = [geo.ux, geo.uy, geo.uz, -geo.ux, -geo.uy, -geo.uz];
            const unit = [geo.ux, geo.uy, geo.uz];
            const curv = newton && geo.len > 1e-9 ? (-o.weight * r) / geo.len : 0;
            for (let p = 0; p < 6; p++) {
                const ip = ids[p];
                if (ip < 0) continue;
                g[ip] += o.weight * vals[p] * r;
                diagGN[ip] += o.weight * vals[p] * vals[p];
                for (let q = 0; q < 6; q++) {
                    const iq = ids[q];
                    if (iq < 0) continue;
                    let h = o.weight * vals[p] * vals[q];
                    if (curv) {
                        const kp = p % 3;
                        const kq = q % 3;
                        const sign = (p < 3) === (q < 3) ? 1 : -1;
                        h += curv * sign * ((kp === kq ? 1 : 0) - unit[kp] * unit[kq]);
                    }
                    N[ip * u + iq] += h;
                }
            }
        }
        for (const s of smooth) {
            const r = zOf(vec, s.za) - zOf(vec, s.zb); // pseudo-observation 0 minus computed (z_b − z_a)
            if (s.zb >= 0) {
                g[s.zb] += s.weight * r;
                N[s.zb * u + s.zb] += s.weight;
            }
            if (s.za >= 0) {
                g[s.za] -= s.weight * r;
                N[s.za * u + s.za] += s.weight;
            }
            if (s.za >= 0 && s.zb >= 0) {
                N[s.za * u + s.zb] -= s.weight;
                N[s.zb * u + s.za] -= s.weight;
            }
            if (s.za >= 0) diagGN[s.za] += s.weight;
            if (s.zb >= 0) diagGN[s.zb] += s.weight;
        }
        return { N, g, diagGN };
    }

    // Levenberg–Marquardt iterations.
    let lambda = 1e-3;
    let cost = costOf(x);
    let iterations = 0;
    let converged = u === 0;
    while (!converged && iterations < 100) {
        iterations++;
        const { N, g, diagGN } = normalEquations(x, true);
        let accepted = false;
        for (let attempt = 0; attempt < 12 && !accepted; attempt++) {
            const A = N.slice();
            for (let i = 0; i < u; i++) A[i * u + i] += lambda * Math.max(diagGN[i], 1e-9);
            const L = cholesky(A, u);
            if (!L) {
                lambda *= 10;
                continue;
            }
            const delta = cholSolve(L, u, g);
            const trial = x.slice();
            for (let i = 0; i < u; i++) trial[i] += delta[i];
            const trialCost = costOf(trial);
            if (trialCost <= cost) {
                let maxStep = 0;
                for (let i = 0; i < u; i++) maxStep = Math.max(maxStep, Math.abs(delta[i]));
                const relChange = (cost - trialCost) / Math.max(cost, 1e-30);
                x.set(trial);
                cost = trialCost;
                lambda = Math.max(lambda / 10, 1e-12);
                accepted = true;
                if (maxStep < 1e-7 || relChange < 1e-10) converged = true;
            } else {
                lambda *= 10;
            }
        }
        if (!accepted) converged = true; // cannot improve any further
    }

    // Covariance of the unknowns (a priori, σ0 = 1).
    let Q = new Float64Array(0);
    if (u > 0) {
        const { N } = normalEquations(x);
        let L = cholesky(N, u);
        if (!L) {
            let maxDiag = 0;
            for (let i = 0; i < u; i++) maxDiag = Math.max(maxDiag, N[i * u + i]);
            for (let i = 0; i < u; i++) N[i * u + i] += 1e-10 * maxDiag;
            L = cholesky(N, u);
            warnings.push('weakGeometry');
        }
        Q = L ? cholInverse(L, u) : new Float64Array(u * u).fill(NaN);
    }

    const solution = { index, x, Q, u, settings, is3D, datum: { origin: init.origin, axis: init.axis, side: settings.side } };

    // Per-measurement statistics: residual, redundancy number and Baarda's standardized residual.
    const measurementResults = new Map();
    let sumV2 = 0;
    let sumR = 0;
    for (const o of obs) {
        const row = rowFor(solution, o.m.from, o.m.fromH, o.m.to, o.m.toH);
        const v = o.m.distance - row.dist;
        const varPred = quadForm(solution, row);
        const qvv = Math.max(o.sigma * o.sigma - varPred, 0);
        const r = qvv / (o.sigma * o.sigma);
        const w = r > 0.01 ? v / Math.sqrt(qvv) : null;
        sumV2 += o.weight * v * v;
        sumR += r;
        measurementResults.set(o.m.id, { used: true, computed: row.dist, residual: v, sigma: o.sigma, sigmaPred: Math.sqrt(varPred), r, w });
    }
    for (const m of input.measurements) {
        if (!measurementResults.has(m.id)) measurementResults.set(m.id, { used: false });
    }

    // Per-point results.
    const linkSets = new Map();
    for (const m of usable) {
        if (!linkSets.has(m.from)) linkSets.set(m.from, new Set());
        if (!linkSets.has(m.to)) linkSets.set(m.to, new Set());
        linkSets.get(m.from).add(m.to);
        linkSets.get(m.to).add(m.from);
    }
    const pointResults = new Map();
    const allNames = new Set([...input.points.map(p => p.name), ...linkSets.keys()]);
    for (const name of allNames) {
        const links = linkSets.get(name) || new Set();
        const placedLinks = [...links].filter(n => index.has(n)).length;
        const idx = index.get(name);
        if (!idx) {
            pointResults.set(name, { placed: false, status: 'unplaced', links: placedLinks });
            continue;
        }
        const qv = (i, j) => (i >= 0 && j >= 0 ? Q[i * u + j] : 0);
        const cxx = qv(idx[0], idx[0]);
        const cyy = qv(idx[1], idx[1]);
        const cxy = qv(idx[0], idx[1]);
        const czz = qv(idx[2], idx[2]);
        let status;
        if (name === init.origin || name === init.axis) status = 'datum';
        else if (placedLinks >= 3 || (name === settings.side && placedLinks >= 2)) status = 'ok';
        else status = 'weak';
        pointResults.set(name, {
            placed: true,
            status,
            zMeasured: parent.has(name),
            links: placedLinks,
            x: coord(x, idx, 0),
            y: coord(x, idx, 1),
            z: coord(x, idx, 2),
            sx: Math.sqrt(cxx),
            sy: Math.sqrt(cyy),
            sz: Math.sqrt(czz),
            sxy: Math.sqrt(cxx + cyy),
            ellipse: ellipse2(cxx, cxy, cyy)
        });
    }

    return {
        ...solution,
        points: pointResults,
        measurements: measurementResults,
        s0: sumR > 0.5 ? Math.sqrt(sumV2 / sumR) : null,
        redundancy: sumR,
        iterations,
        converged,
        warnings
    };
}

// Linearised observation row for a (possibly hypothetical) measurement between two placed points.
// Returns { dist, ids: [6], vals: [6] } or null when a point is not placed.
export function rowFor(solution, from, fromH, to, toH) {
    const a = solution.index.get(from);
    const b = solution.index.get(to);
    if (!a || !b) return null;
    const c = (idx, k) => (idx[k] >= 0 ? solution.x[idx[k]] : 0);
    const vx = c(b, 0) - c(a, 0);
    const vy = c(b, 1) - c(a, 1);
    const vz = c(b, 2) + (toH || 0) - c(a, 2) - (fromH || 0);
    const dist = Math.hypot(vx, vy, vz);
    const ux = dist > 1e-12 ? vx / dist : 1;
    const uy = dist > 1e-12 ? vy / dist : 0;
    const uz = dist > 1e-12 ? vz / dist : 0;
    return { dist, ids: [b[0], b[1], b[2], a[0], a[1], a[2]], vals: [ux, uy, uz, -ux, -uy, -uz] };
}

// aᵀ·Q·a for a sparse row.
export function quadForm(solution, row) {
    const { Q, u } = solution;
    let s = 0;
    for (let p = 0; p < 6; p++) {
        const ip = row.ids[p];
        if (ip < 0) continue;
        for (let q = 0; q < 6; q++) {
            const iq = row.ids[q];
            if (iq < 0) continue;
            s += row.vals[p] * row.vals[q] * Q[ip * u + iq];
        }
    }
    return Math.max(s, 0);
}

// Q·a for a sparse row (dense result of length u).
export function qTimesRow(solution, row) {
    const { Q, u } = solution;
    const out = new Float64Array(u);
    for (let p = 0; p < 6; p++) {
        const ip = row.ids[p];
        if (ip < 0) continue;
        const v = row.vals[p];
        const base = ip * u;
        for (let i = 0; i < u; i++) out[i] += Q[base + i] * v;
    }
    return out;
}
