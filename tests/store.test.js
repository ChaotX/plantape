// GoogleStore against an in-memory fake of the Sheets REST API (no network, no Google account needed).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// ---- Browser globals the store expects -----------------------------------------------------------
function memoryStorage() {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
        clear: () => m.clear()
    };
}
globalThis.localStorage = memoryStorage();
globalThis.sessionStorage = memoryStorage();
sessionStorage.setItem('plantape:token', JSON.stringify({ token: 'fake-token', expiresAt: Date.now() + 3600e3 }));
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
try {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
} catch {
    globalThis.navigator = { onLine: true };
}

// ---- Fake Sheets API ------------------------------------------------------------------------------
const books = new Map();
let offline = false;

function colIndex(letters) {
    let n = 0;
    for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
    return n - 1;
}

function parseRange(range) {
    const m = /^'((?:[^']|'')+)'(?:!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?)?$/.exec(range);
    if (!m) throw new Error(`bad range ${range}`);
    return {
        title: m[1].replace(/''/g, "'"),
        c1: m[2] ? colIndex(m[2]) : 0,
        r1: m[3] ? Number(m[3]) - 1 : 0,
        c2: m[4] ? colIndex(m[4]) : m[2] && !m[3] ? colIndex(m[2]) : Infinity,
        r2: m[5] ? Number(m[5]) - 1 : Infinity
    };
}

function trimRows(rows) {
    const out = rows.map(r => {
        const copy = r.slice();
        while (copy.length && (copy[copy.length - 1] === '' || copy[copy.length - 1] === undefined)) copy.pop();
        return copy;
    });
    while (out.length && out[out.length - 1].length === 0) out.pop();
    return out;
}

// Tab ids: the position of the tab in the book's map, plus 1.
function sheetIdOf(book, title) {
    return [...book.sheets.keys()].indexOf(title) + 1;
}

function titleOf(book, sheetId) {
    return [...book.sheets.keys()][sheetId - 1];
}

function reply(obj, status = 200) {
    return { ok: status < 400, status, json: async () => obj };
}

globalThis.fetch = async (url, opts = {}) => {
    if (offline) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace('/v4/spreadsheets', ''));
    const body = opts.body ? JSON.parse(opts.body) : null;
    const method = opts.method || 'GET';
    if (method === 'POST' && path === '') {
        const id = `sheet${books.size + 1}`;
        const sheets = new Map();
        for (const s of body.sheets) {
            sheets.set(s.properties.title, (s.data?.[0]?.rowData || []).map(r => r.values.map(v => {
                const e = v.userEnteredValue;
                return e.numberValue ?? e.boolValue ?? e.stringValue;
            })));
        }
        books.set(id, { title: body.properties.title, sheets });
        return reply({ spreadsheetId: id });
    }
    const m = /^\/([^/:]+)(.*)$/.exec(path);
    const book = books.get(m[1]);
    if (!book) return reply({ error: { message: 'not found' } }, 404);
    const rest = m[2];
    if (method === 'GET' && rest === '') {
        return reply({
            properties: { title: book.title },
            spreadsheetUrl: `https://fake/${m[1]}`,
            sheets: [...book.sheets.keys()].map(title => ({ properties: { title, sheetId: sheetIdOf(book, title) }, charts: (book.charts || []).filter(c => c.sheetId === sheetIdOf(book, title)).map(c => ({ chartId: c.chartId })) }))
        });
    }
    if (method === 'GET' && rest === '/values:batchGet') {
        const ranges = u.searchParams.getAll('ranges').map(parseRange);
        return reply({
            valueRanges: ranges.map(r => {
                const rows = book.sheets.get(r.title) || [];
                return { values: trimRows(rows.slice(r.r1, r.r2 === Infinity ? undefined : r.r2 + 1).map(row => row.slice(r.c1, r.c2 === Infinity ? undefined : r.c2 + 1))) };
            })
        });
    }
    if (method === 'POST' && rest.endsWith(':append')) {
        const r = parseRange(rest.slice('/values/'.length, -':append'.length));
        const rows = book.sheets.get(r.title);
        const start = trimRows(rows).length;
        body.values.forEach((v, i) => { rows[start + i] = v.slice(); });
        return reply({ updates: { updatedRange: `'${r.title}'!A${start + 1}:Z${start + body.values.length}` } });
    }
    if (method === 'POST' && rest === '/values:batchUpdate') {
        for (const d of body.data) {
            const r = parseRange(d.range);
            const rows = book.sheets.get(r.title);
            d.values.forEach((vals, i) => {
                const row = rows[r.r1 + i] || (rows[r.r1 + i] = []);
                vals.forEach((v, j) => { row[r.c1 + j] = v; });
            });
        }
        return reply({});
    }
    if (method === 'POST' && rest.endsWith(':clear')) {
        const r = parseRange(rest.slice('/values/'.length, -':clear'.length));
        const rows = book.sheets.get(r.title);
        for (let i = r.r1; i < rows.length && i <= r.r2; i++) {
            for (let j = r.c1; j < (rows[i] || []).length && j <= r.c2; j++) rows[i][j] = '';
        }
        return reply({});
    }
    if (method === 'POST' && rest === ':batchUpdate') {
        const replies = [];
        book.charts ||= [];
        for (const req of body.requests) {
            if (req.addSheet) {
                book.sheets.set(req.addSheet.properties.title, []);
                replies.push({ addSheet: { properties: { ...req.addSheet.properties, sheetId: sheetIdOf(book, req.addSheet.properties.title) } } });
                continue;
            }
            if (req.deleteDimension) {
                const { sheetId, startIndex, endIndex } = req.deleteDimension.range;
                book.sheets.get(titleOf(book, sheetId)).splice(startIndex, endIndex - startIndex);
            } else if (req.addChart) {
                const chartId = book.charts.length + 100;
                book.charts.push({ chartId, sheetId: req.addChart.chart.position.overlayPosition.anchorCell.sheetId, chart: req.addChart.chart });
            } else if (req.deleteEmbeddedObject) {
                book.charts = book.charts.filter(c => c.chartId !== req.deleteEmbeddedObject.objectId);
            } else if (req.updateCells) {
                const { sheetId, rowIndex, columnIndex } = req.updateCells.start;
                const rows = book.sheets.get(titleOf(book, sheetId));
                req.updateCells.rows.forEach((r, i) => r.values.forEach((cell, j) => {
                    const row = rows[rowIndex + i] || (rows[rowIndex + i] = []);
                    row[columnIndex + j] = cell.userEnteredValue?.stringValue;
                    (book.links ||= {})[`${titleOf(book, sheetId)}!${rowIndex + i}:${columnIndex + j}`] = cell.userEnteredFormat?.textFormat?.link?.uri;
                }));
            } else throw new Error(`unhandled request ${Object.keys(req)}`);
            replies.push({});
        }
        return reply({ replies });
    }
    throw new Error(`unhandled ${method} ${path}`);
};

// ---- Tests ----------------------------------------------------------------------------------------
let GoogleStore;
let solverInput;
let snoop;
before(async () => {
    ({ GoogleStore } = await import('../js/store.js'));
    ({ solverInput } = await import('../js/model.js'));
    ({ snoop } = await import('../js/solver/blunders.js'));
});

const sheetRows = (id, title) => books.get(id).sheets.get(title);

async function seededStore() {
    const store = await GoogleStore.create('Test');
    await store.load();
    for (const name of ['A', 'B', 'C', 'D']) store.addPoint({ name, category: 'tree', notes: '' });
    const ms = [['A', 'B', 10], ['A', 'C', 8], ['B', 'C', 6], ['A', 'D', 6.403], ['B', 'D', 7.81], ['C', 'D', 10.09]];
    ms.forEach(([from, to, distance], i) => store.addMeasurement({ id: `m${i}`, timestamp: 't', from, fromH: 0, to, toH: 0, distance, status: 'active', note: '' }));
    await store.flush();
    return store;
}

test('create + live append + reload round-trip', async () => {
    const store = await seededStore();
    assert.equal(store.sync.state, 'ok');
    assert.equal(sheetRows(store.id, 'Points').length, 5);
    assert.deepEqual(sheetRows(store.id, 'Measurements')[1].slice(0, 7), ['m0', 't', 'A', 0, 'B', 0, 10]);
    const again = new GoogleStore(store.id);
    const garden = await again.load();
    assert.equal(garden.points.length, 4);
    assert.equal(garden.measurements.length, 6);
    assert.equal(garden.settings.gardenName, 'Test');
});

test('offline changes are queued and flushed later', async () => {
    const store = await seededStore();
    offline = true;
    await store.addMeasurement({ id: 'late', timestamp: 't', from: 'A', fromH: 0, to: 'B', toH: 0, distance: 10.001, status: 'active', note: '' });
    assert.equal(store.sync.state, 'offline');
    assert.equal(store.queue.length, 1);
    assert.equal(JSON.parse(localStorage.getItem(`plantape:queue:${store.id}`)).length, 1);
    // A fresh store (e.g. after a reload while still offline) starts from the cache plus the queue.
    const cachedStore = new GoogleStore(store.id);
    const cached = await cachedStore.load();
    assert.ok(cachedStore.offlineLoaded);
    assert.ok(cached.measurements.some(m => m.id === 'late'));
    offline = false;
    assert.equal(await store.flush(), true);
    assert.equal(store.sync.state, 'ok');
    assert.ok(sheetRows(store.id, 'Measurements').some(r => r[0] === 'late'));
});

test('excluding a measurement updates its status cell', async () => {
    const store = await seededStore();
    await store.updateMeasurement('m2', { status: 'excluded' });
    const row = sheetRows(store.id, 'Measurements').find(r => r[0] === 'm2');
    assert.equal(row[7], 'excluded');
});

test('settings are rewritten as key/value rows', async () => {
    const store = await seededStore();
    await store.saveSettings({ ...store.garden.settings, origin: 'B', tapeLength: 50, heights: [0, 1.5] });
    const again = new GoogleStore(store.id);
    const garden = await again.load();
    assert.equal(garden.settings.origin, 'B');
    assert.equal(garden.settings.tapeLength, 50);
    assert.deepEqual(garden.settings.heights, [0, 1.5]);
});

test('write-back fills coordinates, residuals and flags', async () => {
    const store = await seededStore();
    store.addMeasurement({ id: 'typo', timestamp: 't', from: 'B', fromH: 0, to: 'D', toH: 0, distance: 8.81, status: 'active', note: '' });
    const res = snoop(solverInput(store.garden));
    assert.deepEqual(res.suspects.map(s => s.id), ['typo']);
    await store.writeResults(res.solution, res.suspects);
    const points = sheetRows(store.id, 'Points');
    const header = points[0];
    const d = points.find(r => r[0] === 'D');
    assert.ok(Math.abs(d[header.indexOf('x')] - 4) < 0.01);
    assert.ok(Math.abs(d[header.indexOf('y')] + 5) < 0.01 || Math.abs(d[header.indexOf('y')] - 5) < 0.01);
    const ms = sheetRows(store.id, 'Measurements');
    const flagCol = ms[0].indexOf('flag');
    assert.equal(ms.find(r => r[0] === 'typo')[flagCol], 'suspect');
});

test('hand-made sheet: missing tabs are added, rows without id get one on write-back', async () => {
    const id = 'manual';
    books.set(id, {
        title: 'My garden',
        sheets: new Map([['Measurements', [
            ['From', 'To', 'Distance'],
            ['A', 'B', '10'],
            ['A', 'C', '8,0'],
            ['B', 'C', 6]
        ]]])
    });
    const store = new GoogleStore(id);
    const garden = await store.load();
    assert.ok(books.get(id).sheets.has('Points') && books.get(id).sheets.has('Settings'));
    assert.equal(garden.points.length, 3);
    assert.deepEqual(garden.measurements.map(m => m.distance), [10, 8, 6]);
    assert.equal(garden.settings.gardenName, 'My garden');
    const res = snoop(solverInput(garden));
    await store.writeResults(res.solution, res.suspects);
    const ms = sheetRows(id, 'Measurements');
    const idCol = ms[0].indexOf('id');
    assert.ok(idCol >= 0, 'id column added');
    assert.ok(ms.slice(1).every(r => /^m-/.test(r[idCol])), 'every row got an id');
    assert.ok(ms[0].includes('residual'));
    assert.ok(store.garden.measurements.every(m => /^m-/.test(m.id)), 'in-memory ids follow');
    // Excluding adds the missing status column.
    await store.updateMeasurement(store.garden.measurements[0].id, { status: 'excluded' });
    const after = sheetRows(id, 'Measurements');
    assert.equal(after[1][after[0].indexOf('status')], 'excluded');
});

test('offsets and angles round-trip, adding their columns to an old sheet', async () => {
    const id = 'old-columns';
    books.set(id, {
        title: 'Old garden',
        sheets: new Map([['Measurements', [
            ['id', 'from', 'to', 'distance', 'status'],
            ['m1', 'A', 'B', '10', ''],
            ['m2', 'B', 'C', '6', ''],
            ['m3', 'C', 'D', '10', ''],
            ['m4', 'D', 'A', '6', '']
        ]]])
    });
    const store = new GoogleStore(id);
    await store.load();
    await store.addMeasurement({ id: 'ang', timestamp: 't', kind: 'angle', from: 'A', fromB: 'B', to: 'B', toB: 'C', distance: 90, status: 'active', note: '' });
    await store.addMeasurement({ id: 'off', timestamp: 't', kind: 'offset', from: 'A', fromB: 'B', to: 'E', distance: 0, status: 'active', note: '' });
    const header = sheetRows(id, 'Measurements')[0];
    assert.ok(['kind', 'from_b', 'to_b'].every(c => header.includes(c)), header.join());
    const garden = await new GoogleStore(id).load();
    const ang = garden.measurements.find(m => m.id === 'ang');
    assert.deepEqual([ang.kind, ang.from, ang.fromB, ang.to, ang.toB, ang.distance], ['angle', 'A', 'B', 'B', 'C', 90]);
    const off = garden.measurements.find(m => m.id === 'off');
    assert.deepEqual([off.kind, off.fromB, off.to, off.distance], ['offset', 'B', 'E', 0]);
    assert.ok(garden.points.some(p => p.name === 'E'));
    assert.equal(garden.measurements.find(m => m.id === 'm1').kind, undefined);
});

test('hand-typed angles are normalised to [0, 180)', async () => {
    const id = 'angles';
    books.set(id, {
        title: 'Angles',
        sheets: new Map([['Measurements', [
            ['kind', 'from', 'from_b', 'to', 'to_b', 'distance'],
            ['angle', 'A', 'B', 'C', 'D', '180'],
            ['angle', 'A', 'B', 'C', 'D', '-37'],
            ['angle', 'A', 'B', 'C', '', '90'],
            ['offset', 'A', 'B', 'C', '', '1,5']
        ]]])
    });
    const garden = await new GoogleStore(id).load();
    assert.deepEqual(garden.measurements.map(m => m.distance), [0, 143, 1.5]);
    assert.ok(garden.warnings.some(w => w.key === 'warnBadMeasurement'));
});

test('sketch positions are written to the point row; queued moves of a point are merged', async () => {
    const store = await seededStore();
    await store.updatePoint('C', { sketchX: 1.234, sketchY: -5 });
    let rows = sheetRows(store.id, 'Points');
    let row = rows.find(r => r[0] === 'C');
    assert.equal(row[rows[0].indexOf('sketch_x')], 1.23);
    assert.equal(row[rows[0].indexOf('sketch_y')], -5);
    const flush = store.flush;
    store.flush = async () => false; // hold the queue, as while offline
    await store.updatePoint('D', { sketchX: 1, sketchY: 1 });
    await store.updatePoint('D', { sketchX: 2, sketchY: 2 });
    await store.updatePoint('A', { sketchX: 0, sketchY: 0 });
    assert.equal(store.queue.filter(q => q.type === 'updatePoint' && q.name === 'D').length, 1);
    store.flush = flush;
    await store.flush();
    rows = sheetRows(store.id, 'Points');
    row = rows.find(r => r[0] === 'D');
    assert.equal(row[rows[0].indexOf('sketch_x')], 2);
    const garden = await new GoogleStore(store.id).load();
    const d = garden.points.find(p => p.name === 'D');
    assert.deepEqual([d.sketchX, d.sketchY], [2, 2]);
});

test('showing and hiding points and measurements writes the visible column', async () => {
    const store = await seededStore();
    await store.updatePoint('A', { visible: true });
    await store.updateMeasurement('m1', { visible: true });
    await store.addMeasurement({ id: 'mv', timestamp: 't', from: 'C', fromH: 0, to: 'D', toH: 0, distance: 10.09, status: 'active', note: '', visible: false });
    const pts = sheetRows(store.id, 'Points');
    assert.equal(pts.find(r => r[0] === 'A')[pts[0].indexOf('visible')], true);
    const ms = sheetRows(store.id, 'Measurements');
    const col = ms[0].indexOf('visible');
    assert.equal(ms.find(r => r[0] === 'm1')[col], true);
    assert.equal(ms.find(r => r[0] === 'mv')[col], false);
    const garden = await new GoogleStore(store.id).load();
    assert.equal(garden.points.find(p => p.name === 'A').visible, true);
    assert.equal(garden.points.find(p => p.name === 'B').visible, undefined);
    assert.equal(garden.measurements.find(m => m.id === 'm1').visible, true);
    assert.equal(garden.measurements.find(m => m.id === 'mv').visible, false);
});

test('deleting a measurement and a point removes their rows', async () => {
    const store = await seededStore();
    await store.deleteMeasurement('m2');
    const ms = sheetRows(store.id, 'Measurements');
    assert.equal(ms.length, 6);
    assert.ok(!ms.some(r => r[0] === 'm2'));
    assert.ok(!store.garden.measurements.some(m => m.id === 'm2'));
    for (const m of store.garden.measurements.filter(x => x.from === 'D' || x.to === 'D')) await store.deleteMeasurement(m.id);
    await store.deletePoint('D');
    assert.deepEqual(sheetRows(store.id, 'Points').slice(1).map(r => r[0]), ['A', 'B', 'C']);
    const again = await new GoogleStore(store.id).load();
    assert.deepEqual(again.points.map(p => p.name), ['A', 'B', 'C']);
    assert.deepEqual(again.measurements.map(m => m.id), ['m0', 'm1']);
});

test('deletes queued offline are sent later', async () => {
    const store = await seededStore();
    offline = true;
    await store.deleteMeasurement('m0');
    assert.equal(store.queue.length, 1);
    assert.ok(sheetRows(store.id, 'Measurements').some(r => r[0] === 'm0'));
    offline = false;
    assert.equal(await store.flush(), true);
    assert.ok(!sheetRows(store.id, 'Measurements').some(r => r[0] === 'm0'));
});

test('rows typed by hand without id: deleting one does not hit the wrong row later', async () => {
    const id = 'manual-delete';
    books.set(id, {
        title: 'Typed',
        sheets: new Map([['Measurements', [
            ['from', 'to', 'distance', 'status'],
            ['A', 'B', 10, ''],
            ['A', 'C', 8, ''],
            ['B', 'C', 6, '']
        ]]])
    });
    const store = new GoogleStore(id);
    const garden = await store.load();
    const [ab, , bc] = garden.measurements.map(m => m.id);
    assert.equal(ab, 'row-2');
    offline = true; // queue both, so the second is sent after the first shifted the rows
    await store.deleteMeasurement(ab);
    await store.updateMeasurement(bc, { status: 'excluded' });
    offline = false;
    assert.equal(await store.flush(), true);
    const rows = sheetRows(id, 'Measurements');
    const h = rows[0];
    assert.deepEqual(rows.slice(1).map(r => [r[h.indexOf('from')], r[h.indexOf('to')], r[h.indexOf('status')]]), [['A', 'C', ''], ['B', 'C', 'excluded']]);
    assert.ok(rows.slice(1).every(r => /^m-/.test(r[h.indexOf('id')])), 'remaining rows got ids');
    assert.ok(store.garden.measurements.every(m => /^m-/.test(m.id)));
});

test('write-back adds the Plan tab with the app link and one chart', async () => {
    const store = await seededStore();
    store.updateMeasurement('m0', { visible: true });
    const res = snoop(solverInput(store.garden));
    const plan = { appUrl: 'https://example.test/plantape/?sheet=x', labels: { link: 'Open', note: 'Note', title: 'Test', x: 'x', points: 'P', lines: 'L', helpers: 'H' } };
    await store.writeResults(res.solution, res.suspects, plan);
    await store.writeResults(res.solution, res.suspects, plan);
    const book = books.get(store.id);
    const tab = sheetRows(store.id, 'Plan');
    assert.equal(tab[0][0], 'Open');
    assert.equal(book.links['Plan!0:0'], plan.appUrl);
    assert.equal(tab[1][0], 'Note');
    assert.deepEqual(tab[3], ['x', 'P', 'L', 'H', '']);
    assert.deepEqual(tab.slice(4, 8).map(r => r[4]), ['A', 'B', 'C', 'D']);
    assert.equal(book.charts.length, 1, 'the chart is replaced, not added again');
    const chart = book.charts[0].chart.spec.basicChart;
    assert.equal(chart.chartType, 'SCATTER');
    assert.equal(chart.series.length, 3, 'points, the drawn line A–B and helper lines');
});
