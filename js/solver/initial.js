// Initial (approximate) 2D placement of points by incremental trilateration.
// Heights are ignored except to reduce slope distances to horizontal ones (assuming level ground).
//
// Every reading that ties an unplaced point to placed ones is a locus on the plan: a circle (distance), a
// pair of lines parallel to a fence (offset; one line when the offset is 0) or a line through a neighbour
// at a given angle to another line. A point is placed at the best intersection of its loci. Two loci
// usually cross in two (or four) places that fit equally well; the sketched positions of the points, when
// known, decide which one is meant.

import { kindOf, angleDiff } from './observations.js';

export function horizontalDistance(m) {
    const dh = (m.toH || 0) - (m.fromH || 0);
    return Math.sqrt(Math.max(m.distance * m.distance - dh * dh, 0));
}

// Builds neighbour map from the distance measurements: name → Map(other → averaged horizontal distance).
export function buildGraph(measurements) {
    const sums = new Map();
    const add = (a, b, d) => {
        if (!sums.has(a)) sums.set(a, new Map());
        const inner = sums.get(a);
        const cur = inner.get(b) || { sum: 0, n: 0 };
        cur.sum += d;
        cur.n += 1;
        inner.set(b, cur);
    };
    for (const m of measurements) {
        if (m.from === m.to || kindOf(m) !== 'distance') continue;
        const d = horizontalDistance(m);
        add(m.from, m.to, d);
        add(m.to, m.from, d);
    }
    const graph = new Map();
    for (const [a, inner] of sums) {
        const out = new Map();
        for (const [b, { sum, n }] of inner) out.set(b, sum / n);
        graph.set(a, out);
    }
    return graph;
}

// ---- Sketch frame -------------------------------------------------------------------------------

// Least-squares similarity (rotation, uniform scale, translation; no reflection) mapping sketch positions
// s onto plan positions w: pairs [{ s: {x, y}, w: {x, y} }]. One pair gives a translation, none the identity.
export function fitSimilarity(pairs) {
    const n = pairs.length;
    let ar = 1;
    let ai = 0;
    let sx = 0, sy = 0, wx = 0, wy = 0;
    for (const { s, w } of pairs) {
        sx += s.x; sy += s.y; wx += w.x; wy += w.y;
    }
    if (n) {
        sx /= n; sy /= n; wx /= n; wy /= n;
    }
    if (n >= 2) {
        let nr = 0, ni = 0, den = 0;
        for (const { s, w } of pairs) {
            const px = s.x - sx, py = s.y - sy, qx = w.x - wx, qy = w.y - wy;
            nr += qx * px + qy * py; // (q)·conj(p)
            ni += qy * px - qx * py;
            den += px * px + py * py;
        }
        if (den > 1e-12 && Math.hypot(nr, ni) > 1e-12) {
            ar = nr / den;
            ai = ni / den;
        }
    }
    const apply = p => ({ x: wx + ar * (p.x - sx) - ai * (p.y - sy), y: wy + ai * (p.x - sx) + ar * (p.y - sy) });
    const invert = p => {
        const d = ar * ar + ai * ai;
        const qx = p.x - wx, qy = p.y - wy;
        return { x: sx + (ar * qx + ai * qy) / d, y: sy + (ar * qy - ai * qx) / d };
    };
    let sse = 0;
    for (const { s, w } of pairs) {
        const q = apply(s);
        sse += (q.x - w.x) ** 2 + (q.y - w.y) ** 2;
    }
    return { apply, invert, sse, count: n };
}

export function sketchOf(point) {
    return point && Number.isFinite(point.sketchX) && Number.isFinite(point.sketchY) ? { x: point.sketchX, y: point.sketchY } : null;
}

// Similarity from the sketch frame to the solution's plan frame, fitted on the placed points that have a
// sketch. Used to draw unplaced points at their sketch and to store new sketches in the sketch frame.
export function sketchFrame(solution, points) {
    const pairs = [];
    for (const p of points || []) {
        const s = sketchOf(p);
        const r = solution?.points?.get(p.name);
        if (s && r?.placed) pairs.push({ s, w: { x: r.x, y: r.y } });
    }
    return fitSimilarity(pairs);
}

// ---- Loci ---------------------------------------------------------------------------------------

function circleIntersections(p1, r1, p2, r2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-9) return [];
    const ex = dx / d;
    const ey = dy / d;
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(r1 * r1 - a * a, 0));
    const bx = p1.x + a * ex;
    const by = p1.y + a * ey;
    // First candidate is on the left of p1→p2.
    return [
        { x: bx - h * ey, y: by + h * ex },
        { x: bx + h * ey, y: by - h * ex }
    ];
}

// Line { p, u (unit) } with circle (c, r); a line missing the circle gives its closest point.
function lineCircle(l, c, r) {
    const wx = l.p.x - c.x;
    const wy = l.p.y - c.y;
    const b = wx * l.u.x + wy * l.u.y;
    const disc = b * b - (wx * wx + wy * wy - r * r);
    const h = Math.sqrt(Math.max(disc, 0));
    return [-b + h, -b - h].map(t => ({ x: l.p.x + t * l.u.x, y: l.p.y + t * l.u.y }));
}

function lineLine(l1, l2) {
    const cr = l1.u.x * l2.u.y - l1.u.y * l2.u.x;
    if (Math.abs(cr) < 1e-6) return [];
    const dx = l2.p.x - l1.p.x;
    const dy = l2.p.y - l1.p.y;
    const t = (dx * l2.u.y - dy * l2.u.x) / cr;
    return [{ x: l1.p.x + t * l1.u.x, y: l1.p.y + t * l1.u.y }];
}

function intersect(A, B) {
    if (A.circle && B.circle) return circleIntersections(A.c, A.r, B.c, B.r);
    if (A.circle) return B.lines.flatMap(l => lineCircle(l, A.c, A.r));
    if (B.circle) return A.lines.flatMap(l => lineCircle(l, B.c, B.r));
    return A.lines.flatMap(l1 => B.lines.flatMap(l2 => lineLine(l1, l2)));
}

function distanceToLocus(pos, L) {
    if (L.circle) return Math.hypot(pos.x - L.c.x, pos.y - L.c.y) - L.r;
    let best = Infinity;
    for (const l of L.lines) best = Math.min(best, Math.abs(l.u.x * (pos.y - l.p.y) - l.u.y * (pos.x - l.p.x)));
    return best;
}

function misfit(pos, loci) {
    let s = 0;
    for (const L of loci) s += distanceToLocus(pos, L) ** 2;
    return s;
}

function unitDir(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? { x: dx / len, y: dy / len } : null;
}

function rotate(u, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return { x: u.x * c - u.y * s, y: u.x * s + u.y * c };
}

// The network's readings, indexed for loci lookups.
class Constraints {
    constructor(measurements) {
        this.graph = buildGraph(measurements);
        this.byPoint = new Map();
        this.offsets = [];
        this.angles = [];
        const add = (name, c) => {
            if (!this.byPoint.has(name)) this.byPoint.set(name, []);
            this.byPoint.get(name).push(c);
        };
        const seen = new Set();
        // Repeated readings of the same thing give one locus (offsets averaged, angles: the first one);
        // two copies of the same locus never cross and would look like two readings.
        const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
        const offsetsByKey = new Map();
        const angleKeys = new Set();
        for (const m of measurements) {
            const k = kindOf(m);
            if (k === 'offset') {
                const key = `${m.to}|${pair(m.from, m.fromB)}`;
                const prev = offsetsByKey.get(key);
                if (prev) {
                    prev.d = (prev.d * prev.n + m.distance) / (prev.n + 1);
                    prev.n++;
                    continue;
                }
                const c = { kind: 'offset', p: m.to, a: m.from, b: m.fromB, d: m.distance, n: 1 };
                offsetsByKey.set(key, c);
                this.offsets.push(c);
                add(m.to, c);
            } else if (k === 'angle') {
                const l1 = pair(m.from, m.fromB);
                const l2 = pair(m.to, m.toB);
                const key = l1 < l2 ? `${l1}|${l2}` : `${l2}|${l1}`;
                if (angleKeys.has(key)) continue;
                angleKeys.add(key);
                const c = { kind: 'angle', a: m.from, b: m.fromB, c: m.to, d: m.toB, theta: (m.distance * Math.PI) / 180 };
                this.angles.push(c);
                for (const n of new Set([c.a, c.b, c.c, c.d])) add(n, c);
            }
        }
        this.names = [...this.graph.keys()];
        for (const n of this.graph.keys()) seen.add(n);
        for (const m of measurements) {
            for (const n of [m.from, m.fromB, m.to, m.toB]) {
                if (n && !seen.has(n)) {
                    seen.add(n);
                    this.names.push(n);
                }
            }
        }
    }

    // Loci of `name` from the readings whose other points are all placed.
    lociFor(name, placed) {
        const loci = [];
        for (const [other, r] of this.graph.get(name) || []) {
            if (other !== name && placed.has(other)) loci.push({ circle: true, c: placed.get(other), r });
        }
        for (const c of this.byPoint.get(name) || []) {
            if (c.kind === 'offset') {
                if (!placed.has(c.a) || !placed.has(c.b)) continue;
                const A = placed.get(c.a);
                const u = unitDir(A, placed.get(c.b));
                if (!u) continue;
                const n = { x: -u.y, y: u.x };
                const lines = c.d > 0 ? [c.d, -c.d].map(s => ({ p: { x: A.x + n.x * s, y: A.y + n.y * s }, u })) : [{ p: A, u }];
                loci.push({ lines });
            } else {
                // The unplaced point must be one end of exactly one of the two lines.
                const ends = [c.a, c.b, c.c, c.d];
                if (ends.filter(e => e === name).length !== 1) continue;
                if (!ends.every(e => e === name || placed.has(e))) continue;
                let through;
                let dir;
                if (name === c.c || name === c.d) {
                    const ref = unitDir(placed.get(c.a), placed.get(c.b));
                    if (!ref) continue;
                    dir = rotate(ref, c.theta);
                    through = placed.get(name === c.c ? c.d : c.c);
                } else {
                    const ref = unitDir(placed.get(c.c), placed.get(c.d));
                    if (!ref) continue;
                    dir = rotate(ref, -c.theta);
                    through = placed.get(name === c.a ? c.b : c.a);
                }
                loci.push({ lines: [{ p: through, u: dir }] });
            }
        }
        return loci;
    }

    // Sum of squared misfits over all readings between placed points (angles scaled by line length).
    totalMisfit(placed) {
        let s = 0;
        for (const [a, inner] of this.graph) {
            const pa = placed.get(a);
            if (!pa) continue;
            for (const [b, r] of inner) {
                if (b <= a) continue;
                const pb = placed.get(b);
                if (pb) s += (Math.hypot(pa.x - pb.x, pa.y - pb.y) - r) ** 2;
            }
        }
        for (const c of this.offsets) {
            const [P, A, B] = [placed.get(c.p), placed.get(c.a), placed.get(c.b)];
            if (!P || !A || !B) continue;
            const u = unitDir(A, B);
            if (u) s += (Math.abs(u.x * (P.y - A.y) - u.y * (P.x - A.x)) - c.d) ** 2;
        }
        for (const c of this.angles) {
            const [A, B, C, D] = [placed.get(c.a), placed.get(c.b), placed.get(c.c), placed.get(c.d)];
            if (!A || !B || !C || !D) continue;
            const th = Math.atan2((B.x - A.x) * (D.y - C.y) - (B.y - A.y) * (D.x - C.x), (B.x - A.x) * (D.x - C.x) + (B.y - A.y) * (D.y - C.y));
            const len = Math.min(Math.hypot(B.x - A.x, B.y - A.y), Math.hypot(D.x - C.x, D.y - C.y));
            s += ((angleDiff((c.theta * 180) / Math.PI, (th * 180) / Math.PI) * Math.PI) / 180 * len) ** 2;
        }
        return s;
    }
}

// Candidate positions from the loci, best fitting first: [{ pos, score }]. Candidates that fit about as
// well as the best one are the "equal" alternatives (mirror images); `equal` counts them.
function candidates(loci) {
    const limit = Math.min(loci.length, 8);
    const list = [];
    for (let i = 0; i < limit; i++) {
        for (let j = i + 1; j < limit; j++) {
            for (const c of intersect(loci[i], loci[j])) {
                if (list.some(o => Math.hypot(o.pos.x - c.x, o.pos.y - c.y) < 1e-6)) continue;
                list.push({ pos: c, score: misfit(c, loci) });
            }
        }
    }
    list.sort((a, b) => a.score - b.score); // stable: ties keep the generation order
    if (!list.length) return { list, equal: 0 };
    const tol = Math.max(1e-4, 4 * list[0].score);
    let equal = 0;
    while (equal < list.length && list[equal].score <= list[0].score + tol) equal++;
    return { list, equal };
}

function nearest(cands, target) {
    let best = 0;
    for (let i = 1; i < cands.length; i++) {
        if (Math.hypot(cands[i].pos.x - target.x, cands[i].pos.y - target.y) < Math.hypot(cands[best].pos.x - target.x, cands[best].pos.y - target.y)) best = i;
    }
    return best;
}

// Position for a point from its loci: { pos, score, equal }. choice picks among the equal candidates;
// a sketch target (already mapped into the current frame) overrides it.
function place(loci, choice = 0, target = null) {
    const { list, equal } = candidates(loci);
    if (!list.length) return null;
    const pick = target && equal > 1 ? nearest(list.slice(0, equal), target) : Math.min(choice, equal - 1);
    return { ...list[pick], equal };
}

// Greedy incremental placement from a seed edge. The order depends only on the readings, so runs with
// different mirror choices (forced: Map name → candidate index) place the same points in the same order.
// Points with a sketch are decided by the sketch once two placed points with sketches anchor the frame.
function greedy(cons, seedA, seedB, forced, sketches) {
    const placed = new Map([[seedA, { x: 0, y: 0 }], [seedB, { x: cons.graph.get(seedA).get(seedB), y: 0 }]]);
    const order = [seedA, seedB];
    const ambiguous = [];
    const refs = [seedA, seedB].filter(n => sketches.has(n));
    const stuck = new Map(); // name → number of loci that did not cross (retried once it has more)
    for (;;) {
        let best = null;
        let bestLoci = null;
        for (const name of cons.names) {
            if (placed.has(name)) continue;
            const loci = cons.lociFor(name, placed);
            if (stuck.get(name) === loci.length) continue;
            if (loci.length >= 2 && (!bestLoci || loci.length > bestLoci.length)) {
                best = name;
                bestLoci = loci;
            }
        }
        if (!best) break;
        let target = null;
        if (sketches.has(best) && refs.length >= 2) {
            target = fitSimilarity(refs.map(n => ({ s: sketches.get(n), w: placed.get(n) }))).apply(sketches.get(best));
        }
        const res = place(bestLoci, forced.get(best) || 0, target);
        if (!res) {
            const circles = bestLoci.filter(l => l.circle);
            if (circles.length < 2) {
                // Only parallel lines (e.g. two readings from parallel fences): not fixed yet, stays unplaced.
                stuck.set(best, bestLoci.length);
                continue;
            }
            // Degenerate (coincident circle centres): drop it next to the first centre.
            placed.set(best, { x: circles[0].c.x + circles[0].r, y: circles[0].c.y });
        } else {
            if (res.equal > 1 && placed.size > 2 && !target) ambiguous.push({ name: best, n: res.equal });
            placed.set(best, res.pos);
        }
        order.push(best);
        if (sketches.has(best)) refs.push(best);
    }
    return { placed, order, ambiguous };
}

function commonNeighbours(graph, a, b) {
    let n = 0;
    for (const other of graph.get(a).keys()) if (other !== b && graph.get(b).has(other)) n++;
    return n;
}

// Seed edge for the trilateration: the distance closing the most triangles (ties: best connected ends,
// then names). It does not depend on the chosen datum, so any datum yields the same shape.
function pickSeed(graph) {
    let best = null;
    let bestScore = -1;
    for (const [a, inner] of graph) {
        for (const b of inner.keys()) {
            if (b <= a) continue;
            const score = commonNeighbours(graph, a, b) * 1000 + graph.get(a).size + graph.get(b).size;
            if (score > bestScore) {
                bestScore = score;
                best = [a, b];
            }
        }
    }
    return best;
}

function pickMaxDegree(graph, names) {
    let best = null;
    let bestDeg = -1;
    for (const name of names) {
        const deg = graph.get(name)?.size || 0;
        if (deg > bestDeg) {
            best = name;
            bestDeg = deg;
        }
    }
    return best;
}

// Returns { placed: Map name → {x, y}, origin, axis, order }.
// Datum: origin at (0,0), axis point on +x, side point (if given) at y > 0. Origin and axis only need
// to be placed, not linked: the network is trilaterated from its best-braced edge and then moved into
// the datum frame. points: [{ name, sketchX?, sketchY? }] — sketched positions decide mirror choices and,
// without a side point, the overall orientation.
export function initialPlacement(measurements, { origin, axis, side } = {}, points = []) {
    const cons = new Constraints(measurements);
    const graph = cons.graph;
    if (cons.names.length === 0) return { placed: new Map(), origin: null, axis: null, order: [] };
    const seed = pickSeed(graph);
    if (!seed) {
        const only = graph.has(origin) ? origin : cons.names[0];
        return { placed: new Map([[only, { x: 0, y: 0 }]]), origin: only, axis: null, order: [only] };
    }
    const sketches = new Map();
    for (const p of points) {
        const s = sketchOf(p);
        if (s) sketches.set(p.name, s);
    }

    // Mirror choices made from only two loci can fold a whole branch of the network. Try the other
    // choices of each such point (re-running the placement) and keep those that clearly reduce the total
    // misfit. Each pass applies the single change that helps most (steepest descent).
    let forced = new Map();
    let run = greedy(cons, seed[0], seed[1], forced, sketches);
    let score = cons.totalMisfit(run.placed);
    for (let pass = 0; pass < run.ambiguous.length; pass++) {
        let bestTrial = null;
        for (const { name, n } of run.ambiguous) {
            for (let k = 0; k < n; k++) {
                if (k === (forced.get(name) || 0)) continue;
                const trialForced = new Map(forced).set(name, k);
                const trial = greedy(cons, seed[0], seed[1], trialForced, sketches);
                const trialScore = cons.totalMisfit(trial.placed);
                if (trialScore < score * 0.8 - 1e-9 && (!bestTrial || trialScore < bestTrial.score)) {
                    bestTrial = { forced: trialForced, run: trial, score: trialScore };
                }
            }
        }
        if (!bestTrial) break;
        ({ forced, run, score } = bestTrial);
    }
    const { placed, order } = run;

    // Polish: re-place every point from all its loci, keeping clear improvements.
    for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        for (const name of order.slice(2)) {
            const others = new Map(placed);
            others.delete(name);
            const loci = cons.lociFor(name, others);
            if (loci.length < 3) continue;
            const current = misfit(placed.get(name), loci);
            const res = place(loci);
            if (res && res.score < current * 0.5 - 1e-6) {
                placed.set(name, res.pos);
                changed = true;
            }
        }
        if (!changed) break;
    }

    // Datum points: the requested ones when placed, otherwise sensible defaults.
    const originName = origin && placed.has(origin) ? origin : seed[0];
    let axisName = axis && placed.has(axis) && axis !== originName ? axis : null;
    if (!axisName) {
        const linked = [...(graph.get(originName)?.keys() || [])].filter(n => placed.has(n));
        axisName = linked.length ? pickMaxDegree(graph, linked) : order.find(n => n !== originName);
    }

    // Move into the datum frame: origin → (0,0), axis on +x.
    const o = { ...placed.get(originName) }; // copies: the loop below mutates the stored points
    const a = { ...placed.get(axisName) };
    const angle = Math.atan2(a.y - o.y, a.x - o.x);
    const c = Math.cos(-angle);
    const s = Math.sin(-angle);
    for (const p of placed.values()) {
        const dx = p.x - o.x;
        const dy = p.y - o.y;
        p.x = dx * c - dy * s;
        p.y = dx * s + dy * c;
    }
    placed.get(axisName).y = 0;

    // Orientation: the side point on the left (y > 0). Without one, follow the sketch when at least three
    // placed points have one; otherwise put the first clearly off-axis point on the left.
    const explicitSide = side && placed.has(side) && ![originName, axisName].includes(side);
    let mirror = false;
    const sketchPairs = [...placed].filter(([n]) => sketches.has(n)).map(([n, w]) => ({ s: sketches.get(n), w }));
    if (explicitSide) mirror = placed.get(side).y < 0;
    else if (sketchPairs.length >= 3) {
        const asIs = fitSimilarity(sketchPairs).sse;
        const mirrored = fitSimilarity(sketchPairs.map(({ s: sk, w }) => ({ s: sk, w: { x: w.x, y: -w.y } }))).sse;
        mirror = mirrored < asIs - 1e-9;
    } else {
        const sideRef = order.find(n => n !== originName && n !== axisName && Math.abs(placed.get(n).y) > 1e-6);
        mirror = !!sideRef && placed.get(sideRef).y < 0;
    }
    if (mirror) for (const p of placed.values()) p.y = -p.y;
    const datumOrder = [originName, axisName, ...order.filter(n => n !== originName && n !== axisName)];
    return { placed, origin: originName, axis: axisName, order: datumOrder };
}
