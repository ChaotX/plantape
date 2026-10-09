// The Plan tab of a garden spreadsheet: the computed positions as a native Sheets scatter chart, so the sheet
// shows the last computed state of the garden without the app. Points carry their names as labels; measured
// distances are drawn as line segments (lines of the plan solid, helper lines dashed).

import { isMeasurementDrawn, isLineDrawn } from './model.js';
import { kindOf } from './solver/observations.js';
import { pairKey } from './solver/planner.js';

export const PLAN_TAB = 'Plan';
export const PLAN_FIRST_ROW = 4; // 1-based header row of the chart data; rows 1–2 hold the app link and a note
export const PLAN_COLUMNS = 5; // x | points | lines | helper lines | name

const CHART_W = 900;
// Rough room the chart takes outside its plot area (axes, title, legend), to keep the plan close to scale.
const PAD_W = 110;
const PAD_H = 120;

const round = v => Math.round(v * 1000) / 1000;

// labels: { x, points, lines, helpers }; lines: lines without a reading. Returns { rows, points, bounds } where rows start with the header
// row; each segment is two rows followed by an empty one, which breaks the line there.
export function planTable(solution, measurements, labels, lines = []) {
    const placed = [...solution.points].filter(([, p]) => p.placed);
    const at = new Map(placed);
    const rows = [[labels.x, labels.points, labels.lines, labels.helpers, '']];
    for (const [name, p] of placed.sort((a, b) => a[0].localeCompare(b[0]))) rows.push([round(p.x), round(p.y), '', '', name]);

    const segments = new Map(); // pair → drawn
    for (const m of measurements) {
        if (kindOf(m) !== 'distance' || m.status === 'excluded' || !at.has(m.from) || !at.has(m.to) || m.from === m.to) continue;
        const key = pairKey(m.from, m.to);
        segments.set(key, segments.get(key) || isMeasurementDrawn(m));
    }
    for (const l of lines) {
        if (!at.has(l.from) || !at.has(l.to)) continue;
        const key = pairKey(l.from, l.to);
        segments.set(key, segments.get(key) || isLineDrawn(l));
    }
    let drawn = 0;
    let helpers = 0;
    for (const [key, isDrawn] of segments) {
        const col = isDrawn ? 2 : 3;
        if (isDrawn) drawn++;
        else helpers++;
        for (const name of key.split('|')) {
            const p = at.get(name);
            const row = [round(p.x), '', '', '', ''];
            row[col] = round(p.y);
            rows.push(row);
        }
        rows.push(['', '', '', '', '']);
    }

    let bounds = null;
    for (const [, p] of placed) {
        if (!bounds) bounds = { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y };
        bounds.minX = Math.min(bounds.minX, p.x);
        bounds.maxX = Math.max(bounds.maxX, p.x);
        bounds.minY = Math.min(bounds.minY, p.y);
        bounds.maxY = Math.max(bounds.maxY, p.y);
    }
    return { rows, points: placed.length, drawn, helpers, bounds };
}

// Axis ranges and chart size with (nearly) equal metres per pixel on both axes.
export function planFrame(bounds) {
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
    const pad = span * 0.08;
    let x0 = bounds.minX - pad;
    let x1 = bounds.maxX + pad;
    let y0 = bounds.minY - pad;
    let y1 = bounds.maxY + pad;
    const plotW = CHART_W - PAD_W;
    let plotH = (plotW * (y1 - y0)) / (x1 - x0);
    const clamped = Math.min(Math.max(plotH, 300), 1100);
    if (clamped !== plotH) {
        // Too flat or too tall: widen the other axis instead of distorting the plan.
        plotH = clamped;
        const perPx = Math.max((x1 - x0) / plotW, (y1 - y0) / plotH);
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        [x0, x1] = [cx - (perPx * plotW) / 2, cx + (perPx * plotW) / 2];
        [y0, y1] = [cy - (perPx * plotH) / 2, cy + (perPx * plotH) / 2];
    }
    return { x0: round(x0), x1: round(x1), y0: round(y0), y1: round(y1), width: CHART_W, height: Math.round(plotH + PAD_H) };
}

const rgb = hex => ({ rgbColor: { red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 } });

// EmbeddedChart for the addChart request, or null when no point is placed yet.
export function planChart(sheetId, table, labels) {
    if (!table.points) return null;
    const frame = planFrame(table.bounds);
    const first = PLAN_FIRST_ROW - 1; // 0-based header row
    const end = first + table.rows.length;
    const range = col => ({ sourceRange: { sources: [{ sheetId, startRowIndex: first, endRowIndex: end, startColumnIndex: col, endColumnIndex: col + 1 }] } });
    const axis = (position, title, min, max) => ({ position, title, viewWindowOptions: { viewWindowMode: 'EXPLICIT', viewWindowMin: min, viewWindowMax: max } });
    const series = [{
        series: range(1),
        targetAxis: 'LEFT_AXIS',
        colorStyle: rgb('#2e7d32'),
        pointStyle: { shape: 'CIRCLE', size: 6 },
        dataLabel: { type: 'CUSTOM', placement: 'RIGHT', customLabelData: range(4) }
    }];
    if (table.drawn) series.push({ series: range(2), targetAxis: 'LEFT_AXIS', colorStyle: rgb('#37474f'), lineStyle: { width: 2, type: 'SOLID' }, pointStyle: { size: 1 } });
    if (table.helpers) series.push({ series: range(3), targetAxis: 'LEFT_AXIS', colorStyle: rgb('#b0bec5'), lineStyle: { width: 1, type: 'MEDIUM_DASHED' }, pointStyle: { size: 1 } });
    return {
        spec: {
            title: labels.title,
            basicChart: {
                chartType: 'SCATTER',
                legendPosition: 'BOTTOM_LEGEND',
                headerCount: 1,
                axis: [axis('BOTTOM_AXIS', 'x [m]', frame.x0, frame.x1), axis('LEFT_AXIS', 'y [m]', frame.y0, frame.y1)],
                domains: [{ domain: range(0) }],
                series
            }
        },
        position: { overlayPosition: { anchorCell: { sheetId, rowIndex: 0, columnIndex: PLAN_COLUMNS + 1 }, widthPixels: frame.width, heightPixels: frame.height } }
    };
}
