// PlanTape main controller: screens, garden lifecycle, recomputation and actions.

import { t, setLanguage, getLanguage, applyTranslations, LANGUAGES } from './i18n.js';
import { isConfigured, hasValidToken, requestToken, signOut } from './google-auth.js';
import { pickSpreadsheet, spreadsheetIdFromUrl } from './picker.js';
import { GoogleStore, LocalStore, recentGardens, rememberGarden, forgetGarden } from './store.js';
import { solverInput, datumToKeep, gardenFromJson, gardenFromCsv, CATEGORIES, isPointShown, isMeasurementDrawn, isLineDrawn } from './model.js';
import { snoop, checkMeasurement } from './solver/blunders.js';
import { suggestMeasurements, suggestOffsets, referenceLines, underdeterminedPoints, pairKey, weakPointGains, WEAK_SXY } from './solver/planner.js';
import { layoutPositions, freeSpotNear, followSketches } from './positions.js';
import { rectangleMeasurements } from './rectangle.js';
import { orientation } from './orientation.js';
import { kindOf, pointsOfMeasurement } from './solver/observations.js';
import { lineKey, isLine, lineEnds, sameLine, availableLines, describeMeasurement, formatValue, formatExpected } from './view/describe.js';
import { PlanView, CATEGORY_COLORS } from './view/plan-view.js';
import { MeasurePanel } from './view/measure-panel.js';
import { HintsPanel } from './view/hints-panel.js';
import { PointsPanel, MeasurementsPanel, SettingsPanel } from './view/data-panels.js';
import { downloadSvg, downloadPdf, downloadPointsCsv, downloadGardenJson } from './export.js';
import { demoGarden } from './demo.js';
import { escapeHtml, fmt, uid, nowStamp, storage } from './util.js';

const unit = () => (state.garden?.settings.entryUnit === 'm' ? 'm' : 'cm');

const $ = sel => document.querySelector(sel);

const DEFAULT_LAYERS = { lines: true, hiddenLines: true, hiddenPoints: true, ellipses: true, labels: true, heights: true, hints: true, colorBy: 'category', ellipseScale: 'auto' };
const saved = storage.get('plantape:view', {});

const state = {
    store: null,
    garden: null,
    result: null,
    hints: [],
    under: [],
    positions: new Map(), // name → { x, y, placed }: computed, or else sketched (mapped into the plan frame)
    frame: null, // similarity: sketch frame → plan frame
    ui: {
        tab: 'measure',
        tool: 'pan',
        station: '',
        stationH: 0,
        target: '',
        targetH: 0,
        selected: '',
        onlyReachable: true,
        layers: { ...DEFAULT_LAYERS, ...(saved.layers || {}) },
        selectOnce: saved.selectOnce !== false, // the select tool switches itself off after choosing where I am
        export: { paper: 'A4', orientation: 'landscape', scale: 'fit', ...(saved.export || {}) }
    }
};

// ---- UI helpers ---------------------------------------------------------------------------------

function showScreen(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
    $('#gardensButton').classList.toggle('hidden', id !== 'mainScreen');
    document.body.dataset.screen = id;
}

let toastTimer;
function toast(message, kind = 'info') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' || kind === 'warn' ? 7000 : 3000);
}

function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modalCard').innerHTML = '';
}

// Opens a modal; handlers: { action: fn } called for [data-action] buttons inside; returns the card.
function openModal(html, handlers = {}) {
    const card = $('#modalCard');
    card.innerHTML = html;
    $('#modal').classList.remove('hidden');
    card.onclick = e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const fn = handlers[btn.dataset.action];
        if (fn) fn(btn);
        else if (btn.dataset.action === 'close') closeModal();
    };
    card.querySelector('[autofocus]')?.focus();
    return card;
}

function saveLayers() {
    storage.set('plantape:view', { layers: state.ui.layers, export: state.ui.export, selectOnce: state.ui.selectOnce });
}

function errorMessage(error) {
    const status = error?.status;
    if (status === 403 || status === 404) return t('errNoAccess');
    return error?.message || String(error);
}

// ---- Computation --------------------------------------------------------------------------------

// prefer: a point just dragged on the plan; its sketch wins the mirror choices of the whole network.
function recompute(prefer = null) {
    const garden = state.garden;
    const s = garden.settings;
    const res = snoop(solverInput(garden, prefer));
    const solution = s.autoExclude ? res.solution : res.initial;
    const keep = datumToKeep(s, solution);
    if (keep) {
        // Same points as the solution used, so it needs no recompute.
        Object.assign(s, keep);
        state.store.saveSettings(s);
    }
    const blocked = new Set(garden.blocked.map(b => pairKey(b.a, b.b)));
    state.result = { solution, suspects: res.suspects };
    state.hints = solution.u
        ? [
            ...suggestMeasurements(solution, { tapeLength: s.tapeLength, blocked, use3D: s.mode3d, heights: s.heights, maxResults: 8 }),
            ...suggestOffsets(solution, { lines: offsetLines(garden), tapeLength: s.tapeLength, use3D: s.mode3d, maxResults: 8 })
        ].sort((a, b) => b.score - a.score).slice(0, 8)
        : [];
    state.under = underdeterminedPoints(solution);
    ({ frame: state.frame, positions: state.positions } = layoutPositions(solution, garden.points, garden.measurements));
}

// Lines that distances can be measured from: the ones used in offsets and angles, and lines without a reading.
function offsetLines(garden) {
    const out = new Map(referenceLines(garden.measurements).map(l => [pairKey(...l), l]));
    for (const l of garden.lines || []) out.set(pairKey(l.from, l.to), [l.from, l.to]);
    return [...out.values()];
}

// The reading that would best fix a poorly fixed point, as text ("A2 → KapuBal"), or ''.
function betterReading(name) {
    const { solution } = state.result;
    const s = state.garden.settings;
    const blocked = new Set(state.garden.blocked.map(b => pairKey(b.a, b.b)));
    const involves = h => [h.from, h.to, h.fromB].includes(name);
    const distance = suggestMeasurements(solution, { tapeLength: s.tapeLength, blocked, use3D: false, maxResults: 200 }).find(involves);
    const offset = suggestOffsets(solution, { lines: offsetLines(state.garden), tapeLength: s.tapeLength, use3D: false, point: name, maxResults: 20 }).find(involves);
    // A plain tape distance is easier to take; an offset only when it is clearly better.
    const best = distance && (!offset || distance.xyPct >= offset.xyPct * 0.5) ? distance : offset;
    if (!best) return '';
    return best.kind === 'offset' ? `${best.from}–${best.fromB} ⊥ ${best.to}` : `${best.from} → ${best.to}`;
}

// Warning for a reading that runs the same way as the other readings of a poorly fixed point, so it would not
// fix it; '' when it helps or no point it involves is poorly fixed.
function weakWarning(m) {
    if (!state.result) return '';
    const useless = weakPointGains(state.result.solution, m).filter(g => g.pct < 10);
    return useless.map(g => {
        const better = betterReading(g.name);
        return t(better ? 'weakReading' : 'weakReadingNoHint', { name: g.name, sxy: fmt(g.sxy, 1), better });
    }).join(' ');
}

// After saving: points of the reading that are placed but still poorly fixed.
function weakAfterSave(m) {
    const P = state.result.solution.points;
    return pointsOfMeasurement(m).filter(n => P.get(n)?.placed && P.get(n).sxy > WEAK_SXY).map(name => {
        const better = betterReading(name);
        return t(better ? 'stillWeak' : 'stillWeakNoHint', { name, sxy: fmt(P.get(name).sxy, 1), better });
    }).join(' ');
}

// Sketch position (sketch frame) for a point created without tapping the plan: next to the point or line
// being measured from (the new point is within reach of the tape there), otherwise in the middle of the view.
function defaultSketch() {
    const station = state.ui.station;
    let around = null;
    if (isLine(station)) {
        const [A, B] = lineEnds(station).map(n => state.positions.get(n));
        if (A && B) around = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    } else if (station) around = state.positions.get(station) || null;
    const spot = around ? freeSpotNear(around, state.positions) : planView.centerWorld();
    return state.frame.invert(spot);
}

// ---- Rendering ----------------------------------------------------------------------------------

let planView;
const panels = {};

function renderPlan() {
    if (!state.result) return;
    const layers = state.ui.layers;
    const sketchPos = new Map([...state.positions].filter(([, p]) => !p.placed));
    planView.setScene({
        solution: state.result.solution,
        garden: state.garden,
        sketchPos,
        suspects: new Set(state.result.suspects.map(s => s.id)),
        hints: layers.hints ? state.hints : [],
        selected: state.ui.selected,
        station: state.ui.station,
        target: state.ui.target,
        options: layers,
        orientation: orientation(state.garden.settings, state.result.solution)
    });
    $('#planEmpty').classList.toggle('hidden', state.positions.size > 0);
}

function renderSync(sync) {
    const el = $('#syncBadge');
    if (!state.store) {
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');
    el.dataset.state = sync.state;
    const map = {
        ok: t('syncOk'),
        local: t('syncLocal'),
        pending: t('syncPending', { n: sync.pending }),
        syncing: t('syncPending', { n: sync.pending }),
        offline: t('syncOffline', { n: sync.pending }),
        auth: t('syncAuth'),
        error: t('syncError')
    };
    el.textContent = map[sync.state] || sync.state;
    el.title = sync.message || '';
}

function renderTabs() {
    for (const btn of document.querySelectorAll('.tabs button')) {
        btn.classList.toggle('active', btn.dataset.tab === state.ui.tab);
    }
    for (const body of document.querySelectorAll('.tab-body')) body.classList.toggle('hidden', body.id !== `tab-${state.ui.tab}`);
    const badge = $('#hintsBadge');
    const n = state.result?.suspects.length || 0;
    badge.textContent = n ? String(n) : '';
    badge.classList.toggle('hidden', !n);
}

function renderAll() {
    if (!state.garden) return;
    $('#gardenTitle').textContent = state.store?.title || '';
    renderPlan();
    panels[state.ui.tab]?.render();
    renderTabs();
    renderSync(state.store.sync);
}

function refresh() {
    recompute();
    renderAll();
}

// ---- Write-back to the sheet --------------------------------------------------------------------

// The app link that opens this garden; it is written into the sheet's Plan tab.
function appLink(id) {
    return `${location.origin}${location.pathname}?sheet=${encodeURIComponent(id)}`;
}

function planOptions() {
    const turn = orientation(state.garden.settings, state.result.solution);
    // The chart is turned like the plan; its axes are east / north only when north is up.
    const northUp = turn.north !== null && !(Number(state.garden.settings.rotation) % 360);
    return {
        appUrl: appLink(state.store.id),
        orientation: turn,
        labels: {
            xAxis: northUp ? 'E [m]' : turn.angle ? '[m]' : 'x [m]',
            yAxis: northUp ? 'N [m]' : turn.angle ? '[m]' : 'y [m]',
            link: t('sheetAppLink'),
            note: t('sheetPlanNote', { date: nowStamp() }),
            title: state.store.title,
            x: 'x',
            points: t('chartPoints'),
            lines: t('chartLines'),
            helpers: t('chartHelpers')
        }
    };
}

const WRITE_DELAY = 15000;
let writeTimer = null;
let writing = null;

// Computed coordinates, residuals and the Plan tab go to the sheet when a garden is opened and shortly after
// changes, so the sheet always shows the last computed state. Needs a valid token: a sign-in popup can't be
// opened without a click.
function scheduleWriteBack(delay = WRITE_DELAY) {
    clearTimeout(writeTimer);
    if (state.store?.type === 'google') writeTimer = setTimeout(() => writeBack(), delay);
}

async function writeBack({ quiet = true } = {}) {
    clearTimeout(writeTimer);
    const store = state.store;
    if (store?.type !== 'google' || !state.result) return;
    if (writing) {
        scheduleWriteBack();
        return;
    }
    if (quiet && (!hasValidToken() || !navigator.onLine)) return;
    writing = (async () => {
        try {
            const renamed = await store.writeResults(state.result.solution, state.result.suspects, planOptions());
            store.writeError = '';
            if (renamed && state.store === store) refresh();
            if (!quiet) toast(t('resultsWritten'), 'ok');
        } catch (error) {
            const message = errorMessage(error);
            // An automatic write that keeps failing the same way is reported once.
            if (!quiet || store.writeError !== message) toast(t('writeFailed', { message }), 'error');
            store.writeError = message;
        }
    })().finally(() => {
        writing = null;
    });
    return writing;
}

// ---- Garden lifecycle ---------------------------------------------------------------------------

// fromLink: opened from the link in the sheet, so say when the sheet has been updated.
async function openStore(store, { fromLink = false } = {}) {
    clearTimeout(writeTimer);
    state.store?.dispose?.();
    state.store = store;
    store.onSync(renderSync);
    store.onChange(() => scheduleWriteBack());
    $('#gardenError').classList.add('hidden');
    showLoading(true);
    try {
        state.garden = await store.load();
    } catch (error) {
        state.store = null;
        showLoading(false);
        showOpenError(store, error);
        showGardenScreen();
        return;
    } finally {
        showLoading(false);
    }
    rememberGarden({ type: store.type, id: store.id, name: store.title });
    try {
        sessionStorage.setItem('plantape:current', JSON.stringify({ type: store.type, id: store.id }));
    } catch {
        // ignore
    }
    Object.assign(state.ui, { station: '', target: '', selected: '', stationH: 0, targetH: 0 });
    if (state.store.offlineLoaded) toast(t('offlineLoaded'), 'info');
    showScreen('mainScreen');
    refresh();
    planView.fit();
    if (store.type === 'google' && !store.offlineLoaded) writeBack({ quiet: !fromLink });
}

// The app sees only spreadsheets the user created with it or picked in the Drive Picker (drive.file scope).
// A sheet shared by someone else is opened by picking it once, which grants that access.
function showOpenError(store, error) {
    const el = $('#gardenError');
    el.textContent = errorMessage(error);
    if (store.type === 'google' && (error?.status === 403 || error?.status === 404)) {
        el.textContent = t('errNoAccessGrant');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'secondary';
        btn.textContent = t('grantAccess');
        btn.addEventListener('click', async () => {
            try {
                const picked = await pickSpreadsheet({ title: t('pickTitle'), locale: getLanguage(), fileId: store.id });
                if (picked) await openStore(new GoogleStore(picked.id));
            } catch (err) {
                toast(errorMessage(err), 'error');
            }
        });
        el.append(document.createElement('br'), btn);
    }
    el.classList.remove('hidden');
}

function showLoading(on) {
    $('#loading').classList.toggle('hidden', !on);
}

function showGardenScreen() {
    const google = hasValidToken();
    document.body.classList.toggle('google-on', google);
    const list = recentGardens().filter(g => g.type === 'local' || google);
    $('#recentList').innerHTML = list.length ? list.map(g => `
        <li><button type="button" class="recent" data-open="${escapeHtml(g.type)}:${escapeHtml(g.id)}">
            <span class="name">${escapeHtml(g.name || g.id)}</span>
            <span class="meta">${escapeHtml(t(g.type === 'google' ? 'typeGoogle' : 'typeLocal'))} · ${new Date(g.openedAt).toLocaleDateString(getLanguage())}</span>
        </button><button type="button" class="tiny ghost" data-forget="${escapeHtml(g.type)}:${escapeHtml(g.id)}" title="${escapeHtml(t('forget'))}">✕</button></li>`).join('')
        : `<li class="muted">${escapeHtml(t('noRecent'))}</li>`;
    showScreen('gardenScreen');
}

// ---- Actions ------------------------------------------------------------------------------------

// sketch: { x, y } in the sketch frame (from a tap on the plan); without one the point is sketched next to
// the current station, so it shows on the plan right away and can be dragged into place.
function newPointDialog(initialName, onCreated, sketch = null) {
    sketch = sketch || defaultSketch();
    let category = 'other';
    const card = openModal(`
        <h3>${escapeHtml(t('newPoint'))}</h3>
        <label class="field">${escapeHtml(t('pointName'))}<input id="pointNameInput" type="text" value="${escapeHtml(initialName)}" autocomplete="off" autofocus></label>
        <div class="sub-label">${escapeHtml(t('category'))}</div>
        <div class="chips">${CATEGORIES.map(c => `<button type="button" class="chip${c === category ? ' active' : ''}" data-action="category" data-value="${c}"><span class="dot" style="background:${CATEGORY_COLORS[c]}"></span>${escapeHtml(t(`cat_${c}`))}</button>`).join('')}</div>
        <label class="field">${escapeHtml(t('pointNotes'))}<input id="pointNotesInput" type="text"></label>
        <label class="check"><input id="pointVisibleInput" type="checkbox"${state.garden.settings.newPointsVisible ? ' checked' : ''}> ${escapeHtml(t('showOnPlan'))}</label>
        <p id="pointError" class="error hidden"></p>
        <div class="row end"><button type="button" data-action="close">${escapeHtml(t('cancel'))}</button><button type="button" class="primary" data-action="create">${escapeHtml(t('create'))}</button></div>`, {
        category: btn => {
            category = btn.dataset.value;
            card.querySelectorAll('[data-action="category"]').forEach(b => b.classList.toggle('active', b === btn));
        },
        create: () => {
            const name = card.querySelector('#pointNameInput').value.trim();
            const err = card.querySelector('#pointError');
            if (!name) {
                err.textContent = t('errNameRequired');
                err.classList.remove('hidden');
                return;
            }
            if (state.garden.points.some(p => p.name.toLowerCase() === name.toLowerCase())) {
                err.textContent = t('errNameExists', { name });
                err.classList.remove('hidden');
                return;
            }
            const point = { name, category, notes: card.querySelector('#pointNotesInput').value.trim(), visible: card.querySelector('#pointVisibleInput').checked };
            Object.assign(point, { sketchX: Math.round(sketch.x * 100) / 100, sketchY: Math.round(sketch.y * 100) / 100 });
            state.store.addPoint(point);
            closeModal();
            refresh();
            onCreated?.(name);
        }
    });
    card.querySelector('#pointNameInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') card.querySelector('[data-action="create"]').click();
    });
}

function commitMeasurement(m, check, done) {
    const measurement = { id: uid('m'), timestamp: nowStamp(), status: 'active', ...m };
    delete measurement.typed;
    if (!measurement.raw) delete measurement.raw;
    state.store.addMeasurement(measurement);
    recompute();
    renderAll();
    const msg = t('saved', { what: describeMeasurement(m, { heights: false }), d: formatValue(m, unit()) });
    const weak = weakAfterSave(m);
    if (weak) toast(`${msg} ${weak}`, 'warn');
    else toast(check?.status === 'ok' ? `${msg} ✓ ${t('matchesExpected')}` : msg, 'ok');
    done?.();
}

// Checks a new measurement against the current solution; suspicious values open the typo dialog.
function submitMeasurement(m, done) {
    const check = checkMeasurement(state.result.solution, m);
    if (check.status !== 'suspect') {
        commitMeasurement(m, check, done);
        return;
    }
    const angle = kindOf(m) === 'angle';
    const val = v => formatValue({ ...m, distance: v }, unit());
    openModal(`
        <h3>${escapeHtml(t(angle ? 'checkTitleAngle' : 'checkTitle'))}</h3>
        <p>${escapeHtml(angle
            ? t('checkTextAngle', { d: val(m.distance), expected: formatExpected(m, check.predicted, unit()), dev: fmt(check.deviation, 1), tol: fmt(check.tol, 1) })
            : t('checkText', { d: val(m.distance), expected: formatExpected(m, check.predicted, unit()), dev: fmt(check.deviation * 100, 1), tol: fmt(check.tol * 100, 1) }))}</p>
        ${check.suggestions.length ? `<p>${escapeHtml(t('didYouMean'))}</p>` : ''}
        <div class="column">
            ${check.suggestions.map(c => `<button type="button" class="primary" data-action="use" data-value="${c.value}">${escapeHtml(t('useValue', { value: val(c.value), kind: t(`kind_${c.kind}`) }))}</button>`).join('')}
            <button type="button" data-action="keep">${escapeHtml(t('keepValue', { value: val(m.distance) }))}</button>
            <button type="button" class="ghost" data-action="close">${escapeHtml(t('cancelRemeasure'))}</button>
        </div>`, {
        use: btn => {
            closeModal();
            const value = Number(btn.dataset.value);
            commitMeasurement({ ...m, distance: value, raw: undefined, typed: undefined, note: [m.note, t('correctedFrom', { value: m.typed || val(m.distance) })].filter(Boolean).join(' ') }, { status: 'ok' }, done);
        },
        keep: () => {
            closeModal();
            commitMeasurement(m, check, done);
        }
    });
}

// Rectangle from four corners: its sides become lines, its corners square, and one side optionally parallel
// to another line. Readings that already say the same are not added again.
function rectangleDialog(corners) {
    const ownSide = (a, b) => corners.some((c, i) => sameLine(a, b, c, corners[(i + 1) % 4]));
    const others = availableLines(state.garden).filter(([a, b]) => !ownSide(a, b));
    const card = openModal(`
        <h3>${escapeHtml(t('rectTitle'))}</h3>
        <p>${escapeHtml(t('rectText', { corners: corners.join(' → ') }))}</p>
        <label class="field">${escapeHtml(t('rectParallel', { side: `${corners[0]}–${corners[1]}` }))}<select id="rectParallel">
            <option value="">${escapeHtml(t('rectNone'))}</option>
            ${others.map(([a, b]) => `<option value="${escapeHtml(lineKey(a, b))}">${escapeHtml(`${a}–${b}`)}</option>`).join('')}
        </select></label>
        <p class="muted small">${escapeHtml(t('rectNext'))}</p>
        <div class="row end"><button type="button" data-action="close">${escapeHtml(t('cancel'))}</button><button type="button" class="primary" data-action="create">${escapeHtml(t('create'))}</button></div>`, {
        create: () => {
            const parallel = card.querySelector('#rectParallel').value;
            closeModal();
            const { lines, measurements } = rectangleMeasurements(corners, { parallelTo: parallel ? lineEnds(parallel) : null });
            const known = new Set(availableLines(state.garden).map(l => pairKey(...l)));
            for (const l of lines) if (!known.has(pairKey(l.from, l.to))) state.store.addLine({ ...l, visible: true });
            const sameAngle = (m, x) => kindOf(x) === 'angle' && x.status !== 'excluded' &&
                ((sameLine(m.from, m.fromB, x.from, x.fromB) && sameLine(m.to, m.toB, x.to, x.toB)) || (sameLine(m.from, m.fromB, x.to, x.toB) && sameLine(m.to, m.toB, x.from, x.fromB)));
            let added = 0;
            for (const m of measurements) {
                if (state.garden.measurements.some(x => sameAngle(m, x))) continue;
                state.store.addMeasurement({ id: uid('m'), timestamp: nowStamp(), note: t('rectNote'), visible: state.garden.settings.newMeasurementsVisible, ...m });
                added++;
            }
            refresh();
            toast(t('rectAdded', { n: added }), 'ok');
        }
    });
}

function confirmDelete(title, text, onConfirm) {
    openModal(`
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(text)}</p>
        <div class="row end"><button type="button" data-action="close">${escapeHtml(t('cancel'))}</button><button type="button" class="danger" data-action="confirm">${escapeHtml(t('delete'))}</button></div>`, {
        confirm: () => {
            closeModal();
            onConfirm();
        }
    });
}

const actions = {
    newPointDialog,
    weakWarning,
    submitMeasurement,

    toggleMeasurement(id, force) {
        const m = state.garden.measurements.find(x => x.id === id);
        if (!m) return;
        const status = force || (m.status === 'excluded' ? 'active' : 'excluded');
        state.store.updateMeasurement(id, { status });
        refresh();
    },

    applyCorrection(id, value, kind) {
        const m = state.garden.measurements.find(x => x.id === id);
        if (!m) return;
        const note = [m.note, t('correctedFrom', { value: formatValue(m, unit()) })].filter(Boolean).join(' ');
        state.store.updateMeasurement(id, { distance: value, note, raw: undefined, status: 'active' });
        toast(t('corrected', { value: formatValue({ ...m, distance: value }, unit()), kind: t(`kind_${kind}`) }), 'ok');
        refresh();
    },

    blockPair(a, b) {
        if (!a || !b) return;
        state.store.addBlocked(a, b);
        toast(t('blockedSaved', { a, b }), 'info');
        refresh();
    },

    useHint(h) {
        state.ui.tab = 'measure';
        panels.measure.prefill(h);
        renderAll();
    },

    // Saves a new sketch position for a point dragged on the plan (x, y in the plan frame), then says
    // whether the computed point followed (jumped to its mirror position) or is fixed by the readings.
    // The whole network may change: other points follow to the matching solution, and their sketches are
    // moved with them so the next recompute keeps it.
    movePoint(name, x, y) {
        const toSketch = q => {
            const sk = state.frame.invert(q);
            return { sketchX: Math.round(sk.x * 100) / 100, sketchY: Math.round(sk.y * 100) / 100 };
        };
        const positionsBefore = state.positions;
        const before = positionsBefore.get(name);
        state.store.updatePoint(name, toSketch({ x, y }));
        recompute(name);
        const follow = followSketches(positionsBefore, state.positions, state.garden.points, state.garden.measurements, name);
        const now = state.positions.get(name);
        if (now?.placed) follow.set(name, now); // the sketch moves to where the point ended up
        for (const [n, q] of follow) state.store.updatePoint(n, toSketch(q));
        recompute();
        renderAll();
        const after = state.positions.get(name);
        if (before?.placed && after?.placed) {
            const shift = Math.hypot(after.x - before.x, after.y - before.y);
            if (shift > 0.05) toast(t('pointMoved', { name }), 'ok');
            else if (Math.hypot(x - before.x, y - before.y) > 0.3) toast(t('pointFixed', { name }), 'info');
        }
    },

    // A point or a measured line tapped on the plan: picks "from" / "to" while measuring.
    // With the select tool (station = true) the tap says where I am; otherwise it picks what to measure to.
    select(sel, station = false) {
        if (state.ui.tool === 'line') {
            actions.lineTap(sel);
            return;
        }
        if (state.ui.tool === 'rect') {
            actions.rectTap(sel);
            return;
        }
        const key = sel.line ? lineKey(...sel.line) : sel.point;
        if (!station && !sel.line && state.ui.tab !== 'measure') {
            actions.selectPoint(sel.point);
            return;
        }
        if (state.ui.tab !== 'measure') {
            state.ui.tab = 'measure';
            panels.measure.render();
        }
        if (station) {
            panels.measure.selectStation(key);
            if (state.ui.selectOnce) actions.setTool('pan', { quiet: true });
        } else panels.measure.selectTarget(key);
        renderPlan();
        renderTabs();
    },

    // Line tool: tap one end, then the other; the next tap continues from there (a fence of several sections).
    // Tapping the last point again ends the chain.
    lineTap(sel) {
        if (!sel.point) return;
        const start = state.ui.lineStart;
        if (!start || start === sel.point) {
            state.ui.lineStart = start ? '' : sel.point;
            state.ui.selected = state.ui.lineStart;
            if (state.ui.lineStart) toast(t('lineStartHelp', { name: sel.point }), 'info');
            renderPlan();
            return;
        }
        actions.addLine(start, sel.point);
        state.ui.lineStart = sel.point;
        state.ui.selected = sel.point;
        renderPlan();
    },

    // Rectangle tool: tap the four corners in order (tapping the last one again takes it back).
    rectTap(sel) {
        if (!sel.point) return;
        const corners = state.ui.rectCorners || (state.ui.rectCorners = []);
        if (corners.at(-1) === sel.point) corners.pop();
        else if (!corners.includes(sel.point)) corners.push(sel.point);
        state.ui.selected = corners.at(-1) || '';
        renderPlan();
        if (corners.length < 4) {
            toast(t('rectCornerHelp', { n: corners.length + 1, corners: corners.join(' → ') || '–' }), 'info');
            return;
        }
        const chosen = corners.slice();
        actions.setTool('pan', { quiet: true }); // also clears the corners and their highlight
        rectangleDialog(chosen);
    },

    // A line without a reading between two points; it can be drawn on the plan and used in angles and offsets.
    addLine(a, b) {
        if (!a || !b || a === b) return;
        if (availableLines(state.garden).some(([c, d]) => sameLine(a, b, c, d))) {
            toast(t('lineExists', { line: `${a}–${b}` }), 'info');
            return;
        }
        state.store.addLine({ from: a, to: b, visible: true });
        refresh();
        toast(t('lineAdded', { line: `${a}–${b}` }), 'ok');
    },

    deleteLine(a, b) {
        const used = state.garden.measurements.filter(m => kindOf(m) !== 'distance' && (sameLine(a, b, m.from, m.fromB) || (kindOf(m) === 'angle' && sameLine(a, b, m.to, m.toB))));
        confirmDelete(t('deleteLineTitle', { line: `${a}–${b}` }), used.length ? t('deleteLineTextUsed', { n: used.length }) : t('deleteLineText'), () => {
            state.store.deleteLine(a, b);
            refresh();
        });
    },

    // Shown on the plan or not: { point: name }, { measurement: id } or { line: [a, b] }.
    toggleVisible(item) {
        if (item.point) {
            const p = state.garden.points.find(x => x.name === item.point);
            if (p) state.store.updatePoint(p.name, { visible: !isPointShown(p) });
        } else if (item.line) {
            const l = (state.garden.lines || []).find(x => sameLine(x.from, x.to, ...item.line));
            if (l) state.store.updateLine(l.from, l.to, { visible: !isLineDrawn(l) });
        } else {
            const m = state.garden.measurements.find(x => x.id === item.measurement);
            if (m) state.store.updateMeasurement(m.id, { visible: !isMeasurementDrawn(m) });
        }
        refresh();
    },

    setTool(tool, { quiet = false } = {}) {
        state.ui.tool = state.ui.tool === tool ? 'pan' : tool;
        if (state.ui.lineStart || state.ui.rectCorners?.length) {
            if ([state.ui.lineStart, ...(state.ui.rectCorners || [])].includes(state.ui.selected)) state.ui.selected = '';
            state.ui.lineStart = '';
            state.ui.rectCorners = [];
            renderPlan();
        }
        planView.setMode(['line', 'rect'].includes(state.ui.tool) ? 'pan' : state.ui.tool);
        $('#lineButton').classList.toggle('active', state.ui.tool === 'line');
        $('#rectButton').classList.toggle('active', state.ui.tool === 'rect');
        $('#selectButton').classList.toggle('active', state.ui.tool === 'select');
        $('#addPointButton').classList.toggle('active', state.ui.tool === 'add');
        $('#moveButton').classList.toggle('active', state.ui.tool === 'move');
        const help = { select: 'toolSelectHelp', add: 'toolAddHelp', move: 'toolMoveHelp', line: 'toolLineHelp', rect: 'toolRectHelp' }[state.ui.tool];
        if (help && !quiet) toast(t(help), 'info');
    },

    // Turns the drawing 90° clockwise (coordinates stay as they are).
    rotate() {
        const s = state.garden.settings;
        s.rotation = (((Number(s.rotation) || 0) - 90) % 360 + 360) % 360;
        actions.saveSettings();
        renderPlan();
        planView.fit();
        if (state.ui.tab === 'settings') panels.settings.render();
    },

    selectPoint(name) {
        state.ui.selected = state.ui.selected === name ? '' : name;
        renderPlan();
        if (state.ui.selected) planView.centerOn(name);
        panels[state.ui.tab]?.render();
    },

    settingsChanged(key) {
        if (key === 'entryUnit') {
            panels.measure.draftTyped = false; // a typed value would now be read in the other unit
            panels.measure.applyPrefill();
        }
        if (key === 'gardenName') {
            $('#gardenTitle').textContent = state.store.title;
            return;
        }
        recompute();
        renderPlan();
        renderTabs();
        if (['origin', 'axis', 'side', 'flip', 'rotation', 'northFrom', 'northTo', 'northBearing'].includes(key)) planView.fit();
    },

    saveSettings() {
        state.store.saveSettings(state.garden.settings);
        rememberGarden({ type: state.store.type, id: state.store.id, name: state.store.title });
    },

    async writeResults() {
        showLoading(true);
        try {
            await writeBack({ quiet: false });
        } finally {
            showLoading(false);
        }
    },

    async copyAppLink() {
        const link = appLink(state.store.id);
        try {
            await navigator.clipboard.writeText(link);
            toast(t('linkCopied'), 'ok');
        } catch {
            toast(link, 'info');
        }
    },

    deleteMeasurement(id) {
        const m = state.garden.measurements.find(x => x.id === id);
        if (!m) return;
        confirmDelete(t('deleteMeasurementTitle'), t('deleteMeasurementText', { what: describeMeasurement(m), d: formatValue(m, unit()) }), () => {
            state.store.deleteMeasurement(id);
            refresh();
        });
    },

    // Deletes a point together with every measurement that uses it (distances, and distances and angles of
    // lines through it); a datum setting naming it falls back to automatic.
    deletePoint(name) {
        const used = state.garden.measurements.filter(m => pointsOfMeasurement(m).includes(name));
        const lines = (state.garden.lines || []).filter(l => l.from === name || l.to === name);
        const n = used.length + lines.length;
        confirmDelete(t('deletePointTitle', { name }), n ? t('deletePointText', { name, n }) : t('deletePointTextUnused', { name }), () => {
            for (const m of used) state.store.deleteMeasurement(m.id);
            for (const l of lines) state.store.deleteLine(l.from, l.to);
            state.store.deletePoint(name);
            const s = state.garden.settings;
            const datum = ['origin', 'axis', 'side'].filter(key => s[key] === name);
            for (const key of datum) s[key] = '';
            if (datum.length) actions.saveSettings();
            const involves = key => key === name || (isLine(key) && lineEnds(key).includes(name));
            for (const key of ['station', 'target', 'selected']) if (involves(state.ui[key])) state.ui[key] = '';
            refresh();
            toast(t('pointDeleted', { name }), 'info');
        });
    },

    async reload() {
        await openStore(new GoogleStore(state.store.id));
    },

    exportOptions() {
        return { ...state.ui.export, title: state.store.title };
    },

    exportScene() {
        return { solution: state.result.solution, garden: state.garden, suspects: new Set(state.result.suspects.map(s => s.id)), options: state.ui.layers, orientation: orientation(state.garden.settings, state.result.solution) };
    },

    exportSvg() {
        downloadSvg(actions.exportScene(), actions.exportOptions());
    },

    async exportPdf() {
        showLoading(true);
        try {
            await downloadPdf(actions.exportScene(), actions.exportOptions());
        } catch (error) {
            toast(errorMessage(error), 'error');
        } finally {
            showLoading(false);
        }
    },

    exportCsv() {
        downloadPointsCsv(state.garden, state.result.solution, state.store.title);
    },

    exportJson() {
        downloadGardenJson(state.garden, state.store.title);
    },

    switchGarden() {
        try {
            sessionStorage.removeItem('plantape:current');
        } catch {
            // ignore
        }
        showGardenScreen();
    }
};

const app = { state, actions, toast, renderPlan, saveLayers };

let pendingLink = ''; // spreadsheet id from the sheet's app link, opened after signing in

// ---- Wiring -------------------------------------------------------------------------------------

function bindStartAndGardenScreens() {
    $('#signInButton').addEventListener('click', async () => {
        $('#startError').classList.add('hidden');
        try {
            await requestToken({ prompt: 'consent' });
            const linked = pendingLink;
            pendingLink = '';
            $('#linkNotice').classList.add('hidden');
            if (linked) await openStore(new GoogleStore(linked), { fromLink: true });
            else showGardenScreen();
        } catch (error) {
            const el = $('#startError');
            el.textContent = errorMessage(error);
            el.classList.remove('hidden');
        }
    });
    $('#localButton').addEventListener('click', showGardenScreen);

    $('#recentList').addEventListener('click', e => {
        const open = e.target.closest('[data-open]');
        const forget = e.target.closest('[data-forget]');
        if (open) {
            const [type, ...rest] = open.dataset.open.split(':');
            const id = rest.join(':');
            openStore(type === 'google' ? new GoogleStore(id) : new LocalStore(id));
        } else if (forget) {
            const [type, ...rest] = forget.dataset.forget.split(':');
            forgetGarden(type, rest.join(':'));
            showGardenScreen();
        }
    });

    $('#pickButton').addEventListener('click', async () => {
        try {
            const picked = await pickSpreadsheet({ title: t('pickTitle'), locale: getLanguage() });
            if (picked) await openStore(new GoogleStore(picked.id));
        } catch (error) {
            toast(errorMessage(error), 'error');
        }
    });

    $('#newGardenForm').addEventListener('submit', async e => {
        e.preventDefault();
        const name = $('#newGardenName').value.trim();
        if (!name) return;
        if (hasValidToken()) {
            showLoading(true);
            try {
                const store = await GoogleStore.create(name);
                $('#newGardenName').value = '';
                await openStore(store);
            } catch (error) {
                toast(errorMessage(error), 'error');
            } finally {
                showLoading(false);
            }
        } else {
            $('#newGardenName').value = '';
            await openStore(LocalStore.create(name));
        }
    });

    $('#openUrlForm').addEventListener('submit', async e => {
        e.preventDefault();
        const id = spreadsheetIdFromUrl($('#openUrlInput').value);
        if (!id) {
            toast(t('errBadLink'), 'error');
            return;
        }
        await openStore(new GoogleStore(id));
    });

    $('#importInput').addEventListener('change', async e => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            const text = await file.text();
            const garden = /\.json$/i.test(file.name) ? gardenFromJson(text) : gardenFromCsv(text);
            await openStore(LocalStore.fromGarden(garden, file.name.replace(/\.[^.]+$/, '')));
        } catch (error) {
            toast(t('errImport', { message: error.message }), 'error');
        }
    });

    $('#demoButton').addEventListener('click', () => openStore(LocalStore.fromGarden(demoGarden(t('demoName')))));

    $('#signOutButton').addEventListener('click', () => {
        signOut();
        document.body.classList.remove('google-on');
        showScreen('startScreen');
    });
}

function bindMainScreen() {
    planView = new PlanView($('#plan'), {
        onSelect: (sel, station) => actions.select(sel, station),
        onAdd: (x, y) => newPointDialog('', null, state.frame.invert({ x, y })),
        onMove: (name, x, y) => actions.movePoint(name, x, y)
    });
    panels.measure = new MeasurePanel($('#tab-measure'), app);
    panels.hints = new HintsPanel($('#tab-hints'), app);
    panels.points = new PointsPanel($('#tab-points'), app);
    panels.measurements = new MeasurementsPanel($('#tab-measurements'), app);
    panels.settings = new SettingsPanel($('#tab-settings'), app);

    $('.tabs').addEventListener('click', e => {
        const btn = e.target.closest('[data-tab]');
        if (!btn) return;
        state.ui.tab = btn.dataset.tab;
        panels[state.ui.tab].render();
        renderTabs();
    });
    $('#fitButton').addEventListener('click', () => planView.fit());
    $('#selectButton').addEventListener('click', () => actions.setTool('select'));
    $('#addPointButton').addEventListener('click', () => actions.setTool('add'));
    $('#moveButton').addEventListener('click', () => actions.setTool('move'));
    $('#lineButton').addEventListener('click', () => actions.setTool('line'));
    $('#rectButton').addEventListener('click', () => actions.setTool('rect'));
    $('#rotateButton').addEventListener('click', () => actions.rotate());
    $('#layersButton').addEventListener('click', () => {
        renderLayersMenu();
        $('#layersMenu').classList.toggle('hidden');
    });
    $('#layersMenu').addEventListener('change', e => {
        const key = e.target.dataset.layer;
        if (!key) return;
        state.ui.layers[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        saveLayers();
        renderPlan();
    });
    $('#gardensButton').addEventListener('click', actions.switchGarden);
    $('#syncBadge').addEventListener('click', async () => {
        const store = state.store;
        if (!store || store.type !== 'google') return;
        if (store.sync.state === 'auth') {
            try {
                await requestToken({ prompt: '' });
            } catch (error) {
                toast(errorMessage(error), 'error');
                return;
            }
        }
        store.flush();
    });
    $('#modal').addEventListener('click', e => {
        if (e.target.id === 'modal') closeModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeModal();
    });
}

function renderLayersMenu() {
    const L = state.ui.layers;
    const check = key => `<label class="check"><input type="checkbox" data-layer="${key}"${L[key] ? ' checked' : ''}> ${escapeHtml(t(`layer_${key}`))}</label>`;
    $('#layersMenu').innerHTML = `
        ${['lines', 'hiddenLines', 'hiddenPoints', 'ellipses', 'labels', 'heights', 'hints', 'grid'].map(k => (k === 'grid' ? `<label class="check"><input type="checkbox" data-layer="grid"${L.grid !== false ? ' checked' : ''}> ${escapeHtml(t('layer_grid'))}</label>` : check(k))).join('')}
        <label class="field compact">${escapeHtml(t('colorBy'))}<select data-layer="colorBy">
            <option value="category"${L.colorBy === 'category' ? ' selected' : ''}>${escapeHtml(t('colorByCategory'))}</option>
            <option value="height"${L.colorBy === 'height' ? ' selected' : ''}>${escapeHtml(t('colorByHeight'))}</option></select></label>
        <label class="field compact">${escapeHtml(t('ellipseScale'))}<select data-layer="ellipseScale">
            ${['auto', '1', '10', '100', '1000'].map(v => `<option value="${v}"${String(L.ellipseScale) === v ? ' selected' : ''}>${v === 'auto' ? escapeHtml(t('automatic')) : `×${v}`}</option>`).join('')}</select></label>`;
}

function initLanguageSelect() {
    const sel = $('#languageSelect');
    sel.innerHTML = LANGUAGES.map(l => `<option value="${l.code}"${l.code === getLanguage() ? ' selected' : ''}>${l.label}</option>`).join('');
    sel.addEventListener('change', () => {
        setLanguage(sel.value);
        if (document.body.dataset.screen === 'gardenScreen') showGardenScreen();
        if (state.garden) {
            renderAll();
            if (!$('#layersMenu').classList.contains('hidden')) renderLayersMenu();
        }
    });
}

async function boot() {
    document.documentElement.lang = getLanguage();
    applyTranslations(document);
    initLanguageSelect();
    bindStartAndGardenScreens();
    bindMainScreen();

    if (!isConfigured()) {
        $('#signInButton').disabled = true;
        $('#notConfigured').classList.remove('hidden');
    }

    // The link in a garden spreadsheet: ?sheet=<spreadsheet id>. It opens that garden, which recomputes it and
    // writes the results back. The parameter is dropped from the address so a reload keeps the usual flow.
    const params = new URLSearchParams(location.search);
    const linked = spreadsheetIdFromUrl(params.get('sheet') || '');
    if (params.has('sheet')) {
        params.delete('sheet');
        const query = params.toString();
        history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    }
    if (linked && isConfigured()) {
        if (hasValidToken()) {
            await openStore(new GoogleStore(linked), { fromLink: true });
            return;
        }
        // Signing in needs a click (popup); the sign-in button then opens the linked garden.
        pendingLink = linked;
        $('#linkNotice').classList.remove('hidden');
        showScreen('startScreen');
        return;
    }

    let current = null;
    try {
        current = JSON.parse(sessionStorage.getItem('plantape:current') || 'null');
    } catch {
        // ignore
    }
    if (current && (current.type === 'local' || hasValidToken())) {
        await openStore(current.type === 'google' ? new GoogleStore(current.id) : new LocalStore(current.id));
    } else if (hasValidToken()) {
        showGardenScreen();
    } else {
        showScreen('startScreen');
    }
}

boot();
