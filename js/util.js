export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Formats metres with a fixed number of decimals ('' for non-finite values).
export function fmt(value, decimals = 2) {
    return Number.isFinite(value) ? value.toFixed(decimals) : '';
}

// Formats a length in metres as mm / cm / m depending on size.
export function fmtLength(value) {
    if (!Number.isFinite(value)) return '–';
    const a = Math.abs(value);
    if (a < 0.01) return `${(value * 1000).toFixed(1)} mm`;
    if (a < 1) return `${(value * 100).toFixed(1)} cm`;
    return `${value.toFixed(2)} m`;
}

export function uid(prefix = 'm') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function nowStamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

export function safeFilename(name) {
    return String(name || 'garden').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
}

// localStorage wrappers that never throw (private mode, quota, disabled storage).
export const storage = {
    get(key, fallback = null) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    },
    remove(key) {
        try {
            localStorage.removeItem(key);
        } catch {
            // ignore
        }
    }
};

export function loadScript(src) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing?.dataset.loaded) return resolve();
        const s = existing || document.createElement('script');
        s.addEventListener('load', () => {
            s.dataset.loaded = '1';
            resolve();
        });
        s.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
        if (!existing) {
            s.src = src;
            s.async = true;
            document.head.appendChild(s);
        }
    });
}
