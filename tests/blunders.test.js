import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveNetwork } from '../js/solver/adjust.js';
import { typoCandidates, checkMeasurement, snoop, parseDistance } from '../js/solver/blunders.js';
import { suggestMeasurements, underdeterminedPoints } from '../js/solver/planner.js';
import { TRUTH, makeMeasurements, pointsOf, trueDistance } from './helpers.js';

const settings = { origin: 'A', axis: 'B', side: 'C' };

test('parseDistance accepts comma decimals', () => {
    assert.equal(parseDistance('12,45'), 12.45);
    assert.equal(parseDistance(' 3.5 '), 3.5);
    assert.ok(Number.isNaN(parseDistance('abc')));
});

test('typo candidates include the classic slips', () => {
    const values = c => c.map(x => x.value);
    const c = typoCandidates('12.54');
    assert.ok(values(c).includes(12.45), 'transposition');
    assert.ok(values(c).includes(125.4), 'decimal shift');
    assert.ok(values(c).includes(1.254), 'decimal shift');
    assert.ok(values(c).includes(11.54), 'metre');
    assert.ok(values(c).includes(1.54), 'dropped digit');
    assert.equal(c.find(x => x.value === 12.45).kind, 'transpose');
    assert.ok(values(typoCandidates('6.9')).includes(9.9));
});

test('on-entry check flags a transposed distance and suggests the fix', () => {
    const sol = solveNetwork({ points: pointsOf(TRUTH), measurements: makeMeasurements(TRUTH, { noise: 1, seed: 5 }), settings });
    const d = trueDistance(TRUTH, 'C', 0, 'G', 0); // ≈ 12.37
    const good = Math.round(d * 100) / 100;
    const digits = good.toFixed(2);
    const typed = digits.slice(0, -2) + digits.at(-1) + digits.at(-2); // swap the last two digits
    assert.equal(checkMeasurement(sol, { from: 'C', fromH: 0, to: 'G', toH: 0, distance: good }).status, 'ok');
    const res = checkMeasurement(sol, { from: 'C', fromH: 0, to: 'G', toH: 0, distance: parseFloat(typed), raw: typed });
    assert.equal(res.status, 'suspect');
    assert.equal(res.suggestions[0].value, good);
    assert.equal(res.suggestions[0].kind, 'transpose');
});

test('on-entry check is unknown when a point is not placed', () => {
    const sol = solveNetwork({ points: pointsOf(TRUTH), measurements: makeMeasurements(TRUTH), settings });
    assert.equal(checkMeasurement(sol, { from: 'A', fromH: 0, to: 'NEW', toH: 0, distance: 3 }).status, 'unknown');
});

test('data snooping finds an injected decimal-shift blunder', () => {
    const ms = makeMeasurements(TRUTH, { noise: 1, seed: 7 });
    const victim = ms.find(m => m.from === 'D' && m.to === 'E' && m.toH === 0);
    const good = victim.distance;
    victim.raw = (Math.round(good * 100) / 1000).toFixed(3); // typed 0.xyz instead of x.yz
    victim.distance = parseFloat(victim.raw);
    const res = snoop({ points: pointsOf(TRUTH), measurements: ms, settings });
    assert.equal(res.suspects.length, 1);
    assert.equal(res.suspects[0].id, victim.id);
    assert.ok(res.suspects[0].suggestions.some(s => s.kind === 'decimal' && Math.abs(s.value - good) < 0.01));
    // Solution without the blunder is clean again.
    assert.ok(res.solution.s0 < 1.6);
});

test('data snooping stays quiet on clean data', () => {
    const res = snoop({ points: pointsOf(TRUTH), measurements: makeMeasurements(TRUTH, { noise: 1, seed: 11 }), settings });
    assert.equal(res.suspects.length, 0);
});

test('planner prefers linking a weakly connected point', () => {
    // Square A-B-C-D well connected; E only tied to A and B (mirror ambiguous, poor geometry).
    const truth = {
        A: { x: 0, y: 0, z: 0 }, B: { x: 10, y: 0, z: 0 }, C: { x: 0, y: 10, z: 0 }, D: { x: 10, y: 10, z: 0 },
        E: { x: 5, y: 15, z: 0 }
    };
    const ms = makeMeasurements(truth, { heights: false }).filter(m => m.to !== 'E' || m.from === 'A' || m.from === 'B');
    const sol = solveNetwork({ points: pointsOf(truth), measurements: ms, settings: { origin: 'A', axis: 'B', side: 'C' } });
    assert.deepEqual(underdeterminedPoints(sol).map(p => p.name), ['E']);
    const hints = suggestMeasurements(sol, { use3D: false, maxResults: 3 });
    assert.ok(hints[0].from === 'E' || hints[0].to === 'E', JSON.stringify(hints[0]));
    assert.ok(hints[0].xyPct > 0 && hints[0].xyPct <= 100);
});

test('planner respects tape length, blocked pairs and station', () => {
    const sol = solveNetwork({ points: pointsOf(TRUTH), measurements: makeMeasurements(TRUTH), settings });
    const all = suggestMeasurements(sol, { tapeLength: 10, maxResults: 100 });
    assert.ok(all.every(h => h.estimate <= 10));
    const blocked = new Set(['A|E']);
    assert.ok(suggestMeasurements(sol, { blocked, maxResults: 100 }).every(h => !(h.from === 'A' && h.to === 'E')));
    const fromD = suggestMeasurements(sol, { station: 'D', maxResults: 100 });
    assert.ok(fromD.length > 0 && fromD.every(h => h.from === 'D'));
});

test('typing in centimetres: digit slips are recognised after conversion to metres', async () => {
    const { fromEntry } = await import('../js/units.js');
    const typed = fromEntry('751', 'cm');
    assert.equal(typed.distance, 7.51);
    const values = typoCandidates(typed.raw).map(c => c.value);
    assert.ok(values.includes(5.71), 'swap of the first two digits');
    assert.ok(values.includes(7.15), 'swap of the last two digits');
});
