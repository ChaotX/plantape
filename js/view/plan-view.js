// SVG plan view: a pure scene renderer (shared with exports) plus an interactive pan/zoom wrapper.

import { escapeHtml, fmt } from '../util.js';
import { t } from '../i18n.js';
import { kindOf } from '../solver/observations.js';
import { WEAK_SXY } from '../solver/planner.js';
import { rotateScene, rotateXY } from '../orientation.js';
import { isLine, lineEnds, lineKey } from './describe.js';
import { isPointShown, isMeasurementDrawn, isLineDrawn } from '../model.js';

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

// Bounds of the placed points (and of extra plan positions such as sketched points, which have no z).
export function placedBounds(solution, extra = []) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of solution?.points?.values() || []) {
        if (!p.placed) continue;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    for (const p of extra) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) return null;
    if (!Number.isFinite(minZ)) minZ = maxZ = 0;
    return { minX, minY, maxX, maxY, minZ, maxZ };
}

// Ellipse exaggeration so that a typical ellipse is visible (power of ten).
export function autoEllipseScale(solution, pxPerMetre, targetPx = 16) {
    const sizes = [];
    // Poorly fixed points get a marker instead of an ellipse, and would only shrink the others.
    for (const p of solution.points.values()) if (p.placed && p.status !== 'datum' && p.ellipse.a > 0 && !(p.sxy > WEAK_SXY)) sizes.push(p.ellipse.a);
    if (!sizes.length) return 1;
    sizes.sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    const raw = targetPx / (median * ELLIPSE_K * pxPerMetre);
    return raw <= 1 ? 1 : 10 ** Math.round(Math.log10(raw));
}

// Text with a white halo, drawn as a separate stroked copy underneath (svg2pdf ignores paint-order).
function haloText(x, y, size, color, html) {
    const common = `x="${x}" y="${y}" font-size="${size}" font-family="Helvetica, Arial, sans-serif" pointer-events="none"`;
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
    // Visibility: measurements marked visible are lines of the plan ("drawn lines"); the others are helper
    // lines. Each group, and points marked hidden, can be switched off (options.lines / hiddenLines /
    // hiddenPoints). The point or line being measured from / to always shows.
    const pointByName = new Map(garden.points.map(p => [p.name, p]));
    const involved = name => name === scene.selected || [scene.station, scene.target].some(k => k === name || (isLine(k) && lineEnds(k).includes(name)));
    const shownPoint = name => isPointShown(pointByName.get(name)) || options.hiddenPoints !== false || involved(name);
    const shownMeasurement = m => (isMeasurementDrawn(m) ? options.lines !== false : options.hiddenLines !== false);

    // Measurement colour: excluded, suspect, large residual, unchecked.
    const styleOf = m => {
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
        } else if (isMeasurementDrawn(m)) {
            color = '#37474f';
            width = sw * 2.2;
        } else if (r.used && r.r < 0.05) {
            dash = `${sw} ${sw * 2}`;
        }
        return { r, color, width, dash };
    };
    const placedAll = names => names.every(n => P.get(n)?.placed);
    // Drawing position: computed, or else sketched (only in the interactive view, not in exports).
    const at = n => (P.get(n)?.placed ? P.get(n) : scene.sketchPos?.get(n));
    const knownAll = names => names.every(n => at(n));
    const pendingStyle = ` stroke-dasharray="${sw * 2} ${sw * 2}" opacity="0.6"`;
    const seg = (a, b, color, width, extra = '') => `<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="${color}" stroke-width="${width}"${extra}/>`;
    const foot = (A, B, p) => {
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const L2 = dx * dx + dy * dy || 1;
        const t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / L2;
        return { t, x: A.x + t * dx, y: A.y + t * dy };
    };

    {
        // Reference lines (fences, walls…): dashed, spanning their ends and the feet of their offsets.
        const refs = new Map();
        const addRef = (a, b, p = null) => {
            if (!knownAll([a, b])) return;
            const key = a < b ? lineKey(a, b) : lineKey(b, a);
            if (!refs.has(key)) refs.set(key, { a: at(a < b ? a : b), b: at(a < b ? b : a), lo: 0, hi: 1 });
            if (p) {
                const ref = refs.get(key);
                const f = foot(ref.a, ref.b, p);
                ref.lo = Math.min(ref.lo, f.t);
                ref.hi = Math.max(ref.hi, f.t);
            }
        };
        for (const m of garden.measurements) {
            const k = kindOf(m);
            if (!shownMeasurement(m)) continue;
            if (k === 'offset' && m.status !== 'excluded') addRef(m.from, m.fromB, at(m.to) || null);
            else if (k === 'angle' && m.status !== 'excluded') {
                addRef(m.from, m.fromB);
                addRef(m.to, m.toB);
            }
        }
        for (const { a, b, lo, hi } of refs.values()) {
            const at = t => ({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
            out.push(seg(at(lo - 0.03), at(hi + 0.03), '#8d6e63', sw * 1.4, ` stroke-dasharray="${sw * 8} ${sw * 3}" opacity="0.7"`));
        }

        // Lines without a reading (walls, fences, sides drawn with the line tool).
        for (const l of garden.lines || []) {
            const drawn = isLineDrawn(l);
            if (drawn ? options.lines === false : options.hiddenLines === false) continue;
            if (!knownAll([l.from, l.to])) continue;
            const a = at(l.from);
            const b = at(l.to);
            // Helper lines without a reading are dash-dotted, unlike measured ones; not yet computed: faint at the sketches.
            const extra = !placedAll([l.from, l.to]) ? pendingStyle : drawn ? '' : ` stroke-dasharray="${sw * 6} ${sw * 2} ${sw} ${sw * 2}"`;
            out.push(seg(a, b, drawn ? '#37474f' : '#90a4ae', drawn ? sw * 2.2 : sw, extra));
            if (style.hit) out.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="transparent" stroke-width="${style.hit * 0.9}" data-line="${escapeHtml(lineKey(l.from, l.to))}" style="cursor:pointer"><title>${escapeHtml(`${l.from}–${l.to}`)}</title></line>`);
        }

        for (const m of garden.measurements) {
            const k = kindOf(m);
            if (!shownMeasurement(m)) continue;
            const { r, color, width, dash } = styleOf(m);
            const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
            if (k === 'distance') {
                if (!knownAll([m.from, m.to])) continue;
                const a = at(m.from);
                const b = at(m.to);
                if (!placedAll([m.from, m.to])) {
                    // Between points not computed yet: drawn faintly at their sketches, still selectable as a line.
                    out.push(seg(a, b, '#90a4ae', sw, pendingStyle));
                    if (style.hit) out.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="transparent" stroke-width="${style.hit * 0.9}" data-line="${escapeHtml(lineKey(m.from, m.to))}" style="cursor:pointer"><title>${escapeHtml(`${m.from}–${m.to}`)}</title></line>`);
                    continue;
                }
                const title = `${m.from} (${fmt(m.fromH, 1)}) → ${m.to} (${fmt(m.toH, 1)}): ${fmt(m.distance, 3)} m` +
                    (Number.isFinite(r.residual) ? `, v = ${fmt(r.residual * 1000, 1)} mm` : '') + (r.w != null ? `, w = ${fmt(r.w, 2)}` : '');
                out.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="${color}" stroke-width="${width}"${dashAttr} data-meas="${escapeHtml(m.id)}"><title>${escapeHtml(title)}</title></line>`);
                if (style.hit) out.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="transparent" stroke-width="${style.hit * 0.9}" data-line="${escapeHtml(lineKey(m.from, m.to))}" style="cursor:pointer"><title>${escapeHtml(`${m.from}–${m.to}`)}</title></line>`);
            } else if (k === 'offset') {
                if (!knownAll([m.from, m.fromB, m.to]) || m.distance === 0) continue;
                const p = at(m.to);
                const f = foot(at(m.from), at(m.fromB), p);
                if (!placedAll([m.from, m.fromB, m.to])) {
                    out.push(seg(p, f, color, width, pendingStyle));
                    continue;
                }
                const title = `${m.from}–${m.fromB} ⊥ ${m.to}: ${fmt(m.distance, 3)} m` + (Number.isFinite(r.residual) ? `, v = ${fmt(r.residual * 1000, 1)} mm` : '');
                out.push(`<line x1="${X(p.x)}" y1="${Y(p.y)}" x2="${X(f.x)}" y2="${Y(f.y)}" stroke="${color}" stroke-width="${width}"${dashAttr}><title>${escapeHtml(title)}</title></line>`);
            } else {
                if (!placedAll([m.from, m.fromB, m.to, m.toB])) continue;
                out.push(angleMark(m, color === '#90a4ae' ? '#6d4c41' : color, r));
            }
        }
    }

    // A point whose readings all run one way: a dashed double arrow along the direction it is not fixed in,
    // with a "?", at a fixed size instead of an ellipse that could be hundreds of metres long.
    function weakMarker(name, p) {
        const cx = X(p.x);
        const cy = Y(p.y);
        const u = { x: Math.cos(p.ellipse.angle), y: -Math.sin(p.ellipse.angle) }; // screen y points down
        const n = { x: -u.y, y: u.x };
        const L = style.font * 2.4;
        const h = style.font * 0.55;
        const end = s => ({ x: cx + u.x * L * s, y: cy + u.y * L * s });
        const head = s => {
            const E = end(s);
            const B = { x: E.x - u.x * h * s, y: E.y - u.y * h * s };
            return `M${B.x + n.x * h * 0.6} ${B.y + n.y * h * 0.6}L${E.x} ${E.y}L${B.x - n.x * h * 0.6} ${B.y - n.y * h * 0.6}`;
        };
        const [a, b] = [end(-1), end(1)];
        const color = '#e64a19';
        const title = t('weakMarker', { name, sxy: fmt(p.sxy, 1) });
        const q = { x: b.x + n.x * style.font * 0.5 + u.x * style.font * 0.3, y: b.y + n.y * style.font * 0.5 + u.y * style.font * 0.3 };
        return `<g fill="none" stroke="${color}" stroke-width="${sw * 1.3}"><title>${escapeHtml(title)}</title>` +
            `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-dasharray="${sw * 3} ${sw * 2}"/><path d="${head(1)}${head(-1)}"/></g>` +
            haloText(q.x - style.font * 0.3, q.y + style.font * 0.4, style.font * 1.1, color, '?');
    }

    // Angle mark: at a shared corner a small square (90°) or arc, otherwise a label between the lines.
    function angleMark(m, color, r) {
        const [A, B, C, D] = [m.from, m.fromB, m.to, m.toB].map(n => P.get(n));
        const ends1 = [m.from, m.fromB];
        const ends2 = [m.to, m.toB];
        const shared = ends1.find(n => ends2.includes(n));
        const rad = style.font * 1.1;
        const title = `${m.from}–${m.fromB} ∠ ${m.to}–${m.toB}: ${fmt(m.distance, 1)}°` + (Number.isFinite(r.residual) ? `, v = ${fmt(r.residual, 2)}°` : '');
        if (shared) {
            const V = P.get(shared);
            const o1 = P.get(ends1.find(n => n !== shared));
            const o2 = P.get(ends2.find(n => n !== shared));
            const u = q => {
                const dx = X(q.x) - X(V.x);
                const dy = Y(q.y) - Y(V.y);
                const l = Math.hypot(dx, dy) || 1;
                return { x: dx / l, y: dy / l };
            };
            const u1 = u(o1);
            const u2 = u(o2);
            const vx = X(V.x);
            const vy = Y(V.y);
            const interior = (Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y))) * 180) / Math.PI;
            if (Math.abs(m.distance - 90) < 0.5) {
                const s = rad * 0.8;
                return `<path d="M${vx + u1.x * s} ${vy + u1.y * s} L${vx + (u1.x + u2.x) * s} ${vy + (u1.y + u2.y) * s} L${vx + u2.x * s} ${vy + u2.y * s}" fill="none" stroke="${color}" stroke-width="${sw * 1.2}"><title>${escapeHtml(title)}</title></path>`;
            }
            const sweep = u1.x * u2.y - u1.y * u2.x > 0 ? 1 : 0;
            const mid = { x: u1.x + u2.x, y: u1.y + u2.y };
            const ml = Math.hypot(mid.x, mid.y) || 1;
            return `<path d="M${vx + u1.x * rad} ${vy + u1.y * rad} A${rad} ${rad} 0 0 ${sweep} ${vx + u2.x * rad} ${vy + u2.y * rad}" fill="none" stroke="${color}" stroke-width="${sw * 1.2}"><title>${escapeHtml(title)}</title></path>` +
                haloText(vx + (mid.x / ml) * rad * 1.5 - style.font * 0.6, vy + (mid.y / ml) * rad * 1.5 + style.font * 0.3, style.font * 0.75, color, `${fmt(interior, 0)}°`);
        }
        const m2 = { x: (X(C.x) + X(D.x)) / 2, y: (Y(C.y) + Y(D.y)) / 2 };
        const m1 = { x: (X(A.x) + X(B.x)) / 2, y: (Y(A.y) + Y(B.y)) / 2 };
        return `<line x1="${m1.x}" y1="${m1.y}" x2="${m2.x}" y2="${m2.y}" stroke="${color}" stroke-width="${sw * 0.8}" stroke-dasharray="${sw} ${sw * 3}"><title>${escapeHtml(title)}</title></line>` +
            haloText(m2.x + style.font * 0.3, m2.y - style.font * 0.3, style.font * 0.75, color, `∠${fmt(m.distance, 0)}°`);
    }

    // Selected line(s) in the measuring form
    for (const [key, color] of [[scene.station, '#1565c0'], [scene.target, '#2e7d32']]) {
        if (!isLine(key)) continue;
        const [a, b] = lineEnds(key);
        if (knownAll([a, b])) out.push(seg(at(a), at(b), color, style.pointR * 1.4, ' stroke-linecap="round" opacity="0.35"'));
    }

    // Suggested measurements
    (scene.hints || []).forEach((h, i) => {
        let a;
        let b;
        if (h.kind === 'offset') {
            if (!placedAll([h.from, h.fromB, h.to])) return;
            a = P.get(h.to);
            b = foot(P.get(h.from), P.get(h.fromB), a);
        } else {
            a = P.get(h.from);
            b = P.get(h.to);
            if (!a?.placed || !b?.placed) return;
        }
        out.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="#1565c0" stroke-width="${sw * 1.5}" stroke-dasharray="${sw * 6} ${sw * 4}" opacity="0.8"/>`);
        const mx = (X(a.x) + X(b.x)) / 2;
        const my = (Y(a.y) + Y(b.y)) / 2;
        out.push(`<circle cx="${mx}" cy="${my}" r="${style.font * 0.75}" fill="#1565c0"/><text x="${mx}" y="${my + style.font * 0.35}" font-size="${style.font * 0.9}" font-family="Helvetica, Arial, sans-serif" text-anchor="middle" fill="#fff">${i + 1}</text>`);
    });

    // Error ellipses (95 %, exaggerated)
    if (options.ellipses !== false) {
        const k = ELLIPSE_K * (options.ellipseScale || 1);
        for (const [name, p] of P) {
            if (!p.placed || p.status === 'datum' || !(p.ellipse.a > 0) || !shownPoint(name)) continue;
            if (p.sxy > WEAK_SXY) {
                out.push(weakMarker(name, p));
                continue;
            }
            const rx = p.ellipse.a * k * tf.scale;
            const ry = p.ellipse.b * k * tf.scale;
            if (!Number.isFinite(rx) || rx > 1e5) continue;
            const deg = (-p.ellipse.angle * 180) / Math.PI;
            out.push(`<ellipse cx="${X(p.x)}" cy="${Y(p.y)}" rx="${rx}" ry="${Math.max(ry, sw * 0.3)}" transform="rotate(${deg} ${X(p.x)} ${Y(p.y)})" fill="#ff7043" fill-opacity="0.15" stroke="#e64a19" stroke-width="${sw * 0.8}"/>`);
        }
    }

    // Points
    for (const [name, p] of P) {
        if (!p.placed || !shownPoint(name)) continue;
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

    // Points that are not computed yet, at their sketched position (hollow).
    for (const [name, s] of scene.sketchPos || []) {
        if (P.get(name)?.placed || !shownPoint(name)) continue;
        const cx = X(s.x);
        const cy = Y(s.y);
        const r = style.pointR;
        const color = CATEGORY_COLORS[categories.get(name)] || CATEGORY_COLORS.other;
        if (name === scene.station) out.push(`<circle cx="${cx}" cy="${cy}" r="${r * 2.4}" fill="none" stroke="#1565c0" stroke-width="${sw * 2}"/>`);
        if (name === scene.target) out.push(`<circle cx="${cx}" cy="${cy}" r="${r * 2.4}" fill="none" stroke="#2e7d32" stroke-width="${sw * 2}" stroke-dasharray="${sw * 3} ${sw * 2}"/>`);
        if (name === scene.selected) out.push(`<circle cx="${cx}" cy="${cy}" r="${r * 3}" fill="#ffeb3b" fill-opacity="0.5"/>`);
        out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="${color}" stroke-width="${sw * 1.6}" stroke-dasharray="${sw * 2} ${sw * 1.5}"/>`);
        if (style.hit) out.push(`<circle cx="${cx}" cy="${cy}" r="${style.hit}" fill="transparent" data-point="${escapeHtml(name)}" style="cursor:pointer"><title>${escapeHtml(`${name} – ${t('sketchedOnly')}`)}</title></circle>`);
        if (options.labels !== false) out.push(haloText(cx + r * 1.6, cy - r * 0.6, style.font, '#78909c', `${escapeHtml(name)} ?`));
    }

    // A point being dragged in move mode
    if (scene.drag) {
        const { name, x, y } = scene.drag;
        const from = P.get(name)?.placed ? P.get(name) : scene.sketchPos?.get(name);
        if (from) out.push(seg(from, { x, y }, '#1565c0', sw, ` stroke-dasharray="${sw * 3} ${sw * 2}"`));
        out.push(`<circle cx="${X(x)}" cy="${Y(y)}" r="${style.pointR * 1.3}" fill="#1565c0" fill-opacity="0.35" stroke="#1565c0" stroke-width="${sw * 1.5}"/>`);
    }
    return out.join('');
}

// Scale bar + axis arrows + optional height legend, anchored at (x, y) = bottom-left in output units.
// angle: how much the drawing is turned (radians, counter-clockwise); north: north in the survey frame or null.
export function renderOverlay({ tf, x, y, font, stroke, maxBar, zRange, ellipseScale, showEllipses, angle = 0, north = null }) {
    const out = [];
    const len = niceLength(maxBar / tf.scale / 1.5);
    const w = len * tf.scale;
    const h = font * 0.5;
    const ff = 'font-family="Helvetica, Arial, sans-serif"';
    out.push(`<rect x="${x}" y="${y - h}" width="${w / 2}" height="${h}" fill="#212121"/>`);
    out.push(`<rect x="${x + w / 2}" y="${y - h}" width="${w / 2}" height="${h}" fill="#fff" stroke="#212121" stroke-width="${stroke}"/>`);
    out.push(`<text x="${x}" y="${y - h - font * 0.3}" font-size="${font}" ${ff} fill="#212121">0</text>`);
    out.push(`<text x="${x + w}" y="${y - h - font * 0.3}" font-size="${font}" ${ff} text-anchor="middle" fill="#212121">${len} m</text>`);

    // Axis arrows (local survey frame: +x towards the axis point, +y to its left), turned with the drawing, around
    // the middle of a small box; and a north arrow once north is known.
    const L = font * 1.6;
    const arrow = (cx, cy, a, label, color, width) => {
        const d = { x: Math.cos(a), y: -Math.sin(a) };
        const n = { x: -d.y, y: d.x };
        const tip = { x: cx + d.x * L, y: cy + d.y * L };
        const hs = font * 0.5;
        const b = { x: tip.x - d.x * hs, y: tip.y - d.y * hs };
        return `<path d="M${cx} ${cy}L${tip.x} ${tip.y}M${b.x + n.x * hs * 0.6} ${b.y + n.y * hs * 0.6}L${tip.x} ${tip.y}L${b.x - n.x * hs * 0.6} ${b.y - n.y * hs * 0.6}" fill="none" stroke="${color}" stroke-width="${width}"/>` +
            `<text x="${tip.x + d.x * font * 0.7}" y="${tip.y + d.y * font * 0.7 + font * 0.35}" font-size="${font}" ${ff} text-anchor="middle" font-weight="${label === 'N' ? 'bold' : 'normal'}" fill="${color}">${label}</text>`;
    };
    const ax = x + w + font * 3;
    const ay = y - font * 0.6;
    out.push(arrow(ax, ay, angle, 'x', '#212121', stroke * 1.5), arrow(ax, ay, angle + Math.PI / 2, 'y', '#212121', stroke * 1.5));
    let lx = ax + L + font * 2;
    if (north !== null) {
        lx += font;
        out.push(arrow(lx, ay, north + angle, 'N', '#c62828', stroke * 2));
        lx += L + font * 1.5;
    }
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
    // handlers: onSelect({ point } | { line: [a, b] }, station) — station is true in select mode (the tap
    // says where I am), onAdd(x, y) in add mode, onMove(name, x, y) in move mode
    constructor(svg, { onSelect, onAdd, onMove } = {}) {
        this.svg = svg;
        this.onSelect = onSelect;
        this.onAdd = onAdd;
        this.onMove = onMove;
        this.mode = 'pan'; // 'pan' | 'select' | 'add' | 'move'
        this.lastTap = null; // { t, x, y } of the last plain tap, for double-tap zoom
        this.tapZoom = null; // double tap held down: { anchor, y0, tf0 }
        this.scene = null;
        this.tf = null;
        this.pointers = new Map();
        this.moved = 0;
        this.drag = null;
        this.bind();
        new ResizeObserver(() => (this.userMoved ? this.render() : this.fit())).observe(svg);
    }

    size() {
        const r = this.svg.getBoundingClientRect();
        return { w: Math.max(r.width, 1), h: Math.max(r.height, 1) };
    }

    setMode(mode) {
        this.mode = mode;
        this.svg.dataset.mode = mode;
    }

    // Keeps the whole network in view until the user pans or zooms by hand.
    setScene(scene) {
        this.scene = scene;
        if (!this.tf || !this.userMoved) this.fit();
        else this.render();
    }

    // How much the drawing is turned (radians, counter-clockwise) and north in the survey frame (or null):
    // scene.orientation, from orientation() in orientation.js.
    get angle() {
        return this.scene?.orientation?.angle || 0;
    }

    // The scene as drawn: plan positions turned by the view's angle.
    turned(scene = this.scene) {
        return rotateScene(scene, this.angle);
    }

    bounds() {
        const s = this.turned();
        return placedBounds(s?.solution, s?.sketchPos?.values() || []);
    }

    fit() {
        this.userMoved = false;
        const { w, h } = this.size();
        const b = this.bounds();
        const empty = Math.min(w, h) / 24; // a 20 m grid around the origin to sketch on
        if (!b) {
            this.tf = { scale: empty, ox: w / 2, oy: h / 2 };
        } else {
            // Room for labels, the tool buttons (right) and the legend (bottom).
            const pad = { left: 24, right: 90, top: 28, bottom: 64 };
            const bw = b.maxX - b.minX;
            const bh = b.maxY - b.minY;
            const aw = Math.max(w - pad.left - pad.right, 40);
            const ah = Math.max(h - pad.top - pad.bottom, 40);
            const scale = bw < 1 && bh < 1 ? empty : Math.min(aw / Math.max(bw, 1), ah / Math.max(bh, 1));
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
        const s = this.turned();
        const p = s?.solution?.points.get(name);
        const at = p?.placed ? p : s?.sketchPos?.get(name);
        if (!at) return;
        const { w, h } = this.size();
        this.userMoved = true;
        this.tf = { ...this.tf, ox: w / 2 - at.x * this.tf.scale, oy: h / 2 + at.y * this.tf.scale };
        this.render();
    }

    ellipseScale() {
        const opt = this.scene?.options?.ellipseScale;
        if (opt && opt !== 'auto') return Number(opt);
        return this.scene?.solution ? autoEllipseScale(this.scene.solution, this.tf.scale) : 1;
    }

    // Plan coordinates of the middle of the view.
    centerWorld() {
        const { w, h } = this.size();
        return this.tf ? this.toWorld({ x: w / 2, y: h / 2 }) : { x: 0, y: 0 };
    }

    // Screen (svg pixels) → plan coordinates in metres, in the survey frame (the drawing may be turned).
    toWorld(p) {
        return rotateXY({ x: (p.x - this.tf.ox) / this.tf.scale, y: (this.tf.oy - p.y) / this.tf.scale }, -this.angle);
    }

    render() {
        if (!this.scene || !this.tf) return;
        const { w, h } = this.size();
        this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        const ellipseScale = this.ellipseScale();
        const scene = this.turned({ ...this.scene, drag: this.drag, options: { ...this.scene.options, ellipseScale } });
        const b = placedBounds(this.scene.solution);
        const zRange = this.scene.options?.colorBy === 'height' && b && b.maxZ - b.minZ > 0.01 ? [b.minZ, b.maxZ] : null;
        this.svg.innerHTML =
            `<rect x="0" y="0" width="${w}" height="${h}" fill="#fbfcf8"/>` +
            this.renderGrid(w, h) +
            renderScene(scene, this.tf, { pointR: 5, font: 13, stroke: 1.2, hit: 16 }) +
            `<rect x="6" y="${h - 40}" width="${Math.max(Math.min(w - 12, 520), 0)}" height="34" rx="6" fill="#fff" fill-opacity="0.85"/>` +
            renderOverlay({ tf: this.tf, x: 16, y: h - 14, font: 11, stroke: 1, maxBar: Math.min(w * 0.3, 160), zRange, ellipseScale, showEllipses: scene.options?.ellipses !== false, angle: this.angle, north: this.scene.orientation?.north ?? null });
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
            // Double tap (second press soon after a tap, close to it): zoom. Keeping the finger down and
            // dragging zooms continuously — down zooms in, up zooms out — as in Google Maps.
            const at = local(e);
            const last = this.lastTap;
            this.lastTap = null;
            if (last && this.pointers.size === 1 && this.tf && performance.now() - last.t < 350 && Math.hypot(at.x - last.x, at.y - last.y) < 30) {
                this.tapZoom = { anchor: at, y0: at.y, tf0: { ...this.tf } };
                this.drag = null;
                this.downPoint = this.downLine = null;
                return;
            }
            this.downPoint = e.target.closest?.('[data-point]')?.dataset.point || null;
            this.downLine = e.target.closest?.('[data-line]')?.dataset.line || null;
            this.downAt = local(e);
            // Move mode: dragging a point moves it instead of panning the plan.
            if (this.mode === 'move' && this.downPoint && this.pointers.size === 1 && this.tf) this.drag = { name: this.downPoint, ...this.toWorld(this.downAt) };
        });
        svg.addEventListener('pointermove', e => {
            if (!this.pointers.has(e.pointerId) || !this.tf) return;
            const prev = this.pointers.get(e.pointerId);
            const cur = local(e);
            if (this.tapZoom && this.pointers.size === 1) {
                const { anchor, y0, tf0 } = this.tapZoom;
                this.moved += Math.hypot(cur.x - prev.x, cur.y - prev.y);
                this.pointers.set(e.pointerId, cur);
                const scale = Math.min(Math.max(tf0.scale * Math.exp((cur.y - y0) * 0.012), 0.05), 5000);
                const f = scale / tf0.scale;
                this.userMoved = true;
                this.tf = { scale, ox: anchor.x - (anchor.x - tf0.ox) * f, oy: anchor.y - (anchor.y - tf0.oy) * f };
                this.render();
            } else if (this.drag && this.pointers.size === 1) {
                this.moved += Math.hypot(cur.x - prev.x, cur.y - prev.y);
                this.pointers.set(e.pointerId, cur);
                this.drag = { name: this.drag.name, ...this.toWorld(cur) };
                this.render();
            } else if (this.pointers.size === 1) {
                this.tf = { ...this.tf, ox: this.tf.ox + cur.x - prev.x, oy: this.tf.oy + cur.y - prev.y };
                this.moved += Math.hypot(cur.x - prev.x, cur.y - prev.y);
                if (this.moved > 6) this.userMoved = true;
                this.pointers.set(e.pointerId, cur);
                this.render();
            } else if (this.pointers.size === 2) {
                this.drag = null;
                this.tapZoom = null;
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
            if (this.pointers.size !== 0) return;
            if (this.tapZoom) {
                const { anchor } = this.tapZoom;
                this.tapZoom = null;
                if (this.moved < 6 && e.type === 'pointerup') this.zoomAt(2, anchor.x, anchor.y); // plain double tap
                return;
            }
            const drag = this.drag;
            this.drag = null;
            // Sketching and moving keep the view where it is, so the next tap lands where the user aims.
            if (drag && this.moved >= 6 && e.type === 'pointerup') {
                this.userMoved = true;
                this.render();
                this.onMove?.(drag.name, drag.x, drag.y);
                return;
            }
            if (drag) this.render();
            if (this.moved >= 6 || e.type === 'pointercancel') return;
            this.lastTap = { t: performance.now(), ...this.downAt };
            const station = this.mode === 'select';
            if (this.downPoint) this.onSelect?.({ point: this.downPoint }, station);
            else if (this.downLine) this.onSelect?.({ line: lineEnds(this.downLine) }, station);
            else if (this.mode === 'add' && this.tf) {
                const w = this.toWorld(this.downAt);
                this.userMoved = true;
                this.onAdd?.(w.x, w.y);
            }
        };
        svg.addEventListener('pointerup', end);
        svg.addEventListener('pointercancel', end);
    }
}
