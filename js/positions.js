// Where each point is drawn on the plan: its computed position, its sketched position (mapped into the
// plan frame), or — for a point with neither — a place in a "parking row" below the plan, from where it
// can be dragged to where it belongs. A point that is not fixed yet but has a reading tied to computed
// points is drawn on that reading, nearest to its sketch: on the line it lies on, on the nearer of the
// two lines at the measured distance from a line, on the circle of a distance…

import { sketchFrame, sketchOf, locusSnapper } from './solver/initial.js';
import { isActive } from './solver/adjust.js';
import { isValidMeasurement } from './solver/observations.js';

// Returns { frame, positions: Map name → { x, y, placed, parked? } }.
export function layoutPositions(solution, points, measurements = []) {
    const frame = sketchFrame(solution, points);
    const positions = new Map();
    const unsketched = [];
    for (const p of points) {
        const r = solution?.points?.get(p.name);
        const sketch = sketchOf(p);
        if (r?.placed) positions.set(p.name, { x: r.x, y: r.y, placed: true });
        else if (sketch) positions.set(p.name, { ...frame.apply(sketch), placed: false });
        else unsketched.push(p.name);
    }
    if (unsketched.length) {
        let minX = Infinity, minY = Infinity;
        for (const q of positions.values()) {
            minX = Math.min(minX, q.x);
            minY = Math.min(minY, q.y);
        }
        if (!Number.isFinite(minX)) minX = minY = 0;
        unsketched.forEach((name, i) => positions.set(name, { x: minX + 2 * i, y: minY - 3, placed: false, parked: true }));
    }
    const placed = new Map([...positions].filter(([, q]) => q.placed).map(([n, q]) => [n, { x: q.x, y: q.y }]));
    const snap = locusSnapper(measurements.filter(m => isActive(m) && isValidMeasurement(m)), placed);
    for (const [name, q] of positions) {
        if (!q.placed) Object.assign(q, snap(name, q));
    }
    return { frame, positions };
}

// A free spot about `radius` metres from `around` (plan frame), not on top of another point: tries the
// directions around it in 45° steps, starting below. Returns plan coordinates.
export function freeSpotNear(around, positions, radius = 2) {
    const others = [...positions.values()];
    for (let ring = 1; ring <= 4; ring++) {
        for (let k = 0; k < 8; k++) {
            const a = -Math.PI / 2 + (k * Math.PI) / 4;
            const p = { x: around.x + ring * radius * Math.cos(a), y: around.y + ring * radius * Math.sin(a) };
            if (others.every(q => Math.hypot(q.x - p.x, q.y - p.y) > radius * 0.6)) return p;
        }
    }
    return { x: around.x + radius, y: around.y };
}
