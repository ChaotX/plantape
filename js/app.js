// Plantape main controller: screens, garden lifecycle, recomputation and actions.

import { t, setLanguage, getLanguage, applyTranslations, LANGUAGES } from './i18n.js';
import { isConfigured, hasValidToken, requestToken, signOut } from './google-auth.js';
import { pickSpreadsheet, spreadsheetIdFromUrl } from './picker.js';
import { GoogleStore, LocalStore, recentGardens, rememberGarden, forgetGarden } from './store.js';
import { solverInput, gardenFromJson, gardenFromCsv, CATEGORIES } from './model.js';
import { snoop, checkMeasurement } from './solver/blunders.js';
import { suggestMeasurements, underdeterminedPoints, pairKey } from './solver/planner.js';
import { PlanView, CATEGORY_COLORS } from './view/plan-view.js';
import { MeasurePanel } from './view/measure-panel.js';
import { HintsPanel } from './view/hints-panel.js';
import { PointsPanel, MeasurementsPanel, SettingsPanel } from './view/data-panels.js';
import { downloadSvg, downloadPdf, downloadPointsCsv, downloadGardenJson } from './export.js';
import { demoGarden } from './demo.js';
import { escapeHtml, fmt, uid, nowStamp, storage } from './util.js';
import { formatDistance } from './units.js';

const unit = () => (state.garden?.settings.entryUnit === 'm' ? 'm' : 'cm');
const dist = metres => formatDistance(metres, unit());

const $ = sel => document.querySelector(sel);

const DEFAULT_LAYERS = { lines: true, ellipses: true, labels: true, heights: true, hints: true, colorBy: 'category', ellipseScale: 'auto' };
const saved = storage.get('plantape:view', {});

const state = {
    store: null,
    garden: null,
    result: null,
    hints: [],
    under: [],
    ui: {
        tab: 'measure',
        station: '',
        stationH: 0,
        target: '',
        targetH: 0,
        selected: '',
        onlyReachable: true,
        layers: { ...DEFAULT_LAYERS, ...(saved.layers || {}) },
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
    toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 6000 : 3000);
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
    storage.set('plantape:view', { layers: state.ui.layers, export: state.ui.export });
}

function errorMessage(error) {
    const status = error?.status;
    if (status === 403 || status === 404) return t('errNoAccess');
    return error?.message || String(error);
}

// ---- Computation --------------------------------------------------------------------------------

function recompute() {
    const garden = state.garden;
    const s = garden.settings;
    const res = snoop(solverInput(garden));
    const solution = s.autoExclude ? res.solution : res.initial;
    const blocked = new Set(garden.blocked.map(b => pairKey(b.a, b.b)));
    state.result = { solution, suspects: res.suspects };
    state.hints = solution.u ? suggestMeasurements(solution, { tapeLength: s.tapeLength, blocked, use3D: s.mode3d, heights: s.heights, maxResults: 8 }) : [];
    state.under = underdeterminedPoints(solution);
}

// ---- Rendering ----------------------------------------------------------------------------------

let planView;
const panels = {};

function renderPlan() {
    if (!state.result) return;
    const layers = state.ui.layers;
    planView.setScene({
        solution: state.result.solution,
        garden: state.garden,
        suspects: new Set(state.result.suspects.map(s => s.id)),
        hints: layers.hints ? state.hints : [],
        selected: state.ui.selected,
        station: state.ui.station,
        target: state.ui.target,
        options: layers
    });
    const anyPlaced = [...state.result.solution.points.values()].some(p => p.placed);
    $('#planEmpty').classList.toggle('hidden', anyPlaced);
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

// ---- Garden lifecycle ---------------------------------------------------------------------------

async function openStore(store) {
    state.store?.dispose?.();
    state.store = store;
    store.onSync(renderSync);
    $('#gardenError').classList.add('hidden');
    showLoading(true);
    try {
        state.garden = await store.load();
    } catch (error) {
        state.store = null;
        showLoading(false);
        const el = $('#gardenError');
        el.textContent = errorMessage(error);
        el.classList.remove('hidden');
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

function newPointDialog(initialName, onCreated) {
    let category = 'other';
    const card = openModal(`
        <h3>${escapeHtml(t('newPoint'))}</h3>
        <label class="field">${escapeHtml(t('pointName'))}<input id="pointNameInput" type="text" value="${escapeHtml(initialName)}" autocomplete="off" autofocus></label>
        <div class="sub-label">${escapeHtml(t('category'))}</div>
        <div class="chips">${CATEGORIES.map(c => `<button type="button" class="chip${c === category ? ' active' : ''}" data-action="category" data-value="${c}"><span class="dot" style="background:${CATEGORY_COLORS[c]}"></span>${escapeHtml(t(`cat_${c}`))}</button>`).join('')}</div>
        <label class="field">${escapeHtml(t('pointNotes'))}<input id="pointNotesInput" type="text"></label>
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
            state.store.addPoint({ name, category, notes: card.querySelector('#pointNotesInput').value.trim() });
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
    const msg = t('saved', { from: m.from, to: m.to, d: dist(m.distance) });
    toast(check?.status === 'ok' ? `${msg} ✓ ${t('matchesExpected')}` : msg, 'ok');
    done?.();
}

// Checks a new measurement against the current solution; suspicious values open the typo dialog.
function submitMeasurement(m, done) {
    const check = checkMeasurement(state.result.solution, m);
    if (check.status !== 'suspect') {
        commitMeasurement(m, check, done);
        return;
    }
    openModal(`
        <h3>${escapeHtml(t('checkTitle'))}</h3>
        <p>${escapeHtml(t('checkText', { d: dist(m.distance), expected: dist(check.predicted), dev: fmt(check.deviation * 100, 1), tol: fmt(check.tol * 100, 1) }))}</p>
        ${check.suggestions.length ? `<p>${escapeHtml(t('didYouMean'))}</p>` : ''}
        <div class="column">
            ${check.suggestions.map(c => `<button type="button" class="primary" data-action="use" data-value="${c.value}">${escapeHtml(t('useValue', { value: dist(c.value), kind: t(`kind_${c.kind}`) }))}</button>`).join('')}
            <button type="button" data-action="keep">${escapeHtml(t('keepValue', { value: dist(m.distance) }))}</button>
            <button type="button" class="ghost" data-action="close">${escapeHtml(t('cancelRemeasure'))}</button>
        </div>`, {
        use: btn => {
            closeModal();
            const value = Number(btn.dataset.value);
            commitMeasurement({ ...m, distance: value, raw: undefined, typed: undefined, note: [m.note, t('correctedFrom', { value: m.typed || dist(m.distance) })].filter(Boolean).join(' ') }, { status: 'ok' }, done);
        },
        keep: () => {
            closeModal();
            commitMeasurement(m, check, done);
        }
    });
}

const actions = {
    newPointDialog,
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
        const note = [m.note, t('correctedFrom', { value: dist(m.distance) })].filter(Boolean).join(' ');
        state.store.updateMeasurement(id, { distance: value, note, raw: undefined, status: 'active' });
        toast(t('corrected', { value: dist(value), kind: t(`kind_${kind}`) }), 'ok');
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
        if (['origin', 'axis', 'side', 'flip'].includes(key)) planView.fit();
    },

    saveSettings() {
        state.store.saveSettings(state.garden.settings);
        rememberGarden({ type: state.store.type, id: state.store.id, name: state.store.title });
    },

    async writeResults() {
        showLoading(true);
        try {
            await state.store.writeResults(state.result.solution, state.result.suspects);
            toast(t('resultsWritten'), 'ok');
            refresh(); // rows typed by hand may have received ids
        } catch (error) {
            toast(errorMessage(error), 'error');
        } finally {
            showLoading(false);
        }
    },

    async reload() {
        await openStore(new GoogleStore(state.store.id));
    },

    exportOptions() {
        return { ...state.ui.export, title: state.store.title };
    },

    exportScene() {
        return { solution: state.result.solution, garden: state.garden, suspects: new Set(state.result.suspects.map(s => s.id)), options: state.ui.layers };
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

// ---- Wiring -------------------------------------------------------------------------------------

function bindStartAndGardenScreens() {
    $('#signInButton').addEventListener('click', async () => {
        $('#startError').classList.add('hidden');
        try {
            await requestToken({ prompt: 'consent' });
            showGardenScreen();
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
    planView = new PlanView($('#plan'), { onPointClick: name => {
        if (state.ui.tab === 'measure' && state.ui.station && name !== state.ui.station) {
            state.ui.target = name;
            panels.measure.render();
            renderPlan();
            return;
        }
        if (state.ui.tab === 'measure' && !state.ui.station) {
            state.ui.station = name;
            panels.measure.render();
            renderPlan();
            return;
        }
        actions.selectPoint(name);
    } });
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
    $('#zoomInButton').addEventListener('click', () => planView.zoomBy(1.4));
    $('#zoomOutButton').addEventListener('click', () => planView.zoomBy(1 / 1.4));
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
        ${['lines', 'ellipses', 'labels', 'heights', 'hints', 'grid'].map(k => (k === 'grid' ? `<label class="check"><input type="checkbox" data-layer="grid"${L.grid !== false ? ' checked' : ''}> ${escapeHtml(t('layer_grid'))}</label>` : check(k))).join('')}
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
