// A synthetic sloped demo garden with realistic tape noise and one typo, for trying the app out.

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
    ['Rose', 'shrub', 13.5, -10.5, 0.8]
];

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
    garden.points = TRUTH.map(([n, category]) => ({ name: n, category, notes: '' }));
    let id = 0;
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < TRUTH.length; i++) {
        for (let j = i + 1; j < TRUTH.length; j++) {
            const [a, , ax, ay, az] = TRUTH[i];
            const [b, , bx, by, bz] = TRUTH[j];
            const horiz = Math.hypot(bx - ax, by - ay);
            if (horiz > 14 || rand() < 0.12) continue;
            const pairs = [[0, 0]];
            if (rand() < 0.4) pairs.push([0, 2]);
            for (const [fh, th] of pairs) {
                const d = Math.hypot(horiz, bz + th - az - fh);
                const sigma = 0.005 + 0.002 * d;
                garden.measurements.push({
                    id: `demo-${++id}`,
                    timestamp: `${day} 10:${String(id % 60).padStart(2, '0')}:00`,
                    from: a, fromH: fh, to: b, toH: th,
                    distance: Math.round((d + sigma * gauss()) * 1000) / 1000,
                    status: 'active',
                    note: ''
                });
            }
        }
    }
    // One mistyped distance: last two digits swapped.
    const victim = garden.measurements.find(m => m.from === 'Apple' && m.to === 'Walnut' && m.toH === 0) || garden.measurements[5];
    const s = victim.distance.toFixed(2);
    victim.raw = s.at(-1) !== s.at(-2) ? s.slice(0, -2) + s.at(-1) + s.at(-2) : (victim.distance + 1).toFixed(2);
    victim.distance = parseFloat(victim.raw);
    return garden;
}
