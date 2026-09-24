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
        return reply({ properties: { title: book.title }, spreadsheetUrl: `https://fake/${m[1]}`, sheets: [...book.sheets.keys()].map(title => ({ properties: { title } })) });
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
        for (const req of body.requests) if (req.addSheet) book.sheets.set(req.addSheet.properties.title, []);
        return reply({});
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
