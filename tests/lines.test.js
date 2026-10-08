import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveNetwork } from '../js/solver/adjust.js';
import { snoop, checkMeasurement } from '../js/solver/blunders.js';
import { suggestOffsets } from '../js/solver/planner.js';
import { observe, resolveAngle, normalizeAngle, isValidMeasurement } from '../js/solver/observations.js';
import { fitSimilarity } from '../js/solver/initial.js';

let nextId = 0;
const dist = (truth, a, b) => ({ id: `d${++nextId}`, kind: 'distance', from: a, fromH: 0, to: b, toH: 0, distance: Math.hypot(truth[b].x - truth[a].x, truth[b].y - truth[a].y), status: 'active' });
const offset = (truth, a, b, p, value) => {
    const A = truth[a], B = truth[b], P = truth[p];
    const s = ((B.x - A.x) * (P.y - A.y) - (B.y - A.y) * (P.x - A.x)) / Math.hypot(B.x - A.x, B.y - A.y);
    return { id: `o${++nextId}`, kind: 'offset', from: a, fromB: b, to: p, distance: value ?? Math.abs(s), status: 'active' };
};
const angle = (truth, a, b, c, d, value) => {
    const A = truth[a], B = truth[b], C = truth[c], D = truth[d];
    const th = Math.atan2((B.x - A.x) * (D.y - C.y) - (B.y - A.y) * (D.x - C.x), (B.x - A.x) * (D.x - C.x) + (B.y - A.y) * (D.y - C.y));
    return { id: `a${++nextId}`, kind: 'angle', from: a, fromB: b, to: c, toB: d, distance: value ?? normalizeAngle((th * 180) / Math.PI), status: 'active' };
};

// Sketches: the true plan rotated by 30°, scaled ×1.1 and shifted, plus a little hand-drawing noise.
function sketched(truth, noise = 0.3) {
    const c = Math.cos(Math.PI / 6) * 1.1;
    const s = Math.sin(Math.PI / 6) * 1.1;
    return Object.entries(truth).map(([name, p], i) => ({
        name,
        sketchX: 100 + c * p.x - s * p.y + noise * Math.sin(i * 7.1),
        sketchY: 50 + s * p.x + c * p.y + noise * Math.cos(i * 3.3)
    }));
}

const near = (r, p, tol = 1e-3) => Math.hypot(r.x - p.x, r.y - p.y) < tol;

test('observation partials match finite differences', () => {
    const pts = { A: { x: 0.3, y: -0.2, z: 0 }, B: { x: 7.1, y: 1.4, z: 0.2 }, C: { x: 2.2, y: 4.9, z: 0.5 }, D: { x: 6.3, y: 8.8, z: 1.1 } };
    const ms = [
        { kind: 'offset', from: 'A', fromB: 'B', to: 'C', distance: 2 },
        { kind: 'offset', from: 'A', fromB: 'B', to: 'C', distance: 0 },
        { kind: 'angle', from: 'A', fromB: 'B', to: 'C', toB: 'D', distance: 60 },
        { kind: 'angle', from: 'A', fromB: 'B', to: 'B', toB: 'D', distance: 60 },
        { kind: 'distance', from: 'A', fromH: 0, to: 'D', toH: 2, distance: 12 }
    ];
    const h = 1e-6;
    for (const m of ms) {
        const base = observe(m, n => pts[n]);
        for (const [name, axis, value] of base.partials) {
            const key = ['x', 'y', 'z'][axis];
            const shifted = { ...pts, [name]: { ...pts[name], [key]: pts[name][key] + h } };
            const numeric = (observe(m, n => shifted[n]).computed - base.computed) / h;
            // Repeated points (shared corner) contribute several partials; compare their sum.
            const sum = base.partials.filter(([n, k]) => n === name && k === axis).reduce((s, p) => s + p[2], 0);
            assert.ok(Math.abs(numeric - sum) < 1e-4, `${m.kind} ∂/∂${name}.${key}: ${numeric} vs ${sum} (${value})`);
        }
    }
});

test('resolveAngle picks θ or 180° − θ from the current geometry', () => {
    assert.equal(resolveAngle(37, 40), 37);
    assert.equal(resolveAngle(37, 141), 143);
    assert.equal(resolveAngle(143, 141), 143);
    assert.equal(resolveAngle(143, 30), 37);
    assert.equal(resolveAngle(90, 84), 90);
    assert.equal(resolveAngle(90, 96), 90);
    assert.equal(resolveAngle(0, 178), 0);
    assert.equal(resolveAngle(180, 3), 0);
    assert.equal(resolveAngle(37, NaN), 37);
    assert.equal(normalizeAngle(-37), 143);
    assert.equal(normalizeAngle(180), 0);
});

test('validation of the new kinds', () => {
    assert.ok(isValidMeasurement({ kind: 'offset', from: 'A', fromB: 'B', to: 'C', distance: 0 }));
    assert.ok(!isValidMeasurement({ kind: 'offset', from: 'A', fromB: 'B', to: 'B', distance: 1 }));
    assert.ok(isValidMeasurement({ kind: 'angle', from: 'A', fromB: 'B', to: 'B', toB: 'C', distance: 90 }));
    assert.ok(!isValidMeasurement({ kind: 'angle', from: 'A', fromB: 'B', to: 'B', toB: 'A', distance: 0 }));
    assert.ok(!isValidMeasurement({ kind: 'angle', from: 'A', fromB: 'B', to: 'C', toB: 'D', distance: 180 }));
});

const RECT = { H1: { x: 0, y: 0 }, H2: { x: 8, y: 0 }, H3: { x: 8, y: 5 }, H4: { x: 0, y: 5 } };

test('rectangle from 3 sides + 2 square corners, the sketch decides its shape', () => {
    const ms = [dist(RECT, 'H1', 'H2'), dist(RECT, 'H2', 'H3'), dist(RECT, 'H3', 'H4'), angle(RECT, 'H1', 'H2', 'H2', 'H3', 90), angle(RECT, 'H2', 'H3', 'H3', 'H4', 90)];
    const sol = solveNetwork({ points: sketched(RECT), measurements: ms, settings: { origin: 'H1', axis: 'H2' } });
    for (const [name, p] of Object.entries(RECT)) assert.ok(near(sol.points.get(name), p), `${name} ${JSON.stringify(sol.points.get(name))}`);
});

test('rectangle without sketches: the 4th side decides', () => {
    const ms = [dist(RECT, 'H1', 'H2'), dist(RECT, 'H2', 'H3'), dist(RECT, 'H3', 'H4'), dist(RECT, 'H4', 'H1'), angle(RECT, 'H1', 'H2', 'H2', 'H3', 90), angle(RECT, 'H2', 'H3', 'H3', 'H4', 90)];
    const sol = solveNetwork({ points: Object.keys(RECT).map(name => ({ name })), measurements: ms, settings: { origin: 'H1', axis: 'H2', side: 'H3' } });
    for (const [name, p] of Object.entries(RECT)) assert.ok(near(sol.points.get(name), p), name);
    assert.ok(sol.redundancy > 0.9);
});

test('swapping the ends of the lines gives the same result', () => {
    const base = [dist(RECT, 'H1', 'H2'), dist(RECT, 'H2', 'H3'), dist(RECT, 'H3', 'H4')];
    const a = solveNetwork({ points: sketched(RECT), measurements: [...base, angle(RECT, 'H1', 'H2', 'H2', 'H3', 90), angle(RECT, 'H2', 'H3', 'H3', 'H4', 90)], settings: { origin: 'H1', axis: 'H2' } });
    const b = solveNetwork({ points: sketched(RECT), measurements: [...base, angle(RECT, 'H2', 'H1', 'H3', 'H2', 90), angle(RECT, 'H3', 'H2', 'H4', 'H3', 90)], settings: { origin: 'H1', axis: 'H2' } });
    for (const name of Object.keys(RECT)) assert.ok(near(a.points.get(name), b.points.get(name)), name);
});

const FENCE = { A: { x: 0, y: 0 }, B: { x: 20, y: 0 }, C: { x: 10, y: 8 }, T: { x: 5, y: 3 }, P1: { x: 5, y: 0 }, P2: { x: 12, y: 0 } };
const fenceBase = () => [dist(FENCE, 'A', 'B'), dist(FENCE, 'A', 'C'), dist(FENCE, 'B', 'C')];
const fenceSettings = { origin: 'A', axis: 'B', side: 'C' };

test('offset from a fence + one distance places a tree; the sketch picks the side', () => {
    const ms = [...fenceBase(), offset(FENCE, 'A', 'B', 'T'), dist(FENCE, 'A', 'T')];
    const points = sketched(FENCE);
    const sol = solveNetwork({ points, measurements: ms, settings: fenceSettings });
    assert.ok(near(sol.points.get('T'), FENCE.T), JSON.stringify(sol.points.get('T')));
    // Dragging the sketch to the other side of A along the fence moves the tree there.
    const moved = points.map(p => (p.name === 'T' ? sketched({ T: { x: -4, y: 2.5 } }, 0)[0] : p));
    const sol2 = solveNetwork({ points: moved, measurements: ms, settings: fenceSettings });
    assert.ok(near(sol2.points.get('T'), { x: -5, y: 3 }), JSON.stringify(sol2.points.get('T')));
    // And to the other side of the fence.
    const below = points.map(p => (p.name === 'T' ? sketched({ T: { x: 5, y: -3 } }, 0)[0] : p));
    const sol3 = solveNetwork({ points: below, measurements: ms, settings: fenceSettings });
    assert.ok(near(sol3.points.get('T'), { x: 5, y: -3 }), JSON.stringify(sol3.points.get('T')));
});

test('a fully fixed point does not follow its sketch', () => {
    const ms = [...fenceBase(), offset(FENCE, 'A', 'B', 'T'), dist(FENCE, 'A', 'T'), dist(FENCE, 'B', 'T'), dist(FENCE, 'C', 'T')];
    const points = sketched(FENCE).map(p => (p.name === 'T' ? sketched({ T: { x: -4, y: -3 } }, 0)[0] : p));
    const sol = solveNetwork({ points, measurements: ms, settings: fenceSettings });
    assert.ok(near(sol.points.get('T'), FENCE.T));
    assert.equal(sol.points.get('T').status, 'ok');
});

test('offset 0 puts fence posts on the line', () => {
    const ms = [...fenceBase(), offset(FENCE, 'A', 'B', 'P1', 0), dist(FENCE, 'A', 'P1'), offset(FENCE, 'A', 'B', 'P2', 0), dist(FENCE, 'P1', 'P2'), dist(FENCE, 'C', 'P2')];
    const sol = solveNetwork({ points: sketched(FENCE), measurements: ms, settings: fenceSettings });
    assert.ok(near(sol.points.get('P1'), FENCE.P1), JSON.stringify(sol.points.get('P1')));
    assert.ok(near(sol.points.get('P2'), FENCE.P2), JSON.stringify(sol.points.get('P2')));
});

test('a 37° bed edge, and a parallel path edge near 0°/180°', () => {
    const truth = {
        A: { x: 0, y: 0 }, B: { x: 10, y: 0 }, C: { x: 4, y: 7 },
        E: { x: 6 * Math.cos((37 * Math.PI) / 180), y: 6 * Math.sin((37 * Math.PI) / 180) },
        F: { x: 2, y: -3 }, G: { x: 9, y: -3.05 }
    };
    const ms = [
        dist(truth, 'A', 'B'), dist(truth, 'A', 'C'), dist(truth, 'B', 'C'),
        dist(truth, 'A', 'E'), angle(truth, 'A', 'B', 'A', 'E'),
        dist(truth, 'A', 'F'), dist(truth, 'B', 'F'), dist(truth, 'F', 'G'), angle(truth, 'A', 'B', 'F', 'G')
    ];
    assert.ok(Math.abs(ms[4].distance - 37) < 1e-9);
    assert.ok(ms.at(-1).distance > 179);
    const sol = solveNetwork({ points: sketched(truth), measurements: ms, settings: { origin: 'A', axis: 'B', side: 'C' } });
    for (const [name, p] of Object.entries(truth)) assert.ok(near(sol.points.get(name), p), `${name} ${JSON.stringify(sol.points.get(name))}`);
    // The same parallel line entered as 0° (wraps around) gives the same plan.
    const parallel0 = ms.map(m => (m === ms.at(-1) ? { ...m, distance: normalizeAngle(m.distance + 1 - 1 + 180) } : m));
    const sol2 = solveNetwork({ points: sketched(truth), measurements: parallel0, settings: { origin: 'A', axis: 'B', side: 'C' } });
    assert.ok(near(sol2.points.get('G'), truth.G));
});

test('without a side point the orientation follows the sketch', () => {
    const tri = { A: { x: 0, y: 0 }, B: { x: 10, y: 0 }, C: { x: 3, y: -6 } };
    const ms = [dist(tri, 'A', 'B'), dist(tri, 'A', 'C'), dist(tri, 'B', 'C')];
    const sol = solveNetwork({ points: sketched(tri, 0), measurements: ms, settings: { origin: 'A', axis: 'B' } });
    assert.ok(near(sol.points.get('C'), tri.C), JSON.stringify(sol.points.get('C')));
    const pairs = sketched(tri, 0).map(p => ({ s: { x: p.sketchX, y: p.sketchY }, w: sol.points.get(p.name) }));
    assert.ok(fitSimilarity(pairs).sse < 1e-6);
});

test('a mistyped offset is caught on entry with a swapped-digit suggestion', () => {
    const truth = { ...FENCE, T: { x: 5, y: 3.45 } };
    const ms = [...fenceBase(), dist(truth, 'A', 'T'), dist(truth, 'B', 'T'), dist(truth, 'C', 'T')];
    const sol = solveNetwork({ points: sketched(truth), measurements: ms, settings: fenceSettings });
    const check = checkMeasurement(sol, { kind: 'offset', from: 'A', fromB: 'B', to: 'T', distance: 4.35, raw: '4.35' });
    assert.equal(check.status, 'suspect');
    assert.ok(check.suggestions.some(s => s.kind === 'transpose' && Math.abs(s.value - 3.45) < 1e-9), JSON.stringify(check.suggestions));
    assert.equal(checkMeasurement(sol, { kind: 'offset', from: 'A', fromB: 'B', to: 'T', distance: 3.452 }).status, 'ok');
});

test('a corner that is not square is flagged', () => {
    const quad = { H1: { x: 0, y: 0 }, H2: { x: 8, y: 0 }, H3: { x: 8 + 5 * Math.sin((6 * Math.PI) / 180), y: 5 * Math.cos((6 * Math.PI) / 180) }, H4: { x: 0, y: 5 } };
    const ms = [dist(quad, 'H1', 'H2'), dist(quad, 'H2', 'H3'), dist(quad, 'H3', 'H4'), dist(quad, 'H4', 'H1'), dist(quad, 'H1', 'H3'), dist(quad, 'H2', 'H4')];
    const wrong = angle(quad, 'H1', 'H2', 'H2', 'H3', 90);
    const res = snoop({ points: sketched(quad), measurements: [...ms, wrong], settings: { origin: 'H1', axis: 'H2', side: 'H4' } });
    assert.deepEqual(res.suspects.map(s => s.id), [wrong.id]);
    assert.ok(Math.abs(res.suspects[0].predicted - 84) < 0.1, String(res.suspects[0].predicted));
});

test('offset hints from a reference line', () => {
    const ms = [...fenceBase(), dist(FENCE, 'A', 'T'), dist(FENCE, 'B', 'T')];
    const sol = solveNetwork({ points: sketched(FENCE), measurements: ms, settings: fenceSettings });
    const hints = suggestOffsets(sol, { lines: [['A', 'B']] });
    assert.ok(hints.length >= 2);
    const t = hints.find(h => h.to === 'T');
    assert.ok(t && Math.abs(t.estimate - 3) < 1e-6 && t.xyPct > 0);
});
