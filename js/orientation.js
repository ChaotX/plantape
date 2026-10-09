// Orientation of the plan on screen, in exports and in the sheet's chart. The survey frame (x towards the axis
// point) has an arbitrary direction, so the drawing is turned to look like the sketch (what was drawn level
// stays level) or, once the compass bearing of one line is known, so that north is up; the user's 90° steps
// come on top. Coordinates themselves never change.

const DEG = Math.PI / 180;

export function parseBearing(value) {
    if (value === '' || value === null || value === undefined) return NaN;
    const n = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
    return Number.isFinite(n) ? ((n % 360) + 360) % 360 : NaN;
}

// How much the sketch frame is turned relative to the survey frame (radians), from the similarity fitted between
// them (sketchFrame in solver/initial.js); 0 while fewer than two computed points have a sketch.
export function frameRotation(frame) {
    if (!frame || frame.count < 2) return 0;
    const o = frame.apply({ x: 0, y: 0 });
    const e = frame.apply({ x: 1, y: 0 });
    return Math.atan2(e.y - o.y, e.x - o.x);
}

// settings: { rotation: user turn in degrees (counter-clockwise), northFrom, northTo, northBearing: compass
// bearing (degrees clockwise from north) of the direction northFrom → northTo }. frame: sketch → survey frame.
// Returns { angle: how much the drawing is turned (radians, counter-clockwise), north: direction of north in the
// survey frame (radians, counter-clockwise from +x) or null while unknown }.
export function orientation(settings, solution, frame = null) {
    const user = (Number(settings?.rotation) || 0) * DEG;
    const asSketched = user - frameRotation(frame);
    const bearing = parseBearing(settings?.northBearing);
    const a = solution?.points.get(settings?.northFrom);
    const b = solution?.points.get(settings?.northTo);
    if (!Number.isFinite(bearing) || !a?.placed || !b?.placed || settings.northFrom === settings.northTo) return { angle: asSketched, north: null };
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
