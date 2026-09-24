// SVG plan view: a pure scene renderer (shared with exports) plus an interactive pan/zoom wrapper.

import { escapeHtml, fmt } from '../util.js';
import { t } from '../i18n.js';

export const CATEGORY_COLORS = {
    building: '#8d6e63',
    tree: '#2e7d32',
    shrub: '#7cb342',
    fence: '#6d4c41',
    path: '#9e9e9e',
    water: '#1e88e5',
    other: '#546e7a',
    '': '#37474f'
};

const VIRIDIS = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];
const ELLIPSE_K = 2.4477; // √χ²(2 dof, 95 %)

function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function heightColor(t01) {
    const x = Math.min(Math.max(t01, 0), 1) * (VIRIDIS.length - 1);
    const i = Math.min(Math.floor(x), VIRIDIS.length - 2);
    const f = x - i;
    const a = hexToRgb(VIRIDIS[i]);
    const b = hexToRgb(VIRIDIS[i + 1]);
    return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}

export function niceLength(target) {
    const p = 10 ** Math.floor(Math.log10(target));
    for (const m of [1, 2, 5, 10]) if (m * p >= target) return m * p;
    return 10 * p;
}

export function placedBounds(solution) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of solution?.points?.values() || []) {
        if (!p.placed) continue;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY, minZ, maxZ };
}

// Ellipse exaggeration so that a typical ellipse is visible (power of ten).
export function autoEllipseScale(solution, pxPerMetre, targetPx = 16) {
    const sizes = [];
    for (const p of solution.points.values()) if (p.placed && p.status !== 'datum' && p.ellipse.a > 0) sizes.push(p.ellipse.a);
    if (!sizes.length) return 1;
    sizes.sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    const raw = targetPx / (median * ELLIPSE_K * pxPerMetre);
    return raw <= 1 ? 1 : 10 ** Math.round(Math.log10(raw));
}

// Text with a white halo, drawn as a separate stroked copy underneath (svg2pdf ignores paint-order).
function haloText(x, y, size, color, html) {
    const common = `x="${x}" y="${y}" font-size="${size}" font-family="Helvetica, Arial, sans-serif"`;
    return `<text ${common} fill="#fff" stroke="#fff" stroke-width="${size * 0.25}" stroke-linejoin="round">${html}</text><text ${common} fill="${color}">${html}</text>`;
}

// scene: { solution, garden, suspects: Set, hints: [], selected, station, target, options }
// tf: { scale (units per metre), ox, oy } — screen = (ox + x·scale, oy − y·scale)
// style: { pointR, font, stroke, hit } in output units
export function renderScene(scene, tf, style) {
    const { solution, garden, options = {} } = scene;
    if (!solution) return '';
    const P = solution.points;
    const X = x => tf.ox + x * tf.scale;
    const Y = y => tf.oy - y * tf.scale;
    const out = [];
    const bounds = placedBounds(solution);
    const zRange = bounds && bounds.maxZ - bounds.minZ > 0.01 ? [bounds.minZ, bounds.maxZ] : null;
    const categories = new Map(garden.points.map(p => [p.name, p.category || '']));
    const sw = style.stroke;

    // Measurement lines
    if (options.lines !== false) {
        for (const m of garden.measurements) {
            const a = P.get(m.from);
            const b = P.get(m.to);
            if (!a?.placed || !b?.placed) continue;
            const r = solution.measurements.get(m.id) || {};
            let color = '#90a4ae';
            let width = sw;
            let dash = '';
            if (m.status === 'excluded') {
                color = '#b0bec5';
                dash = `${sw * 4} ${sw * 3}`;
            } else if (scene.suspects?.has(m.id)) {
                color = '#d32f2f';
                width = sw * 2.5;
            } else if (r.used && r.w !== null && Math.abs(r.w) > 2) {
                color = '#f57c00';
                width = sw * 1.8;
            } else if (r.used && r.r < 0.05) {
                dash = `${sw} ${sw * 2}`;
            }
            const title = `${m.from} (${fmt(m.fromH, 1)}) → ${m.to} (${fmt(m.toH, 1)}): ${fmt(m.distance, 3)} m` +
                (Number.isFinite(r.residual) ? `, v = ${fmt(r.residual * 1000, 1)} mm` : '') + (r.w != null ? `, w = ${fmt(r.w, 2)}` : '');
            out.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} data-meas="${escapeHtml(m.id)}"><title>${escapeHtml(title)}</title></line>`);
        }
    }

    // Suggested measurements
    (scene.hints || []).forEach((h, i) => {
        const a = P.get(h.from);
        const b = P.get(h.to);
        if (!a?.placed || !b?.placed) return;
        out.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="#1565c0" stroke-width="${sw * 1.5}" stroke-dasharray="${sw * 6} ${sw * 4}" opacity="0.8"/>`);
        const mx = (X(a.x) + X(b.x)) / 2;
        const my = (Y(a.y) + Y(b.y)) / 2;
        out.push(`<circle cx="${mx}" cy="${my}" r="${style.font * 0.75}" fill="#1565c0"/><text x="${mx}" y="${my + style.font * 0.35}" font-size="${style.font * 0.9}" font-family="Helvetica, Arial, sans-serif" text-anchor="middle" fill="#fff">${i + 1}</text>`);
    });

    // Error ellipses (95 %, exaggerated)
    if (options.ellipses !== false) {
        const k = ELLIPSE_K * (options.ellipseScale || 1);
        for (const [, p] of P) {
            if (!p.placed || p.status === 'datum' || !(p.ellipse.a > 0)) continue;
            const rx = p.ellipse.a * k * tf.scale;
            const ry = p.ellipse.b * k * tf.scale;
            if (!Number.isFinite(rx) || rx > 1e5) continue;
            const deg = (-p.ellipse.angle * 180) / Math.PI;
            out.push(`<ellipse cx="${X(p.x)}" cy="${Y(p.y)}" rx="${rx}" ry="${Math.max(ry, sw * 0.3)}" transform="rotate(${deg} ${X(p.x)} ${Y(p.y)})" fill="#ff7043" fill-opacity="0.15" stroke="#e64a19" stroke-width="${sw * 0.8}"/>`);
        }
    }

    // Points
    for (const [name, p] of P) {
        if (!p.placed) continue;
        const cx = X(p.x);
        const cy = Y(p.y);
        const fill = options.colorBy === 'height' && zRange ? heightColor((p.z - zRange[0]) / (zRange[1] - zRange[0])) : CATEGORY_COLORS[categories.get(name)] || CATEGORY_COLORS.other;
        const r = style.pointR;
        if (name === scene.station) out.push(`<circle cx="${cx}" cy="${cy}" r="${r * 2.4}" fill="none" stroke="#1565c0" stroke-width="${sw * 2}"/>`);
        if (name === scene.target) out.push(`<circle cx="${cx}" cy="${cy}" r="${r * 2.4}" fill="none" stroke="#2e7d32" stroke-width="${sw * 2}" stroke-dasharray="${sw * 3} ${sw * 2}"/>`);
        if (name === scene.selected) out.push(`<circle cx="${cx}" cy="${cy}" r="${r * 3}" fill="#ffeb3b" fill-opacity="0.5"/>`);
        if (p.status === 'weak') out.push(`<circle cx="${cx}" cy="${cy}" r="${r * 1.6}" fill="none" stroke="#f57c00" stroke-width="${sw * 1.5}"/>`);
        const shape = p.status === 'datum'
            ? `<rect x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" fill="${fill}" stroke="#fff" stroke-width="${sw}"/>`
            : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="#fff" stroke-width="${sw}"/>`;
        out.push(shape);
        if (style.hit) out.push(`<circle cx="${cx}" cy="${cy}" r="${style.hit}" fill="transparent" data-point="${escapeHtml(name)}" style="cursor:pointer"><title>${escapeHtml(name)}</title></circle>`);
        if (options.labels !== false) {
            out.push(haloText(cx + r * 1.6, cy - r * 0.6, style.font, '#212121', escapeHtml(name)));
            if (options.heights !== false && solution.is3D && p.zMeasured) {
                out.push(haloText(cx + r * 1.6, cy + style.font * 0.75, style.font * 0.75, '#546e7a', `${p.z >= 0 ? '+' : ''}${fmt(p.z, 2)}`));
            }
        }
    }
    return out.join('');
}

// Scale bar + axis arrows + optional height legend, anchored at (x, y) = bottom-left in output units.
export function renderOverlay({ tf, x, y, font, stroke, maxBar, zRange, ellipseScale, showEllipses }) {
    const out = [];
    const len = niceLength(maxBar / tf.scale / 1.5);
    const w = len * tf.scale;
    const h = font * 0.5;
    const ff = 'font-family="Helvetica, Arial, sans-serif"';
    out.push(`<rect x="${x}" y="${y - h}" width="${w / 2}" height="${h}" fill="#212121"/>`);
    out.push(`<rect x="${x + w / 2}" y="${y - h}" width="${w / 2}" height="${h}" fill="#fff" stroke="#212121" stroke-width="${stroke}"/>`);
    out.push(`<text x="${x}" y="${y - h - font * 0.3}" font-size="${font}" ${ff} fill="#212121">0</text>`);
    out.push(`<text x="${x + w}" y="${y - h - font * 0.3}" font-size="${font}" ${ff} text-anchor="middle" fill="#212121">${len} m</text>`);

    // Axis arrows (local survey frame: +x towards the axis point, +y to its left)
    const ax = x + w + font * 3;
    const ay = y;
    const L = font * 3;
    out.push(`<path d="M${ax} ${ay} h${L} m${-font * 0.6} ${-font * 0.35} l${font * 0.6} ${font * 0.35} l${-font * 0.6} ${font * 0.35} M${ax} ${ay} v${-L} m${-font * 0.35} ${font * 0.6} l${font * 0.35} ${-font * 0.6} l${font * 0.35} ${font * 0.6}" fill="none" stroke="#212121" stroke-width="${stroke * 1.5}"/>`);
    out.push(`<text x="${ax + L + font * 0.3}" y="${ay + font * 0.35}" font-size="${font}" ${ff} fill="#212121">x</text>`);
    out.push(`<text x="${ax - font * 0.3}" y="${ay - L - font * 0.3}" font-size="${font}" ${ff} fill="#212121">y</text>`);

    let lx = ax + L + font * 2.5;
    if (zRange) {
        const gw = font * 8;
        const steps = 12;
        for (let i = 0; i < steps; i++) {
            out.push(`<rect x="${lx + (gw * i) / steps}" y="${y - h * 1.6}" width="${gw / steps + stroke}" height="${h * 1.6}" fill="${heightColor(i / (steps - 1))}"/>`);
        }
        out.push(`<text x="${lx}" y="${y - h * 1.6 - font * 0.3}" font-size="${font * 0.85}" ${ff} fill="#212121">${fmt(zRange[0], 2)}</text>`);
        out.push(`<text x="${lx + gw}" y="${y - h * 1.6 - font * 0.3}" font-size="${font * 0.85}" ${ff} text-anchor="end" fill="#212121">${fmt(zRange[1], 2)} m</text>`);
        lx += gw + font;
    }
    if (showEllipses) {
        out.push(`<ellipse cx="${lx + font}" cy="${y - h}" rx="${font}" ry="${font * 0.5}" fill="#ff7043" fill-opacity="0.15" stroke="#e64a19" stroke-width="${stroke * 0.8}"/>`);
        out.push(`<text x="${lx + font * 2.4}" y="${y - h + font * 0.35}" font-size="${font * 0.85}" ${ff} fill="#212121">${escapeHtml(t('legendEllipse', { scale: ellipseScale }))}</text>`);
    }
    return out.join('');
}

// ---- Interactive view ---------------------------------------------------------------------------

export class PlanView {
    constructor(svg, { onPointClick } = {}) {
        this.svg = svg;
        this.onPointClick = onPointClick;
        this.scene = null;
        this.tf = null;
        this.pointers = new Map();
        this.moved = 0;
        this.bind();
        new ResizeObserver(() => (this.userMoved ? this.render() : this.fit())).observe(svg);
    }

    size() {
        const r = this.svg.getBoundingClientRect();
        return { w: Math.max(r.width, 1), h: Math.max(r.height, 1) };
    }

    // Keeps the whole network in view until the user pans or zooms by hand.
    setScene(scene) {
        this.scene = scene;
        if (!this.tf || !this.userMoved) this.fit();
        else this.render();
    }

    fit() {
        this.userMoved = false;
        const { w, h } = this.size();
        const b = placedBounds(this.scene?.solution);
        if (!b) {
            this.tf = { scale: 20, ox: w / 2, oy: h / 2 };
        } else {
            // Room for labels, the tool buttons (right) and the legend (bottom).
            const pad = { left: 24, right: 90, top: 28, bottom: 64 };
            const bw = Math.max(b.maxX - b.minX, 1);
            const bh = Math.max(b.maxY - b.minY, 1);
            const aw = Math.max(w - pad.left - pad.right, 40);
            const ah = Math.max(h - pad.top - pad.bottom, 40);
            const scale = Math.min(aw / bw, ah / bh);
            this.tf = {
                scale,
                ox: pad.left + aw / 2 - ((b.minX + b.maxX) / 2) * scale,
                oy: pad.top + ah / 2 + ((b.minY + b.maxY) / 2) * scale
            };
        }
        this.render();
    }

    zoomAt(factor, sx, sy) {
        if (!this.tf) return;
        this.userMoved = true;
        const scale = Math.min(Math.max(this.tf.scale * factor, 0.05), 5000);
        const f = scale / this.tf.scale;
        this.tf = { scale, ox: sx - (sx - this.tf.ox) * f, oy: sy - (sy - this.tf.oy) * f };
        this.render();
    }

    zoomBy(factor) {
        const { w, h } = this.size();
        this.zoomAt(factor, w / 2, h / 2);
    }

    centerOn(name) {
        const p = this.scene?.solution?.points.get(name);
        if (!p?.placed) return;
        const { w, h } = this.size();
        this.userMoved = true;
        this.tf = { ...this.tf, ox: w / 2 - p.x * this.tf.scale, oy: h / 2 + p.y * this.tf.scale };
        this.render();
    }

    ellipseScale() {
        const opt = this.scene?.options?.ellipseScale;
        if (opt && opt !== 'auto') return Number(opt);
        return this.scene?.solution ? autoEllipseScale(this.scene.solution, this.tf.scale) : 1;
    }

    render() {
        if (!this.scene || !this.tf) return;
        const { w, h } = this.size();
        this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        const ellipseScale = this.ellipseScale();
        const scene = { ...this.scene, options: { ...this.scene.options, ellipseScale } };
        const b = placedBounds(this.scene.solution);
        const zRange = this.scene.options?.colorBy === 'height' && b && b.maxZ - b.minZ > 0.01 ? [b.minZ, b.maxZ] : null;
        this.svg.innerHTML =
            `<rect x="0" y="0" width="${w}" height="${h}" fill="#fbfcf8"/>` +
            this.renderGrid(w, h) +
            renderScene(scene, this.tf, { pointR: 5, font: 13, stroke: 1.2, hit: 16 }) +
            `<rect x="6" y="${h - 40}" width="${Math.min(w - 12, 520)}" height="34" rx="6" fill="#fff" fill-opacity="0.85"/>` +
            renderOverlay({ tf: this.tf, x: 16, y: h - 14, font: 11, stroke: 1, maxBar: Math.min(w * 0.3, 160), zRange, ellipseScale, showEllipses: scene.options?.ellipses !== false });
    }

    renderGrid(w, h) {
        if (this.scene.options?.grid === false) return '';
        const step = niceLength(60 / this.tf.scale);
        const lines = [];
        const x0 = Math.ceil(-this.tf.ox / this.tf.scale / step) * step;
        for (let x = x0; this.tf.ox + x * this.tf.scale < w; x += step) {
            const sx = this.tf.ox + x * this.tf.scale;
            lines.push(`M${sx} 0V${h}`);
        }
        const y0 = Math.floor(this.tf.oy / this.tf.scale / step) * step;
        for (let y = y0; this.tf.oy - y * this.tf.scale < h; y -= step) {
            const sy = this.tf.oy - y * this.tf.scale;
            lines.push(`M0 ${sy}H${w}`);
        }
        return `<path d="${lines.join('')}" stroke="#e3e8e0" stroke-width="1" fill="none"/>`;
    }

    bind() {
        const svg = this.svg;
        const local = e => {
            const r = svg.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        };
        svg.addEventListener('wheel', e => {
            e.preventDefault();
            const p = local(e);
            this.zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
        }, { passive: false });
        svg.addEventListener('pointerdown', e => {
            svg.setPointerCapture(e.pointerId);
            this.pointers.set(e.pointerId, local(e));
            this.moved = 0;
            this.downTarget = e.target.closest?.('[data-point]')?.dataset.point || null;
        });
        svg.addEventListener('pointermove', e => {
            if (!this.pointers.has(e.pointerId) || !this.tf) return;
            const prev = this.pointers.get(e.pointerId);
            const cur = local(e);
            if (this.pointers.size === 1) {
                this.tf = { ...this.tf, ox: this.tf.ox + cur.x - prev.x, oy: this.tf.oy + cur.y - prev.y };
                this.moved += Math.hypot(cur.x - prev.x, cur.y - prev.y);
                if (this.moved > 6) this.userMoved = true;
                this.pointers.set(e.pointerId, cur);
                this.render();
            } else if (this.pointers.size === 2) {
                const [other] = [...this.pointers].filter(([id]) => id !== e.pointerId).map(([, p]) => p);
                const before = Math.hypot(prev.x - other.x, prev.y - other.y);
                const after = Math.hypot(cur.x - other.x, cur.y - other.y);
                this.pointers.set(e.pointerId, cur);
                this.moved += 10;
                if (before > 0) this.zoomAt(after / before, (cur.x + other.x) / 2, (cur.y + other.y) / 2);
            }
        });
        const end = e => {
            if (!this.pointers.has(e.pointerId)) return;
            this.pointers.delete(e.pointerId);
            if (this.pointers.size === 0 && this.moved < 6 && this.downTarget && this.onPointClick) this.onPointClick(this.downTarget);
        };
        svg.addEventListener('pointerup', end);
        svg.addEventListener('pointercancel', end);
    }
}
