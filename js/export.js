// Export of the plan as SVG / vector PDF on a paper sheet at a chosen scale, plus data exports.

import { renderScene, renderOverlay, placedBounds, autoEllipseScale } from './view/plan-view.js';
import { escapeHtml, downloadBlob, safeFilename, loadScript, fmt } from './util.js';
import { gardenToJson, toCsv } from './model.js';
import { t } from './i18n.js';

export const PAPERS = { A4: [210, 297], A3: [297, 420], A2: [420, 594] };
export const SCALES = [20, 25, 50, 100, 200, 250, 500, 1000, 2000];

const MARGIN = 10;
const TITLE_H = 16;

// Returns { svg, widthMm, heightMm, scale } for the given options:
// { paper: 'A4', orientation: 'landscape' | 'portrait', scale: 'fit' | number, title, options }
export function buildPaperSvg(scene, { paper = 'A4', orientation = 'landscape', scale = 'fit', title = '' } = {}) {
    const [a, b] = PAPERS[paper] || PAPERS.A4;
    const W = orientation === 'portrait' ? a : b;
    const H = orientation === 'portrait' ? b : a;
    const area = { x: MARGIN, y: MARGIN, w: W - 2 * MARGIN, h: H - 2 * MARGIN - TITLE_H };
    const bounds = placedBounds(scene.solution) || { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 0 };
    const bw = Math.max(bounds.maxX - bounds.minX, 0.5);
    const bh = Math.max(bounds.maxY - bounds.minY, 0.5);

    let S = Number(scale);
    if (!Number.isFinite(S) || S <= 0) {
        // Smallest standard scale where the drawing (plus some room for labels) fits.
        S = SCALES.find(s => (bw * 1000) / s <= area.w * 0.9 && (bh * 1000) / s <= area.h * 0.85) || SCALES[SCALES.length - 1];
    }
    const mmPerM = 1000 / S;
    const tf = {
        scale: mmPerM,
        ox: area.x + area.w / 2 - ((bounds.minX + bounds.maxX) / 2) * mmPerM,
        oy: area.y + area.h / 2 + ((bounds.minY + bounds.maxY) / 2) * mmPerM
    };
    const optEllipse = scene.options?.ellipseScale;
    const ellipseScale = optEllipse && optEllipse !== 'auto' ? Number(optEllipse) : autoEllipseScale(scene.solution, mmPerM, 3);
    const drawScene = { ...scene, hints: [], selected: null, station: null, target: null, options: { ...scene.options, ellipseScale, grid: false } };
    const zRange = scene.options?.colorBy === 'height' && bounds.maxZ - bounds.minZ > 0.01 ? [bounds.minZ, bounds.maxZ] : null;
    const ff = 'font-family="Helvetica, Arial, sans-serif"';
    const date = new Date().toISOString().slice(0, 10);
    const tb = { y: H - MARGIN - TITLE_H };

    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`,
        `<defs><clipPath id="drawArea"><rect x="${area.x}" y="${area.y}" width="${area.w}" height="${area.h}"/></clipPath></defs>`,
        `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`,
        `<g clip-path="url(#drawArea)">${renderScene(drawScene, tf, { pointR: 1.1, font: 2.6, stroke: 0.18, hit: 0 })}</g>`,
        `<rect x="${area.x}" y="${area.y}" width="${area.w}" height="${area.h}" fill="none" stroke="#212121" stroke-width="0.35"/>`,
        // Title block
        `<rect x="${MARGIN}" y="${tb.y}" width="${W - 2 * MARGIN}" height="${TITLE_H}" fill="none" stroke="#212121" stroke-width="0.35"/>`,
        `<text x="${MARGIN + 3}" y="${tb.y + 6.5}" font-size="4.2" font-weight="bold" ${ff} fill="#212121">${escapeHtml(title)}</text>`,
        `<text x="${MARGIN + 3}" y="${tb.y + 12}" font-size="2.6" ${ff} fill="#424242">${escapeHtml(t('exportSubtitle', { date, points: [...scene.solution.points.values()].filter(p => p.placed).length, measurements: scene.garden.measurements.length }))}</text>`,
        `<text x="${W - MARGIN - 3}" y="${tb.y + 6.5}" font-size="4.2" font-weight="bold" ${ff} text-anchor="end" fill="#212121">1:${S}</text>`,
        `<text x="${W - MARGIN - 3}" y="${tb.y + 12}" font-size="2.6" ${ff} text-anchor="end" fill="#424242">${escapeHtml(t('exportPaper', { paper }))}</text>`,
        `<g>${renderOverlay({ tf, x: W / 2 - 40, y: tb.y + TITLE_H - 3, font: 2.4, stroke: 0.2, maxBar: 45, zRange, ellipseScale, showEllipses: scene.options?.ellipses !== false })}</g>`,
        '</svg>'
    ].join('');
    return { svg, widthMm: W, heightMm: H, scale: S };
}

export function downloadSvg(scene, opts) {
    const { svg } = buildPaperSvg(scene, opts);
    downloadBlob(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: 'image/svg+xml' }), `${safeFilename(opts.title)}.svg`);
}

// The standard PDF fonts only cover Latin-1; map the Hungarian double-acute letters to their closest glyphs.
function pdfSafe(text) {
    return text.replace(/ő/g, 'ö').replace(/ű/g, 'ü').replace(/Ő/g, 'Ö').replace(/Ű/g, 'Ü');
}

export async function downloadPdf(scene, opts) {
    await loadScript('vendor/jspdf.umd.min.js');
    await loadScript('vendor/svg2pdf.umd.min.js');
    const { svg, widthMm, heightMm } = buildPaperSvg(scene, opts);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: widthMm > heightMm ? 'landscape' : 'portrait', unit: 'mm', format: [widthMm, heightMm] });
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:10px;height:10px;overflow:hidden';
    host.innerHTML = pdfSafe(svg);
    document.body.appendChild(host);
    try {
        const el = host.querySelector('svg');
        if (typeof doc.svg === 'function') await doc.svg(el, { x: 0, y: 0, width: widthMm, height: heightMm });
        else await window.svg2pdf.svg2pdf(el, doc, { x: 0, y: 0, width: widthMm, height: heightMm });
        doc.save(`${safeFilename(opts.title)}.pdf`);
    } finally {
        host.remove();
    }
}

export function downloadPointsCsv(garden, solution, title) {
    const rows = [['name', 'category', 'x', 'y', 'z', 'sigma_xy', 'sigma_z', 'links', 'status']];
    const cats = new Map(garden.points.map(p => [p.name, p.category || '']));
    for (const [name, p] of solution.points) {
        rows.push([name, cats.get(name) || '', fmt(p.x, 4), fmt(p.y, 4), fmt(p.z, 4), fmt(p.sxy, 4), fmt(p.sz, 4), p.links, p.status]);
    }
    downloadBlob(new Blob([toCsv(rows)], { type: 'text/csv' }), `${safeFilename(title)}-points.csv`);
}

export function downloadGardenJson(garden, title) {
    downloadBlob(new Blob([gardenToJson(garden)], { type: 'application/json' }), `${safeFilename(title)}.plantape.json`);
}
