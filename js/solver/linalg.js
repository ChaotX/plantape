// Dense symmetric linear algebra on flat Float64Array (row-major n×n) matrices.

// Cholesky decomposition A = L·Lᵀ. Returns lower-triangular L or null when A is not positive definite.
export function cholesky(A, n) {
    const L = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
        const rowJ = j * n;
        let sum = A[rowJ + j];
        for (let k = 0; k < j; k++) sum -= L[rowJ + k] * L[rowJ + k];
        if (!(sum > 0)) return null;
        const ljj = Math.sqrt(sum);
        L[rowJ + j] = ljj;
        for (let i = j + 1; i < n; i++) {
            const rowI = i * n;
            let s = A[rowI + j];
            for (let k = 0; k < j; k++) s -= L[rowI + k] * L[rowJ + k];
            L[rowI + j] = s / ljj;
        }
    }
    return L;
}

// Solves L·Lᵀ·x = b.
export function cholSolve(L, n, b) {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = b[i];
        const row = i * n;
        for (let k = 0; k < i; k++) s -= L[row + k] * y[k];
        y[i] = s / L[row + i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = y[i];
        for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
        x[i] = s / L[i * n + i];
    }
    return x;
}

// Inverse of A from its Cholesky factor: A⁻¹ = L⁻ᵀ·L⁻¹.
export function cholInverse(L, n) {
    // M = L⁻¹ (lower triangular)
    const M = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
        M[j * n + j] = 1 / L[j * n + j];
        for (let i = j + 1; i < n; i++) {
            let s = 0;
            const row = i * n;
            for (let k = j; k < i; k++) s -= L[row + k] * M[k * n + j];
            M[row + j] = s / L[row + i];
        }
    }
    // Q = Mᵀ·M, symmetric
    const Q = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let s = 0;
            for (let k = i; k < n; k++) s += M[k * n + i] * M[k * n + j];
            Q[i * n + j] = s;
            Q[j * n + i] = s;
        }
    }
    return Q;
}

// Eigen decomposition of a symmetric 2×2 matrix [[a, b], [b, c]] → semi-axes and angle of the ellipse.
export function ellipse2(a, b, c) {
    const mean = (a + c) / 2;
    const diff = Math.sqrt(((a - c) / 2) ** 2 + b * b);
    const l1 = Math.max(mean + diff, 0);
    const l2 = Math.max(mean - diff, 0);
    return { a: Math.sqrt(l1), b: Math.sqrt(l2), angle: 0.5 * Math.atan2(2 * b, a - c) };
}
