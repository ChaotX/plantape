import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orientation, rotateXY, eastNorth, rotateScene, parseBearing } from '../js/orientation.js';

const solution = { points: new Map([['A', { placed: true, x: 0, y: 0 }], ['B', { placed: true, x: 10, y: 0 }], ['C', { placed: false }]]) };
const close = (p, x, y) => assert.ok(Math.hypot(p.x - x, p.y - y) < 1e-9, `(${p.x}, ${p.y}) ≠ (${x}, ${y})`);

test('without a bearing the drawing turns only by the user steps', () => {
    assert.deepEqual(orientation({ rotation: 0 }, solution), { angle: 0, north: null });
    assert.equal(orientation({ rotation: 90, northFrom: 'A', northTo: 'C', northBearing: 30 }, solution).north, null, 'C is not placed');
    close(rotateXY({ x: 1, y: 0 }, orientation({ rotation: 90 }, solution).angle), 0, 1);
});

test('north up: a line pointing east (bearing 90°) is drawn pointing right', () => {
    // A → B is the survey +x axis. If it points east, north is +y and nothing turns.
    const east = orientation({ northFrom: 'A', northTo: 'B', northBearing: 90 }, solution);
    assert.ok(Math.abs(east.angle) < 1e-9);
    close(eastNorth({ x: 10, y: 0 }, east.north), 10, 0);
    // If A → B points north-east (45°), B is drawn up and to the right at 45°.
    const ne = orientation({ northFrom: 'A', northTo: 'B', northBearing: 45 }, solution);
    close(rotateXY({ x: 10, y: 0 }, ne.angle), Math.SQRT1_2 * 10, Math.SQRT1_2 * 10);
    close(eastNorth({ x: 10, y: 0 }, ne.north), Math.SQRT1_2 * 10, Math.SQRT1_2 * 10);
    // B → A has the opposite bearing and gives the same north.
    const back = orientation({ northFrom: 'B', northTo: 'A', northBearing: 225 }, solution);
    assert.ok(Math.abs(Math.cos(back.north - ne.north) - 1) < 1e-9);
});

test('bearings are read from text, decimal comma and all', () => {
    assert.equal(parseBearing('72,5'), 72.5);
    assert.equal(parseBearing(-90), 270);
    assert.ok(Number.isNaN(parseBearing('')));
});

test('a turned scene turns points, ellipses, sketches and the drag, not the rest', () => {
    const scene = {
        solution: { ...solution, points: new Map([['A', { placed: true, x: 1, y: 0, ellipse: { a: 1, b: 0.5, angle: 0 } }], ['C', { placed: false }]]) },
        sketchPos: new Map([['C', { x: 0, y: 2 }]]),
        drag: { name: 'A', x: 2, y: 0 },
        garden: { points: [] }
    };
    const turned = rotateScene(scene, Math.PI / 2);
    close(turned.solution.points.get('A'), 0, 1);
    assert.equal(turned.solution.points.get('A').ellipse.angle, Math.PI / 2);
    close(turned.sketchPos.get('C'), -2, 0);
    close(turned.drag, 0, 2);
    assert.equal(turned.drag.name, 'A');
    assert.equal(turned.garden, scene.garden);
    assert.equal(rotateScene(scene, 0), scene);
});

test('without north the drawing turns back to the sketch', async () => {
    const { fitSimilarity } = await import('../js/solver/initial.js');
    const { frameRotation } = await import('../js/orientation.js');
    // The sketch has A → B going up; the survey frame has it along +x.
    const frame = fitSimilarity([{ s: { x: 0, y: 0 }, w: { x: 0, y: 0 } }, { s: { x: 0, y: 10 }, w: { x: 10, y: 0 } }]);
    const turn = orientation({ rotation: 0 }, solution, frame);
    close(rotateXY({ x: 10, y: 0 }, turn.angle), 0, 10);
    assert.equal(frameRotation(fitSimilarity([{ s: { x: 0, y: 0 }, w: { x: 3, y: 4 } }])), 0, 'one point gives no direction');
    // North wins over the sketch.
    assert.ok(Math.abs(orientation({ northFrom: 'A', northTo: 'B', northBearing: 90 }, solution, frame).angle) < 1e-9);
});
