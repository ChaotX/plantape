// Measuring workflows step by step, the way the app runs them: sketch points, save readings, recompute
// (snoop on the garden, as app.js does) and check where every point is drawn after each step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoGarden } from '../js/demo.js';
import { emptyGarden, solverInput } from '../js/model.js';
import { snoop, checkMeasurement } from '../js/solver/blunders.js';
import { rowForMeasurement } from '../js/solver/adjust.js';
import { resolveAngle, normalizeAngle, directedAngle } from '../js/solver/observations.js';
import { layoutPositions, freeSpotNear, followSketches } from '../js/positions.js';
import { availableLines, sameLine } from '../js/view/describe.js';

// A garden being measured. Values are taken from `truth` (plan positions), so they are exact.
class Session {
    constructor(garden, truth = {}) {
        this.garden = garden;
        this.truth = truth;
        this.n = 0;
        this.recompute();
    }

    recompute(prefer = null, dropAt = null) {
        const res = snoop(solverInput(this.garden, prefer, dropAt));
        this.solution = this.garden.settings.autoExclude ? res.solution : res.initial;
        this.suspects = res.suspects;
        ({ frame: this.frame, positions: this.positions } = layoutPositions(this.solution, this.garden.points, this.garden.measurements));
    }

    // Plan position of a known point (computed or from the truth table).
    real(name) {
        if (this.truth[name]) return this.truth[name];
        const p = this.solution.points.get(name);
        return { x: p.x, y: p.y };
    }

    // A point tapped on the plan at (x, y) (plan frame), as the ⊕ tool does.
    sketch(name, x, y) {
        const s = this.frame.invert({ x, y });
        this.garden.points.push({ name, category: 'building', notes: '', sketchX: s.x, sketchY: s.y });
        this.recompute();
    }

    // Dragging a point with the ✥ tool to (x, y), exactly as app.js movePoint does.
    move(name, x, y) {
        const setSketch = (n, q) => {
            const sk = this.frame.invert(q);
            Object.assign(this.garden.points.find(p => p.name === n), { sketchX: sk.x, sketchY: sk.y });
        };
        const before = this.positions;
        setSketch(name, { x, y });
        this.recompute(name, { x, y });
        const follow = followSketches(before, this.positions, this.garden.points, this.garden.measurements, name);
        if (this.positions.get(name)?.placed) follow.set(name, this.positions.get(name));
        for (const [n, q] of this.positions) if (q.free && !follow.has(n)) follow.set(n, q);
        for (const [n, q] of follow) setSketch(n, q);
        this.recompute();
    }

    save(m) {
        this.garden.measurements.push({ id: `w${++this.n}`, status: 'active', ...m });
        this.recompute();
    }

    distance(a, b) {
        const A = this.real(a);
        const B = this.real(b);
        this.save({ from: a, fromH: 0, to: b, toH: 0, distance: Math.hypot(B.x - A.x, B.y - A.y) });
    }

    // Distance of p from the line a–b; value defaults to the true one.
    offset(a, b, p, value) {
        const [A, B, P] = [a, b, p].map(n => this.real(n));
        const s = Math.abs((B.x - A.x) * (P.y - A.y) - (B.y - A.y) * (P.x - A.x)) / Math.hypot(B.x - A.x, B.y - A.y);
        this.save({ kind: 'offset', from: a, fromB: b, to: p, distance: value ?? s });
    }

    // The angle form: the user types the angle they see; the app resolves θ / 180° − θ from the current
    // (computed or sketched) drawing, exactly like the measure panel.
    angle(a, b, c, d, typed) {
        const lines = availableLines(this.garden);
        for (const [x, y] of [[a, b], [c, d]]) {
            assert.ok(lines.some(([u, v]) => sameLine(u, v, x, y)), `line ${x}–${y} is not measured, so the form does not offer it`);
        }
        const m = { kind: 'angle', from: a, fromB: b, to: c, toB: d };
        const row = rowForMeasurement(this.solution, m);
        const [A, B, C, D] = [a, b, c, d].map(n => this.positions.get(n));
        const now = row ? row.value : A && B && C && D ? normalizeAngle((directedAngle(A, B, C, D) * 180) / Math.PI) : NaN;
        const value = resolveAngle(typed, now);
        this.save({ ...m, distance: value });
        return value;
    }

    check(m) {
        return checkMeasurement(this.solution, m).status;
    }

    point(name) {
        return this.solution.points.get(name);
    }
}

const near = (p, q, tol = 0.01) => Math.hypot(p.x - q.x, p.y - q.y) < tol;
const fmt = p => (p ? `(${p.x?.toFixed(3)}, ${p.y?.toFixed(3)})` : String(p));

// A shed north of the house, aligned with the house's north wall (House NW → NE runs along y = 0).
const SHED = { B1: { x: 11.5, y: 0 }, B2: { x: 15.5, y: 0 }, B3: { x: 15.5, y: 3 }, B4: { x: 11.5, y: 3 } };
const WALL = ['House NW', 'House NE'];

function demoSession() {
    const g = demoGarden('Demo');
    return new Session(g, SHED);
}


// Not fixed by the readings: drawn where they allow nearest the sketch, with a large uncertainty (or, without a
// sketch to start from, not computed at all).
const notFixed = p => !p?.placed || p.sxy > 0.5;

test('a point sketched on the plan is drawn at its sketch until it is fixed', () => {
    const s = demoSession();
    s.sketch('B1', 11.3, 0.4);
    const p = s.positions.get('B1');
    assert.ok(p && !p.placed && near(p, { x: 11.3, y: 0.4 }, 0.05), fmt(p));
});

test('a point not fixed yet is drawn on what is known about it, nearest to its sketch', () => {
    const s = demoSession();
    // On the wall line: moved straight onto the line.
    s.sketch('P', 4, 1.2);
    s.offset(...WALL, 'P', 0);
    assert.ok(near(s.positions.get('P'), { x: 4, y: 0 }, 0.05), fmt(s.positions.get('P')));
    assert.ok(notFixed(s.point('P')));
    // 3 m from the wall line: onto the nearer of the two parallels (the sketch is on the +y side).
    s.sketch('Q', 6, 2.2);
    s.offset(...WALL, 'Q', 3);
    assert.ok(near(s.positions.get('Q'), { x: 6, y: 3 }, 0.05), fmt(s.positions.get('Q')));
    s.move('Q', 6, -1.5);
    assert.ok(near(s.positions.get('Q'), { x: 6, y: -3 }, 0.05), `dragged across the wall: ${fmt(s.positions.get('Q'))}`);
    // A single distance from a computed point: onto that circle.
    s.sketch('R', 3, 3);
    s.save({ from: 'House NW', fromH: 0, to: 'R', toH: 0, distance: 2 });
    const r = s.positions.get('R');
    assert.ok(Math.abs(Math.hypot(r.x, r.y) - 2) < 0.05 && r.x > 0 && r.y > 0, fmt(r));
    // Moving the sketch along the line moves the drawn point along it, still on the line.
    s.move('P', 6, 0.8);
    assert.ok(near(s.positions.get('P'), { x: 6, y: 0 }, 0.05), fmt(s.positions.get('P')));
});

test('building: on the line twice still waits for a second reading (no jump onto a line end)', () => {
    const s = demoSession();
    s.sketch('B1', 11.3, 0.4);
    s.offset(...WALL, 'B1', 0);
    assert.ok(notFixed(s.point('B1')));
    s.offset(...WALL, 'B1', 0); // saved again
    assert.ok(notFixed(s.point('B1')), fmt(s.point('B1')));
    assert.ok(near(s.positions.get('B1'), { x: 11.3, y: 0 }, 0.05), `drawn on the wall line below its sketch: ${fmt(s.positions.get('B1'))}`);
    // A distance from the end of the line fixes it; the sketch picks the side of House NE.
    s.distance('House NE', 'B1');
    assert.ok(near(s.point('B1'), SHED.B1, 0.05), fmt(s.point('B1')));
    // Dragging it to the other side of House NE moves it to the other solution, and back.
    s.move('B1', 7.4, 0.3);
    assert.ok(near(s.point('B1'), { x: 7.7, y: 0 }, 0.05), fmt(s.point('B1')));
    s.move('B1', 11.3, 0.4);
    assert.ok(near(s.point('B1'), SHED.B1, 0.05), fmt(s.point('B1')));
});

test('building: corners on the line, a side at a distance from it, square corners, parallel check', () => {
    const s = demoSession();
    s.sketch('B1', 11.3, 0.4);
    s.offset(...WALL, 'B1', 0);
    s.distance('House NE', 'B1');
    // Second corner on the same line, one side length away.
    s.sketch('B2', 15.2, -0.3);
    s.offset(...WALL, 'B2', 0);
    assert.ok(notFixed(s.point('B2')));
    s.distance('B1', 'B2');
    assert.ok(near(s.point('B2'), SHED.B2, 0.05), fmt(s.point('B2')));
    // Third corner: 3 m from the wall line and square to B1–B2 at B2.
    s.sketch('B3', 15.8, 2.6);
    s.offset(...WALL, 'B3');
    assert.ok(notFixed(s.point('B3')), 'one reading is not enough');
    assert.ok(s.positions.get('B3'), 'but it is drawn at its sketch');
    s.distance('B2', 'B3');
    assert.equal(s.angle('B1', 'B2', 'B2', 'B3', 90), 90);
    assert.ok(near(s.point('B3'), SHED.B3, 0.05), fmt(s.point('B3')));
    // Fourth corner: square at B3 and the side length; then the open side is a check.
    s.sketch('B4', 11.2, 3.3);
    s.distance('B3', 'B4');
    s.angle('B2', 'B3', 'B3', 'B4', 90);
    assert.ok(near(s.point('B4'), SHED.B4, 0.05), fmt(s.point('B4')));
    // B4 rests on two readings, so nothing can be checked against it yet.
    assert.equal(s.point('B4').status, 'weak');
    assert.equal(s.check({ from: 'B4', fromH: 0, to: 'B1', toH: 0, distance: 3 }), 'unknown');
    // Closing readings: the 4th side, its distance from the wall, parallel to the wall. They all agree.
    s.distance('B4', 'B1');
    s.offset(...WALL, 'B4');
    assert.equal(s.angle(WALL[0], WALL[1], 'B3', 'B4', 0), 0);
    assert.equal(s.point('B4').status, 'ok');
    assert.deepEqual(s.suspects.map(x => s.garden.measurements.find(m => m.id === x.id).from), ['Apple'], 'only the demo typo is suspect');
    for (const m of s.garden.measurements.filter(m => m.id.startsWith('w'))) {
        const r = s.solution.measurements.get(m.id);
        assert.ok(r.w === null || Math.abs(r.w) < 1, `${m.kind} ${m.from}→${m.to} w=${r.w}`);
    }
    // Now a wrong reading is caught on entry: the shed's east side is not square to the wall.
    assert.equal(s.check({ kind: 'angle', from: WALL[0], fromB: WALL[1], to: 'B3', toB: 'B4', distance: 90 }), 'suspect');
    assert.equal(s.check({ kind: 'offset', from: WALL[0], fromB: WALL[1], to: 'B4', distance: 3.3 }), 'suspect');
});

test('points with only readings from lines and between each other wait, then follow once tied in', () => {
    const s = demoSession();
    s.sketch('B1', 11.3, 0.4);
    s.offset(...WALL, 'B1', 0);
    s.distance('House NE', 'B1');
    s.sketch('B2', 15.2, -0.3);
    s.offset(...WALL, 'B2', 0);
    s.distance('B1', 'B2');
    // Two corners known only by their distance from the wall and from each other: still loose.
    s.sketch('B3', 15.8, 2.6);
    s.sketch('B4', 11.2, 3.3);
    s.offset(...WALL, 'B3');
    s.offset(...WALL, 'B4');
    s.distance('B3', 'B4');
    for (const n of ['B3', 'B4']) {
        assert.ok(notFixed(s.point(n)), n);
        assert.ok(s.positions.get(n), `${n} drawn`);
    }
    // Tying B3 to B2 fixes B3 (the sketch picks the side), and then B4 follows.
    s.distance('B2', 'B3');
    s.distance('B1', 'B3');
    assert.ok(near(s.point('B3'), SHED.B3, 0.05), fmt(s.point('B3')));
    assert.ok(near(s.point('B4'), SHED.B4, 0.05), fmt(s.point('B4')));
});

test('an arbitrary angle: typed 37 is stored as 37 or 143 depending on the drawing', () => {
    const s = demoSession();
    s.sketch('B1', 11.3, 0.4);
    s.offset(...WALL, 'B1', 0);
    s.distance('House NE', 'B1');
    // A path edge from B1 towards the upper left, at 37° to the wall.
    const E = { x: 11.5 - 5 * Math.cos((37 * Math.PI) / 180), y: 5 * Math.sin((37 * Math.PI) / 180) };
    s.truth.E = E;
    s.sketch('E', E.x - 0.4, E.y + 0.3);
    s.distance('B1', 'E');
    assert.equal(s.angle(...WALL, 'B1', 'E', 37), 143);
    assert.ok(near(s.point('E'), E, 0.05), fmt(s.point('E')));
    // The same edge typed as the other angle the user sees gives the same value.
    assert.equal(resolveAngle(143, s.solution && 143), 143);
});

test('points without a sketch (older gardens) are parked below the plan, and new ones go next to the station', () => {
    const g = emptyGarden('T');
    const truth = { A: { x: 0, y: 0 }, B: { x: 6, y: 0 }, C: { x: 3, y: 4 } };
    g.points = ['A', 'B', 'C', 'D'].map(name => ({ name, category: '', notes: '' }));
    const s = new Session(g, truth);
    s.distance('A', 'B');
    s.distance('A', 'C');
    s.distance('B', 'C');
    const d = s.positions.get('D');
    assert.ok(d?.parked && d.y < Math.min(...['A', 'B', 'C'].map(n => s.positions.get(n).y)), JSON.stringify(d));
    const spot = freeSpotNear(s.positions.get('C'), s.positions);
    assert.ok(Math.hypot(spot.x - 3, spot.y - 4) > 1 && [...s.positions.values()].every(q => Math.hypot(q.x - spot.x, q.y - spot.y) > 1));
});

test('k1–k4: dragging any point moves the whole network to the matching solution', () => {
    const s = demoSession();
    const NE = s.point('House NE');
    const at = (name, x, y, tol = 0.1) => {
        const q = s.positions.get(name);
        assert.ok(near(q, { x, y }, tol), `${name} expected (${x.toFixed(2)}, ${y.toFixed(2)}), got ${fmt(q)}`);
    };
    // k1 on the wall line, 3.5 m from House NE (sketched right of it).
    s.sketch('k1', NE.x + 3.2, 0.5);
    s.offset(...WALL, 'k1', 0);
    s.save({ from: 'k1', fromH: 0, to: 'House NE', toH: 0, distance: 3.5 });
    at('k1', NE.x + 3.5, 0);
    // k2 right of k1, k3 above k2, k4 above k1.
    s.sketch('k2', NE.x + 5.8, 0.5);
    s.sketch('k3', NE.x + 5.9, 4.4);
    s.sketch('k4', NE.x + 3.4, 4.3);
    s.offset('k1', 'House NE', 'k2', 0);
    s.save({ from: 'k1', fromH: 0, to: 'k2', toH: 0, distance: 2.5 });
    at('k2', NE.x + 6, 0);
    s.save({ from: 'k2', fromH: 0, to: 'k3', toH: 0, distance: 4 });
    at('k3', NE.x + 5.9, 4, 0.2); // on the 4 m circle around k2, nearest its sketch
    assert.ok(notFixed(s.point('k3')));

    // Drag k2 left of House NE: only possible with k1 on the other side of House NE too.
    s.move('k2', 7, 0.3);
    at('k1', NE.x - 3.5, 0);
    at('k2', NE.x - 1, 0);
    at('k3', NE.x - 1.1, 4, 1); // k3 (not fixed yet) comes along
    s.recompute();
    at('k2', NE.x - 1, 0); // and it stays there

    // Square corner at k2 between the measured sides k1–k2 and k2–k3: k3 is fixed.
    s.angle('k1', 'k2', 'k2', 'k3', 90);
    at('k3', NE.x - 1, 4);
    assert.equal(s.positions.get('k3').placed, true);

    // Drag k3 further left: k2 goes to the other side of k1 to make it possible; k1 stays.
    s.move('k3', 4, 4.5);
    at('k1', NE.x - 3.5, 0);
    at('k2', NE.x - 6, 0);
    at('k3', NE.x - 6, 4);

    // Drag k3 back to the right of House NE: k1 and k2 go there with it.
    s.move('k3', NE.x + 6.4, 4.3);
    at('k1', NE.x + 3.5, 0);
    at('k2', NE.x + 6, 0);
    at('k3', NE.x + 6, 4);
    s.recompute();
    at('k3', NE.x + 6, 4);

    // Dragged below the wall line, k3 goes to the mirror solution there (still square, 4 m from the line)…
    s.move('k3', NE.x + 6, -5);
    at('k3', NE.x + 6, -4);
    // …and dragged far away from any solution, it stays at the nearest one.
    s.move('k3', NE.x + 6, -20);
    at('k3', NE.x + 6, -4);
});

test('k1–k4 with the corner squared first: a drag lands on the nearest solution, not one pulled by old sketches', () => {
    const s = demoSession();
    const NE = s.point('House NE');
    s.sketch('k1', NE.x + 3.2, 0.5);
    s.sketch('k2', NE.x + 5.8, 0.5);
    s.sketch('k3', NE.x + 5.9, 4.4);
    s.sketch('k4', NE.x + 3.4, 4.3);
    s.offset('House NE', 'House NW', 'k1', 0);
    s.save({ from: 'k1', fromH: 0, to: 'House NE', toH: 0, distance: 3.5 });
    s.offset('House NE', 'k1', 'k2', 0);
    s.save({ from: 'k1', fromH: 0, to: 'k2', toH: 0, distance: 2.5 });
    s.save({ from: 'k2', fromH: 0, to: 'k3', toH: 0, distance: 4 });
    s.angle('k1', 'k2', 'k2', 'k3', 90);
    assert.ok(near(s.positions.get('k3'), { x: NE.x + 6, y: 4 }, 0.1), fmt(s.positions.get('k3')));
    // Dropped 2.6 m left of House NE: the nearest solution has k1 left of NE and k2 between k1 and NE.
    s.move('k2', NE.x - 2.6, 0);
    for (const [name, x, y] of [['k1', NE.x - 3.5, 0], ['k2', NE.x - 1, 0], ['k3', NE.x - 1, 4]]) {
        assert.ok(near(s.positions.get(name), { x, y }, 0.1), `${name} ${fmt(s.positions.get(name))}`);
    }
});
