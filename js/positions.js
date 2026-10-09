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

// After a drag changed the network's mirror choices: new sketch positions (plan frame) for the points that
// moved with it, so their sketches keep matching and the next recompute does not flip them back. Computed
// points get their new position; points not fixed yet move along with the computed points they are tied to.
// Returns Map name → { x, y }.
export function followSketches(before, after, points, measurements, moved, threshold = 0.3) {
    const shift = new Map();
    for (const [name, q] of after) {
        const p = before.get(name);
        if (!q.placed || !p?.placed) continue;
        if (Math.hypot(q.x - p.x, q.y - p.y) > threshold) shift.set(name, { dx: q.x - p.x, dy: q.y - p.y });
    }
    const out = new Map();
    const sketched = new Set(points.filter(p => Number.isFinite(p.sketchX)).map(p => p.name));
    // (the dragged point itself is left to the caller)
    for (const name of shift.keys()) if (name !== moved && sketched.has(name)) out.set(name, { x: after.get(name).x, y: after.get(name).y });
    // Points not fixed yet: the average shift of the moved points they share a reading with.
    const partners = new Map();
    for (const m of measurements) {
        const names = [m.from, m.fromB, m.to, m.toB].filter(Boolean);
        for (const n of names) {
            if (!partners.has(n)) partners.set(n, new Set());
            for (const o of names) if (o !== n) partners.get(n).add(o);
        }
    }
    for (const [name, q] of before) {
        if (name === moved || q.placed || !sketched.has(name)) continue;
        const ds = [...(partners.get(name) || [])].map(n => shift.get(n)).filter(Boolean);
        if (!ds.length) continue;
        const dx = ds.reduce((s, d) => s + d.dx, 0) / ds.length;
        const dy = ds.reduce((s, d) => s + d.dy, 0) / ds.length;
        out.set(name, { x: q.x + dx, y: q.y + dy });
    }
    return out;
}
