// A garden whose readings fix the points only together (the reported Ház / K / Kapu garden): every point's
// second reading is an angle or a distance from a line through a point that is not placed yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snoop } from '../js/solver/blunders.js';
import { solverInput, emptyGarden } from '../js/model.js';

const truth = {
    K4: [0, 0], KapuB: [8, 0], KapuJ: [12, 0], K1: [35, 0], K2: [35, 35], K3: [0, 35],
    Ház1: [20, 5], Ház2: [30, 5], Ház3: [30, 16], Ház4: [20, 16]
};
const dist = (a, b) => Math.hypot(truth[a][0] - truth[b][0], truth[a][1] - truth[b][1]);
const d = (from, to) => ({ from, to, fromH: 0, toH: 0, distance: dist(from, to) });
const angle = (from, fromB, to, toB, distance) => ({ kind: 'angle', from, fromB, to, toB, distance });
const offset = (from, fromB, to, distance) => ({ kind: 'offset', from, fromB, to, distance });

function garden() {
    const g = emptyGarden('seeded');
    // Sketch: the truth turned by 30°, scaled and a little off, as tapped on the plan.
    const c = Math.cos(0.5), s = Math.sin(0.5);
    g.points = Object.entries(truth).map(([name, [x, y]], i) => ({
        name, category: '', notes: '', sketchX: 1.2 * (x * c - y * s) + (i % 3) * 0.8, sketchY: 1.2 * (x * s + y * c) - (i % 2) * 0.8
    }));
    g.measurements = [
        angle('Ház1', 'Ház2', 'Ház2', 'Ház3', 90), angle('Ház2', 'Ház3', 'Ház3', 'Ház4', 90), angle('Ház3', 'Ház4', 'Ház4', 'Ház1', 90), angle('Ház4', 'Ház1', 'Ház1', 'Ház2', 90),
        d('Ház2', 'Ház1'), d('Ház2', 'Ház3'), d('KapuB', 'KapuJ'), angle('KapuB', 'KapuJ', 'Ház2', 'Ház1', 0),
        d('KapuJ', 'K1'), angle('KapuJ', 'K1', 'Ház2', 'Ház1', 0), d('K2', 'K1'), angle('K2', 'K1', 'KapuJ', 'K1', 90),
        d('K3', 'K2'), angle('K3', 'K2', 'K2', 'K1', 90), d('K4', 'K3'), angle('K4', 'K3', 'K3', 'K2', 90),
        d('KapuB', 'K4'), d('KapuJ', 'Ház1'), angle('KapuB', 'KapuJ', 'KapuB', 'K4', 0), angle('K4', 'K3', 'KapuB', 'K4', 90),
        offset('KapuJ', 'K1', 'K4', 0), offset('KapuJ', 'K1', 'KapuB', 0), offset('KapuJ', 'K1', 'Ház2', 5), offset('K2', 'K1', 'Ház3', 5),
        angle('Ház2', 'Ház3', 'K2', 'K1', 0), angle('K3', 'K4', 'K4', 'K1', 90), angle('K4', 'K1', 'K1', 'K2', 90)
    ].map((m, i) => ({ id: `m${i}`, status: 'active', ...m }));
    return g;
}

test('points that only the readings together fix are placed, starting from the sketch', () => {
    const res = snoop(solverInput(garden()));
    const P = res.solution.points;
    for (const name of Object.keys(truth)) assert.ok(P.get(name).placed, `${name} placed`);
    assert.deepEqual(res.suspects, []);
    // The shape is right: distances between points that were never measured to each other.
    for (const [a, b] of [['K3', 'Ház4'], ['K4', 'Ház1'], ['K2', 'KapuB'], ['Ház3', 'K4']]) {
        const pa = P.get(a), pb = P.get(b);
        assert.ok(Math.abs(Math.hypot(pa.x - pb.x, pa.y - pb.y) - dist(a, b)) < 0.05, `${a}–${b}`);
    }
});

test('a point the readings do not fix keeps waiting', () => {
    const g = garden();
    // Ház4 loses both the angles at its corners that tie it down, keeping one: it can slide along a line.
    g.measurements = g.measurements.filter(m => !(m.kind === 'angle' && [m.from, m.fromB, m.to, m.toB].filter(n => n === 'Ház4').length && m.id !== 'm1'));
    const P = snoop(solverInput(g)).solution.points;
    assert.equal(P.get('Ház4').placed, false);
    assert.ok(P.get('Ház3').placed && P.get('K3').placed);
});
