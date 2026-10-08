// Measurement entry. "From" is the point I'm standing at (tape at height h) or a line (a measured pair,
// e.g. a fence); "to" is a point or a line. The pair decides what is measured:
//     point → point   distance (with tape heights)
//     line  → point   shortest distance from the line (0 = the point is on the line)
//     line  → line    angle between the lines

import { t } from '../i18n.js';
import { escapeHtml, fmt } from '../util.js';
import { rowFor, rowForMeasurement } from '../solver/adjust.js';
import { checkMeasurement, parseDistance } from '../solver/blunders.js';
import { suggestMeasurements, suggestOffsets, pairKey } from '../solver/planner.js';
import { kindOf, pointsOfMeasurement, resolveAngle, normalizeAngle, directedAngle, signedOffset } from '../solver/observations.js';
import { CATEGORY_COLORS } from './plan-view.js';
import { gainLabel } from './hints-panel.js';
import { toEntry, fromEntry, formatDistance } from '../units.js';
import {
    lineKey, isLine, lineEnds, lineLabel, selectionLabel, sameLine, availableLines,
    describeMeasurement, formatValue, formatResidual
} from './describe.js';

const MAX_LINES = 12;

function heightChips(kind, current, heights) {
    const values = [...new Set([0, ...heights])].sort((a, b) => a - b);
    const custom = !values.includes(current);
    return `<div class="chips" role="group">${values.map(h =>
        `<button type="button" class="chip${h === current ? ' active' : ''}" data-action="height" data-kind="${kind}" data-value="${h}">${fmt(h, h % 1 ? 2 : 0)} m</button>`).join('')}
        <input class="chip-input${custom ? ' active' : ''}" type="text" inputmode="decimal" data-custom-height="${kind}" value="${custom ? current : ''}" placeholder="${escapeHtml(t('customHeight'))}" aria-label="${escapeHtml(t('customHeight'))}">
    </div>`;
}

// Typed angle in degrees (decimal comma accepted), NaN when invalid.
function parseAngle(text) {
    const s = String(text ?? '').trim().replace(',', '.').replace(/°$/, '');
    return /^[-+]?(\d*\.?\d+|\d+\.)$/.test(s) ? parseFloat(s) : NaN;
}

function trimAngle(v) {
    return String(Math.round(v * 10) / 10);
}

export class MeasurePanel {
    constructor(el, app) {
        this.el = el;
        this.app = app;
        this.filter = '';
        this.draft = '';
        this.draftTyped = false; // true once the user edited the value; pre-fills never overwrite that
        this.prefilledFrom = null; // the stored measurement the current draft was pre-filled from
        this.note = '';
        el.addEventListener('focusin', e => {
            if (e.target.id === 'distanceInput' && !this.draftTyped) e.target.select();
        });
        el.addEventListener('click', e => this.onClick(e));
        el.addEventListener('input', e => this.onInput(e));
        el.addEventListener('change', e => this.onChange(e));
        el.addEventListener('keydown', e => {
            if (e.key === 'Enter' && e.target.id === 'distanceInput') {
                e.preventDefault();
                this.save();
            }
        });
    }

    get ui() {
        return this.app.state.ui;
    }

    get unit() {
        return this.app.state.garden?.settings.entryUnit === 'm' ? 'm' : 'cm';
    }

    // What the current from/to pair measures: 'distance' | 'offset' | 'angle' | null.
    get mode() {
        const { station, target } = this.ui;
        if (!station || !target || station === target) return null;
        const l1 = isLine(station);
        const l2 = isLine(target);
        if (l1 && l2) {
            const [a, b] = lineEnds(station);
            const [c, d] = lineEnds(target);
            return sameLine(a, b, c, d) ? null : 'angle';
        }
        if (l1 || l2) {
            const [a, b] = lineEnds(l1 ? station : target);
            const p = l1 ? target : station;
            return p === a || p === b ? null : 'offset';
        }
        return 'distance';
    }

    // The measurement the form would save (value from the draft), without id/timestamp.
    currentMeasurement() {
        const { station, target } = this.ui;
        const mode = this.mode;
        if (mode === 'offset') {
            const lineSel = isLine(station) ? station : target;
            const [a, b] = lineEnds(lineSel);
            const text = this.draft.trim() === '' ? '0' : this.draft;
            return { kind: 'offset', from: a, fromB: b, to: isLine(station) ? target : station, ...fromEntry(text, this.unit), typed: `${text.trim()} ${this.unit}` };
        }
        if (mode === 'angle') {
            const [a, b] = lineEnds(station);
            const [c, d] = lineEnds(target);
            const typed = parseAngle(this.draft);
            const m = { kind: 'angle', from: a, fromB: b, to: c, toB: d };
            const now = this.currentAngle(m);
            return { ...m, distance: Number.isFinite(typed) ? resolveAngle(typed, now) : NaN, typed: this.draft.trim() ? `${this.draft.trim()}°` : '', now };
        }
        return {
            kind: 'distance',
            from: station,
            fromH: this.ui.stationH,
            to: target,
            toH: this.ui.targetH,
            ...fromEntry(this.draft, this.unit),
            typed: this.draft.trim() ? `${this.draft.trim()} ${this.unit}` : ''
        };
    }

    // Current angle (°, [0, 180)) between the lines from computed or sketched positions, or NaN.
    currentAngle(m) {
        const row = this.app.state.result?.solution && rowForMeasurement(this.app.state.result.solution, m);
        if (row) return row.value;
        const pos = this.app.state.positions;
        const [A, B, C, D] = [m.from, m.fromB, m.to, m.toB].map(n => pos?.get(n));
        if (!A || !B || !C || !D) return NaN;
        return normalizeAngle((directedAngle(A, B, C, D) * 180) / Math.PI);
    }

    // Latest stored (not excluded) measurement of the current selection, in either direction. For angles
    // between the same lines picked the other way round, `flip` says the value reads 180° − θ.
    lastStored() {
        const { station, stationH, target, targetH } = this.ui;
        const mode = this.mode;
        if (!mode) return null;
        const cur = this.currentMeasurement();
        const same = (a, b) => Math.abs((a || 0) - (b || 0)) < 1e-9;
        const list = this.app.state.garden.measurements;
        for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i];
            if (m.status === 'excluded' || kindOf(m) !== mode) continue;
            if (mode === 'distance') {
                if ((m.from === station && m.to === target && same(m.fromH, stationH) && same(m.toH, targetH)) ||
                    (m.from === target && m.to === station && same(m.fromH, targetH) && same(m.toH, stationH))) return { m };
            } else if (mode === 'offset') {
                if (m.to === cur.to && sameLine(m.from, m.fromB, cur.from, cur.fromB)) return { m };
            } else {
                if (sameLine(m.from, m.fromB, cur.from, cur.fromB) && sameLine(m.to, m.toB, cur.to, cur.toB)) return { m };
                if (sameLine(m.from, m.fromB, cur.to, cur.toB) && sameLine(m.to, m.toB, cur.from, cur.fromB)) return { m, flip: true };
            }
        }
        return null;
    }

    // Puts the last stored value of the selection into the value field (offsets default to 0), unless the
    // user has already typed something.
    applyPrefill() {
        if (this.draftTyped) return;
        const last = this.lastStored();
        this.prefilledFrom = last?.m || null;
        // A new offset starts at 0 ("on the line"); that default is not checked until it is confirmed.
        this.draftDefault = !last && this.mode === 'offset';
        if (!last) this.draft = this.draftDefault ? '0' : '';
        else if (this.mode === 'angle') this.draft = trimAngle(last.flip ? normalizeAngle(180 - last.m.distance) : last.m.distance);
        else this.draft = toEntry(last.m.distance, this.unit);
    }

    render() {
        const { garden } = this.app.state;
        if (!garden) return;
        const names = garden.points.map(p => p.name).sort((a, b) => a.localeCompare(b));
        const heights = garden.settings.heights;
        if (!names.length) {
            this.el.innerHTML = `<div class="empty-state"><p>${escapeHtml(t('firstPointIntro'))}</p>
                <button class="primary" data-action="newPoint" data-role="station">${escapeHtml(t('addFirstPoint'))}</button></div>`;
            return;
        }
        const lines = availableLines(garden);
        const lineKeys = lines.map(([a, b]) => lineKey(a, b));
        const valid = key => !key || (isLine(key) ? lineEnds(key).every(n => names.includes(n)) : names.includes(key));
        if (!valid(this.ui.station)) this.ui.station = '';
        if (!valid(this.ui.target)) this.ui.target = '';
        const station = this.ui.station;
        // A line picked on the plan the other way round is shown under its listed key.
        const listed = isLine(station) ? lineKeys.find(k => sameLine(...lineEnds(k), ...lineEnds(station))) : null;
        const stationValue = listed || station;
        this.el.innerHTML = `
            <div class="field">
                <label for="stationSelect">${escapeHtml(t('stationLabel'))}</label>
                <div class="row">
                    <select id="stationSelect" data-bind="station">
                        <option value="">${escapeHtml(t('chooseStation'))}</option>
                        <optgroup label="${escapeHtml(t('groupPoints'))}">
                            ${names.map(n => `<option value="${escapeHtml(n)}"${n === stationValue ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')}
                        </optgroup>
                        ${lines.length ? `<optgroup label="${escapeHtml(t('groupLines'))}">
                            ${lines.map(([a, b]) => `<option value="${escapeHtml(lineKey(a, b))}"${lineKey(a, b) === stationValue ? ' selected' : ''}>${escapeHtml(lineLabel(a, b))}</option>`).join('')}
                        </optgroup>` : ''}
                        ${isLine(station) && !listed ? `<option value="${escapeHtml(station)}" selected>${escapeHtml(selectionLabel(station))}</option>` : ''}
                    </select>
                    <button type="button" data-action="newPoint" data-role="station" title="${escapeHtml(t('newPoint'))}">＋</button>
                </div>
                ${isLine(station) ? `<p class="muted small">${escapeHtml(t('fromLineHelp'))}</p>` : `<div class="sub-label">${escapeHtml(t('tapeHeightHere'))}</div>
                ${heightChips('station', this.ui.stationH, heights)}`}
            </div>
            <div data-part="targets"></div>
            <div data-part="form"></div>
            <div data-part="history"></div>`;
        this.renderTargets();
        this.renderForm();
        this.renderHistory();
    }

    stationContext() {
        const { garden, result } = this.app.state;
        const solution = result?.solution;
        const station = this.ui.station;
        const counts = new Map();
        const blocked = new Set(garden.blocked.map(b => pairKey(b.a, b.b)));
        const gains = new Map();
        if (isLine(station)) {
            const [a, b] = lineEnds(station);
            for (const m of garden.measurements) {
                if (kindOf(m) === 'offset' && sameLine(m.from, m.fromB, a, b)) counts.set(m.to, (counts.get(m.to) || 0) + 1);
            }
            if (solution?.u && solution.index.has(a) && solution.index.has(b)) {
                for (const s of suggestOffsets(solution, { line: [a, b], tapeLength: Infinity, use3D: garden.settings.mode3d, maxResults: 10000 })) gains.set(s.to, s);
            }
            return { solution, counts, blocked, gains };
        }
        for (const m of garden.measurements) {
            if (kindOf(m) !== 'distance') continue;
            if (m.from === station) counts.set(m.to, (counts.get(m.to) || 0) + 1);
            else if (m.to === station) counts.set(m.from, (counts.get(m.from) || 0) + 1);
        }
        if (solution?.u && solution.index.has(station)) {
            for (const s of suggestMeasurements(solution, {
                station, tapeLength: Infinity, blocked, use3D: garden.settings.mode3d, heights: garden.settings.heights, maxResults: 10000
            })) gains.set(s.to === station ? s.from : s.to, s);
        }
        return { solution, counts, blocked, gains };
    }

    // Expected value of measuring from the current station to point `name`: from the solution, or
    // roughly from sketched positions ({ value, rough }), or null.
    estimate(name) {
        const station = this.ui.station;
        const sol = this.app.state.result?.solution;
        const pos = this.app.state.positions;
        if (isLine(station)) {
            const [a, b] = lineEnds(station);
            const row = sol && rowForMeasurement(sol, { kind: 'offset', from: a, fromB: b, to: name, distance: 1 });
            if (row) return { value: row.value, rough: false };
            const [A, B, P] = [a, b, name].map(n => pos?.get(n));
            return A && B && P ? { value: Math.abs(signedOffset(A, B, P).s), rough: true } : null;
        }
        const row = sol ? rowFor(sol, station, this.ui.stationH, name, this.ui.targetH) : null;
        if (row) return { value: row.dist, rough: false };
        const [S, P] = [station, name].map(n => pos?.get(n));
        return S && P ? { value: Math.hypot(P.x - S.x, P.y - S.y), rough: true } : null;
    }

    // Distance between the midpoints of two lines (for sorting nearby lines first); Infinity if unknown.
    lineDistance(a, b, c, d) {
        const pos = this.app.state.positions;
        const [A, B, C, D] = [a, b, c, d].map(n => pos?.get(n));
        if (!A || !B || !C || !D) return Infinity;
        return Math.hypot((A.x + B.x - C.x - D.x) / 2, (A.y + B.y - C.y - D.y) / 2);
    }

    renderTargets() {
        const part = this.el.querySelector('[data-part="targets"]');
        if (!part) return;
        const { garden } = this.app.state;
        const station = this.ui.station;
        if (!station) {
            part.innerHTML = `<p class="muted">${escapeHtml(t('pickStationFirst'))}</p>`;
            return;
        }
        const fromLine = isLine(station);
        const ends = fromLine ? lineEnds(station) : [station];
        const { counts, blocked, gains } = this.stationContext();
        const tape = garden.settings.tapeLength;
        const filter = this.filter.trim().toLowerCase();
        const items = [];
        for (const p of garden.points) {
            if (ends.includes(p.name)) continue;
            if (filter && !p.name.toLowerCase().includes(filter)) continue;
            const isBlocked = !fromLine && blocked.has(pairKey(station, p.name));
            const est = this.estimate(p.name);
            const estimate = est ? est.value : null;
            if (this.ui.onlyReachable && ((estimate !== null && estimate > tape) || isBlocked) && p.name !== this.ui.target) continue;
            items.push({ p, est, isBlocked, count: counts.get(p.name) || 0, gain: gains.get(p.name) });
        }
        items.sort((a, b) => (a.est?.value ?? Infinity) - (b.est?.value ?? Infinity) || a.p.name.localeCompare(b.p.name));
        const exact = garden.points.some(p => p.name.toLowerCase() === filter);

        let linesHtml = '';
        if (fromLine) {
            const [a, b] = ends;
            const others = availableLines(garden)
                .filter(([c, d]) => !sameLine(a, b, c, d))
                .filter(([c, d]) => !filter || c.toLowerCase().includes(filter) || d.toLowerCase().includes(filter))
                .map(([c, d]) => ({ c, d, shared: [c, d].some(n => n === a || n === b), far: this.lineDistance(a, b, c, d) }))
                .sort((x, y) => Number(y.shared) - Number(x.shared) || x.far - y.far || lineLabel(x.c, x.d).localeCompare(lineLabel(y.c, y.d)));
            const shown = filter ? others : others.slice(0, MAX_LINES);
            linesHtml = shown.length ? `
                <div class="sub-label">${escapeHtml(t('angleToLine'))}</div>
                <ul class="target-list">${shown.map(({ c, d }) => {
                    const key = lineKey(c, d);
                    const now = this.currentAngle({ kind: 'angle', from: a, fromB: b, to: c, toB: d });
                    const active = isLine(this.ui.target) && sameLine(c, d, ...lineEnds(this.ui.target));
                    return `<li><button type="button" class="target${active ? ' active' : ''}" data-action="target" data-name="${escapeHtml(key)}">
                        <span class="dot line-dot"></span>
                        <span class="name">${escapeHtml(lineLabel(c, d))}</span>
                        <span class="meta">${Number.isFinite(now) ? `≈ ${fmt(now, 0)}°` : escapeHtml(t('notPlaced'))}</span>
                    </button></li>`;
                }).join('')}</ul>
                ${others.length > shown.length ? `<p class="muted small">${escapeHtml(t('moreLines', { n: others.length - shown.length }))}</p>` : ''}` : '';
        }

        part.innerHTML = `
            <div class="field">
                <label for="targetFilter">${escapeHtml(t(fromLine ? 'measureFromLineTo' : 'measureTo'))}</label>
                <input id="targetFilter" type="search" data-bind="filter" value="${escapeHtml(this.filter)}" placeholder="${escapeHtml(t('filterOrNew'))}" autocomplete="off">
                <label class="check"><input type="checkbox" data-bind="onlyReachable"${this.ui.onlyReachable ? ' checked' : ''}> ${escapeHtml(t('onlyReachable', { tape }))}</label>
            </div>
            <ul class="target-list">
                ${items.map(({ p, est, isBlocked, count, gain }) => `
                    <li><button type="button" class="target${p.name === this.ui.target ? ' active' : ''}${isBlocked ? ' blocked' : ''}" data-action="target" data-name="${escapeHtml(p.name)}">
                        <span class="dot" style="background:${CATEGORY_COLORS[p.category] || CATEGORY_COLORS.other}"></span>
                        <span class="name">${escapeHtml(p.name)}</span>
                        <span class="meta">${est ? `${est.rough ? '~' : '≈'} ${formatDistance(est.value, this.unit)}` : escapeHtml(t('notPlaced'))}${gain ? ` · ${escapeHtml(gainLabel(gain, garden.settings.mode3d))}` : ''}${count ? ` · ${count}×` : ''}${isBlocked ? ` · ${escapeHtml(t('blocked'))}` : ''}</span>
                    </button></li>`).join('') || `<li class="muted">${escapeHtml(t('noTargets'))}</li>`}
            </ul>
            ${filter && !exact ? `<button type="button" class="secondary" data-action="newPoint" data-role="target" data-name="${escapeHtml(this.filter.trim())}">${escapeHtml(t('createPointNamed', { name: this.filter.trim() }))}</button>` : ''}
            ${!filter ? `<button type="button" class="link-button" data-action="newPoint" data-role="target">＋ ${escapeHtml(t('newPoint'))}</button>` : ''}
            ${linesHtml}`;
    }

    renderForm() {
        const part = this.el.querySelector('[data-part="form"]');
        if (!part) return;
        const { garden } = this.app.state;
        const { station, target } = this.ui;
        const mode = this.mode;
        if (!mode) {
            part.innerHTML = '';
            return;
        }
        const input = unitLabel => `<div class="row distance-row">
                <input id="distanceInput" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(this.draft)}" placeholder="${escapeHtml(t(mode === 'angle' ? 'anglePlaceholder' : 'distancePlaceholder'))}" aria-label="${escapeHtml(t(mode === 'angle' ? 'anglePlaceholder' : 'distancePlaceholder'))}">
                <span class="unit">${unitLabel}</span>
            </div>`;
        const tail = `<div class="predict" data-part="predict"></div>
            <input id="noteInput" type="text" value="${escapeHtml(this.note)}" placeholder="${escapeHtml(t('notePlaceholder'))}">`;
        if (mode === 'offset') {
            const m = this.currentMeasurement();
            part.innerHTML = `
                <div class="measure-form card-inset">
                    <div class="pair">${escapeHtml(lineLabel(m.from, m.fromB))} ⊥ <strong>${escapeHtml(m.to)}</strong></div>
                    <p class="muted small">${escapeHtml(t('offsetHelp', { line: lineLabel(m.from, m.fromB), point: m.to }))}</p>
                    ${input(this.unit)}
                    ${tail}
                    <div class="row">
                        <button type="button" class="primary grow" data-action="save">${escapeHtml(t('saveMeasurement'))}</button>
                        <button type="button" data-action="saveZero" title="${escapeHtml(t('onLineHelp'))}">${escapeHtml(t('onLine'))}</button>
                    </div>
                </div>`;
        } else if (mode === 'angle') {
            const typed = parseAngle(this.draft);
            part.innerHTML = `
                <div class="measure-form card-inset">
                    <div class="pair">${escapeHtml(selectionLabel(station))} ∠ <strong>${escapeHtml(selectionLabel(target))}</strong></div>
                    <p class="muted small">${escapeHtml(t('angleHelp'))}</p>
                    <div class="chips" role="group">
                        <button type="button" class="chip${typed === 90 ? ' active' : ''}" data-action="angleChip" data-value="90">⟂ 90°</button>
                        <button type="button" class="chip${typed === 0 || typed === 180 ? ' active' : ''}" data-action="angleChip" data-value="0">∥ 0°</button>
                    </div>
                    ${input('°')}
                    <div class="muted small" data-part="angleNow"></div>
                    ${tail}
                    <div class="row">
                        <button type="button" class="primary grow" data-action="save">${escapeHtml(t('saveMeasurement'))}</button>
                    </div>
                </div>`;
        } else {
            part.innerHTML = `
                <div class="measure-form card-inset">
                    <div class="pair">${escapeHtml(station)} <small>(${fmt(this.ui.stationH, 2)} m)</small> → <strong>${escapeHtml(target)}</strong></div>
                    <div class="sub-label">${escapeHtml(t('tapeHeightThere', { name: target }))}</div>
                    ${heightChips('target', this.ui.targetH, garden.settings.heights)}
                    ${input(this.unit)}
                    ${tail}
                    <div class="row">
                        <button type="button" class="primary grow" data-action="save">${escapeHtml(t('saveMeasurement'))}</button>
                        <button type="button" class="ghost" data-action="block" title="${escapeHtml(t('blockHelp'))}">${escapeHtml(t('markBlocked'))}</button>
                    </div>
                </div>`;
        }
        this.renderPredict();
    }

    renderPredict() {
        const part = this.el.querySelector('[data-part="predict"]');
        if (!part) return;
        const solution = this.app.state.result?.solution;
        const input = this.el.querySelector('#distanceInput');
        input?.classList.remove('suspect', 'ok');
        const m = this.currentMeasurement();
        const nowPart = this.el.querySelector('[data-part="angleNow"]');
        if (nowPart) {
            nowPart.textContent = Number.isFinite(m.now)
                ? (Number.isFinite(m.distance) ? t('angleNowStore', { now: fmt(m.now, 0), value: trimAngle(m.distance) }) : t('angleNow', { now: fmt(m.now, 0) }))
                : '';
        }
        if (!solution) {
            part.textContent = '';
            return;
        }
        const prefix = this.prefilledFrom && !this.draftTyped
            ? `${t('lastStored', { date: this.prefilledFrom.timestamp || '?' })} ` : '';
        const hasValue = m.kind === 'offset' ? !(this.draftDefault && !this.draftTyped) && Number.isFinite(m.distance) && m.distance >= 0
            : Number.isFinite(m.distance) && (m.kind === 'angle' || m.distance > 0);
        const probe = checkMeasurement(solution, { ...m, distance: hasValue ? m.distance : 1 });
        if (probe.status === 'unknown') {
            part.textContent = prefix + t(`predict_${probe.reason}`);
            return;
        }
        const angle = m.kind === 'angle';
        let text = prefix + (angle
            ? t('expectedAngle', { value: fmt(probe.predicted, 1), tol: fmt(probe.tol, 1) })
            : t('expected', { value: formatDistance(probe.predicted, this.unit), tol: fmt(probe.tol * 100, 1) }));
        if (hasValue) {
            const check = checkMeasurement(solution, m);
            input?.classList.add(check.status === 'suspect' ? 'suspect' : 'ok');
            if (check.status === 'suspect') text += ` — ${angle ? t('differsByAngle', { dev: fmt(check.deviation, 1) }) : t('differsBy', { dev: fmt(check.deviation * 100, 1) })}`;
        }
        part.textContent = text;
    }

    renderHistory() {
        const part = this.el.querySelector('[data-part="history"]');
        if (!part) return;
        const { garden, result } = this.app.state;
        const station = this.ui.station;
        if (!station) {
            part.innerHTML = '';
            return;
        }
        const relevant = m => {
            if (!isLine(station)) return pointsOfMeasurement(m).includes(station);
            const [a, b] = lineEnds(station);
            const k = kindOf(m);
            if (k === 'distance') return sameLine(m.from, m.to, a, b);
            return sameLine(m.from, m.fromB, a, b) || (k === 'angle' && sameLine(m.to, m.toB, a, b));
        };
        const list = garden.measurements.filter(relevant).slice(-12).reverse();
        if (!list.length) {
            part.innerHTML = '';
            return;
        }
        const suspects = new Set((result?.suspects || []).map(s => s.id));
        part.innerHTML = `<h4>${escapeHtml(t('stationHistory', { name: selectionLabel(station) }))}</h4>
            <ul class="history">${list.map(m => {
                const r = result?.solution.measurements.get(m.id);
                const cls = m.status === 'excluded' ? 'excluded' : suspects.has(m.id) ? 'suspect' : '';
                return `<li class="${cls}"><span>${escapeHtml(describeMeasurement(m))}</span>
                    <span class="num">${escapeHtml(formatValue(m, this.unit))}${r?.used && Number.isFinite(r.residual) ? ` <small>v ${escapeHtml(formatResidual(m, r.residual))}</small>` : ''}</span>
                    <button type="button" class="tiny" data-action="toggle" data-id="${escapeHtml(m.id)}">${escapeHtml(t(m.status === 'excluded' ? 'include' : 'exclude'))}</button></li>`;
            }).join('')}</ul>`;
    }

    // Selects a measurement to take (used by hints and "measure again"): { kind, from, fromB, fromH, to, toB, toH }.
    prefill(h) {
        const k = h.kind || 'distance';
        if (k === 'offset') Object.assign(this.ui, { station: lineKey(h.from, h.fromB), target: h.to });
        else if (k === 'angle') Object.assign(this.ui, { station: lineKey(h.from, h.fromB), target: h.to ? lineKey(h.to, h.toB) : '' });
        else Object.assign(this.ui, { station: h.from, stationH: h.fromH || 0, target: h.to, targetH: h.toH || 0 });
        this.filter = '';
        this.draftTyped = false;
        this.applyPrefill();
        this.render();
        this.el.querySelector('#distanceInput')?.focus();
    }

    // Selection from the plan: the first tap picks "from", later taps pick "to".
    select(key) {
        if (!this.ui.station) {
            this.ui.station = key;
            if (this.ui.target === key) this.ui.target = '';
        } else if (key === this.ui.station) {
            return;
        } else {
            if (this.ui.target !== key) this.draftTyped = false;
            this.ui.target = key;
        }
        this.draftTyped = false;
        this.applyPrefill();
        this.render();
        if (this.mode) this.el.querySelector('#distanceInput')?.focus();
    }

    save(zero = false) {
        if (zero) {
            this.draft = '0';
            this.draftTyped = true;
        }
        const m = this.currentMeasurement();
        const ok = m.kind === 'offset' ? Number.isFinite(m.distance) && m.distance >= 0
            : m.kind === 'angle' ? Number.isFinite(m.distance) : m.distance > 0;
        if (!ok) {
            this.app.toast(t(m.kind === 'angle' ? 'invalidAngle' : 'invalidDistance'), 'error');
            this.el.querySelector('#distanceInput')?.focus();
            return;
        }
        const measurement = { ...m, note: this.note.trim() };
        delete measurement.now;
        if (m.kind !== 'distance') {
            delete measurement.fromH;
            delete measurement.toH;
        }
        this.app.actions.submitMeasurement(measurement, () => {
            this.draftTyped = false;
            this.applyPrefill();
            this.note = '';
            this.renderForm();
            this.renderHistory();
            this.renderTargets();
            this.el.querySelector('#targetFilter')?.focus();
        });
    }

    onClick(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'height') {
            const key = btn.dataset.kind === 'station' ? 'stationH' : 'targetH';
            this.ui[key] = Number(btn.dataset.value);
            this.applyPrefill();
            this.render();
            this.app.renderPlan();
        } else if (action === 'target') {
            if (this.ui.target !== btn.dataset.name) this.draftTyped = false;
            this.ui.target = btn.dataset.name;
            this.applyPrefill();
            this.renderTargets();
            this.renderForm();
            this.app.renderPlan();
            this.el.querySelector('#distanceInput')?.focus();
        } else if (action === 'newPoint') {
            const role = btn.dataset.role;
            this.app.actions.newPointDialog(btn.dataset.name || '', name => {
                if (role === 'station' || !this.ui.station) this.ui.station = name;
                else this.ui.target = name;
                this.draftTyped = false;
                this.applyPrefill();
                this.filter = '';
                this.render();
            });
        } else if (action === 'save') {
            this.save();
        } else if (action === 'saveZero') {
            this.save(true);
        } else if (action === 'angleChip') {
            this.draft = btn.dataset.value;
            this.draftTyped = true;
            this.renderForm();
            this.el.querySelector('#distanceInput')?.focus();
        } else if (action === 'block') {
            this.app.actions.blockPair(this.ui.station, this.ui.target);
            this.ui.target = '';
            this.render();
        } else if (action === 'toggle') {
            this.app.actions.toggleMeasurement(btn.dataset.id);
        }
    }

    onInput(e) {
        const el = e.target;
        if (el.dataset.bind === 'filter') {
            this.filter = el.value;
            const pos = el.selectionStart;
            this.renderTargets();
            const again = this.el.querySelector('#targetFilter');
            again.focus();
            again.setSelectionRange(pos, pos);
        } else if (el.id === 'distanceInput') {
            this.draft = el.value;
            this.draftTyped = el.value.trim() !== '';
            this.renderPredict();
        } else if (el.id === 'noteInput') {
            this.note = el.value;
        } else if (el.dataset.customHeight) {
            const v = parseDistance(el.value);
            if (Number.isFinite(v)) {
                this.ui[el.dataset.customHeight === 'station' ? 'stationH' : 'targetH'] = v;
                this.renderPredict();
            }
        }
    }

    onChange(e) {
        const el = e.target;
        if (el.dataset.bind === 'station') {
            this.ui.station = el.value;
            if (this.ui.target === el.value) this.ui.target = '';
            this.draftTyped = false;
            this.applyPrefill();
            this.render();
            this.app.renderPlan();
        } else if (el.dataset.bind === 'onlyReachable') {
            this.ui.onlyReachable = el.checked;
            this.renderTargets();
        } else if (el.dataset.customHeight) {
            this.applyPrefill();
            this.render();
        }
    }
}
