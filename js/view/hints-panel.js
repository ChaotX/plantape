// Network status, suspected typos and the ranked list of most useful next measurements.

import { t } from '../i18n.js';
import { escapeHtml, fmt } from '../util.js';
import { formatDistance } from '../units.js';

// "+12 % plan · +30 % height" — the shares by which total plan / height uncertainty would shrink.
export function gainLabel(h, use3D) {
    const parts = [];
    const pct = v => fmt(v, v < 10 ? 1 : 0);
    if (h.xyPct >= 0.05 || !use3D) parts.push(t('gainPlan', { pct: pct(h.xyPct) }));
    if (use3D && h.zPct >= 0.05) parts.push(t('gainHeight', { pct: pct(h.zPct) }));
    return parts.join(' · ');
}

export class HintsPanel {
    constructor(el, app) {
        this.el = el;
        this.app = app;
        el.addEventListener('click', e => this.onClick(e));
    }

    render() {
        const { garden, result, hints, under } = this.app.state;
        if (!garden || !result) return;
        const sol = result.solution;
        const placed = [...sol.points.values()].filter(p => p.placed).length;
        const active = garden.measurements.filter(m => m.status !== 'excluded').length;
        const unchecked = [...sol.measurements.values()].filter(r => r.used && r.r < 0.05).length;
        const byId = new Map(garden.measurements.map(m => [m.id, m]));
        const suspects = result.suspects || [];
        const unit = garden.settings.entryUnit === 'm' ? 'm' : 'cm';

        const summary = `
            <div class="stats">
                <div><strong>${placed}</strong>/${sol.points.size}<span>${escapeHtml(t('statPlaced'))}</span></div>
                <div><strong>${active}</strong><span>${escapeHtml(t('statMeasurements'))}</span></div>
                <div><strong>${fmt(sol.redundancy, 1)}</strong><span>${escapeHtml(t('statRedundancy'))}</span></div>
                <div><strong>${sol.s0 === null ? '–' : fmt(sol.s0, 2)}</strong><span title="${escapeHtml(t('s0Help'))}">${escapeHtml(t('statS0'))}</span></div>
                <div><strong>${sol.is3D ? '3D' : '2D'}</strong><span>${escapeHtml(t('statMode'))}</span></div>
            </div>
            ${!sol.is3D && garden.settings.mode3d && placed >= 3 ? `<p class="notice">${escapeHtml(t('hint2DMode'))}</p>` : ''}
            ${sol.warnings.includes('weakGeometry') ? `<p class="notice">${escapeHtml(t('warnWeakGeometry'))}</p>` : ''}
            ${(garden.warnings || []).map(w => `<p class="notice">${escapeHtml(t(w.key, w.params))}</p>`).join('')}`;

        const suspectHtml = suspects.length ? `
            <h4 class="danger">${escapeHtml(t('suspectsTitle'))}</h4>
            <p class="muted">${escapeHtml(t(garden.settings.autoExclude ? 'suspectsAutoExcluded' : 'suspectsIncluded'))}</p>
            <ul class="cards">${suspects.map(s => {
                const m = byId.get(s.id);
                if (!m) return '';
                return `<li class="card-inset suspect">
                    <div><strong>${escapeHtml(m.from)}</strong> (${fmt(m.fromH, 1)}) → <strong>${escapeHtml(m.to)}</strong> (${fmt(m.toH, 1)}): <strong>${formatDistance(m.distance, unit)}</strong></div>
                    <div class="muted">${escapeHtml(t('suspectDetail', { w: fmt(Math.abs(s.w), 1), expected: s.predicted === null ? '?' : formatDistance(s.predicted, unit) }))}</div>
                    <div class="row wrap">
                        ${s.suggestions.map(c => `<button type="button" class="primary small" data-action="fix" data-id="${escapeHtml(m.id)}" data-value="${c.value}" data-kind="${c.kind}">${escapeHtml(t('useValue', { value: formatDistance(c.value, unit), kind: t(`kind_${c.kind}`) }))}</button>`).join('')}
                        <button type="button" class="small" data-action="exclude" data-id="${escapeHtml(m.id)}">${escapeHtml(t('exclude'))}</button>
                        <button type="button" class="small" data-action="remeasure" data-id="${escapeHtml(m.id)}">${escapeHtml(t('remeasure'))}</button>
                    </div></li>`;
            }).join('')}</ul>` : '';

        const underHtml = under.length ? `
            <h4>${escapeHtml(t('needsLinksTitle'))}</h4>
            <ul class="plain">${under.map(u => `<li><button type="button" class="link-button" data-action="station" data-name="${escapeHtml(u.name)}">${escapeHtml(u.name)}</button> — ${escapeHtml(t(u.status === 'weak' ? 'needsLinkWeak' : 'needsLinks', { n: u.needed }))}</li>`).join('')}</ul>` : '';

        const hintsHtml = hints.length ? `
            <h4>${escapeHtml(t('bestNextTitle'))}</h4>
            <ol class="hint-list">${hints.map((h, i) => `
                <li><button type="button" class="hint" data-action="hint" data-index="${i}">
                    <span class="rank">${i + 1}</span>
                    <span class="name">${escapeHtml(h.from)} <small>${fmt(h.fromH, 1)} m</small> ↔ ${escapeHtml(h.to)} <small>${fmt(h.toH, 1)} m</small></span>
                    <span class="meta">≈ ${formatDistance(h.estimate, garden.settings.entryUnit === 'm' ? 'm' : 'cm')}<br>${escapeHtml(gainLabel(h, garden.settings.mode3d))}</span>
                </button></li>`).join('')}</ol>
            <p class="muted small">${escapeHtml(t('gainHelp'))}</p>` : placed >= 2 ? `<p class="muted">${escapeHtml(t('noHints'))}</p>` : '';

        const uncheckedHtml = unchecked ? `<p class="muted">${escapeHtml(t('uncheckedNote', { n: unchecked }))}</p>` : '';

        this.el.innerHTML = summary + suspectHtml + underHtml + hintsHtml + uncheckedHtml +
            `<label class="check"><input type="checkbox" data-bind="showHints"${this.app.state.ui.layers.hints ? ' checked' : ''}> ${escapeHtml(t('showHintsOnPlan'))}</label>`;
        this.el.querySelector('[data-bind="showHints"]').addEventListener('change', e => {
            this.app.state.ui.layers.hints = e.target.checked;
            this.app.saveLayers();
            this.app.renderPlan();
        });
    }

    onClick(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const { actions, state } = this.app;
        const action = btn.dataset.action;
        if (action === 'hint') actions.useHint(state.hints[Number(btn.dataset.index)]);
        else if (action === 'station') actions.useHint({ from: btn.dataset.name, fromH: 0, to: '', toH: 0 });
        else if (action === 'fix') actions.applyCorrection(btn.dataset.id, Number(btn.dataset.value), btn.dataset.kind);
        else if (action === 'exclude') actions.toggleMeasurement(btn.dataset.id, 'excluded');
        else if (action === 'remeasure') {
            const m = state.garden.measurements.find(x => x.id === btn.dataset.id);
            if (m) actions.useHint({ from: m.from, fromH: m.fromH, to: m.to, toH: m.toH });
        }
    }
}
