// Measurement kinds and their observation equations.
//
// distance  from (tape at fromH) → to (tape at toH): d = |(P_to + toH·ez) − (P_from + fromH·ez)|
// offset    horizontal distance of point `to` from the vertical plane through the line from–fromB (a fence
//           or wall). 0 means the point lies on the line.
// angle     the angle (degrees, in [0, 180)) by which the line from–fromB is turned counter-clockwise, seen
//           from above, to lie on the line to–toB. Lines have no direction, so the angle is taken modulo 180°.

export const KINDS = ['distance', 'offset', 'angle'];

const DEG = Math.PI / 180;

export function kindOf(m) {
    return m.kind === 'offset' || m.kind === 'angle' ? m.kind : 'distance';
}

// Names of all points an observation refers to (with repeats removed).
export function pointsOfMeasurement(m) {
    const k = kindOf(m);
    const list = k === 'distance' ? [m.from, m.to] : k === 'offset' ? [m.from, m.fromB, m.to] : [m.from, m.fromB, m.to, m.toB];
    return [...new Set(list)];
}

// Angle in degrees normalised to [0, 180) (180 → 0, −37 → 143).
export function normalizeAngle(deg) {
    let a = deg % 180;
    if (a < 0) a += 180;
    if (a >= 180 - 1e-9) a = 0;
    return a;
}

// Difference a − b of two undirected angles (degrees), in (−90, 90].
export function angleDiff(a, b) {
    let d = (a - b) % 180;
    if (d <= -90) d += 180;
    else if (d > 90) d -= 180;
    return d;
}

// The value to store for an angle the user typed: the typed θ or its mirror 180° − θ, whichever is closer
// to the current (computed or sketched) angle. Without a current angle the typed value is kept.
export function resolveAngle(typed, current) {
    const a = normalizeAngle(typed);
    const b = normalizeAngle(180 - typed);
    if (!Number.isFinite(current)) return a;
    return Math.abs(angleDiff(b, current)) < Math.abs(angleDiff(a, current)) - 1e-9 ? b : a;
}

export function isValidMeasurement(m) {
    const k = kindOf(m);
    if (!Number.isFinite(m.distance)) return false;
    if (k === 'distance') return !!(m.from && m.to && m.from !== m.to && m.distance > 0);
    if (k === 'offset') return !!(m.from && m.fromB && m.to && m.from !== m.fromB && m.to !== m.from && m.to !== m.fromB && m.distance >= 0);
    if (!(m.from && m.fromB && m.to && m.toB && m.from !== m.fromB && m.to !== m.toB)) return false;
    const same = (m.from === m.to && m.fromB === m.toB) || (m.from === m.toB && m.fromB === m.to);
    return !same && m.distance >= 0 && m.distance < 180;
}

// Rules: a square corner (90°), a parallel (0°) or a point on a line (0 m from it). They state the shape that
// is meant rather than a tape reading, so unless settings.exactRules is false they are held (almost) exactly:
// a rectangle stays a rectangle, and a reading that disagrees is the one that shows up as not fitting.
export const RULE_ANGLE_SIGMA = 0.01; // °
export const RULE_OFFSET_SIGMA = 0.001; // m

export function isRule(m) {
    const k = kindOf(m);
    return (k === 'angle' && (m.distance === 0 || m.distance === 90)) || (k === 'offset' && m.distance === 0);
}

// A priori standard deviation of an observation in its own unit (metres, or radians for angles).
export function observationSigma(m, settings) {
    const k = kindOf(m);
    if (settings.exactRules !== false && isRule(m)) return k === 'angle' ? RULE_ANGLE_SIGMA * DEG : RULE_OFFSET_SIGMA;
    if (k === 'angle') return Math.max(settings.angleSigma ?? 1, 1e-3) * DEG;
    const s = settings.sigmaConst + settings.sigmaRel * Math.abs(m.distance);
    return k === 'offset' ? s + (settings.lineSigma ?? 0.01) : s;
}

// Signed horizontal offset of p from the line a → b (positive on the left), and the line length.
export function signedOffset(a, b, p) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) return { s: 0, len };
    return { s: (dx * (p.y - a.y) - dy * (p.x - a.x)) / len, len };
}

// Counter-clockwise angle (radians, in (−π, π]) from direction a → b to direction c → d, in the plan.
export function directedAngle(a, b, c, d) {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = d.x - c.x;
    const vy = d.y - c.y;
    return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
}

// Evaluates an observation at the positions pos(name) → { x, y, z }.
// Returns { computed, residual, partials: [[name, axis (0 x, 1 y, 2 z), ∂computed/∂coordinate]] }.
// computed and residual are in metres, or in radians for angles; residual = observed − computed.
// For distances the partials are ordered to (x, y, z), from (x, y, z) — the adjustment's curvature term
// relies on that.
export function observe(m, pos) {
    const k = kindOf(m);
    if (k === 'distance') {
        const a = pos(m.from);
        const b = pos(m.to);
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const vz = b.z + (m.toH || 0) - a.z - (m.fromH || 0);
        const len = Math.hypot(vx, vy, vz);
        const ux = len > 1e-12 ? vx / len : 1;
        const uy = len > 1e-12 ? vy / len : 0;
        const uz = len > 1e-12 ? vz / len : 0;
        return {
            computed: len,
            residual: m.distance - len,
            unit: [ux, uy, uz],
            partials: [[m.to, 0, ux], [m.to, 1, uy], [m.to, 2, uz], [m.from, 0, -ux], [m.from, 1, -uy], [m.from, 2, -uz]]
        };
    }
    if (k === 'offset') {
        const a = pos(m.from);
        const b = pos(m.fromB);
        const p = pos(m.to);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const ex = p.x - a.x;
        const ey = p.y - a.y;
        const L = Math.hypot(dx, dy);
        if (L < 1e-12) return { computed: 0, residual: m.distance, partials: [] };
        const c = dx * ey - dy * ex;
        const s = c / L;
        // A non-zero offset only says how far, not on which side: compare with |s|.
        const sg = m.distance > 0 && s < 0 ? -1 : 1;
        const L3 = L * L * L;
        const pP = [-dy / L, dx / L];
        const pB = [ey / L - (c * dx) / L3, -ex / L - (c * dy) / L3];
        const pA = [-pP[0] - pB[0], -pP[1] - pB[1]];
        return {
            computed: sg * s,
            residual: m.distance - sg * s,
            partials: [
                [m.to, 0, sg * pP[0]], [m.to, 1, sg * pP[1]],
                [m.fromB, 0, sg * pB[0]], [m.fromB, 1, sg * pB[1]],
                [m.from, 0, sg * pA[0]], [m.from, 1, sg * pA[1]]
            ]
        };
    }
    const a = pos(m.from);
    const b = pos(m.fromB);
    const c = pos(m.to);
    const d = pos(m.toB);
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = d.x - c.x;
    const vy = d.y - c.y;
    const lu = ux * ux + uy * uy;
    const lv = vx * vx + vy * vy;
    if (lu < 1e-24 || lv < 1e-24) return { computed: 0, residual: 0, partials: [] };
    const theta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    // θ = φ(v) − φ(u); ∂φ/∂(vector) = (−y, x)/|vector|².
    const gv = [-vy / lv, vx / lv];
    const gu = [uy / lu, -ux / lu];
    const computed = theta;
    const residual = angleDiff(m.distance, theta / DEG) * DEG;
    return {
        computed,
        residual,
        partials: [
            [m.toB, 0, gv[0]], [m.toB, 1, gv[1]], [m.to, 0, -gv[0]], [m.to, 1, -gv[1]],
            [m.fromB, 0, gu[0]], [m.fromB, 1, gu[1]], [m.from, 0, -gu[0]], [m.from, 1, -gu[1]]
        ]
    };
}

// The observation's computed value in display units: metres, or degrees in [0, 180) for angles.
export function displayValue(m, computed) {
    return kindOf(m) === 'angle' ? normalizeAngle(computed / DEG) : computed;
}

// Converts a value in observation units (m or rad) to display units (m or °).
export function toDisplayUnits(m, v) {
    return kindOf(m) === 'angle' ? v / DEG : v;
}
