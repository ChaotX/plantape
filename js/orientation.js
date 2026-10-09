// Orientation of the plan on screen, in exports and in the sheet's chart. The survey frame (x towards the axis
// point) has an arbitrary direction; the drawing is turned by the user's 90° steps and, once the compass bearing
// of one line is known, so that north is up. Coordinates themselves never change.

const DEG = Math.PI / 180;

export function parseBearing(value) {
    if (value === '' || value === null || value === undefined) return NaN;
    const n = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
    return Number.isFinite(n) ? ((n % 360) + 360) % 360 : NaN;
}

// settings: { rotation: user turn in degrees (counter-clockwise), northFrom, northTo, northBearing: compass
// bearing (degrees clockwise from north) of the direction northFrom → northTo }.
// Returns { angle: how much the drawing is turned (radians, counter-clockwise), north: direction of north in the
// survey frame (radians, counter-clockwise from +x) or null while unknown }.
export function orientation(settings, solution) {
    const user = (Number(settings?.rotation) || 0) * DEG;
    const bearing = parseBearing(settings?.northBearing);
    const a = solution?.points.get(settings?.northFrom);
    const b = solution?.points.get(settings?.northTo);
    if (!Number.isFinite(bearing) || !a?.placed || !b?.placed || settings.northFrom === settings.northTo) return { angle: user, north: null };
    // The line points at `bearing` clockwise from north, so north is the line turned back counter-clockwise.
    const north = Math.atan2(b.y - a.y, b.x - a.x) + bearing * DEG;
    return { angle: Math.PI / 2 - north + user, north };
}

export function rotateXY(p, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

// East / north coordinates of a survey-frame point, given north's direction in that frame.
export function eastNorth(p, north) {
    return rotateXY(p, Math.PI / 2 - north);
}

// The scene with every plan position turned by angle: computed points (and their ellipses), sketches and the
// point being dragged. Labels are drawn upright on top, so they stay readable.
export function rotateScene(scene, angle) {
    if (!angle || !scene?.solution) return scene;
    const turn = p => ({ ...p, ...rotateXY(p, angle) });
    const points = new Map([...scene.solution.points].map(([name, p]) => [name, p.placed
        ? { ...turn(p), ellipse: p.ellipse && { ...p.ellipse, angle: p.ellipse.angle + angle } }
        : p]));
    return {
        ...scene,
        solution: { ...scene.solution, points },
        sketchPos: scene.sketchPos && new Map([...scene.sketchPos].map(([name, p]) => [name, turn(p)])),
        drag: scene.drag && turn(scene.drag)
    };
}
