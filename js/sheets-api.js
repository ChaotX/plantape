// Thin wrapper around the Google Sheets API v4 REST endpoints.

import { getToken, invalidateToken } from './google-auth.js';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export class HttpError extends Error {
    constructor(status, message) {
        super(message || `HTTP ${status}`);
        this.status = status;
    }
}

// Ported from plant-trainer's ApiClient.fetchWithRetry; client errors (4xx except 429) are not retried.
export async function fetchWithRetry(url, options = {}, { retries = 2, timeoutMs = 20000, retryDelayMs = 1000 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            if (!response.ok) {
                let message = `HTTP ${response.status}`;
                try {
                    message = (await response.json()).error?.message || message;
                } catch {
                    // not JSON
                }
                throw new HttpError(response.status, message);
            }
            return response;
        } catch (error) {
            lastError = error;
            const retryable = !(error instanceof HttpError) || error.status === 429 || error.status >= 500;
            if (!retryable) throw error;
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }
    throw lastError;
}

async function api(method, url, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const token = await getToken();
        try {
            const response = await fetchWithRetry(url, {
                method,
                headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined
            });
            return response.status === 204 ? null : response.json();
        } catch (error) {
            if (error instanceof HttpError && error.status === 401 && attempt === 0) {
                invalidateToken();
                continue;
            }
            throw error;
        }
    }
    return null;
}

export function quoteSheet(title) {
    return `'${String(title).replace(/'/g, "''")}'`;
}

export function columnLetter(index) {
    let s = '';
    let n = index + 1;
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

export function getSpreadsheet(id) {
    return api('GET', `${BASE}/${encodeURIComponent(id)}?fields=spreadsheetId,properties.title,spreadsheetUrl,sheets.properties(sheetId,title)`);
}

export async function batchGet(id, ranges) {
    const params = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
    const res = await api('GET', `${BASE}/${encodeURIComponent(id)}/values:batchGet?${params}&valueRenderOption=UNFORMATTED_VALUE`);
    return (res.valueRanges || []).map(vr => vr.values || []);
}

// Appends rows below the table; returns the 1-based row number of the first appended row.
export async function appendRows(id, sheetTitle, rows) {
    const range = encodeURIComponent(`${quoteSheet(sheetTitle)}!A1`);
    const res = await api('POST', `${BASE}/${encodeURIComponent(id)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
    const match = /![A-Z]+(\d+)/.exec(res?.updates?.updatedRange || '');
    return match ? Number(match[1]) : null;
}

export function batchUpdateValues(id, data) {
    return api('POST', `${BASE}/${encodeURIComponent(id)}/values:batchUpdate`, { valueInputOption: 'RAW', data });
}

export function clearRange(id, range) {
    return api('POST', `${BASE}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:clear`, {});
}

export function batchUpdate(id, requests) {
    return api('POST', `${BASE}/${encodeURIComponent(id)}:batchUpdate`, { requests });
}

// Creates a spreadsheet with the given tabs, each with a bold, frozen header row.
export async function createSpreadsheet(title, tabs) {
    const res = await api('POST', BASE, {
        properties: { title },
        sheets: tabs.map((tab, i) => ({
            properties: { sheetId: i + 1, title: tab.title, gridProperties: { frozenRowCount: 1 } },
            data: [{
                startRow: 0,
                startColumn: 0,
                rowData: tab.rows.map((row, r) => ({
                    values: row.map(v => ({
                        userEnteredValue: typeof v === 'number' ? { numberValue: v } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) },
                        ...(r === 0 ? { userEnteredFormat: { textFormat: { bold: true } } } : {})
                    }))
                }))
            }]
        }))
    });
    return res;
}

// Adds missing tabs with header rows.
export async function addTabs(id, tabs) {
    if (!tabs.length) return;
    await batchUpdate(id, tabs.map(tab => ({ addSheet: { properties: { title: tab.title, gridProperties: { frozenRowCount: 1 } } } })));
    await batchUpdateValues(id, tabs.map(tab => ({ range: `${quoteSheet(tab.title)}!A1`, values: tab.rows })));
}
