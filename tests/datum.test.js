// The automatic datum is kept once chosen, so adding a measurement does not turn the plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyGarden, solverInput, datumToKeep } from '../js/model.js';
import { snoop } from '../js/solver/blunders.js';

const d = (id, from, to, distance) => ({ id, from, to, fromH: 0, toH: 0, distance, status: 'active' });
const angle = (id, from, fromB, to, toB, distance) => ({ id, kind: 'angle', from, fromB, to, toB, distance, status: 'active' });

// A 3 × 5 m building and a gate 6 m away, measured only along one line (the reported test garden).
function garden() {
    const g = emptyGarden('test');
    g.points = ['KapuBal', 'KapuJobb', 'A1', 'A2', 'A3', 'A4'].map(name => ({ name, category: '', notes: '' }));
    g.measurements = [
        d('k', 'KapuBal', 'KapuJobb', 3), d('12', 'A1', 'A2', 5), d('43', 'A4', 'A3', 5), d('41', 'A4', 'A1', 3), d('32', 'A3', 'A2', 3),
        angle('a1', 'A3', 'A2', 'A1', 'A2', 90), angle('a2', 'A4', 'A3', 'A4', 'A1', 90), angle('a3', 'A1', 'A2', 'KapuBal', 'KapuJobb', 0),
        { id: 'o', kind: 'offset', from: 'KapuBal', fromB: 'KapuJobb', to: 'A1', distance: 6, status: 'active' },
        d('1k', 'A1', 'KapuBal', 6), angle('a4', 'A4', 'A1', 'A1', 'A2', 90), d('4k', 'A4', 'KapuBal', 9)
    ];
    return g;
}

const at = (solution, name) => {
    const p = solution.points.get(name);
    return [Math.round(p.x * 100) / 100 + 0, Math.round(p.y * 100) / 100 + 0];
};

test('the first automatic datum is kept when a measurement is added', () => {
    const g = garden();
    const first = snoop(solverInput(g)).solution;
    const keep = datumToKeep(g.settings, first);
    assert.deepEqual(keep, { origin: 'A1', axis: 'A4' });
    Object.assign(g.settings, keep);
    assert.equal(datumToKeep(g.settings, first), null);
    const before = at(first, 'A2');

    g.measurements.push(d('x', 'A2', 'KapuJobb', Math.hypot(6, 2)));
    const after = snoop(solverInput(g)).solution;
    assert.deepEqual(at(after, 'A4'), [3, 0]);
    assert.deepEqual(at(after, 'A2'), before);
    assert.ok(after.points.get('KapuJobb').sxy < 1, 'the diagonal ties the gate down');
});

test('a reading in the same direction as the others is recognised as adding nothing to a weak point', async () => {
    const { weakPointGains } = await import('../js/solver/planner.js');
    const g = garden();
    g.settings.origin = 'A1';
    g.settings.axis = 'A4';
    const solution = snoop(solverInput(g)).solution;
    // KapuBal is fixed only by readings along the A4–A1 line.
    const along = weakPointGains(solution, d('again', 'A4', 'KapuBal', 9));
    assert.equal(along.length, 1);
    assert.equal(along[0].name, 'KapuBal');
    assert.ok(along[0].pct < 1, `along the line: ${along[0].pct}`);
    const across = weakPointGains(solution, d('x', 'A2', 'KapuBal', Math.hypot(6, 5)));
    assert.ok(across[0].pct > 90, `across: ${across[0].pct}`);
    assert.deepEqual(weakPointGains(solution, d('ok', 'A2', 'A3', 3)), [], 'well fixed points are not reported');
});
