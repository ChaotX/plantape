// Garden data model and its mapping to spreadsheet tabs.

import { parseDistance } from './solver/blunders.js';
import { kindOf, normalizeAngle } from './solver/observations.js';

export const TABS = {
    points: 'Points',
    measurements: 'Measurements',
    settings: 'Settings',
    blocked: 'Blocked',
    lines: 'Lines'
};

export const HEADERS = {
    points: ['name', 'category', 'notes', 'x', 'y', 'z', 'sigma_xy', 'sigma_z', 'links', 'status', 'sketch_x', 'sketch_y', 'visible'],
    // New sheets: what is measured first, with each line's two points side by side. Columns are found by their
    // header, so older sheets with another order keep working.
    measurements: ['id', 'timestamp', 'kind', 'from', 'from_b', 'from_h', 'to', 'to_b', 'to_h', 'distance', 'description', 'status', 'note', 'visible', 'residual', 'w', 'flag'],
    settings: ['key', 'value'],
    blocked: ['from', 'to', 'note'],
    lines: ['from', 'to', 'visible', 'note']
};

export const CATEGORIES = ['building', 'tree', 'shrub', 'fence', 'path', 'water', 'other'];

export const DEFAULT_SETTINGS = {
    gardenName: '',
    tapeLength: 30,
    sigmaConst: 0.005,
    sigmaRel: 0.002,
    lineSigma: 0.01,
    angleSigma: 1,
    newPointsVisible: false,
    newMeasurementsVisible: false,
    heights: [0, 1, 2],
    origin: '',
    axis: '',
    side: '',
    flip: false,
    mode3d: true,
    autoExclude: true,
    exactRules: true,
    entryUnit: 'cm',
    rotation: 0, // how the plan is drawn: turned counter-clockwise by this many degrees
    northFrom: '', // compass bearing (° clockwise from north) of the direction northFrom → northTo
    northTo: '',
    northBearing: ''
};

export function emptyGarden(name = '') {
    return { points: [], measurements: [], lines: [], settings: { ...DEFAULT_SETTINGS, gardenName: name }, blocked: [], warnings: [] };
}

function num(value, fallback = 0) {
    if (value === '' || value === null || value === undefined) return fallback;
    const n = parseDistance(value);
    return Number.isFinite(n) ? n : typeof value === 'number' ? value : fallback;
}

function normHeader(h) {
    return String(h ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

// values: 2D array (first row = header). Returns { headers, rows: [{ record, rowNumber }] } with rowNumber 1-based.
export function tableToRecords(values) {
    const [headerRow = [], ...body] = values || [];
    const headers = headerRow.map(normHeader);
    const rows = [];
    body.forEach((row, i) => {
        if (!row || row.every(c => c === '' || c === null || c === undefined)) return;
        const record = {};
        headers.forEach((h, j) => {
            if (h) record[h] = row[j] ?? '';
        });
        rows.push({ record, rowNumber: i + 2 });
    });
    return { headers, rows };
}

// Builds a row array matching the sheet's header order.
export function recordToRow(headers, record) {
    return headers.map(h => (record[h] === undefined || record[h] === null ? '' : record[h]));
}

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : '');

// Shown on the plan? A point without the flag (gardens from before it existed) is shown; a measurement
// without it is a helper line. A measurement marked visible is a line of the plan itself (a wall, a fence…).
export function isPointShown(p) {
    return p?.visible !== false;
}

export function isMeasurementDrawn(m) {
    return m?.visible === true;
}

// A line without a reading ({ from, to, visible }) is drawn on purpose, so it is a line of the plan unless hidden.
export function isLineDrawn(l) {
    return l?.visible !== false;
}

export function lineToRecord(l) {
    return { from: l.from, to: l.to, visible: flagCell(l.visible), note: l.note || '' };
}

const flagCell = v => (v === true ? true : v === false ? false : '');

function parseFlag(value) {
    if (value === true || value === false) return value;
    const s = String(value ?? '').trim().toLowerCase();
    if (/^(true|yes|1|igen|x)$/.test(s)) return true;
    if (/^(false|no|0|nem)$/.test(s)) return false;
    return undefined;
}

export function pointToRecord(p) {
    return { name: p.name, category: p.category || '', notes: p.notes || '', sketch_x: round2(p.sketchX), sketch_y: round2(p.sketchY), visible: flagCell(p.visible) };
}

// Sheet record of a measurement. Distances keep the original columns only (kind, from_b, to_b stay
// empty), so sheets made before offsets and angles existed read them unchanged.
export function measurementToRecord(m) {
    const kind = kindOf(m);
    const dist = kind === 'distance';
    return {
        id: m.id,
        timestamp: m.timestamp || '',
        from: m.from,
        from_h: dist ? m.fromH || 0 : '',
        to: m.to,
        to_h: dist ? m.toH || 0 : '',
        distance: m.distance,
        status: m.status || 'active',
        note: m.note || '',
        visible: flagCell(m.visible),
        kind: dist ? '' : kind,
        from_b: dist ? '' : m.fromB,
        to_b: kind === 'angle' ? m.toB : ''
    };
}

// Signed number with a decimal point or comma (angles may be typed as −37).
function signedNum(value) {
    if (typeof value === 'number') return value;
    const s = String(value ?? '').trim().replace(',', '.');
    return /^[-+]?(\d*\.?\d+|\d+\.)$/.test(s) ? parseFloat(s) : NaN;
}

function parseSettings(rows) {
    const settings = { ...DEFAULT_SETTINGS };
    for (const { record } of rows) {
        const key = String(record.key ?? '').trim();
        if (!(key in DEFAULT_SETTINGS)) continue;
        const def = DEFAULT_SETTINGS[key];
        const raw = record.value;
        if (typeof def === 'boolean') settings[key] = raw === true || /^(true|1|yes|igen)$/i.test(String(raw).trim());
        else if (typeof def === 'number') settings[key] = num(raw, def);
        else if (Array.isArray(def)) {
            const list = String(raw).split(/[;\s]+/).map(s => num(s, NaN)).filter(Number.isFinite);
            settings[key] = list.length ? list : def;
        } else settings[key] = String(raw ?? '').trim();
    }
    return settings;
}

export function settingsToRows(settings) {
    return Object.keys(DEFAULT_SETTINGS).map(key => {
        const v = settings[key];
        return [key, Array.isArray(v) ? v.join(';') : v];
    });
}

// Parses the tabs' raw values into a garden. rowRefs keeps sheet row numbers for write-back.
export function gardenFromTables({ points, measurements, settings, blocked, lines = [] }) {
    const garden = emptyGarden();
    const warnings = garden.warnings;

    const pts = tableToRecords(points);
    const seen = new Set();
    for (const { record, rowNumber } of pts.rows) {
        const name = String(record.name ?? '').trim();
        if (!name) continue;
        if (seen.has(name)) {
            warnings.push({ key: 'warnDuplicatePoint', params: { name, row: rowNumber } });
            continue;
        }
        seen.add(name);
        const point = { name, category: String(record.category ?? '').trim(), notes: String(record.notes ?? '') };
        const sx = signedNum(record.sketch_x);
        const sy = signedNum(record.sketch_y);
        if (Number.isFinite(sx) && Number.isFinite(sy)) Object.assign(point, { sketchX: sx, sketchY: sy });
        const pv = parseFlag(record.visible);
        if (pv !== undefined) point.visible = pv;
        garden.points.push(point);
    }

    const ms = tableToRecords(measurements);
    const ids = new Set();
    for (const { record, rowNumber } of ms.rows) {
        const from = String(record.from ?? '').trim();
        const to = String(record.to ?? '').trim();
        const fromB = String(record.from_b ?? '').trim();
        const toB = String(record.to_b ?? '').trim();
        const kindText = String(record.kind ?? '').trim().toLowerCase();
        const kind = kindText === '' || kindText === 'distance' ? 'distance' : kindText;
        const raw = record.distance;
        let distance = kind === 'angle' ? signedNum(raw) : num(raw, NaN);
        if (kind === 'angle') distance = normalizeAngle(distance);
        let id = String(record.id ?? '').trim();
        const needsId = !id || ids.has(id);
        if (needsId) id = `row-${rowNumber}`;
        ids.add(id);
        const valid = kind === 'distance' ? from && to && distance > 0
            : kind === 'offset' ? from && fromB && to && distance >= 0
                : kind === 'angle' ? from && fromB && to && toB && Number.isFinite(distance)
                    : false;
        if (!valid || !Number.isFinite(distance)) {
            warnings.push({ key: 'warnBadMeasurement', params: { row: rowNumber } });
            continue;
        }
        for (const name of [from, to, fromB, toB].filter(Boolean)) {
            if (!seen.has(name)) {
                seen.add(name);
                garden.points.push({ name, category: '', notes: '' });
                warnings.push({ key: 'warnImplicitPoint', params: { name } });
            }
        }
        const status = String(record.status ?? '').trim().toLowerCase() === 'excluded' ? 'excluded' : 'active';
        const m = {
            id,
            needsId,
            timestamp: String(record.timestamp ?? ''),
            from,
            fromH: kind === 'distance' ? num(record.from_h, 0) : 0,
            to,
            toH: kind === 'distance' ? num(record.to_h, 0) : 0,
            distance,
            raw: typeof raw === 'string' && kind !== 'angle' ? raw : undefined,
            status,
            note: String(record.note ?? '')
        };
        const mv = parseFlag(record.visible);
        if (mv !== undefined) m.visible = mv;
        if (kind !== 'distance') Object.assign(m, { kind, fromB });
        if (kind === 'angle') m.toB = toB;
        garden.measurements.push(m);
    }

    // Lines without a reading: two points that form a wall, fence or side, usable in angles and offsets.
    const ls = tableToRecords(lines);
    const pairs = new Set();
    for (const { record } of ls.rows) {
        const from = String(record.from ?? '').trim();
        const to = String(record.to ?? '').trim();
        const key = from < to ? `${from}|${to}` : `${to}|${from}`;
        if (!from || !to || from === to || pairs.has(key)) continue;
        pairs.add(key);
        for (const name of [from, to]) {
            if (!seen.has(name)) {
                seen.add(name);
                garden.points.push({ name, category: '', notes: '' });
                warnings.push({ key: 'warnImplicitPoint', params: { name } });
            }
        }
        const line = { from, to, note: String(record.note ?? '') };
        const lv = parseFlag(record.visible);
        if (lv !== undefined) line.visible = lv;
        garden.lines.push(line);
    }

    garden.settings = parseSettings(tableToRecords(settings).rows);
    garden.blocked = tableToRecords(blocked).rows
        .map(({ record }) => ({ a: String(record.from ?? '').trim(), b: String(record.to ?? '').trim() }))
        .filter(p => p.a && p.b);
    garden.headers = {
        points: pts.headers.length ? pts.headers : HEADERS.points,
        measurements: ms.headers.length ? ms.headers : HEADERS.measurements,
        blocked: tableToRecords(blocked).headers.length ? tableToRecords(blocked).headers : HEADERS.blocked,
        lines: ls.headers.length ? ls.headers : HEADERS.lines
    };
    return garden;
}

// Solver input from a garden. prefer: a point just dragged on the plan, whose sketch wins mirror choices.
export function solverInput(garden, prefer = null) {
    const s = garden.settings;
    return {
        prefer,
        points: garden.points,
        measurements: garden.measurements,
        settings: {
            sigmaConst: s.sigmaConst,
            sigmaRel: s.sigmaRel,
            lineSigma: s.lineSigma,
            angleSigma: s.angleSigma,
            exactRules: s.exactRules,
            origin: s.origin,
            axis: s.axis,
            side: s.side,
            flip: s.flip
        }
    };
}

// The automatic datum (origin: the best-braced pair, axis: its best-linked neighbour) can move to other points
// as measurements are added, which turns the whole plan. The first choice is kept: returns the settings
// changes { origin, axis } to save, or null when both are set already (or nothing is placed yet).
export function datumToKeep(settings, solution) {
    const d = solution?.datum;
    if ((settings.origin && settings.axis) || !d?.origin || !d?.axis) return null;
    return { origin: d.origin, axis: d.axis };
}

// ---- Local file formats -------------------------------------------------------------------------

export function gardenToJson(garden) {
    const { points, measurements, lines = [], settings, blocked } = garden;
    return JSON.stringify({
        format: 'plantape-garden',
        version: 1,
        points,
        measurements: measurements.map(({ needsId, ...m }) => m),
        lines,
        settings,
        blocked
    }, null, 2);
}

export function gardenFromJson(text) {
    const data = JSON.parse(text);
    if (data.format !== 'plantape-garden') throw new Error('Not a plantape garden file');
    const garden = emptyGarden();
    garden.points = data.points || [];
    garden.measurements = data.measurements || [];
    garden.lines = data.lines || [];
    garden.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    garden.blocked = data.blocked || [];
    return garden;
}

// Minimal CSV parser (comma or semicolon separated, double-quoted fields).
export function parseCsv(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : firstLine.includes('\t') ? '\t' : ',';
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') {
                field += '"';
                i++;
            } else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"') quoted = true;
        else if (c === sep) {
            row.push(field);
            field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else field += c;
    }
    if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

// A CSV with the Measurements columns (at least from, to, distance) becomes a garden.
export function gardenFromCsv(text) {
    return gardenFromTables({ points: [], measurements: parseCsv(text), settings: [], blocked: [] });
}

export function toCsv(rows) {
    return rows.map(r => r.map(v => {
        const s = String(v ?? '');
        return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');
}
