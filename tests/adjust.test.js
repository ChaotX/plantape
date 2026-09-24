import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveNetwork } from '../js/solver/adjust.js';
import { TRUTH, makeMeasurements, pointsOf, rng, gaussian } from './helpers.js';

const settings = { origin: 'A', axis: 'B', side: 'C' };

test('recovers exact 3D coordinates from noise-free measurements with heights', () => {
    const sol = solveNetwork({ points: pointsOf(TRUTH), measurements: makeMeasurements(TRUTH), settings });
    assert.ok(sol.converged);
    assert.ok(sol.is3D);
    // True coordinates relative to A with B on the x axis: B's z makes the frame tilted, so compare distances instead.
    for (const [name, p] of Object.entries(TRUTH)) {
        const r = sol.points.get(name);
        assert.ok(r.placed, name);
        // horizontal distance from origin and height difference are frame independent (rotation about z only)
        assert.ok(Math.abs(Math.hypot(r.x, r.y) - Math.hypot(p.x, p.y)) < 1e-3, `${name} horizontal`);
        // The smoothness prior may bias heights slightly, far below their standard deviation.
        assert.ok(Math.abs(r.z - p.z) < Math.max(1e-3, 0.1 * r.sz), `${name} z ${r.z} vs ${p.z} (sz ${r.sz})`);
    }
    assert.ok(sol.points.get('C').y > 0);
});

test('flip mirrors the result', () => {
    const sol = solveNetwork({ points: pointsOf(TRUTH), measurements: makeMeasurements(TRUTH), settings: { ...settings, flip: true } });
    assert.ok(sol.points.get('C').y < 0);
});

test('2D mode: ground-only measurements give plan coordinates and weak z', () => {
    const flat = Object.fromEntries(Object.entries(TRUTH).map(([k, p]) => [k, { ...p, z: 0 }]));
    const sol = solveNetwork({ points: pointsOf(flat), measurements: makeMeasurements(flat, { heights: false }), settings });
    assert.equal(sol.is3D, false);
    for (const [name, p] of Object.entries(flat)) {
        const r = sol.points.get(name);
        assert.ok(Math.abs(r.x - p.x) < 1e-4 && Math.abs(r.y - p.y) < 1e-4, name);
    }
});

test('covariance matches Monte Carlo spread', () => {
    const runs = 150;
    const xs = [];
    let predicted;
    for (let s = 0; s < runs; s++) {
        const sol = solveNetwork({ points: pointsOf(TRUTH), measurements: makeMeasurements(TRUTH, { noise: 1, seed: s + 10 }), settings });
        xs.push(sol.points.get('D').x);
        predicted = sol.points.get('D').sx;
    }
    const mean = xs.reduce((a, b) => a + b, 0) / runs;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (runs - 1));
    assert.ok(sd / predicted > 0.75 && sd / predicted < 1.3, `sd ${sd} predicted ${predicted}`);
});

test('noisy data: s0 near 1 and standardized residuals are small', () => {
    const sol = solveNetwork({ points: pointsOf(TRUTH), measurements: makeMeasurements(TRUTH, { noise: 1, seed: 3 }), settings });
    assert.ok(sol.s0 > 0.5 && sol.s0 < 1.6, `s0 ${sol.s0}`);
    for (const r of sol.measurements.values()) if (r.w !== null) assert.ok(Math.abs(r.w) < 4.5);
});

test('points with a single link stay unplaced, two links are weak', () => {
    const ms = makeMeasurements(TRUTH, { heights: false });
    ms.push({ id: 'x1', from: 'A', fromH: 0, to: 'H', toH: 0, distance: 5, status: 'active' });
    ms.push({ id: 'x2', from: 'A', fromH: 0, to: 'I', toH: 0, distance: 5, status: 'active' });
    ms.push({ id: 'x3', from: 'B', fromH: 0, to: 'I', toH: 0, distance: 9, status: 'active' });
    const sol = solveNetwork({ points: pointsOf(TRUTH), measurements: ms, settings });
    assert.equal(sol.points.get('H').status, 'unplaced');
    assert.equal(sol.points.get('I').status, 'weak');
    assert.equal(sol.points.get('E').status, 'ok');
    assert.equal(sol.measurements.get('x1').used, false);
});

test('excluded measurements are ignored', () => {
    const ms = makeMeasurements(TRUTH);
    ms[0].distance += 3;
    ms[0].status = 'excluded';
    const sol = solveNetwork({ points: pointsOf(TRUTH), measurements: ms, settings });
    assert.equal(sol.measurements.get(ms[0].id).used, false);
    assert.ok(Math.abs(sol.points.get('B').x - Math.hypot(12, 0)) < 0.01);
});

test('random networks converge from trilateration start', () => {
    const rand = rng(42);
    for (let t = 0; t < 10; t++) {
        const truth = {};
        for (let i = 0; i < 25; i++) truth[`P${i}`] = { x: rand() * 30, y: rand() * 20, z: rand() * 2 };
        const ms = makeMeasurements(truth, { maxDist: 12, noise: 1, seed: t });
        const sol = solveNetwork({ points: pointsOf(truth), measurements: ms, settings: {} });
        assert.ok(sol.converged);
        if (sol.s0 !== null) assert.ok(sol.s0 < 2, `trial ${t} s0 ${sol.s0}`);
    }
    void gaussian;
});

test('the shape does not depend on the chosen datum points', () => {
    const ms = makeMeasurements(TRUTH, { noise: 1, seed: 21 });
    const a = solveNetwork({ points: pointsOf(TRUTH), measurements: ms, settings: { origin: 'A', axis: 'B' } });
    const b = solveNetwork({ points: pointsOf(TRUTH), measurements: ms, settings: { origin: 'G', axis: 'C' } });
    assert.equal(b.points.get('G').x, 0);
    assert.equal(b.points.get('C').y, 0);
    const names = Object.keys(TRUTH);
    for (const p of names) {
        for (const q of names) {
            const da = Math.hypot(a.points.get(p).x - a.points.get(q).x, a.points.get(p).y - a.points.get(q).y);
            const db = Math.hypot(b.points.get(p).x - b.points.get(q).x, b.points.get(p).y - b.points.get(q).y);
            assert.ok(Math.abs(da - db) < 1e-3, `${p}-${q}: ${da} vs ${db}`);
        }
    }
});

test('origin and axis do not need to be linked to each other', () => {
    const flat = Object.fromEntries(Object.entries(TRUTH).map(([k, p]) => [k, { ...p, z: 0 }]));
    const ms = makeMeasurements(flat, { heights: false }).filter(m => !(m.from === 'A' && m.to === 'D'));
    const sol = solveNetwork({ points: pointsOf(flat), measurements: ms, settings: { origin: 'A', axis: 'D' } });
    assert.equal(sol.datum.axis, 'D');
    assert.ok([...sol.points.values()].every(p => p.placed));
    assert.ok(Math.abs(Math.hypot(sol.points.get('D').x, sol.points.get('D').y) - Math.hypot(11, 9)) < 1e-3);
});
