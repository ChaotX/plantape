// A rectangle given by its corners: sides as lines without readings, square corners, one side parallel to a
// fence, two side lengths and two readings that tie it to the fence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snoop } from '../js/solver/blunders.js';
import { solverInput, emptyGarden } from '../js/model.js';
import { rectangleMeasurements } from '../js/rectangle.js';

const d = (id, from, to, distance) => ({ id, from, to, fromH: 0, toH: 0, distance, status: 'active' });

function garden() {
    const g = emptyGarden('rect');
    // Fence F1 (0,0) – F2 (10,0) – F3 (10,6): an L, so the frame is fixed.
    // Rough sketch positions, as tapped on the plan: they pick the mirror solutions.
    const sketch = { F1: [0, 0], F2: [9, 1], F3: [10, 7], R1: [2.5, 1.5], R2: [6.5, 2.5], R3: [5.5, 5.5], R4: [1.5, 4.5] };
    g.points = Object.entries(sketch).map(([name, [x, y]]) => ({ name, category: '', notes: '', sketchX: x, sketchY: y }));
    g.measurements = [d('f12', 'F1', 'F2', 10), d('f23', 'F2', 'F3', 6), d('f13', 'F1', 'F3', Math.hypot(10, 6))];
    // House R1 (2,2) R2 (6,2) R3 (6,5) R4 (2,5).
    const { lines, measurements } = rectangleMeasurements(['R1', 'R2', 'R3', 'R4'], { parallelTo: ['F1', 'F2'], status: 'active' });
    g.lines = lines;
    g.measurements.push(...measurements.map((m, i) => ({ id: `r${i}`, ...m })));
    g.measurements.push(
        d('w', 'R1', 'R2', 4), d('h', 'R2', 'R3', 3),
        { id: 'o', kind: 'offset', from: 'F1', fromB: 'F2', to: 'R1', distance: 2, status: 'active' },
        d('t', 'F1', 'R1', Math.hypot(2, 2))
    );
    g.settings.origin = 'F1';
    g.settings.axis = 'F2';
    g.settings.side = 'F3';
    return g;
}

test('rectangle helper: four sides as lines, four square corners and the parallel', () => {
    const { lines, measurements } = rectangleMeasurements(['A', 'B', 'C', 'D'], { parallelTo: ['P', 'Q'] });
    assert.deepEqual(lines.map(l => `${l.from}${l.to}`), ['AB', 'BC', 'CD', 'DA']);
    assert.deepEqual(measurements.map(m => `${m.from}${m.fromB}∠${m.to}${m.toB}=${m.distance}`), ['AB∠BC=90', 'BC∠CD=90', 'CD∠DA=90', 'DA∠AB=90', 'PQ∠AB=0']);
});

test('a rectangle tied to a fence is placed and fully determined', () => {
    const res = snoop(solverInput(garden()));
    const P = res.solution.points;
    const near = (name, x, y) => {
        const p = P.get(name);
        assert.ok(p.placed, `${name} placed`);
        assert.ok(Math.hypot(p.x - x, p.y - y) < 0.01, `${name} at (${p.x.toFixed(3)}, ${p.y.toFixed(3)}), expected (${x}, ${y})`);
        assert.ok(p.sxy < 0.2, `${name} σ ${p.sxy}`); // angles (σ 1°) over a few metres: centimetres
    };
    near('R1', 2, 2);
    near('R2', 6, 2);
    near('R3', 6, 5);
    near('R4', 2, 5);
    assert.deepEqual(res.suspects, []);
});

test('rectangle helper: the parallel can be on the second side', () => {
    const { measurements } = rectangleMeasurements(['A', 'B', 'C', 'D'], { parallelTo: ['P', 'Q'], parallelSide: 1 });
    assert.equal(`${measurements.at(-1).to}${measurements.at(-1).toB}`, 'BC');
});
