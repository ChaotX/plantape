// Measuring workflows step by step, the way the app runs them: sketch points, save readings, recompute
// (snoop on the garden, as app.js does) and check where every point is drawn after each step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoGarden } from '../js/demo.js';
import { emptyGarden, solverInput } from '../js/model.js';
import { snoop, checkMeasurement } from '../js/solver/blunders.js';
import { rowForMeasurement } from '../js/solver/adjust.js';
import { resolveAngle, normalizeAngle, directedAngle } from '../js/solver/observations.js';
import { layoutPositions, freeSpotNear } from '../js/positions.js';

// A garden being measured. Values are taken from `truth` (plan positions), so they are exact.
class Session {
    constructor(garden, truth = {}) {
        this.garden = garden;
        this.truth = truth;
        this.n = 0;
        this.recompute();
    }

    recompute() {
        const res = snoop(solverInput(this.garden));
        this.solution = this.garden.settings.autoExclude ? res.solution : res.initial;
        this.suspects = res.suspects;
        ({ frame: this.frame, positions: this.positions } = layoutPositions(this.solution, this.garden.points));
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

    // Dragging a point with the ✥ tool to (x, y).
    move(name, x, y) {
        const s = this.frame.invert({ x, y });
        Object.assign(this.garden.points.find(p => p.name === name), { sketchX: s.x, sketchY: s.y });
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

test('a point sketched on the plan is drawn at its sketch until it is fixed', () => {
    const s = demoSession();
    s.sketch('B1', 11.3, 0.4);
    const p = s.positions.get('B1');
    assert.ok(p && !p.placed && near(p, { x: 11.3, y: 0.4 }, 0.05), fmt(p));
});

test('building: on the line twice still waits for a second reading (no jump onto a line end)', () => {
    const s = demoSession();
    s.sketch('B1', 11.3, 0.4);
    s.offset(...WALL, 'B1', 0);
    assert.equal(s.point('B1').status, 'unplaced');
    s.offset(...WALL, 'B1', 0); // saved again
    assert.equal(s.point('B1').status, 'unplaced', fmt(s.point('B1')));
    assert.ok(near(s.positions.get('B1'), { x: 11.3, y: 0.4 }, 0.05), 'still drawn at its sketch');
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
    assert.equal(s.point('B2').status, 'unplaced');
    s.distance('B1', 'B2');
    assert.ok(near(s.point('B2'), SHED.B2, 0.05), fmt(s.point('B2')));
    // Third corner: 3 m from the wall line and square to B1–B2 at B2.
    s.sketch('B3', 15.8, 2.6);
    s.offset(...WALL, 'B3');
    assert.equal(s.point('B3').status, 'unplaced', 'one reading is not enough');
    assert.ok(s.positions.get('B3'), 'but it is drawn at its sketch');
    assert.equal(s.angle('B1', 'B2', 'B2', 'B3', 90), 90);
    assert.ok(near(s.point('B3'), SHED.B3, 0.05), fmt(s.point('B3')));
    // Fourth corner: square at B3 and the side length; then the open side is a check.
    s.sketch('B4', 11.2, 3.3);
    s.angle('B2', 'B3', 'B3', 'B4', 90);
    s.distance('B3', 'B4');
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
        assert.equal(s.point(n).status, 'unplaced', n);
        assert.ok(s.positions.get(n) && !s.positions.get(n).placed, `${n} drawn at its sketch`);
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
    assert.equal(s.angle(...WALL, 'B1', 'E', 37), 143);
    s.distance('B1', 'E');
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
