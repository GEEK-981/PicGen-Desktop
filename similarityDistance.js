'use strict';

// Pairwise distances for similar-image grouping (v3.1 plan §2.6, §2.18; final.md §3.2, §5).
//
// Two frozen formulas share one contract: d <= t links two images at preset t,
// d = Infinity is a hard veto (and how user cannot-link is expressed).
//
// hd1 (default; DINOv2-small q8 + prompt):
//   c = cos(qA, qB)
//   g = (1 - c + max(0, 0.70 - c)) / 0.696
//   c < 0.40 or cannot-link  → Infinity
//   both prompted            → 0.65 (1 - J) + 0.175 g
//   otherwise                → 0.45 g
//
// H (fallback when ORT or the model is unavailable): method H from final.md,
// verbatim, including the white-pair pHash term and the v > 1.0 veto.
//
// The bounds helpers give the exact pruning thresholds implied by each formula at T;
// the clustering code uses them to skip pairs that cannot reach d <= T.

function deepFreeze(object) {
    for (const value of Object.values(object)) if (value && typeof value === 'object') deepFreeze(value);
    return Object.freeze(object);
}

const HD = deepFreeze({
    E0: 0.696,              // median of 1 - cos over different-prompt pairs
    WP: 0.65,               // prompt weight
    WV: 0.175,              // visual weight for prompted pairs
    S: 0.45,                // promptless scale
    VETO_COS: 0.40,
    HINGE_COS: 0.70,
    HINGE_K: 1,
    T_EDGE: 0.11,
    PRESETS: { strict: 0.07, standard: 0.09, loose: 0.11 },
    NEXT_CUT: { strict: 0.05, standard: 0.07, loose: 0.09 },
    NEIGHBOR_D_MAX: 0.15,
    VISUAL_COS_MIN: 0.70,
    NEAR_J: 0.8308
});

const H = deepFreeze({
    LAB_NORM: 0.7077,       // Lab / HSV / layout normalisers (final.md §5)
    HSV_NORM: 0.7589,
    LAYOUT_NORM: 149.0,
    RATIO_GATE: 0.1,        // |ΔlogR| above this: histograms only, plus the penalty
    RATIO_PENALTY: 0.2,
    VETO_V: 1.0,
    WP: 0.65,
    WV: 0.175,
    V_CAP: 2,
    S: 0.3,                 // promptless scale
    WHITE_MIN: 0.5,         // both whiteFrac above this: blend in pHash256
    WHITE_WEIGHT: 1,
    PHASH_NORM: 128,
    T_EDGE: 0.15,
    PRESETS: { strict: 0.10, standard: 0.125, loose: 0.15 },
    NEXT_CUT: { strict: 0.075, standard: 0.10, loose: 0.125 },
    NEIGHBOR_D_MAX: 0.35,
    VISUAL_V_MAX: 0.6,
    NEAR_J: 0.7692
});

// --- hd1 ----------------------------------------------------------------------------

function g(c) {
    return (1 - c + HD.HINGE_K * Math.max(0, HD.HINGE_COS - c)) / HD.E0;
}

// Inverse of g (g is strictly decreasing): the cosine at which the visual term equals G.
function gInv(G) {
    const c = 1 - HD.E0 * G;
    return c >= HD.HINGE_COS ? c : (1 + HD.HINGE_K * HD.HINGE_COS - HD.E0 * G) / (1 + HD.HINGE_K);
}

// Every pair with d <= T satisfies: J >= jMin (prompted, different np), cos >= sameCosMin
// (prompted), cos >= noPromptCosMin (either promptless). At T_EDGE 0.11: 0.8308 / 0.6313 / 0.8299.
function boundsHD(T = HD.T_EDGE) {
    return {
        jMin: 1 - T / HD.WP,
        sameCosMin: Math.max(HD.VETO_COS, gInv(T / HD.WV)),
        noPromptCosMin: Math.max(HD.VETO_COS, gInv(T / HD.S))
    };
}

// Int8 cosine: (qA · qB) · invA · invB. The two inverse norms are multiplied first so
// the result is bitwise symmetric in A and B.
function cosQ(qA, invA, qB, invB) {
    let dot = 0;
    for (let i = 0; i < qA.length; i++) dot += qA[i] * qB[i];
    return dot * (invA * invB);
}

function distanceHD({ cos, J = 0, bothPrompted = false, cannot = false } = {}) {
    if (!(cos >= HD.VETO_COS) || cannot) return Infinity;
    const u = g(cos);
    return bothPrompted ? HD.WP * (1 - J) + HD.WV * u : HD.S * u;
}

// --- H (fallback) -----------------------------------------------------------------------

function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

function l2(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        s += d * d;
    }
    return Math.sqrt(s);
}

function popcount32(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function hamming256(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += popcount32((a[i] ^ b[i]) >>> 0);
    return s;
}

// a, b: {hsv, lab (square-rooted histograms), layout, logR, whiteFrac, phash}, as a row holds them.
function visualH(a, b) {
    const hl = Math.sqrt(Math.max(0, 1 - dot(a.lab, b.lab))) / H.LAB_NORM;
    const hh = Math.sqrt(Math.max(0, 1 - dot(a.hsv, b.hsv))) / H.HSV_NORM;
    let v = Math.abs(a.logR - b.logR) > H.RATIO_GATE
        ? (2 * hl + hh) / 3 + H.RATIO_PENALTY
        : (l2(a.layout, b.layout) / H.LAYOUT_NORM + 2 * hl + hh) / 4;
    if (a.whiteFrac > H.WHITE_MIN && b.whiteFrac > H.WHITE_MIN) {
        v = (4 * v + H.WHITE_WEIGHT * hamming256(a.phash, b.phash) / H.PHASH_NORM) / (4 + H.WHITE_WEIGHT);
    }
    return v;
}

function distanceH({ v, J = 0, bothPrompted = false, cannot = false } = {}) {
    if (!(v <= H.VETO_V) || cannot) return Infinity;
    return bothPrompted ? H.WP * (1 - J) + H.WV * Math.min(v, H.V_CAP) : H.S * v;
}

// Every pair with d <= T satisfies: J >= jMin, v <= sameVMax (prompted), v <= noPromptVMax
// (either promptless). At T_EDGE 0.15: 0.7692 / 0.857 / 0.5.
function boundsH(T = H.T_EDGE) {
    return {
        jMin: 1 - T / H.WP,
        sameVMax: Math.min(H.VETO_V, T / H.WV),
        noPromptVMax: Math.min(H.VETO_V, T / H.S)
    };
}

module.exports = {
    HD,
    H,
    g,
    gInv,
    boundsHD,
    boundsH,
    cosQ,
    visualH,
    distanceHD,
    distanceH,
    hamming256
};
