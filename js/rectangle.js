// A rectangle from its corners in order: the four sides as lines without a reading, a square corner at each
// corner (one of them is a check), and optionally one side parallel to a given line. Sizes and position still
// need readings: two side lengths and two readings that tie a corner to the rest of the garden.

// corners: [a, b, c, d] in order around the rectangle; parallelTo: [p, q] or null (made parallel to a–b).
// Returns { lines: [{ from, to }], measurements: [angle measurements without id / timestamp] }.
export function rectangleMeasurements(corners, { parallelTo = null, status = 'active' } = {}) {
    const sides = corners.map((name, i) => [name, corners[(i + 1) % corners.length]]);
    const lines = sides.map(([from, to]) => ({ from, to }));
    const angle = ([from, fromB], [to, toB], distance) => ({ kind: 'angle', from, fromB, to, toB, distance, status });
    const measurements = sides.map((side, i) => angle(side, sides[(i + 1) % sides.length], 90));
    if (parallelTo) measurements.push(angle(parallelTo, sides[0], 0));
    return { lines, measurements };
}
