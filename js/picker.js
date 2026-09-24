// Google Drive Picker restricted to spreadsheets. Picking a file grants the app (drive.file) access to it.

import { GOOGLE_API_KEY, GOOGLE_APP_ID } from './config.js';
import { getToken } from './google-auth.js';
import { loadScript } from './util.js';

let pickerLoaded = null;

function loadPicker() {
    if (!pickerLoaded) {
        pickerLoaded = loadScript('https://apis.google.com/js/api.js').then(() => new Promise((resolve, reject) => {
            window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Picker failed to load')) });
        }));
    }
    return pickerLoaded;
}

// Resolves to { id, name } or null when cancelled.
export async function pickSpreadsheet({ title = '', locale = 'en' } = {}) {
    const [token] = await Promise.all([getToken(), loadPicker()]);
    const picker = window.google.picker;
    return new Promise(resolve => {
        const view = new picker.DocsView(picker.ViewId.SPREADSHEETS).setMode(picker.DocsViewMode.LIST);
        const builder = new picker.PickerBuilder()
            .addView(view)
            .setOAuthToken(token)
            .setLocale(locale)
            .setTitle(title)
            .setCallback(data => {
                const action = data[picker.Response.ACTION];
                if (action === picker.Action.PICKED) {
                    const doc = data[picker.Response.DOCUMENTS][0];
                    resolve({ id: doc[picker.Document.ID], name: doc[picker.Document.NAME] });
                } else if (action === picker.Action.CANCEL) {
                    resolve(null);
                }
            });
        if (GOOGLE_API_KEY) builder.setDeveloperKey(GOOGLE_API_KEY);
        if (GOOGLE_APP_ID) builder.setAppId(GOOGLE_APP_ID);
        builder.build().setVisible(true);
    });
}

export function spreadsheetIdFromUrl(text) {
    const s = String(text || '').trim();
    const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(s);
    if (m) return m[1];
    return /^[a-zA-Z0-9_-]{25,}$/.test(s) ? s : null;
}
