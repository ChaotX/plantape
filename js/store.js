// Garden persistence: a local (browser-only) store and a Google Sheets store with an offline queue.
// Both expose the same mutation API; every mutation is applied to the in-memory garden immediately.

import {
    TABS, HEADERS, emptyGarden, gardenFromTables, gardenFromJson, gardenToJson, recordToRow,
    pointToRecord, measurementToRecord, settingsToRows, DEFAULT_SETTINGS
} from './model.js';
import * as sheets from './sheets-api.js';
import { HttpError, quoteSheet, columnLetter } from './sheets-api.js';
import { PLAN_TAB, PLAN_FIRST_ROW, PLAN_COLUMNS, planTable, planChart } from './sheet-plan.js';
import { storage, uid } from './util.js';

const RECENT_KEY = 'plantape:recent';

export function recentGardens() {
    return storage.get(RECENT_KEY, []);
}

export function rememberGarden(entry) {
    const list = recentGardens().filter(g => !(g.type === entry.type && g.id === entry.id));
    list.unshift({ ...entry, openedAt: Date.now() });
    storage.set(RECENT_KEY, list.slice(0, 12));
}

export function forgetGarden(type, id) {
    storage.set(RECENT_KEY, recentGardens().filter(g => !(g.type === type && g.id === id)));
    if (type === 'local') storage.remove(`plantape:local:${id}`);
}

function applyOp(garden, op) {
    switch (op.type) {
        case 'addPoint':
            if (!garden.points.some(p => p.name === op.point.name)) garden.points.push({ ...op.point });
            break;
        case 'addMeasurement':
            if (!garden.measurements.some(m => m.id === op.measurement.id)) garden.measurements.push({ ...op.measurement });
            break;
        case 'updateMeasurement': {
            const m = garden.measurements.find(x => x.id === op.id);
            if (m) Object.assign(m, op.changes);
            break;
        }
        case 'updatePoint': {
            const p = garden.points.find(x => x.name === op.name);
            if (p) Object.assign(p, op.changes);
            break;
        }
        case 'deleteMeasurement':
            garden.measurements = garden.measurements.filter(m => m.id !== op.id);
            break;
        case 'deletePoint':
            garden.points = garden.points.filter(p => p.name !== op.name);
            break;
        case 'addBlocked':
            garden.blocked.push({ a: op.a, b: op.b });
            break;
        case 'saveSettings':
            garden.settings = { ...op.settings };
            break;
        default:
            break;
    }
}

class BaseStore {
    constructor() {
        this.garden = emptyGarden();
        this.listeners = new Set();
        this.sync = { state: 'ok', pending: 0, message: '' };
    }

    onSync(fn) {
        this.listeners.add(fn);
    }

    setSync(state, message = '') {
        this.sync = { state, pending: this.pendingCount(), message };
        for (const fn of this.listeners) fn(this.sync);
    }

    pendingCount() {
        return 0;
    }

    // fn(op) after every change of the garden.
    onChange(fn) {
        (this.changeListeners ||= new Set()).add(fn);
    }

    mutate(op) {
        applyOp(this.garden, op);
        for (const fn of this.changeListeners || []) fn(op);
        return this.persist(op);
    }

    addPoint(point) {
        return this.mutate({ type: 'addPoint', point });
    }

    addMeasurement(measurement) {
        return this.mutate({ type: 'addMeasurement', measurement });
    }

    updateMeasurement(id, changes) {
        return this.mutate({ type: 'updateMeasurement', id, changes });
    }

    // changes: { sketchX, sketchY, category, notes }
    updatePoint(name, changes) {
        return this.mutate({ type: 'updatePoint', name, changes });
    }

    deleteMeasurement(id) {
        return this.mutate({ type: 'deleteMeasurement', id });
    }

    // Only the point itself; the caller deletes the measurements that use it first.
    deletePoint(name) {
        return this.mutate({ type: 'deletePoint', name });
    }

    addBlocked(a, b) {
        return this.mutate({ type: 'addBlocked', a, b });
    }

    saveSettings(settings) {
        return this.mutate({ type: 'saveSettings', settings: { ...settings } });
    }
}

// ---- Local store --------------------------------------------------------------------------------

export class LocalStore extends BaseStore {
    constructor(id) {
        super();
        this.type = 'local';
        this.id = id;
    }

    static create(name) {
        const store = new LocalStore(uid('local'));
        store.garden = emptyGarden(name);
        store.save();
        return store;
    }

    static fromGarden(garden, name) {
        const store = new LocalStore(uid('local'));
        store.garden = garden;
        if (name && !garden.settings.gardenName) garden.settings.gardenName = name;
        store.save();
        return store;
    }

    get title() {
        return this.garden.settings.gardenName || this.id;
    }

    async load() {
        const text = storage.get(`plantape:local:${this.id}`);
        if (!text) throw new Error('Local garden not found');
        this.garden = gardenFromJson(text);
        this.setSync('local');
        return this.garden;
    }

    save() {
        const ok = storage.set(`plantape:local:${this.id}`, gardenToJson(this.garden));
        this.setSync(ok ? 'local' : 'error', ok ? '' : 'Browser storage is full or disabled');
    }

    async persist() {
        this.save();
    }

    async writeResults() {
        // Results are always recomputed locally; nothing to write.
    }
}

// ---- Google Sheets store ------------------------------------------------------------------------

function isNetworkError(error) {
    return !(error instanceof HttpError) && (error?.name === 'TypeError' || error?.name === 'AbortError' || !navigator.onLine);
}

export class GoogleStore extends BaseStore {
    constructor(spreadsheetId) {
        super();
        this.type = 'google';
        this.id = spreadsheetId;
        this.queueKey = `plantape:queue:${spreadsheetId}`;
        this.cacheKey = `plantape:cache:${spreadsheetId}`;
        this.queue = storage.get(this.queueKey, []);
        this.sheetTitle = '';
        this.url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
        this.flushing = null;
        this.onlineHandler = () => this.flush();
        window.addEventListener('online', this.onlineHandler);
    }

    dispose() {
        window.removeEventListener('online', this.onlineHandler);
    }

    get title() {
        return this.garden.settings.gardenName || this.sheetTitle || this.id;
    }

    pendingCount() {
        return this.queue.length;
    }

    static async create(name) {
        const tabs = [
            { title: TABS.points, rows: [HEADERS.points] },
            { title: TABS.measurements, rows: [HEADERS.measurements] },
            { title: TABS.settings, rows: [HEADERS.settings, ...settingsToRows({ ...DEFAULT_SETTINGS, gardenName: name })] },
            { title: TABS.blocked, rows: [HEADERS.blocked] }
        ];
        const res = await sheets.createSpreadsheet(`PlanTape – ${name}`, tabs);
        return new GoogleStore(res.spreadsheetId);
    }

    async load() {
        try {
            const meta = await this.readMeta();
            this.sheetTitle = meta.properties?.title || '';
            if (meta.spreadsheetUrl) this.url = meta.spreadsheetUrl;
            const titles = new Set((meta.sheets || []).map(s => s.properties.title));
            const missing = [];
            for (const [key, title] of Object.entries(TABS)) {
                if (titles.has(title)) continue;
                const rows = [HEADERS[key]];
                if (key === 'settings') rows.push(...settingsToRows({ ...DEFAULT_SETTINGS, gardenName: this.sheetTitle }));
                missing.push({ title, rows });
            }
            await sheets.addTabs(this.id, missing);
            if (missing.length) this.sheetIds = null; // read again when a row is deleted
            const [points, measurements, settings, blocked] = await sheets.batchGet(this.id, Object.values(TABS).map(quoteSheet));
            this.garden = gardenFromTables({ points, measurements, settings, blocked });
            if (!this.garden.settings.gardenName) this.garden.settings.gardenName = this.sheetTitle;
            this.saveCache();
            this.offlineLoaded = false;
        } catch (error) {
            const cached = storage.get(this.cacheKey);
            if (!isNetworkError(error) || !cached) throw error;
            this.garden = { ...gardenFromJson(cached.garden), headers: cached.headers, warnings: [] };
            this.sheetTitle = cached.title || '';
            this.offlineLoaded = true;
        }
        for (const op of this.queue) applyOp(this.garden, op);
        this.setSync(this.queue.length ? 'pending' : 'ok');
        this.flush();
        return this.garden;
    }

    // Spreadsheet metadata; keeps the tab ids (needed to delete rows) and the charts of each tab.
    async readMeta() {
        const meta = await sheets.getSpreadsheet(this.id);
        this.sheetIds = new Map((meta.sheets || []).map(s => [s.properties.title, s.properties.sheetId]));
        return meta;
    }

    async deleteRow(tab, row) {
        if (!this.sheetIds?.has(tab)) await this.readMeta();
        const sheetId = this.sheetIds.get(tab);
        if (sheetId === undefined) return;
        await sheets.batchUpdate(this.id, [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }]);
    }

    saveCache() {
        storage.set(this.cacheKey, { garden: gardenToJson(this.garden), headers: this.garden.headers, title: this.sheetTitle });
    }

    async persist(op) {
        if (op.type === 'saveSettings') this.queue = this.queue.filter(q => q.type !== 'saveSettings');
        if (op.type === 'updatePoint') {
            // Repeated moves of the same point: send only the latest (the one being sent now stays).
            const busy = this.flushing ? this.queue[0] : null;
            this.queue = this.queue.filter(q => {
                if (q === busy || q.type !== 'updatePoint' || q.name !== op.name) return true;
                op = { ...op, changes: { ...q.changes, ...op.changes } };
                return false;
            });
        }
        this.queue.push(op);
        storage.set(this.queueKey, this.queue);
        this.saveCache();
        this.setSync('pending');
        return this.flush();
    }

    flush() {
        if (this.flushing) return this.flushing;
        this.flushing = (async () => {
            while (this.queue.length) {
                this.setSync('syncing');
                try {
                    await this.execute(this.queue[0]);
                } catch (error) {
                    if (isNetworkError(error)) this.setSync('offline');
                    else if (error instanceof HttpError && (error.status === 401 || error.status === 403)) this.setSync('auth', error.message);
                    else if (/popup|sign-in|access_denied|interaction/i.test(error.message)) this.setSync('auth', error.message);
                    else this.setSync('error', error.message);
                    return false;
                }
                this.queue.shift();
                storage.set(this.queueKey, this.queue);
            }
            this.saveCache();
            this.setSync('ok');
            return true;
        })().finally(() => {
            this.flushing = null;
        });
        return this.flushing;
    }

    headers(key) {
        return this.garden.headers?.[key] || HEADERS[key];
    }

    async execute(op) {
        switch (op.type) {
            case 'addPoint':
                if (Number.isFinite(op.point.sketchX)) {
                    await this.ensureColumn('points', TABS.points, 'sketch_x');
                    await this.ensureColumn('points', TABS.points, 'sketch_y');
                }
                if (typeof op.point.visible === 'boolean') await this.ensureColumn('points', TABS.points, 'visible');
                await sheets.appendRows(this.id, TABS.points, [recordToRow(this.headers('points'), pointToRecord(op.point))]);
                break;
            case 'addMeasurement': {
                const record = measurementToRecord(op.measurement);
                if (record.kind) for (const column of ['kind', 'from_b', 'to_b']) await this.ensureColumn('measurements', TABS.measurements, column);
                if (record.visible !== '') await this.ensureColumn('measurements', TABS.measurements, 'visible');
                await sheets.appendRows(this.id, TABS.measurements, [recordToRow(this.headers('measurements'), record)]);
                break;
            }
            case 'updatePoint':
                await this.updatePointRow(op.name, op.changes);
                break;
            case 'addBlocked':
                await sheets.appendRows(this.id, TABS.blocked, [recordToRow(this.headers('blocked'), { from: op.a, to: op.b })]);
                break;
            case 'saveSettings':
                await sheets.clearRange(this.id, `${quoteSheet(TABS.settings)}!A2:B`);
                await sheets.batchUpdateValues(this.id, [{ range: `${quoteSheet(TABS.settings)}!A1`, values: [HEADERS.settings, ...settingsToRows(op.settings)] }]);
                break;
            case 'updateMeasurement':
                await this.updateMeasurementRow(op.id, op.changes);
                break;
            case 'deleteMeasurement': {
                await this.ensureIds();
                if (/^row-\d+$/.test(op.id)) break; // could not be pinned to a row
                const row = await this.findMeasurementRow(op.id);
                if (row) await this.deleteRow(TABS.measurements, row);
                break;
            }
            case 'deletePoint': {
                const row = await this.findPointRow(op.name);
                if (row) await this.deleteRow(TABS.points, row);
                break;
            }
            default:
                break;
        }
    }

    async findMeasurementRow(id) {
        const syn = /^row-(\d+)$/.exec(id);
        if (syn) return Number(syn[1]);
        const col = this.headers('measurements').indexOf('id');
        if (col < 0) return null;
        const letter = columnLetter(col);
        const [values] = await sheets.batchGet(this.id, [`${quoteSheet(TABS.measurements)}!${letter}:${letter}`]);
        const idx = values.findIndex(row => String(row[0] ?? '') === id);
        return idx >= 0 ? idx + 1 : null;
    }

    // 1-based row of a point, or null when it is not (or no longer) in the sheet.
    async findPointRow(name) {
        const nameCol = this.headers('points').indexOf('name');
        if (nameCol < 0) return null;
        const letter = columnLetter(nameCol);
        const [values] = await sheets.batchGet(this.id, [`${quoteSheet(TABS.points)}!${letter}:${letter}`]);
        const idx = values.findIndex((row, i) => i > 0 && String(row[0] ?? '').trim() === name);
        return idx >= 0 ? idx + 1 : null;
    }

    // Rows typed by hand without an id (or with a duplicate one) are known by their row number ('row-12'),
    // which deleting a row above them would shift. Gives them real ids in the sheet and renames the in-memory
    // and queued references. Returns Map old id → new id.
    async ensureIds() {
        const synthetic = id => /^row-\d+$/.test(String(id ?? ''));
        const wanted = new Set([...this.garden.measurements.map(m => m.id), ...this.queue.map(q => q.id)].filter(synthetic));
        const renamed = new Map();
        if (!wanted.size) return renamed;
        const col = columnLetter(await this.ensureColumn('measurements', TABS.measurements, 'id'));
        const data = [];
        for (const old of wanted) {
            const id = uid('m');
            renamed.set(old, id);
            data.push({ range: `${quoteSheet(TABS.measurements)}!${col}${old.slice(4)}`, values: [[id]] });
        }
        await sheets.batchUpdateValues(this.id, data);
        for (const m of this.garden.measurements) {
            if (!renamed.has(m.id)) continue;
            m.id = renamed.get(m.id);
            m.needsId = false;
        }
        for (const q of this.queue) if (renamed.has(q.id)) q.id = renamed.get(q.id);
        storage.set(this.queueKey, this.queue);
        this.saveCache();
        return renamed;
    }

    // Column index of a header in a tab, appending the header cell when the sheet lacks it.
    async ensureColumn(key, tab, column) {
        const headers = this.headers(key).slice();
        let col = headers.indexOf(column);
        if (col >= 0) return col;
        col = headers.length;
        headers.push(column);
        await sheets.batchUpdateValues(this.id, [{ range: `${quoteSheet(tab)}!${columnLetter(col)}1`, values: [[column]] }]);
        this.garden.headers = { ...(this.garden.headers || {}), [key]: headers };
        this.saveCache();
        return col;
    }

    // Writes changed point fields (sketch position, category, notes) into the point's row.
    async updatePointRow(name, changes) {
        const keyMap = { sketchX: 'sketch_x', sketchY: 'sketch_y', category: 'category', notes: 'notes', visible: 'visible' };
        const row = await this.findPointRow(name);
        if (!row) return; // row was deleted in the sheet meanwhile
        const record = pointToRecord({ name, ...changes });
        const data = [];
        for (const [field, column] of Object.entries(keyMap)) {
            if (!(field in changes)) continue;
            const col = await this.ensureColumn('points', TABS.points, column);
            data.push({ range: `${quoteSheet(TABS.points)}!${columnLetter(col)}${row}`, values: [[record[column]]] });
        }
        if (data.length) await sheets.batchUpdateValues(this.id, data);
    }

    async updateMeasurementRow(id, changes) {
        const row = await this.findMeasurementRow(id);
        if (!row) return; // row was deleted in the sheet meanwhile
        if ('status' in changes) await this.ensureColumn('measurements', TABS.measurements, 'status');
        if ('note' in changes) await this.ensureColumn('measurements', TABS.measurements, 'note');
        if ('visible' in changes) await this.ensureColumn('measurements', TABS.measurements, 'visible');
        const headers = this.headers('measurements');
        const record = measurementToRecord({ ...changes, id });
        const keyMap = { distance: 'distance', status: 'status', note: 'note', fromH: 'from_h', toH: 'to_h', visible: 'visible' };
        const data = [];
        for (const [field, column] of Object.entries(keyMap)) {
            if (!(field in changes)) continue;
            const col = headers.indexOf(column);
            if (col < 0) continue;
            data.push({ range: `${quoteSheet(TABS.measurements)}!${columnLetter(col)}${row}`, values: [[record[column]]] });
        }
        if (data.length) await sheets.batchUpdateValues(this.id, data);
    }

    // Writes computed coordinates, residuals and flags back into the sheet (online only), and with plan
    // ({ appUrl, labels }) the Plan tab with a chart of the computed positions. Returns true when
    // measurement ids changed (rows typed by hand got one), so the caller should recompute.
    async writeResults(solution, suspects, plan = null) {
        const flushed = await this.flush();
        if (!flushed) throw new Error('Pending changes could not be synced yet');
        // Rows typed by hand get a real id so they can be referenced later; the solution still knows them
        // by their row number.
        const renamed = await this.ensureIds();
        const solvedId = new Map([...renamed].map(([old, id]) => [id, old]));
        const [pointValues, measurementValues] = await sheets.batchGet(this.id, [quoteSheet(TABS.points), quoteSheet(TABS.measurements)]);
        const data = [];
        const suspectIds = new Set((suspects || []).map(s => s.id));
        const round = (v, d = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : '');

        const pointOutputs = {
            x: p => round(p.x), y: p => round(p.y), z: p => round(p.z),
            sigma_xy: p => round(p.sxy), sigma_z: p => round(p.sz), links: p => p.links, status: p => p.status
        };
        this.addColumns(data, TABS.points, pointValues, pointOutputs, row => {
            const name = String(row[pointValues[0].map(h => String(h).trim().toLowerCase()).indexOf('name')] ?? '').trim();
            return solution.points.get(name) || null;
        }, p => p.placed);

        const idCol = (measurementValues[0] || []).map(h => String(h).trim().toLowerCase()).indexOf('id');
        const measurementOutputs = {
            residual: r => round(r.residual),
            w: r => (r.w === null ? '' : round(r.w, 2)),
            flag: (r, id) => (suspectIds.has(id) ? 'suspect' : !r.used ? 'unused' : r.r < 0.05 ? 'unchecked' : '')
        };
        this.addColumns(data, TABS.measurements, measurementValues, measurementOutputs, row => {
            const id = idCol >= 0 ? String(row[idCol] ?? '').trim() : '';
            const key = solution.measurements.has(id) ? id : solvedId.get(id);
            return key ? { res: solution.measurements.get(key), id: key } : null;
        }, () => true, true);

        if (data.length) await sheets.batchUpdateValues(this.id, data);
        this.saveCache();
        if (plan) await this.writePlan(solution, plan);
        return renamed.size > 0;
    }

    // The Plan tab (first tab of the sheet): a link that opens this garden in the app, and a chart of the
    // computed positions. The tab is rewritten each time.
    async writePlan(solution, { appUrl, labels }) {
        const meta = await this.readMeta();
        const tab = (meta.sheets || []).find(s => s.properties.title === PLAN_TAB);
        const requests = (tab?.charts || []).map(c => ({ deleteEmbeddedObject: { objectId: c.chartId } }));
        let sheetId = tab?.properties.sheetId;
        if (sheetId === undefined) {
            const res = await sheets.batchUpdate(this.id, [{ addSheet: { properties: { title: PLAN_TAB, index: 0 } } }]);
            sheetId = res?.replies?.[0]?.addSheet?.properties?.sheetId;
        }
        const table = planTable(solution, this.garden.measurements, labels);
        const q = quoteSheet(PLAN_TAB);
        await sheets.clearRange(this.id, `${q}!A1:${columnLetter(PLAN_COLUMNS - 1)}`);
        await sheets.batchUpdateValues(this.id, [
            { range: `${q}!A2`, values: [[labels.note]] },
            { range: `${q}!A${PLAN_FIRST_ROW}`, values: table.rows }
        ]);
        // A linked cell rather than a HYPERLINK formula, whose argument separator depends on the sheet's locale.
        requests.push({
            updateCells: {
                start: { sheetId, rowIndex: 0, columnIndex: 0 },
                rows: [{ values: [{ userEnteredValue: { stringValue: labels.link }, userEnteredFormat: { textFormat: { bold: true, link: { uri: appUrl } } } }] }],
                fields: 'userEnteredValue,userEnteredFormat.textFormat'
            }
        });
        const chart = planChart(sheetId, table, labels);
        if (chart) requests.push({ addChart: { chart } });
        if (requests.length) await sheets.batchUpdate(this.id, requests);
    }

    // Fills output columns (adding missing headers at the end) for every data row of a tab.
    addColumns(data, tab, values, outputs, lookup, include, wrapped = false) {
        const headers = (values[0] || []).map(h => String(h).trim().toLowerCase());
        let nextCol = headers.length;
        const body = values.slice(1);
        for (const [column, fn] of Object.entries(outputs)) {
            let col = headers.indexOf(column);
            if (col < 0) {
                col = nextCol++;
                headers[col] = column;
                data.push({ range: `${quoteSheet(tab)}!${columnLetter(col)}1`, values: [[column]] });
            }
            if (!body.length) continue;
            const cells = body.map((row, i) => {
                const hit = lookup(row, i);
                if (!hit) return [''];
                if (wrapped) return [fn(hit.res, hit.id)];
                return [include(hit) ? fn(hit) : ''];
            });
            data.push({ range: `${quoteSheet(tab)}!${columnLetter(col)}2:${columnLetter(col)}${body.length + 1}`, values: cells });
        }
        this.garden.headers = { ...(this.garden.headers || {}), [tab === TABS.points ? 'points' : 'measurements']: headers };
    }
}
