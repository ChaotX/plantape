// Points table, measurements table and the settings / export panel.

import { t } from '../i18n.js';
import { escapeHtml, fmt, debounce } from '../util.js';
import { CATEGORY_COLORS } from './plan-view.js';
import { PAPERS, SCALES } from '../export.js';

export class PointsPanel {
    constructor(el, app) {
        this.el = el;
        this.app = app;
        el.addEventListener('click', e => {
            const row = e.target.closest('[data-point]');
            if (row) app.actions.selectPoint(row.dataset.point);
        });
    }

    render() {
        const { garden, result, ui } = this.app.state;
        if (!garden || !result) return;
        const cats = new Map(garden.points.map(p => [p.name, p.category]));
        const rows = [...result.solution.points].sort((a, b) => a[0].localeCompare(b[0]));
        const z = result.solution.is3D;
        this.el.innerHTML = rows.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>${escapeHtml(t('colName'))}</th><th>x</th><th>y</th>${z ? '<th>z</th>' : ''}<th>σxy</th>${z ? '<th>σz</th>' : ''}<th>${escapeHtml(t('colLinks'))}</th></tr></thead>
            <tbody>${rows.map(([name, p]) => `
                <tr data-point="${escapeHtml(name)}" class="${name === ui.selected ? 'selected' : ''} status-${p.status}">
                    <td><span class="dot" style="background:${CATEGORY_COLORS[cats.get(name)] || CATEGORY_COLORS.other}"></span>${escapeHtml(name)}${p.status === 'datum' ? ' <small>◆</small>' : ''}</td>
                    ${p.placed ? `<td class="num">${fmt(p.x)}</td><td class="num">${fmt(p.y)}</td>${z ? `<td class="num${p.zMeasured ? '' : ' muted'}">${p.zMeasured ? '' : '~'}${fmt(p.z)}</td>` : ''}
                    <td class="num">${p.status === 'datum' && !(p.sxy > 0) ? '0' : fmt(p.sxy * 100, 1) + ' cm'}</td>${z ? `<td class="num${p.zMeasured ? '' : ' muted'}">${p.status === 'datum' && !(p.sz > 0) ? '0' : fmt(p.sz * 100, 1) + ' cm'}</td>` : ''}`
                    : `<td colspan="${z ? 5 : 3}" class="muted">${escapeHtml(t('notPlaced'))}</td>`}
                    <td class="num">${p.links}${p.status === 'weak' ? ' ⚠' : ''}</td>
                </tr>`).join('')}</tbody></table></div>
            <p class="muted small">${escapeHtml(t('pointsLegend'))}</p>` : `<p class="muted">${escapeHtml(t('noPoints'))}</p>`;
    }
}

export class MeasurementsPanel {
    constructor(el, app) {
        this.el = el;
        this.app = app;
        el.addEventListener('click', e => {
            const btn = e.target.closest('[data-action="toggle"]');
            if (btn) app.actions.toggleMeasurement(btn.dataset.id);
        });
    }

    render() {
        const { garden, result } = this.app.state;
        if (!garden || !result) return;
        const suspects = new Set((result.suspects || []).map(s => s.id));
        const list = garden.measurements.slice().reverse();
        this.el.innerHTML = list.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>${escapeHtml(t('colFrom'))}</th><th>${escapeHtml(t('colTo'))}</th><th>d [m]</th><th>v [mm]</th><th>w</th><th></th></tr></thead>
            <tbody>${list.map(m => {
                const r = result.solution.measurements.get(m.id) || {};
                const flag = m.status === 'excluded' ? 'excluded' : suspects.has(m.id) ? 'suspect' : r.used && r.w !== null && Math.abs(r.w) > 2 ? 'warn' : '';
                return `<tr class="${flag}" title="${escapeHtml([m.timestamp, m.note].filter(Boolean).join(' · '))}">
                    <td>${escapeHtml(m.from)} <small>${fmt(m.fromH, 1)}</small></td>
                    <td>${escapeHtml(m.to)} <small>${fmt(m.toH, 1)}</small></td>
                    <td class="num">${fmt(m.distance, 3)}</td>
                    <td class="num">${r.used && Number.isFinite(r.residual) ? fmt(r.residual * 1000, 0) : '–'}</td>
                    <td class="num">${r.used ? (r.w === null ? `<span title="${escapeHtml(t('uncheckedHelp'))}">·</span>` : fmt(r.w, 1)) : '–'}</td>
                    <td><button type="button" class="tiny" data-action="toggle" data-id="${escapeHtml(m.id)}">${escapeHtml(t(m.status === 'excluded' ? 'include' : 'exclude'))}</button></td>
                </tr>`;
            }).join('')}</tbody></table></div>
            <p class="muted small">${escapeHtml(t('measurementsLegend'))}</p>` : `<p class="muted">${escapeHtml(t('noMeasurements'))}</p>`;
    }
}

export class SettingsPanel {
    constructor(el, app) {
        this.el = el;
        this.app = app;
        this.save = debounce(() => app.actions.saveSettings(), 700);
        el.addEventListener('change', e => this.onChange(e));
        el.addEventListener('click', e => this.onClick(e));
    }

    render() {
        const { garden, store, ui } = this.app.state;
        if (!garden) return;
        const s = garden.settings;
        const names = garden.points.map(p => p.name).sort((a, b) => a.localeCompare(b));
        const pointSelect = (key, emptyLabel) => `<select data-setting="${key}"><option value="">${escapeHtml(emptyLabel)}</option>${names.map(n => `<option value="${escapeHtml(n)}"${n === s[key] ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select>`;
        const exp = ui.export;
        const google = store?.type === 'google';
        this.el.innerHTML = `
            <section>
                <h4>${escapeHtml(t('gardenSection'))}</h4>
                <label class="field">${escapeHtml(t('gardenName'))}<input type="text" data-setting="gardenName" value="${escapeHtml(s.gardenName)}"></label>
                ${google ? `<div class="row wrap">
                    <a class="button" href="${escapeHtml(store.url)}" target="_blank" rel="noopener">${escapeHtml(t('openSheet'))}</a>
                    <button type="button" data-action="writeResults">${escapeHtml(t('writeResults'))}</button>
                    <button type="button" data-action="reload">${escapeHtml(t('reloadSheet'))}</button>
                </div><p class="muted small">${escapeHtml(t('writeResultsHelp'))}</p>` : `<p class="muted small">${escapeHtml(t('localHelp'))}</p>`}
            </section>
            <section>
                <h4>${escapeHtml(t('datumSection'))}</h4>
                <p class="muted small">${escapeHtml(t('datumHelp'))}</p>
                <label class="field">${escapeHtml(t('datumOrigin'))}${pointSelect('origin', t('automatic'))}</label>
                <label class="field">${escapeHtml(t('datumAxis'))}${pointSelect('axis', t('automatic'))}</label>
                <label class="field">${escapeHtml(t('datumSide'))}${pointSelect('side', t('automatic'))}</label>
                <label class="check"><input type="checkbox" data-setting="flip"${s.flip ? ' checked' : ''}> ${escapeHtml(t('flip'))}</label>
            </section>
            <section>
                <h4>${escapeHtml(t('surveySection'))}</h4>
                <label class="check"><input type="checkbox" data-setting="mode3d"${s.mode3d ? ' checked' : ''}> ${escapeHtml(t('mode3d'))}</label>
                <label class="field">${escapeHtml(t('entryUnit'))}<select data-setting="entryUnit">
                    <option value="cm"${s.entryUnit !== 'm' ? ' selected' : ''}>cm</option>
                    <option value="m"${s.entryUnit === 'm' ? ' selected' : ''}>m</option></select></label>
                <label class="field">${escapeHtml(t('tapeLength'))}<input type="number" min="1" step="1" data-setting="tapeLength" value="${s.tapeLength}"></label>
                <label class="field">${escapeHtml(t('heightPresets'))}<input type="text" data-setting="heights" value="${escapeHtml(s.heights.join('; '))}"></label>
                <label class="field">${escapeHtml(t('sigmaConst'))}<input type="number" min="0.1" step="0.5" data-setting="sigmaConst" value="${fmt(s.sigmaConst * 1000, 1)}"></label>
                <label class="field">${escapeHtml(t('sigmaRel'))}<input type="number" min="0" step="0.5" data-setting="sigmaRel" value="${fmt(s.sigmaRel * 1000, 1)}"></label>
                <label class="check"><input type="checkbox" data-setting="autoExclude"${s.autoExclude ? ' checked' : ''}> ${escapeHtml(t('autoExclude'))}</label>
            </section>
            <section>
                <h4>${escapeHtml(t('exportSection'))}</h4>
                <div class="row wrap">
                    <label class="field compact">${escapeHtml(t('paper'))}<select data-export="paper">${Object.keys(PAPERS).map(p => `<option${p === exp.paper ? ' selected' : ''}>${p}</option>`).join('')}</select></label>
                    <label class="field compact">${escapeHtml(t('orientation'))}<select data-export="orientation">
                        <option value="landscape"${exp.orientation === 'landscape' ? ' selected' : ''}>${escapeHtml(t('landscape'))}</option>
                        <option value="portrait"${exp.orientation === 'portrait' ? ' selected' : ''}>${escapeHtml(t('portrait'))}</option></select></label>
                    <label class="field compact">${escapeHtml(t('scale'))}<select data-export="scale">
                        <option value="fit"${exp.scale === 'fit' ? ' selected' : ''}>${escapeHtml(t('scaleFit'))}</option>
                        ${SCALES.map(v => `<option value="${v}"${String(v) === String(exp.scale) ? ' selected' : ''}>1:${v}</option>`).join('')}</select></label>
                </div>
                <p class="muted small">${escapeHtml(t('exportHelp'))}</p>
                <div class="row wrap">
                    <button type="button" data-action="exportPdf">PDF</button>
                    <button type="button" data-action="exportSvg">SVG</button>
                    <button type="button" data-action="exportCsv">${escapeHtml(t('exportCsv'))}</button>
                    <button type="button" data-action="exportJson">${escapeHtml(t('exportJson'))}</button>
                </div>
            </section>
            <section>
                <button type="button" class="ghost" data-action="switchGarden">${escapeHtml(t('switchGarden'))}</button>
            </section>`;
    }

    onChange(e) {
        const el = e.target;
        const { garden, ui } = this.app.state;
        if (el.dataset.export) {
            ui.export[el.dataset.export] = el.value;
            this.app.saveLayers();
            return;
        }
        const key = el.dataset.setting;
        if (!key) return;
        const s = garden.settings;
        if (el.type === 'checkbox') s[key] = el.checked;
        else if (key === 'sigmaConst' || key === 'sigmaRel') {
            const v = Number(el.value);
            if (Number.isFinite(v) && v >= 0) s[key] = v / 1000;
            if (key === 'sigmaConst' && s[key] <= 0) s[key] = 0.0001;
        } else if (key === 'tapeLength') {
            const v = Number(el.value);
            if (v > 0) s[key] = v;
        } else if (key === 'heights') {
            const list = el.value.split(/[;\s]+/).map(v => Number(v.replace(',', '.'))).filter(v => Number.isFinite(v) && v >= 0);
            s.heights = list.length ? [...new Set(list)] : [0, 1, 2];
        } else s[key] = el.value;
        this.app.actions.settingsChanged(key);
        this.save();
    }

    onClick(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const a = this.app.actions;
        const map = {
            writeResults: a.writeResults, reload: a.reload, exportPdf: a.exportPdf, exportSvg: a.exportSvg,
            exportCsv: a.exportCsv, exportJson: a.exportJson, switchGarden: a.switchGarden
        };
        map[btn.dataset.action]?.();
    }
}
