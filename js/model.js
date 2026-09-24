// Garden data model and its mapping to spreadsheet tabs.

import { parseDistance } from './solver/blunders.js';

export const TABS = {
    points: 'Points',
    measurements: 'Measurements',
    settings: 'Settings',
    blocked: 'Blocked'
};

export const HEADERS = {
    points: ['name', 'category', 'notes', 'x', 'y', 'z', 'sigma_xy', 'sigma_z', 'links', 'status'],
    measurements: ['id', 'timestamp', 'from', 'from_h', 'to', 'to_h', 'distance', 'status', 'residual', 'w', 'flag', 'note'],
    settings: ['key', 'value'],
    blocked: ['from', 'to', 'note']
};

export const CATEGORIES = ['building', 'tree', 'shrub', 'fence', 'path', 'water', 'other'];

export const DEFAULT_SETTINGS = {
    gardenName: '',
    tapeLength: 30,
    sigmaConst: 0.005,
    sigmaRel: 0.002,
    heights: [0, 1, 2],
    origin: '',
    axis: '',
    side: '',
    flip: false,
    mode3d: true,
    autoExclude: true,
    entryUnit: 'cm'
};

export function emptyGarden(name = '') {
    return { points: [], measurements: [], settings: { ...DEFAULT_SETTINGS, gardenName: name }, blocked: [], warnings: [] };
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

export function pointToRecord(p) {
    return { name: p.name, category: p.category || '', notes: p.notes || '' };
}

export function measurementToRecord(m) {
    return {
        id: m.id,
        timestamp: m.timestamp || '',
        from: m.from,
        from_h: m.fromH || 0,
        to: m.to,
        to_h: m.toH || 0,
        distance: m.distance,
        status: m.status || 'active',
        note: m.note || ''
    };
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

// Parses the four tabs' raw values into a garden. rowRefs keeps sheet row numbers for write-back.
export function gardenFromTables({ points, measurements, settings, blocked }) {
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
        garden.points.push({ name, category: String(record.category ?? '').trim(), notes: String(record.notes ?? '') });
    }

    const ms = tableToRecords(measurements);
    const ids = new Set();
    for (const { record, rowNumber } of ms.rows) {
        const from = String(record.from ?? '').trim();
        const to = String(record.to ?? '').trim();
        const raw = record.distance;
        const distance = num(raw, NaN);
        let id = String(record.id ?? '').trim();
        const needsId = !id || ids.has(id);
        if (needsId) id = `row-${rowNumber}`;
        ids.add(id);
        if (!from || !to || !Number.isFinite(distance) || distance <= 0) {
            warnings.push({ key: 'warnBadMeasurement', params: { row: rowNumber } });
            continue;
        }
        for (const name of [from, to]) {
            if (!seen.has(name)) {
                seen.add(name);
                garden.points.push({ name, category: '', notes: '' });
                warnings.push({ key: 'warnImplicitPoint', params: { name } });
            }
        }
        const status = String(record.status ?? '').trim().toLowerCase() === 'excluded' ? 'excluded' : 'active';
        garden.measurements.push({
            id,
            needsId,
            timestamp: String(record.timestamp ?? ''),
            from,
            fromH: num(record.from_h, 0),
            to,
            toH: num(record.to_h, 0),
            distance,
            raw: typeof raw === 'string' ? raw : undefined,
            status,
            note: String(record.note ?? '')
        });
    }

    garden.settings = parseSettings(tableToRecords(settings).rows);
    garden.blocked = tableToRecords(blocked).rows
        .map(({ record }) => ({ a: String(record.from ?? '').trim(), b: String(record.to ?? '').trim() }))
        .filter(p => p.a && p.b);
    garden.headers = {
        points: pts.headers.length ? pts.headers : HEADERS.points,
        measurements: ms.headers.length ? ms.headers : HEADERS.measurements,
        blocked: tableToRecords(blocked).headers.length ? tableToRecords(blocked).headers : HEADERS.blocked
    };
    return garden;
}

// Solver input from a garden.
export function solverInput(garden) {
    const s = garden.settings;
    return {
        points: garden.points,
        measurements: garden.measurements,
        settings: {
            sigmaConst: s.sigmaConst,
            sigmaRel: s.sigmaRel,
            origin: s.origin,
            axis: s.axis,
            side: s.side,
            flip: s.flip
        }
    };
}

// ---- Local file formats -------------------------------------------------------------------------

export function gardenToJson(garden) {
    const { points, measurements, settings, blocked } = garden;
    return JSON.stringify({
        format: 'plantape-garden',
        version: 1,
        points,
        measurements: measurements.map(({ needsId, ...m }) => m),
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
