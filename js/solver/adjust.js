// Weighted least-squares adjustment of a tape-distance network (Levenberg–Marquardt).
//
// Unknowns: ground position P = (x, y, z) of every placed point, z vertical.
// Observations (see observations.js): distances between the tape ends, held fromH / toH metres above the
// ground points, d = |(P_to + toH·ez) − (P_from + fromH·ez)|; horizontal offsets of a point from a line
// (fence, wall); angles between two lines in the plan.
// Datum: origin = (0,0,0), axis point has y = 0, side point at y > 0 (or y < 0 when flipped).
// Only distances with different tape heights at the two ends make z observable. To keep heights of
// points without such measurements bounded (and from leaking into x/y through the linearisation), every
// measured pair (unless their height difference is measured) gets a weak terrain-smoothness pseudo-observation
// z_to − z_from ≈ 0 with
//     σ = slopeSigma0 + slopeSigma · horizontal distance.

import { cholesky, cholSolve, cholInverse, ellipse2 } from './linalg.js';
import { initialPlacement, robustFitSimilarity, sketchOf } from './initial.js';
import { observe, kindOf, observationSigma, isValidMeasurement, pointsOfMeasurement, toDisplayUnits, normalizeAngle, isRule } from './observations.js';

export const DEFAULT_SOLVER_SETTINGS = {
    sigmaConst: 0.005,
    sigmaRel: 0.002,
    lineSigma: 0.01,      // offsets from a line: straightness of the fence / wall [m]
    angleSigma: 1,        // angles between lines [°]
    exactRules: true,     // square corners, parallels and "on the line" held exactly (observations.js)
    slopeSigma0: 0.1,     // smoothness prior: constant part [m]
    slopeSigma: 0.15,     // smoothness prior: expected terrain slope (15 %)
    origin: '',
    axis: '',
    side: '',
    flip: false
};

// The pull of each point towards its sketch (mapped by a fitted similarity): strong enough to keep what the
// readings leave free where it was drawn, far too weak to bend what they fix (5 mm readings weigh 10⁵ times
// more). For the reported uncertainties it is made negligible, so a free point shows as free.
const SKETCH_SIGMA = 2; // m
const SKETCH_SIGMA_REPORT = 1000; // m
const PIN_SIGMA = 30; // m: the last phase's hold on where the points are (see levenbergMarquardt below)
// Plan uncertainty above which a computed point counts as not fixed by the readings (planner.js WEAK_SXY).
const FREE_SXY = 0.5; // m

export function measurementSigma(distance, settings) {
    return settings.sigmaConst + settings.sigmaRel * Math.abs(distance);
}

export function isActive(m) {
    return (m.status || 'active') !== 'excluded';
}

function pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Key of the reading a measurement gives; repeated readings of the same thing share it.
function readingKey(m) {
    const k = kindOf(m);
    if (k === 'distance') return `d|${pairKey(m.from, m.to)}`;
    if (k === 'offset') return `o|${m.to}|${pairKey(m.from, m.fromB)}`;
    const l1 = pairKey(m.from, m.fromB);
    const l2 = pairKey(m.to, m.toB);
    return `a|${l1 < l2 ? `${l1}|${l2}` : `${l2}|${l1}`}`;
}

// Point pairs whose heights a measurement ties together (for the terrain-smoothness prior).
function heightPairs(m) {
    const k = kindOf(m);
    if (k === 'distance') return [[m.from, m.to]];
    if (k === 'offset') return [[m.from, m.to], [m.fromB, m.to]];
    return [[m.from, m.fromB], [m.to, m.toB]];
}

// Start positions from the sketch for points with readings that the placement could not fix (they wait for
// each other, or the readings leave them free), and the sketch anchors: [{ name, s }] with s the sketch in the
// orientation of the placed frame, plus the similarity { a, b, tx, ty } mapping it there. Adds the started
// points to placed and order. Returns null when fewer than two placed points have a sketch.
function startFromSketch(placed, order, usable, points, settings) {
    const sketches = new Map();
    for (const p of points) {
        const sk = sketchOf(p);
        if (sk) sketches.set(p.name, sk);
    }
    const pairs = [...placed].filter(([n]) => sketches.has(n)).map(([n, w]) => ({ s: sketches.get(n), w }));
    if (pairs.length < 2) return null;
    // The placed frame may be a mirror image of the sketch (side point, "mirror the drawing").
    const flipY = q => ({ x: q.x, y: -q.y });
    const asIs = robustFitSimilarity(pairs);
    const mirrored = robustFitSimilarity(pairs.map(({ s: sk, w }) => ({ s: flipY(sk), w })));
    const mirror = pairs.length >= 3 ? mirrored.sse < asIs.sse - 1e-9 : !!settings.flip;
    const T = mirror ? mirrored : asIs;
    const oriented = sk => (mirror ? flipY(sk) : sk);
    const withReadings = new Set(usable.flatMap(pointsOfMeasurement));
    for (const [name, sk] of sketches) {
        if (placed.has(name) || !withReadings.has(name)) continue;
        placed.set(name, T.apply(oriented(sk)));
        order.push(name);
    }
    const t = T.apply({ x: 0, y: 0 });
    const e = T.apply({ x: 1, y: 0 });
    const anchors = [...placed.keys()].filter(n => sketches.has(n)).map(name => ({ name, s: oriented(sketches.get(name)) }));
    return { anchors, sim: { a: e.x - t.x, b: e.y - t.y, tx: t.x, ty: t.y } };
}

// input: { prefer?: name of a point just dragged (its sketch wins mirror choices), points: [{name, sketchX?, sketchY?}], measurements: [{id, kind, from, fromB, fromH, to, toB, toH,
// distance, status}], settings }
// options.exclude: Set of measurement ids to leave out in addition to excluded ones.
export function solveNetwork(input, options = {}) {
    const settings = { ...DEFAULT_SOLVER_SETTINGS, ...(input.settings || {}) };
    const exclude = options.exclude || new Set();
    const warnings = [];

    const usable = input.measurements.filter(m => isActive(m) && !exclude.has(m.id) && isValidMeasurement(m));

    const init = initialPlacement(usable, settings, input.points || [], input.prefer || null);
    const placed = init.placed;
    if (settings.flip) for (const p of placed.values()) p.y = -p.y;

    const order = [...init.order];
    const sketched = startFromSketch(placed, order, usable, input.points || [], settings);

    const used = usable.filter(m => pointsOfMeasurement(m).every(n => placed.has(n)));
    const hasDh = m => kindOf(m) === 'distance' && Math.abs((m.toH || 0) - (m.fromH || 0)) > 1e-9;
    const is3D = used.some(hasDh);

    // Parameter indexing: -1 marks a coordinate fixed by the datum.
    const index = new Map();
    let u = 0;
    for (const name of order) {
        if (name === init.origin) index.set(name, [-1, -1, -1]);
        else if (name === init.axis) index.set(name, [u++, -1, u++]);
        else index.set(name, [u++, u++, u++]);
    }
    // The sketch similarity (a, b, tx, ty) follows the point unknowns; it exists only with sketch anchors.
    const simAt = u;
    const nu = sketched ? u + 4 : u; // all unknowns
    const x = new Float64Array(nu);
    for (const [name, idx] of index) {
        const p = placed.get(name);
        if (idx[0] >= 0) x[idx[0]] = p.x;
        if (idx[1] >= 0) x[idx[1]] = p.y;
    }
    if (sketched) x.set([sketched.sim.a, sketched.sim.b, sketched.sim.tx, sketched.sim.ty], simAt);
    // Pull towards the sketch: x − (a·sx − b·sy + tx) ≈ 0 and y − (b·sx + a·sy + ty) ≈ 0 for every anchor.
    const pulls = sketched ? sketched.anchors.map(({ name, s: sk }) => ({ idx: index.get(name), s: sk })) : [];
    let pullWeight = 1 / (SKETCH_SIGMA * SKETCH_SIGMA);
    // Instead of the sketch, the last phase pins every plan unknown (and the similarity) lightly to where it is.
    let pins = null;
    const pinIds = [];
    for (const idx of index.values()) for (const k of [0, 1]) if (idx[k] >= 0) pinIds.push(idx[k]);
    if (sketched) pinIds.push(simAt, simAt + 1, simAt + 2, simAt + 3);
    const pullRows = vec => (pins ? pinIds.map(i => ({ r: pins[i] - vec[i], ids: [i], vals: [1] })) : pulls.flatMap(({ idx, s: sk }) => {
        const [a, b, tx, ty] = vec.subarray(simAt, simAt + 4);
        const px = idx[0] >= 0 ? vec[idx[0]] : 0;
        const py = idx[1] >= 0 ? vec[idx[1]] : 0;
        // residual = 0 − computed; partials of computed
        return [
            { r: a * sk.x - b * sk.y + tx - px, ids: [idx[0], simAt, simAt + 1, simAt + 2], vals: [1, -sk.x, sk.y, -1] },
            { r: b * sk.x + a * sk.y + ty - py, ids: [idx[1], simAt, simAt + 1, simAt + 3], vals: [1, -sk.y, -sk.x, -1] }
        ];
    }));

    const coord = (vec, idx, k) => (idx[k] >= 0 ? vec[idx[k]] : 0);
    const pointAt = vec => name => {
        const idx = index.get(name);
        return { x: coord(vec, idx, 0), y: coord(vec, idx, 1), z: coord(vec, idx, 2) };
    };
    const obs = used.map(m => {
        const sigma = observationSigma(m, settings);
        const soft = observationSigma(m, { ...settings, exactRules: false });
        return { m, kind: kindOf(m), sigma, weight: 1 / (sigma * sigma), exactWeight: 1 / (sigma * sigma), softWeight: 1 / (soft * soft) };
    });
    // Rules held exactly make the equations badly conditioned far from the solution, so they are first solved
    // with the tolerance of an ordinary reading, then tightened.
    const ruleWeights = exact => {
        for (const o of obs) o.weight = exact ? o.exactWeight : o.softWeight;
    };
    // Linearised row of an observation at vec: { res, ids, vals, unit } (unit vector: distances only).
    const rowAt = (o, vec) => {
        const r = observe(o.m, pointAt(vec));
        return { res: r.residual, ids: r.partials.map(([n, k]) => index.get(n)[k]), vals: r.partials.map(p => p[2]), unit: r.unit };
    };

    // Groups of points whose relative heights are measured: connected by measurements with a tape
    // height difference (union–find). Independent of the datum.
    const parent = new Map();
    const find = n => {
        while (parent.has(n) && parent.get(n) !== n) n = parent.get(n);
        return n;
    };
    for (const o of obs) {
        if (!hasDh(o.m)) continue;
        for (const n of [o.m.from, o.m.to]) if (!parent.has(n)) parent.set(n, n);
        parent.set(find(o.m.from), find(o.m.to));
    }
    const sameHeightGroup = (a, b) => parent.has(a) && parent.has(b) && find(a) === find(b);

    // One smoothness pseudo-observation per distinct measured pair (a point and the ends of the line it
    // was measured from count as pairs too), unless both heights are measured.
    const smooth = [];
    const seenPairs = new Set();
    for (const o of obs) {
        for (const [na, nb] of heightPairs(o.m)) {
            const key = pairKey(na, nb);
            if (seenPairs.has(key) || sameHeightGroup(na, nb)) continue;
            seenPairs.add(key);
            const pa = placed.get(na);
            const pb = placed.get(nb);
            const sigma = settings.slopeSigma0 + settings.slopeSigma * Math.hypot(pb.x - pa.x, pb.y - pa.y);
            const za = index.get(na)[2];
            const zb = index.get(nb)[2];
            if (za >= 0 || zb >= 0) smooth.push({ za, zb, weight: 1 / (sigma * sigma) });
        }
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
            if (!hasDh(o.m)) continue;
            const dh = (o.m.toH || 0) - (o.m.fromH || 0);
            const pa = placed.get(o.m.from);
            const pb = placed.get(o.m.to);
            const h = Math.hypot(pb.x - pa.x, pb.y - pa.y);
            const vz2 = o.m.distance * o.m.distance - h * h;
            if (vz2 <= 0) continue;
            const vz = Math.sign(dh) * Math.sqrt(vz2);
            const sigma = Math.max(o.sigma * o.m.distance / Math.abs(vz), 0.02) + 0.05 * h / Math.abs(vz);
            add(index.get(o.m.from)[2], index.get(o.m.to)[2], vz - dh, 1 / (sigma * sigma));
        }
        const L = cholesky(N, n);
        if (!L) return;
        const z = cholSolve(L, n, g);
        zIdx.forEach((iz, k) => { x[iz] = z[k]; });
    }

    function costOf(vec) {
        let c = 0;
        const at = pointAt(vec);
        for (const o of obs) {
            const r = observe(o.m, at).residual;
            c += o.weight * r * r;
        }
        for (const row of pullRows(vec)) c += pullWeight * row.r * row.r;
        for (const s of smooth) c += s.weight * (zOf(vec, s.zb) - zOf(vec, s.za)) ** 2;
        return c;
    }

    // Normal equations N·δ = g. With newton = true, N also contains the height part of the second-order term
    // −w·r·∇²d of the distances (∇²d = (I − u·uᵀ)/d for each end): heights enter ground-to-ground distances only
    // quadratically, and without this curvature Gauss–Newton crawls along the nearly flat height directions.
    // Only the height part, and only when heights are measured at all: elsewhere it can make the equations
    // indefinite where the readings leave points free, and the solve then crawls instead of converging.
    function normalEquations(vec, newton = false) {
        const u = nu; // the point unknowns and the sketch similarity
        const N = new Float64Array(u * u);
        const g = new Float64Array(u);
        const diagGN = new Float64Array(u);
        for (const { r, ids, vals } of pullRows(vec)) {
            for (let p = 0; p < ids.length; p++) {
                if (ids[p] < 0) continue;
                g[ids[p]] += pullWeight * vals[p] * r;
                diagGN[ids[p]] += pullWeight * vals[p] * vals[p];
                for (let q = 0; q < ids.length; q++) if (ids[q] >= 0) N[ids[p] * u + ids[q]] += pullWeight * vals[p] * vals[q];
            }
        }
        for (const o of obs) {
            const { res: r, ids, vals, unit } = rowAt(o, vec);
            const len = o.kind === 'distance' ? o.m.distance - r : 0;
            const curv = newton && o.kind === 'distance' && len > 1e-9 ? (-o.weight * r) / len : 0;
            const n = ids.length;
            for (let p = 0; p < n; p++) {
                const ip = ids[p];
                if (ip < 0) continue;
                g[ip] += o.weight * vals[p] * r;
                diagGN[ip] += o.weight * vals[p] * vals[p];
                for (let q = 0; q < n; q++) {
                    const iq = ids[q];
                    if (iq < 0) continue;
                    let h = o.weight * vals[p] * vals[q];
                    if (curv && p % 3 === 2 && q % 3 === 2) {
                        // Distance partials are ordered to (x, y, z), from (x, y, z).
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

    // Levenberg–Marquardt iterations: with the pull towards the sketch, then pinned where that left the points.
    let iterations = 0;
    let converged = false;
    const levenbergMarquardt = maxIterations => {
    let lambda = 1e-3;
    let cost = costOf(x);
    converged = nu === 0;
    for (let it = 0; !converged && it < maxIterations; it++) {
        iterations++;
        const { N, g, diagGN } = normalEquations(x, is3D);
        let accepted = false;
        for (let attempt = 0; attempt < 12 && !accepted; attempt++) {
            const A = N.slice();
            for (let i = 0; i < nu; i++) A[i * nu + i] += lambda * Math.max(diagGN[i], 1e-9);
            const L = cholesky(A, nu);
            if (!L) {
                lambda *= 10;
                continue;
            }
            const delta = cholSolve(L, nu, g);
            const trial = x.slice();
            for (let i = 0; i < nu; i++) trial[i] += delta[i];
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
    };
    const tightened = obs.some(o => o.exactWeight !== o.softWeight);
    if (tightened) {
        ruleWeights(false);
        levenbergMarquardt(100);
        ruleWeights(true);
    }
    levenbergMarquardt(100);
    if (pulls.length) {
        // Meet the readings exactly with the least movement: pinned where phase 2 left them, so what the readings
        // leave free does not drift, and the sketch no longer pushes against any reading.
        pins = x.slice();
        pullWeight = 1 / (PIN_SIGMA * PIN_SIGMA);
        levenbergMarquardt(30);
        pins = null;
    }
    pullWeight = 1 / (SKETCH_SIGMA_REPORT * SKETCH_SIGMA_REPORT);

    // Covariance of the point unknowns (a priori, σ0 = 1), with the pull towards the sketch made negligible:
    // what only the sketch holds comes out as free.
    let Q = new Float64Array(0);
    if (u > 0) {
        const { N } = normalEquations(x);
        let L = cholesky(N, nu);
        if (!L) {
            let maxDiag = 0;
            for (let i = 0; i < nu; i++) maxDiag = Math.max(maxDiag, N[i * nu + i]);
            for (let i = 0; i < nu; i++) N[i * nu + i] += 1e-10 * maxDiag;
            L = cholesky(N, nu);
            warnings.push('weakGeometry');
        }
        const full = L ? cholInverse(L, nu) : new Float64Array(nu * nu).fill(NaN);
        Q = new Float64Array(u * u);
        for (let i = 0; i < u; i++) Q.set(full.subarray(i * nu, i * nu + u), i * u);
    }

    const solution = { index, x, Q, u, settings, is3D, datum: { origin: init.origin, axis: init.axis, side: settings.side } };

    // Per-measurement statistics: residual, redundancy number and Baarda's standardized residual.
    // Residuals, computed values and σ are reported in display units (metres, or degrees for angles).
    const measurementResults = new Map();
    let sumV2 = 0;
    let sumR = 0;
    for (const o of obs) {
        const row = rowForMeasurement(solution, o.m);
        const v = row.residual;
        const varPred = quadForm(solution, row);
        const qvv = Math.max(o.sigma * o.sigma - varPred, 0);
        const r = qvv / (o.sigma * o.sigma);
        // A rule held exactly has a tiny redundancy, but its test value is still well defined: it measures how far
        // the other readings pull away from it.
        const rule = settings.exactRules !== false && isRule(o.m);
        const w = r > 0.01 || (rule && r > 1e-7) ? v / Math.sqrt(qvv) : null;
        sumV2 += o.weight * v * v;
        sumR += r;
        const disp = val => toDisplayUnits(o.m, val);
        measurementResults.set(o.m.id, {
            used: true, kind: o.kind, computed: row.value, residual: disp(v), sigma: disp(o.sigma), sigmaPred: disp(Math.sqrt(varPred)), r, w, rule
        });
    }
    for (const m of input.measurements) {
        if (!measurementResults.has(m.id)) measurementResults.set(m.id, { used: false, kind: kindOf(m) });
    }

    // Per-point results. links = distinct readings that tie the point to other placed points.
    const readingSets = new Map();
    for (const m of usable) {
        const names = pointsOfMeasurement(m);
        for (const name of names) {
            if (!readingSets.has(name)) readingSets.set(name, new Map());
            readingSets.get(name).set(readingKey(m), names.filter(n => n !== name));
        }
    }
    const pointResults = new Map();
    const allNames = new Set([...input.points.map(p => p.name), ...readingSets.keys()]);
    for (const name of allNames) {
        let placedLinks = 0;
        for (const others of (readingSets.get(name) || new Map()).values()) if (others.every(n => index.has(n))) placedLinks++;
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
        else if (Math.sqrt(cxx + cyy) > FREE_SXY) status = 'weak'; // not fixed by the readings: held by the sketch
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

// Linearised observation row of a (possibly hypothetical) measurement of any kind at the solution.
// Returns { value (computed, display units: m, or ° in [0, 180)), residual (m or rad), ids, vals } or
// null when a point is not placed.
export function rowForMeasurement(solution, m) {
    if (!pointsOfMeasurement(m).every(n => solution.index.has(n))) return null;
    const c = (idx, k) => (idx[k] >= 0 ? solution.x[idx[k]] : 0);
    const r = observe(m, name => {
        const idx = solution.index.get(name);
        return { x: c(idx, 0), y: c(idx, 1), z: c(idx, 2) };
    });
    const value = kindOf(m) === 'angle' ? normalizeAngle((r.computed * 180) / Math.PI) : r.computed;
    return { value, residual: r.residual, ids: r.partials.map(([n, k]) => solution.index.get(n)[k]), vals: r.partials.map(p => p[2]) };
}

// Linearised row of a (possibly hypothetical) distance between two placed points:
// { dist, ids, vals } or null when a point is not placed.
export function rowFor(solution, from, fromH, to, toH) {
    const row = rowForMeasurement(solution, { from, fromH, to, toH, distance: 0 });
    return row && { dist: row.value, ids: row.ids, vals: row.vals };
}

// aᵀ·Q·a for a sparse row.
export function quadForm(solution, row) {
    const { Q, u } = solution;
    let s = 0;
    const n = row.ids.length;
    for (let p = 0; p < n; p++) {
        const ip = row.ids[p];
        if (ip < 0) continue;
        for (let q = 0; q < n; q++) {
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
    for (let p = 0; p < row.ids.length; p++) {
        const ip = row.ids[p];
        if (ip < 0) continue;
        const v = row.vals[p];
        const base = ip * u;
        for (let i = 0; i < u; i++) out[i] += Q[base + i] * v;
    }
    return out;
}
