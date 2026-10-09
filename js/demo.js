// A synthetic sloped demo garden with realistic tape noise and one typo, for trying the app out.
// Besides tape distances it has a fence with a post on its line, trees measured from the fence, and a
// house corner squared with angles; every point has a rough sketched position.

import { emptyGarden } from './model.js';

const TRUTH = [
    ['House NW', 'building', 0, 0, 0.0],
    ['House NE', 'building', 9.6, 0, 0.05],
    ['House SE', 'building', 9.6, -7.2, 0.1],
    ['Terrace', 'path', 4.8, -10.5, 0.25],
    ['Gate', 'fence', -3.5, 4.5, -0.3],
    ['Fence W1', 'fence', -5, -6, 0.2],
    ['Fence W2', 'fence', -5.5, -16, 0.9],
    ['Apple', 'tree', 1.5, -15.5, 0.8],
    ['Walnut', 'tree', 12.5, -17, 1.3],
    ['Shed', 'building', 16, -4, 0.6],
    ['Pond', 'water', 7, -21, 1.1],
    ['Rose', 'shrub', 13.5, -10.5, 0.8],
    // Measured with lines and angles only (not in the all-pairs distances below).
    ['House SW', 'building', 0, -7.2, 0.05],
    ['Fence W3', 'fence', -5.25, -11, 0.5],
    ['Plum', 'tree', -2.2, -9.5, 0.4]
];
const LINE_ONLY = new Set(['House SW', 'Fence W3', 'Plum']);

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function demoGarden(name) {
    const garden = emptyGarden(name);
    garden.settings.origin = 'House NW';
    garden.settings.axis = 'House NE';
    garden.settings.side = 'Gate';
    const rand = rng(7);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
    // Sketches: the true plan, drawn by hand (up to about half a metre off).
    garden.points = TRUTH.map(([n, category, x, y]) => ({
        name: n, category, notes: '',
        sketchX: Math.round((x + 0.3 * gauss()) * 10) / 10,
        sketchY: Math.round((y + 0.3 * gauss()) * 10) / 10
    }));
    const at = new Map(TRUTH.map(([n, , x, y, z]) => [n, { x, y, z }]));
    let id = 0;
    const day = new Date().toISOString().slice(0, 10);
    const add = m => garden.measurements.push({
        id: `demo-${++id}`,
        timestamp: `${day} 10:${String(id % 60).padStart(2, '0')}:00`,
        status: 'active',
        note: '',
        ...m
    });
    const distance = (a, b, fh = 0, th = 0) => {
        const A = at.get(a);
        const B = at.get(b);
        const d = Math.hypot(B.x - A.x, B.y - A.y, B.z + th - A.z - fh);
        const sigma = 0.005 + 0.002 * d;
        add({ from: a, fromH: fh, to: b, toH: th, distance: Math.round((d + sigma * gauss()) * 1000) / 1000 });
    };
    for (let i = 0; i < TRUTH.length; i++) {
        for (let j = i + 1; j < TRUTH.length; j++) {
            const [a, , ax, ay] = TRUTH[i];
            const [b, , bx, by] = TRUTH[j];
            if (LINE_ONLY.has(a) || LINE_ONLY.has(b)) continue;
            const horiz = Math.hypot(bx - ax, by - ay);
            if (horiz > 14 || rand() < 0.12) continue;
            distance(a, b);
            if (rand() < 0.4) distance(a, b, 0, 2);
        }
    }

    // Distance of point p from the fence / wall line a–b (horizontal), with tape noise.
    const offset = (a, b, p) => {
        const [A, B, P] = [a, b, p].map(n => at.get(n));
        const s = Math.abs((B.x - A.x) * (P.y - A.y) - (B.y - A.y) * (P.x - A.x)) / Math.hypot(B.x - A.x, B.y - A.y);
        const value = s < 1e-9 ? 0 : Math.round((s + 0.008 * gauss()) * 1000) / 1000;
        add({ kind: 'offset', from: a, fromB: b, to: p, distance: value });
    };
    // The west fence: a post on its line, a tree measured from it, the apple tree as a check.
    offset('Fence W1', 'Fence W2', 'Fence W3');
    distance('Fence W1', 'Fence W3');
    offset('Fence W1', 'Fence W2', 'Plum');
    distance('Fence W1', 'Plum');
    offset('Fence W1', 'Fence W2', 'Apple');
    // The house is a rectangle: the south-west corner from one side and a square corner, the west side
    // as a check.
    distance('House SE', 'House SW');
    add({ kind: 'angle', from: 'House NE', fromB: 'House SE', to: 'House SE', toB: 'House SW', distance: 90 });
    distance('House NW', 'House SW');

    // What the plan shows: every point, and the house outline and the west fence as drawn lines; all other
    // measurements are helper lines.
    const drawn = [['House NW', 'House NE'], ['House NE', 'House SE'], ['House SE', 'House SW'], ['House NW', 'House SW'],
        ['Fence W1', 'Fence W3'], ['Fence W1', 'Fence W2']];
    for (const p of garden.points) p.visible = true;
    for (const m of garden.measurements) {
        m.visible = !m.kind && !m.fromH && !m.toH && drawn.some(([a, b]) => (m.from === a && m.to === b) || (m.from === b && m.to === a));
    }

    // One mistyped distance: last two digits swapped.
    const victim = garden.measurements.find(m => m.from === 'Apple' && m.to === 'Walnut' && m.toH === 0) || garden.measurements[5];
    const s = victim.distance.toFixed(2);
    victim.raw = s.at(-1) !== s.at(-2) ? s.slice(0, -2) + s.at(-1) + s.at(-2) : (victim.distance + 1).toFixed(2);
    victim.distance = parseFloat(victim.raw);
    return garden;
}
