import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTable, planFrame, planChart } from '../js/sheet-plan.js';

const labels = { x: 'x', points: 'P', lines: 'L', helpers: 'H', title: 'T' };
const solution = {
    points: new Map([
        ['A', { placed: true, x: 0, y: 0 }],
        ['B', { placed: true, x: 20, y: 0 }],
        ['C', { placed: true, x: 20, y: 5 }],
        ['X', { placed: false }]
    ])
};
const ms = [
    { id: '1', from: 'A', to: 'B', distance: 20, visible: true },
    { id: '2', from: 'B', to: 'A', distance: 20 },
    { id: '3', from: 'B', to: 'C', distance: 5 },
    { id: '4', from: 'A', to: 'C', distance: 20.6, status: 'excluded' },
    { id: '5', from: 'A', to: 'X', distance: 3 },
    { id: '6', kind: 'offset', from: 'A', fromB: 'B', to: 'C', distance: 5 }
];

test('plan table: placed points, one segment per measured pair, a gap row after each segment', () => {
    const table = planTable(solution, ms, labels);
    assert.equal(table.points, 3);
    assert.equal(table.drawn, 1);
    assert.equal(table.helpers, 1);
    assert.deepEqual(table.rows.slice(1, 4).map(r => r[4]), ['A', 'B', 'C']);
    assert.deepEqual(table.rows.slice(4), [
        [0, '', 0, '', ''], [20, '', 0, '', ''], ['', '', '', '', ''],
        [20, '', '', 0, ''], [20, '', '', 5, ''], ['', '', '', '', '']
    ]);
});

test('plan frame keeps metres per pixel equal on both axes', () => {
    for (const bounds of [{ minX: 0, maxX: 20, minY: 0, maxY: 5 }, { minX: 0, maxX: 2, minY: 0, maxY: 40 }, { minX: 0, maxX: 10, minY: 0, maxY: 8 }]) {
        const f = planFrame(bounds);
        const perX = (f.x1 - f.x0) / (f.width - 110);
        const perY = (f.y1 - f.y0) / (f.height - 120);
        assert.ok(Math.abs(perX / perY - 1) < 0.01, JSON.stringify(f));
        assert.ok(f.x0 <= bounds.minX && f.x1 >= bounds.maxX && f.y0 <= bounds.minY && f.y1 >= bounds.maxY);
    }
});

test('no chart before any point is placed', () => {
    assert.equal(planChart(1, planTable({ points: new Map() }, [], labels), labels), null);
});

test('lines without a reading are drawn too, unless a measurement already draws the pair', () => {
    const table = planTable(solution, ms, labels, [{ from: 'A', to: 'C' }, { from: 'B', to: 'A', visible: false }, { from: 'A', to: 'X' }]);
    assert.equal(table.drawn, 2, 'A–B (measured, drawn) and A–C');
    assert.equal(table.helpers, 1, 'B–C');
});
