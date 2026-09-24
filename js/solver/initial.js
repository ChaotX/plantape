// Initial (approximate) 2D placement of points by incremental trilateration.
// Heights are ignored except to reduce slope distances to horizontal ones (assuming level ground).

export function horizontalDistance(m) {
    const dh = (m.toH || 0) - (m.fromH || 0);
    return Math.sqrt(Math.max(m.distance * m.distance - dh * dh, 0));
}

// Builds neighbour map: name → Map(other → averaged horizontal distance).
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
        if (m.from === m.to) continue;
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

function misfit(pos, neighbours, placed) {
    let s = 0;
    for (const [name, r] of neighbours) {
        const p = placed.get(name);
        const e = Math.hypot(pos.x - p.x, pos.y - p.y) - r;
        s += e * e;
    }
    return s;
}

// Best position from circle intersections of neighbour pairs: { pos, score }.
// With exactly two neighbours both intersections fit equally well; `choice` (0 = left of n1 → n2, 1 = right)
// decides, since the mirror side of such a point is undetermined until a third link exists.
function trilaterate(neighbours, placed, choice = 0) {
    if (neighbours.length === 2) {
        const [[n1, r1], [n2, r2]] = neighbours;
        const c = circleIntersections(placed.get(n1), r1, placed.get(n2), r2);
        if (c.length) return { pos: c[choice], score: misfit(c[choice], neighbours, placed) };
    }
    const limit = Math.min(neighbours.length, 8);
    let pos = null;
    let bestScore = Infinity;
    for (let i = 0; i < limit; i++) {
        for (let j = i + 1; j < limit; j++) {
            const [n1, r1] = neighbours[i];
            const [n2, r2] = neighbours[j];
            for (const c of circleIntersections(placed.get(n1), r1, placed.get(n2), r2)) {
                const score = misfit(c, neighbours, placed);
                if (score < bestScore - 1e-9) {
                    bestScore = score;
                    pos = c;
                }
            }
        }
    }
    if (!pos) {
        // Degenerate (coincident neighbours): drop it next to the first neighbour.
        const [n1, r1] = neighbours[0];
        const p = placed.get(n1);
        pos = { x: p.x + r1, y: p.y };
        bestScore = misfit(pos, neighbours, placed);
    }
    return { pos, score: bestScore };
}

// Sum of squared distance misfits over all links between placed points.
function totalMisfit(graph, placed) {
    let s = 0;
    for (const [a, inner] of graph) {
        const pa = placed.get(a);
        if (!pa) continue;
        for (const [b, r] of inner) {
            if (b <= a) continue;
            const pb = placed.get(b);
            if (pb) s += (Math.hypot(pa.x - pb.x, pa.y - pb.y) - r) ** 2;
        }
    }
    return s;
}

// Greedy incremental placement from a seed edge. The order depends only on the graph, so runs with
// different mirror choices (forced: Map name → 0 | 1) place the same points in the same order.
function greedy(graph, names, seedA, seedB, forced) {
    const placed = new Map([[seedA, { x: 0, y: 0 }], [seedB, { x: graph.get(seedA).get(seedB), y: 0 }]]);
    const order = [seedA, seedB];
    const ambiguous = [];
    for (;;) {
        let best = null;
        let bestCount = 1;
        for (const name of names) {
            if (placed.has(name)) continue;
            let count = 0;
            for (const other of graph.get(name).keys()) if (placed.has(other)) count++;
            if (count > bestCount) {
                best = name;
                bestCount = count;
            }
        }
        if (!best) break;
        const neighbours = [...graph.get(best)].filter(([other]) => placed.has(other));
        if (neighbours.length === 2 && placed.size > 2) ambiguous.push(best);
        placed.set(best, trilaterate(neighbours, placed, forced.get(best) || 0).pos);
        order.push(best);
    }
    return { placed, order, ambiguous };
}

function commonNeighbours(graph, a, b) {
    let n = 0;
    for (const other of graph.get(a).keys()) if (other !== b && graph.get(b).has(other)) n++;
    return n;
}

// Seed edge for the trilateration: the link closing the most triangles (ties: best connected ends, then
// names). It does not depend on the chosen datum, so any datum yields the same shape.
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

// Returns { placed: Map name → {x, y}, origin, axis, order }.
// Datum: origin at (0,0), axis point on +x, side point (if given) at y > 0. Origin and axis only need
// to be placed, not linked: the network is trilaterated from its best-braced edge and then moved into
// the datum frame.
export function initialPlacement(measurements, { origin, axis, side } = {}) {
    const graph = buildGraph(measurements);
    const names = [...graph.keys()];
    if (names.length === 0) return { placed: new Map(), origin: null, axis: null, order: [] };
    const seed = pickSeed(graph);
    if (!seed) {
        const only = graph.has(origin) ? origin : names[0];
        return { placed: new Map([[only, { x: 0, y: 0 }]]), origin: only, axis: null, order: [only] };
    }

    // Mirror choices made with only two neighbours can fold a whole branch of the network. Try flipping
    // each such choice (re-running the placement) and keep flips that clearly reduce the total misfit.
    // Each pass applies the single flip that helps most (steepest descent).
    let forced = new Map();
    let run = greedy(graph, names, seed[0], seed[1], forced);
    let score = totalMisfit(graph, run.placed);
    for (let pass = 0; pass < run.ambiguous.length; pass++) {
        let bestTrial = null;
        for (const name of run.ambiguous) {
            const trialForced = new Map(forced).set(name, 1 - (forced.get(name) || 0));
            const trial = greedy(graph, names, seed[0], seed[1], trialForced);
            const trialScore = totalMisfit(graph, trial.placed);
            if (trialScore < score * 0.8 - 1e-9 && (!bestTrial || trialScore < bestTrial.score)) {
                bestTrial = { forced: trialForced, run: trial, score: trialScore };
            }
        }
        if (!bestTrial) break;
        ({ forced, run, score } = bestTrial);
    }
    const { placed, order } = run;

    // Polish: re-trilaterate every point from all its neighbours, keeping clear improvements.
    for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        for (const name of order.slice(2)) {
            const neighbours = [...graph.get(name)].filter(([other]) => placed.has(other) && other !== name);
            if (neighbours.length < 3) continue;
            const current = misfit(placed.get(name), neighbours, placed);
            const { pos, score: sc } = trilaterate(neighbours, placed);
            if (sc < current * 0.5 - 1e-6) {
                placed.set(name, pos);
                changed = true;
            }
        }
        if (!changed) break;
    }

    // Datum points: the requested ones when placed, otherwise sensible defaults.
    const originName = origin && placed.has(origin) ? origin : seed[0];
    let axisName = axis && placed.has(axis) && axis !== originName ? axis : null;
    if (!axisName) {
        const linked = [...graph.get(originName).keys()].filter(n => placed.has(n));
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

    // Side point (or else the first clearly off-axis point) on the left (y > 0).
    const sideRef = side && placed.has(side) && ![originName, axisName].includes(side)
        ? side
        : order.find(n => n !== originName && n !== axisName && Math.abs(placed.get(n).y) > 1e-6);
    if (sideRef && placed.get(sideRef).y < 0) {
        for (const p of placed.values()) p.y = -p.y;
    }
    const datumOrder = [originName, axisName, ...order.filter(n => n !== originName && n !== axisName)];
    return { placed, origin: originName, axis: axisName, order: datumOrder };
}
