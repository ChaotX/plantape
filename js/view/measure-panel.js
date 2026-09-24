// Measurement entry: "I'm standing at point S with the tape at height h, measuring to T".

import { t } from '../i18n.js';
import { escapeHtml, fmt } from '../util.js';
import { rowFor } from '../solver/adjust.js';
import { checkMeasurement, parseDistance } from '../solver/blunders.js';
import { suggestMeasurements, pairKey } from '../solver/planner.js';
import { CATEGORY_COLORS } from './plan-view.js';
import { gainLabel } from './hints-panel.js';
import { toEntry, fromEntry, formatDistance } from '../units.js';

function heightChips(kind, current, heights) {
    const values = [...new Set([0, ...heights])].sort((a, b) => a - b);
    const custom = !values.includes(current);
    return `<div class="chips" role="group">${values.map(h =>
        `<button type="button" class="chip${h === current ? ' active' : ''}" data-action="height" data-kind="${kind}" data-value="${h}">${fmt(h, h % 1 ? 2 : 0)} m</button>`).join('')}
        <input class="chip-input${custom ? ' active' : ''}" type="text" inputmode="decimal" data-custom-height="${kind}" value="${custom ? current : ''}" placeholder="${escapeHtml(t('customHeight'))}" aria-label="${escapeHtml(t('customHeight'))}">
    </div>`;
}

export class MeasurePanel {
    constructor(el, app) {
        this.el = el;
        this.app = app;
        this.filter = '';
        this.draft = '';
        this.draftTyped = false; // true once the user edited the distance; pre-fills never overwrite that
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

    // Latest stored (not excluded) measurement of the current pair with the current tape heights,
    // in either direction.
    lastStored() {
        const { station, stationH, target, targetH } = this.ui;
        if (!station || !target) return null;
        const same = (a, b) => Math.abs((a || 0) - (b || 0)) < 1e-9;
        const list = this.app.state.garden.measurements;
        for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i];
            if (m.status === 'excluded') continue;
            if ((m.from === station && m.to === target && same(m.fromH, stationH) && same(m.toH, targetH)) ||
                (m.from === target && m.to === station && same(m.fromH, targetH) && same(m.toH, stationH))) return m;
        }
        return null;
    }

    // Puts the last stored value of the selected pair / heights into the distance field, unless the
    // user has already typed something.
    applyPrefill() {
        if (this.draftTyped) return;
        const last = this.lastStored();
        this.prefilledFrom = last;
        this.draft = last ? toEntry(last.distance, this.unit) : '';
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
        if (this.ui.station && !names.includes(this.ui.station)) this.ui.station = '';
        this.el.innerHTML = `
            <div class="field">
                <label for="stationSelect">${escapeHtml(t('stationLabel'))}</label>
                <div class="row">
                    <select id="stationSelect" data-bind="station">
                        <option value="">${escapeHtml(t('chooseStation'))}</option>
                        ${names.map(n => `<option value="${escapeHtml(n)}"${n === this.ui.station ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')}
                    </select>
                    <button type="button" data-action="newPoint" data-role="station" title="${escapeHtml(t('newPoint'))}">＋</button>
                </div>
                <div class="sub-label">${escapeHtml(t('tapeHeightHere'))}</div>
                ${heightChips('station', this.ui.stationH, heights)}
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
        for (const m of garden.measurements) {
            if (m.from === station) counts.set(m.to, (counts.get(m.to) || 0) + 1);
            else if (m.to === station) counts.set(m.from, (counts.get(m.from) || 0) + 1);
        }
        const blocked = new Set(garden.blocked.map(b => pairKey(b.a, b.b)));
        const gains = new Map();
        if (solution?.u && solution.index.has(station)) {
            for (const s of suggestMeasurements(solution, {
                station, tapeLength: Infinity, blocked, use3D: garden.settings.mode3d, heights: garden.settings.heights, maxResults: 10000
            })) gains.set(s.to, s);
        }
        return { solution, counts, blocked, gains };
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
        const { solution, counts, blocked, gains } = this.stationContext();
        const tape = garden.settings.tapeLength;
        const filter = this.filter.trim().toLowerCase();
        const items = [];
        for (const p of garden.points) {
            if (p.name === station) continue;
            if (filter && !p.name.toLowerCase().includes(filter)) continue;
            const isBlocked = blocked.has(pairKey(station, p.name));
            const row = solution ? rowFor(solution, station, this.ui.stationH, p.name, this.ui.targetH) : null;
            const estimate = row ? row.dist : null;
            if (this.ui.onlyReachable && ((estimate !== null && estimate > tape) || isBlocked) && p.name !== this.ui.target) continue;
            items.push({ p, estimate, isBlocked, count: counts.get(p.name) || 0, gain: gains.get(p.name) });
        }
        items.sort((a, b) => (a.estimate ?? Infinity) - (b.estimate ?? Infinity) || a.p.name.localeCompare(b.p.name));
        const exact = garden.points.some(p => p.name.toLowerCase() === filter);
        part.innerHTML = `
            <div class="field">
                <label for="targetFilter">${escapeHtml(t('measureTo'))}</label>
                <input id="targetFilter" type="search" data-bind="filter" value="${escapeHtml(this.filter)}" placeholder="${escapeHtml(t('filterOrNew'))}" autocomplete="off">
                <label class="check"><input type="checkbox" data-bind="onlyReachable"${this.ui.onlyReachable ? ' checked' : ''}> ${escapeHtml(t('onlyReachable', { tape }))}</label>
            </div>
            <ul class="target-list">
                ${items.map(({ p, estimate, isBlocked, count, gain }) => `
                    <li><button type="button" class="target${p.name === this.ui.target ? ' active' : ''}${isBlocked ? ' blocked' : ''}" data-action="target" data-name="${escapeHtml(p.name)}">
                        <span class="dot" style="background:${CATEGORY_COLORS[p.category] || CATEGORY_COLORS.other}"></span>
                        <span class="name">${escapeHtml(p.name)}</span>
                        <span class="meta">${estimate !== null ? `≈ ${formatDistance(estimate, this.unit)}` : escapeHtml(t('notPlaced'))}${gain ? ` · ${escapeHtml(gainLabel(gain, garden.settings.mode3d))}` : ''}${count ? ` · ${count}×` : ''}${isBlocked ? ` · ${escapeHtml(t('blocked'))}` : ''}</span>
                    </button></li>`).join('') || `<li class="muted">${escapeHtml(t('noTargets'))}</li>`}
            </ul>
            ${filter && !exact ? `<button type="button" class="secondary" data-action="newPoint" data-role="target" data-name="${escapeHtml(this.filter.trim())}">${escapeHtml(t('createPointNamed', { name: this.filter.trim() }))}</button>` : ''}
            ${!filter ? `<button type="button" class="link-button" data-action="newPoint" data-role="target">＋ ${escapeHtml(t('newPoint'))}</button>` : ''}`;
    }

    renderForm() {
        const part = this.el.querySelector('[data-part="form"]');
        if (!part) return;
        const { garden } = this.app.state;
        const { station, target } = this.ui;
        if (!station || !target || station === target) {
            part.innerHTML = '';
            return;
        }
        part.innerHTML = `
            <div class="measure-form card-inset">
                <div class="pair">${escapeHtml(station)} <small>(${fmt(this.ui.stationH, 2)} m)</small> → <strong>${escapeHtml(target)}</strong></div>
                <div class="sub-label">${escapeHtml(t('tapeHeightThere', { name: target }))}</div>
                ${heightChips('target', this.ui.targetH, garden.settings.heights)}
                <div class="row distance-row">
                    <input id="distanceInput" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(this.draft)}" placeholder="${escapeHtml(t('distancePlaceholder'))}" aria-label="${escapeHtml(t('distancePlaceholder'))}">
                    <span class="unit">${this.unit}</span>
                </div>
                <div class="predict" data-part="predict"></div>
                <input id="noteInput" type="text" value="${escapeHtml(this.note)}" placeholder="${escapeHtml(t('notePlaceholder'))}">
                <div class="row">
                    <button type="button" class="primary grow" data-action="save">${escapeHtml(t('saveMeasurement'))}</button>
                    <button type="button" class="ghost" data-action="block" title="${escapeHtml(t('blockHelp'))}">${escapeHtml(t('markBlocked'))}</button>
                </div>
            </div>`;
        this.renderPredict();
    }

    currentMeasurement() {
        return {
            from: this.ui.station,
            fromH: this.ui.stationH,
            to: this.ui.target,
            toH: this.ui.targetH,
            ...fromEntry(this.draft, this.unit),
            typed: this.draft.trim() ? `${this.draft.trim()} ${this.unit}` : ''
        };
    }

    renderPredict() {
        const part = this.el.querySelector('[data-part="predict"]');
        if (!part) return;
        const solution = this.app.state.result?.solution;
        const input = this.el.querySelector('#distanceInput');
        input?.classList.remove('suspect', 'ok');
        if (!solution) {
            part.textContent = '';
            return;
        }
        const m = this.currentMeasurement();
        const prefix = this.prefilledFrom && !this.draftTyped
            ? `${t('lastStored', { date: this.prefilledFrom.timestamp || '?' })} ` : '';
        const probe = checkMeasurement(solution, { ...m, distance: Number.isFinite(m.distance) ? m.distance : 1 });
        if (probe.status === 'unknown') {
            part.textContent = prefix + t(`predict_${probe.reason}`);
            return;
        }
        let text = prefix + t('expected', { value: formatDistance(probe.predicted, this.unit), tol: fmt(probe.tol * 100, 1) });
        if (Number.isFinite(m.distance) && m.distance > 0) {
            const check = checkMeasurement(solution, m);
            input?.classList.add(check.status === 'suspect' ? 'suspect' : 'ok');
            if (check.status === 'suspect') text += ` — ${t('differsBy', { dev: fmt(check.deviation * 100, 1) })}`;
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
        const list = garden.measurements.filter(m => m.from === station || m.to === station).slice(-12).reverse();
        if (!list.length) {
            part.innerHTML = '';
            return;
        }
        const suspects = new Set((result?.suspects || []).map(s => s.id));
        part.innerHTML = `<h4>${escapeHtml(t('stationHistory', { name: station }))}</h4>
            <ul class="history">${list.map(m => {
                const other = m.from === station ? m.to : m.from;
                const r = result?.solution.measurements.get(m.id);
                const cls = m.status === 'excluded' ? 'excluded' : suspects.has(m.id) ? 'suspect' : '';
                return `<li class="${cls}"><span>${escapeHtml(m.from)} (${fmt(m.fromH, 1)}) → ${escapeHtml(m.to)} (${fmt(m.toH, 1)})</span>
                    <span class="num">${formatDistance(m.distance, this.unit)}${r?.used && Number.isFinite(r.residual) ? ` <small>v ${fmt(r.residual * 1000, 0)} mm</small>` : ''}</span>
                    <button type="button" class="tiny" data-action="toggle" data-id="${escapeHtml(m.id)}" title="${escapeHtml(other)}">${escapeHtml(t(m.status === 'excluded' ? 'include' : 'exclude'))}</button></li>`;
            }).join('')}</ul>`;
    }

    // Selects a pair and heights (used by hints) and pre-fills the last stored value.
    prefill({ from, fromH, to, toH }) {
        Object.assign(this.ui, { station: from, stationH: fromH, target: to, targetH: toH });
        this.filter = '';
        this.draftTyped = false;
        this.applyPrefill();
        this.render();
        this.el.querySelector('#distanceInput')?.focus();
    }

    save() {
        const m = this.currentMeasurement();
        if (!(m.distance > 0)) {
            this.app.toast(t('invalidDistance'), 'error');
            this.el.querySelector('#distanceInput')?.focus();
            return;
        }
        this.app.actions.submitMeasurement({ ...m, note: this.note.trim() }, () => {
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
