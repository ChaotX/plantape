// Shown / hidden points and measurements: storage, defaults, and what the plan draws.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// The plan renderer pulls in the UI strings, which read the language from storage.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

let model;
let renderScene;
let demoGarden;
let snoop;
before(async () => {
    model = await import('../js/model.js');
    ({ renderScene } = await import('../js/view/plan-view.js'));
    ({ demoGarden } = await import('../js/demo.js'));
    ({ snoop } = await import('../js/solver/blunders.js'));
});

test('the visible column is read and written; missing flags keep the old look', () => {
    const g = model.gardenFromTables({
        points: [['name', 'visible'], ['A', 'TRUE'], ['B', 'nem'], ['C', '']],
        measurements: [['id', 'from', 'to', 'distance', 'visible'], ['m1', 'A', 'B', '5', 'yes'], ['m2', 'B', 'C', '4', ''], ['m3', 'A', 'C', '3', false]],
        settings: [], blocked: []
    });
    const p = name => g.points.find(x => x.name === name);
    assert.deepEqual(['A', 'B', 'C'].map(n => model.isPointShown(p(n))), [true, false, true]);
    assert.deepEqual(g.measurements.map(m => model.isMeasurementDrawn(m)), [true, false, false]);
    assert.equal(model.measurementToRecord(g.measurements[0]).visible, true);
    assert.equal(model.measurementToRecord(g.measurements[1]).visible, '');
    assert.equal(model.pointToRecord(p('B')).visible, false);
    assert.equal(model.DEFAULT_SETTINGS.newPointsVisible, false);
    assert.equal(model.DEFAULT_SETTINGS.newMeasurementsVisible, false);
});

function scene(options, extra = {}) {
    const garden = demoGarden('Demo');
    garden.points.find(p => p.name === 'Plum').visible = false;
    const solution = snoop(model.solverInput(garden)).solution;
    const tf = { scale: 20, ox: 400, oy: 300 };
    return { garden, svg: renderScene({ solution, garden, options, suspects: new Set(), ...extra }, tf, { pointR: 5, font: 13, stroke: 1.2, hit: 16 }) };
}

const lineIds = svg => [...svg.matchAll(/data-meas="([^"]+)"/g)].map(m => m[1]);
const points = svg => [...svg.matchAll(/data-point="([^"]+)"/g)].map(m => m[1]);

test('drawn lines, helper lines and hidden points can each be switched off', () => {
    const all = scene({});
    const drawn = all.garden.measurements.filter(m => model.isMeasurementDrawn(m) && !m.kind).map(m => m.id);
    const helpers = all.garden.measurements.filter(m => !model.isMeasurementDrawn(m) && !m.kind).map(m => m.id);
    assert.ok(drawn.length >= 4 && helpers.length > 10);
    assert.ok(drawn.every(id => lineIds(all.svg).includes(id)) && helpers.every(id => lineIds(all.svg).includes(id)));
    assert.ok(points(all.svg).includes('Plum'));

    const noHelpers = scene({ hiddenLines: false });
    assert.deepEqual(lineIds(noHelpers.svg).sort(), drawn.sort(), 'only the drawn lines remain');

    const noDrawn = scene({ lines: false });
    assert.ok(!lineIds(noDrawn.svg).some(id => drawn.includes(id)) && helpers.every(id => lineIds(noDrawn.svg).includes(id)));

    const noHidden = scene({ hiddenPoints: false });
    assert.ok(!points(noHidden.svg).includes('Plum') && points(noHidden.svg).includes('Apple'));
    // …unless it is the point I am measuring from.
    assert.ok(points(scene({ hiddenPoints: false }, { station: 'Plum' }).svg).includes('Plum'));
});

test('drawn lines look like lines of the plan, helper lines stay thin', () => {
    const { svg, garden } = scene({});
    const drawnId = garden.measurements.find(m => model.isMeasurementDrawn(m)).id;
    const helperId = garden.measurements.find(m => !model.isMeasurementDrawn(m) && !m.kind && m.status !== 'excluded').id;
    const widthOf = id => Number(new RegExp(`stroke-width="([0-9.]+)"[^>]*data-meas="${id}"`).exec(svg)?.[1]);
    assert.ok(widthOf(drawnId) > widthOf(helperId) * 1.5, `${widthOf(drawnId)} vs ${widthOf(helperId)}`);
});
