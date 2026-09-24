// Synthetic garden generator for solver tests.

// Deterministic PRNG (mulberry32) so tests are reproducible.
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function gaussian(rand) {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// A sloped garden in a local frame where A = (0,0,0), B on +x (y = 0), C on +y side.
export const TRUTH = {
    A: { x: 0, y: 0, z: 0 },
    B: { x: 12, y: 0, z: 0.4 },
    C: { x: 3, y: 8, z: 0.9 },
    D: { x: 11, y: 9, z: 1.3 },
    E: { x: 6.5, y: 4.2, z: 0.7 },
    F: { x: -2, y: 6, z: 0.6 },
    G: { x: 15, y: 5, z: 1.0 }
};

export function trueDistance(truth, from, fromH, to, toH) {
    const a = truth[from];
    const b = truth[to];
    return Math.hypot(b.x - a.x, b.y - a.y, b.z + toH - a.z - fromH);
}

// Generates measurements: every pair within maxDist, ground-to-ground plus (optionally) a height pair.
export function makeMeasurements(truth, { noise = 0, seed = 1, heights = true, maxDist = 30, sigmaConst = 0.005, sigmaRel = 0.002 } = {}) {
    const rand = rng(seed);
    const names = Object.keys(truth);
    const out = [];
    let id = 0;
    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            const pairs = heights ? [[0, 0], [0, 2]] : [[0, 0]];
            for (const [fh, th] of pairs) {
                const d = trueDistance(truth, names[i], fh, names[j], th);
                if (d > maxDist) continue;
                const sigma = sigmaConst + sigmaRel * d;
                out.push({ id: `m${++id}`, from: names[i], fromH: fh, to: names[j], toH: th, distance: d + noise * sigma * gaussian(rand), status: 'active' });
            }
        }
    }
    return out;
}

export function pointsOf(truth) {
    return Object.keys(truth).map(name => ({ name }));
}
