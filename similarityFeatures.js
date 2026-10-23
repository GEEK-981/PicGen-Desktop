'use strict';

// Pixel features and the feature row for similar-image grouping (v3.1 plan §2.4, §2.5).
//
// Pure and dependency-free, so main, the similarity host and the tests share it.
//
// - `colourFeatures` / `phash256` are straight ports of the evaluated method H
//   (sim-eval-hash/small-hist.js, white.js, design-user-first/probe2.js) and work
//   on the 64x64 RGB buffer (`flatten #fff → resize 64x64 fill → removeAlpha`).
//   `hsv` and `lab` come back as the square roots of the normalised histograms,
//   exactly the values the row stores and `visualH` consumes.
// - `toNchw` / `poolTokens` / `quantizeEmbedding` wrap the DINOv2-small input and
//   output: ImageNet-normalised NCHW float32, mean of the patch tokens (CLS
//   skipped) then L2, and int8 max-abs quantisation with an f32 `inv = 1/‖q‖`.
// - `packRow` / `unpackRow` implement layout 2 (2,164 bytes, little-endian, CRC-32
//   of bytes 0..2159 in the last four bytes).

const os = require('node:os');

const H_VERSION = 'cc4w-64fill-v1';
const EMB_VERSION_BASE = 'dinov2s-q8-pad-v1';

const SIDE = 64;
const HSV_BINS = 128;
const LAB_BINS = 256;
const LAYOUT_VALUES = 48;
const PHASH_WORDS = 8;
const EMB_DIM = 384;

const ROW_BYTES = 2164;
const OFFSETS = Object.freeze({
    hsv: 0,
    lab: 512,
    layout: 1536,
    logR: 1728,
    whiteFrac: 1732,
    phash: 1736,
    q: 1768,
    inv: 2152,
    flags: 2156,
    crc: 2160
});
const FLAGS = Object.freeze({ OK: 1, SRC_JPEG360: 2, ORIG_ALPHA: 4, DINO_OK: 8 });

// Lab bins counted by whiteFrac: L-bin 3 with a, b bins in {3, 4}.
const WHITE_BINS = [3 * 64 + 3 * 8 + 3, 3 * 64 + 3 * 8 + 4, 3 * 64 + 4 * 8 + 3, 3 * 64 + 4 * 8 + 4];

// ImageNet normalisation used by DINOv2.
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const LITTLE_ENDIAN = os.endianness() === 'LE';

// --- colour features (port of small-hist.js; keep the arithmetic order) --------

const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
    const c = i / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function labF(t) {
    return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function assertRgb(rgb, width, height, label) {
    if (!rgb || typeof rgb.length !== 'number' || rgb.length !== width * height * 3) {
        throw new TypeError(`${label} expects a ${width}x${height} RGB buffer (${width * height * 3} bytes)`);
    }
}

function colourFeatures(rgb64, width = SIDE, height = SIDE) {
    assertRgb(rgb64, width, height, 'colourFeatures');
    const n = width * height;
    const hsvCounts = new Float64Array(HSV_BINS);
    const labCounts = new Float64Array(LAB_BINS);
    const grid = new Float64Array(LAYOUT_VALUES);
    const cellCounts = new Float64Array(16);
    for (let i = 0; i < n; i++) {
        const r = rgb64[3 * i];
        const g = rgb64[3 * i + 1];
        const b = rgb64[3 * i + 2];
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const d = mx - mn;
        let h = 0;
        if (d) {
            if (mx === r) h = ((g - b) / d) % 6;
            else if (mx === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h /= 6;
            if (h < 0) h += 1;
        }
        const s = mx ? d / mx : 0;
        const v = mx / 255;
        hsvCounts[Math.min(7, Math.floor(h * 8)) * 16 + Math.min(3, Math.floor(s * 4)) * 4 + Math.min(3, Math.floor(v * 4))]++;

        const R = SRGB_TO_LINEAR[r];
        const G = SRGB_TO_LINEAR[g];
        const B = SRGB_TO_LINEAR[b];
        const X = labF((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
        const Y = labF(R * 0.2126 + G * 0.7152 + B * 0.0722);
        const Z = labF((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
        const L = 116 * Y - 16;
        const A = 500 * (X - Y);
        const Bb = 200 * (Y - Z);
        labCounts[
            Math.min(3, Math.max(0, Math.floor(L / 25))) * 64
            + Math.min(7, Math.max(0, Math.floor((A + 80) / 20))) * 8
            + Math.min(7, Math.max(0, Math.floor((Bb + 80) / 20)))
        ]++;

        const x = i % width;
        const y = (i / width) | 0;
        const cell = Math.min(3, Math.floor(y * 4 / height)) * 4 + Math.min(3, Math.floor(x * 4 / width));
        grid[cell * 3] += L;
        grid[cell * 3 + 1] += A;
        grid[cell * 3 + 2] += Bb;
        cellCounts[cell]++;
    }

    const hsv = new Float32Array(HSV_BINS);
    for (let i = 0; i < HSV_BINS; i++) hsv[i] = Math.sqrt(hsvCounts[i] / n);
    const lab = new Float32Array(LAB_BINS);
    for (let i = 0; i < LAB_BINS; i++) lab[i] = Math.sqrt(labCounts[i] / n);
    const layout = new Float32Array(LAYOUT_VALUES);
    for (let i = 0; i < LAYOUT_VALUES; i++) layout[i] = grid[i] / cellCounts[Math.floor(i / 3)];
    let whiteFrac = 0;
    for (const bin of WHITE_BINS) whiteFrac += labCounts[bin] / n;
    return { hsv, lab, layout, whiteFrac };
}

// --- pHash256 (port of probe2.js) ------------------------------------------------

const DCT = new Float64Array(SIDE * SIDE);
for (let k = 0; k < SIDE; k++) {
    for (let x = 0; x < SIDE; x++) DCT[k * SIDE + x] = Math.cos(Math.PI / 64 * (x + 0.5) * k);
}

// Grey 0.299R + 0.587G + 0.114B on the 64x64 image, 2-D DCT, top-left 16x16,
// one bit per coefficient above the median.
function phash256(rgb64) {
    assertRgb(rgb64, SIDE, SIDE, 'phash256');
    const grey = new Float64Array(SIDE * SIDE);
    for (let i = 0; i < SIDE * SIDE; i++) grey[i] = 0.299 * rgb64[3 * i] + 0.587 * rgb64[3 * i + 1] + 0.114 * rgb64[3 * i + 2];
    const tmp = new Float64Array(SIDE * 16);
    for (let y = 0; y < SIDE; y++) {
        for (let k = 0; k < 16; k++) {
            let s = 0;
            for (let x = 0; x < SIDE; x++) s += DCT[k * SIDE + x] * grey[y * SIDE + x];
            tmp[y * 16 + k] = s;
        }
    }
    const low = new Float64Array(256);
    for (let k = 0; k < 16; k++) {
        for (let x = 0; x < 16; x++) {
            let s = 0;
            for (let y = 0; y < SIDE; y++) s += DCT[k * SIDE + y] * tmp[y * 16 + x];
            low[k * 16 + x] = s;
        }
    }
    const sorted = Float64Array.from(low).sort();
    const median = (sorted[127] + sorted[128]) / 2;
    const words = new Uint32Array(PHASH_WORDS);
    for (let i = 0; i < 256; i++) if (low[i] > median) words[i >> 5] |= 1 << (i & 31);
    return words;
}

// --- DINOv2 input / output -----------------------------------------------------

// v -> (v/255 - mean[c]) / std[c], per channel, as float32.
const NCHW_LUT = [0, 1, 2].map(c => Float32Array.from({ length: 256 }, (_, v) => (v / 255 - MEAN[c]) / STD[c]));

// Interleaved RGB (HWC, uchar) → planar float32 (CHW). A 224x224 input gives the
// [1,3,224,224] tensor data (150,528 floats); any whole number of pixels works.
function toNchw(rgb) {
    if (!rgb || typeof rgb.length !== 'number' || rgb.length % 3 !== 0) {
        throw new TypeError('toNchw expects interleaved RGB bytes (length a multiple of 3)');
    }
    const pixels = rgb.length / 3;
    const out = new Float32Array(rgb.length);
    for (let c = 0; c < 3; c++) {
        const lut = NCHW_LUT[c];
        const plane = c * pixels;
        for (let p = 0; p < pixels; p++) out[plane + p] = lut[rgb[3 * p + c]];
    }
    return out;
}

// last_hidden_state [1, T, D] (or [T, D]) → mean of tokens 1..T-1 (CLS skipped), L2-normalised.
// `mask` (optional, length T-1, truthy = keep) restricts the mean to those patch tokens, e.g. the
// foreground of a product shot; an all-false mask falls back to every token.
function poolTokens(data, dims, mask = null) {
    const shape = Array.from(dims || [], Number);
    if (shape.length === 3 && shape[0] !== 1) throw new RangeError(`poolTokens expects batch 1, got dims [${shape}]`);
    const [T, D] = shape.length === 3 ? shape.slice(1) : shape;
    if (shape.length < 2 || shape.length > 3 || !(T >= 2) || !(D >= 1) || !data || data.length !== T * D) {
        throw new RangeError(`poolTokens: dims [${shape}] do not match ${data ? data.length : 0} values`);
    }
    if (mask && mask.length !== T - 1) throw new RangeError(`poolTokens: mask length ${mask.length} instead of ${T - 1}`);
    const useMask = !!mask && Array.prototype.some.call(mask, Boolean);
    const acc = new Float64Array(D);
    let used = 0;
    for (let t = 1; t < T; t++) {
        if (useMask && !mask[t - 1]) continue;
        used++;
        const offset = t * D;
        for (let d = 0; d < D; d++) acc[d] += data[offset + d];
    }
    let norm = 0;
    for (let d = 0; d < D; d++) {
        acc[d] /= used;
        norm += acc[d] * acc[d];
    }
    norm = Math.sqrt(norm);
    const out = new Float32Array(D);
    if (norm > 0) for (let d = 0; d < D; d++) out[d] = acc[d] / norm;
    return out;
}

// s = 127 / max|e|, q = clamp(round(e·s), -127, 127), inv = 1/‖q‖ (stored as f32).
// cos(A, B) = (qA · qB) · invA · invB. A zero vector gives q = 0 and inv = 0.
function quantizeEmbedding(embedding) {
    const length = embedding ? embedding.length : 0;
    let max = 0;
    for (let i = 0; i < length; i++) {
        const value = embedding[i];
        if (!Number.isFinite(value)) throw new RangeError('quantizeEmbedding: the embedding holds a non-finite value');
        const magnitude = Math.abs(value);
        if (magnitude > max) max = magnitude;
    }
    const q = new Int8Array(length);
    if (max === 0) return { q, inv: 0 };
    const scale = 127 / max;
    let sumSquares = 0;
    for (let i = 0; i < length; i++) {
        const value = Math.max(-127, Math.min(127, Math.round(embedding[i] * scale)));
        q[i] = value;
        sumSquares += value * value;
    }
    return { q, inv: sumSquares > 0 ? Math.fround(1 / Math.sqrt(sumSquares)) : 0 };
}

// --- CRC-32 (IEEE 802.3, the zlib polynomial) ---------------------------------------

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf, start = 0, end = buf.length) {
    let crc = -1;
    for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

// --- feature row, layout 2 -----------------------------------------------------------

function assertArray(value, length, name) {
    if (!value || typeof value.length !== 'number' || value.length !== length) {
        throw new TypeError(`packRow: ${name} must hold ${length} values`);
    }
}

function assertFinite(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`packRow: ${name} must be a finite number`);
}

function writeFloats(buf, offset, values) {
    for (let i = 0; i < values.length; i++) buf.writeFloatLE(values[i], offset + 4 * i);
}

function packRow({ hsv, lab, layout, logR, whiteFrac, phash, q, inv } = {}, flags = 0) {
    assertArray(hsv, HSV_BINS, 'hsv');
    assertArray(lab, LAB_BINS, 'lab');
    assertArray(layout, LAYOUT_VALUES, 'layout');
    assertFinite(logR, 'logR');
    assertFinite(whiteFrac, 'whiteFrac');
    assertArray(phash, PHASH_WORDS, 'phash');
    if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) throw new TypeError('packRow: flags must be a u32');
    const dinoOk = (flags & FLAGS.DINO_OK) !== 0;
    if (dinoOk) {
        assertArray(q, EMB_DIM, 'q');
        assertFinite(inv, 'inv');
    }

    const buf = Buffer.alloc(ROW_BYTES);
    writeFloats(buf, OFFSETS.hsv, hsv);
    writeFloats(buf, OFFSETS.lab, lab);
    writeFloats(buf, OFFSETS.layout, layout);
    buf.writeFloatLE(logR, OFFSETS.logR);
    buf.writeFloatLE(whiteFrac, OFFSETS.whiteFrac);
    for (let i = 0; i < PHASH_WORDS; i++) buf.writeUInt32LE(phash[i] >>> 0, OFFSETS.phash + 4 * i);
    // Without DINO_OK the embedding and inv stay all zero, whatever the caller passed.
    if (dinoOk) {
        for (let i = 0; i < EMB_DIM; i++) buf.writeInt8(q[i], OFFSETS.q + i);
        buf.writeFloatLE(inv, OFFSETS.inv);
    }
    buf.writeUInt32LE(flags >>> 0, OFFSETS.flags);
    buf.writeUInt32LE(crc32(buf, 0, OFFSETS.crc), OFFSETS.crc);
    return buf;
}

// Returns copies (one aligned ArrayBuffer per row), so the source buffer may be reused.
function unpackRow(buf) {
    if (!buf || typeof buf.length !== 'number' || buf.length < ROW_BYTES) {
        throw new RangeError(`unpackRow expects at least ${ROW_BYTES} bytes`);
    }
    const bytes = new Uint8Array(ROW_BYTES);
    bytes.set(buf.subarray ? buf.subarray(0, ROW_BYTES) : Array.prototype.slice.call(buf, 0, ROW_BYTES));
    const view = new DataView(bytes.buffer);
    const storedCrc = view.getUint32(OFFSETS.crc, true);
    const crcOk = crc32(bytes, 0, OFFSETS.crc) === storedCrc;

    let hsv;
    let lab;
    let layout;
    let phash;
    if (LITTLE_ENDIAN) {
        hsv = new Float32Array(bytes.buffer, OFFSETS.hsv, HSV_BINS);
        lab = new Float32Array(bytes.buffer, OFFSETS.lab, LAB_BINS);
        layout = new Float32Array(bytes.buffer, OFFSETS.layout, LAYOUT_VALUES);
        phash = new Uint32Array(bytes.buffer, OFFSETS.phash, PHASH_WORDS);
    } else {
        const floats = (offset, length) => Float32Array.from({ length }, (_, i) => view.getFloat32(offset + 4 * i, true));
        hsv = floats(OFFSETS.hsv, HSV_BINS);
        lab = floats(OFFSETS.lab, LAB_BINS);
        layout = floats(OFFSETS.layout, LAYOUT_VALUES);
        phash = Uint32Array.from({ length: PHASH_WORDS }, (_, i) => view.getUint32(OFFSETS.phash + 4 * i, true));
    }
    return {
        hsv,
        lab,
        layout,
        logR: view.getFloat32(OFFSETS.logR, true),
        whiteFrac: view.getFloat32(OFFSETS.whiteFrac, true),
        phash,
        q: new Int8Array(bytes.buffer, OFFSETS.q, EMB_DIM),
        inv: view.getFloat32(OFFSETS.inv, true),
        flags: view.getUint32(OFFSETS.flags, true),
        crcOk
    };
}

module.exports = {
    colourFeatures,
    phash256,
    toNchw,
    poolTokens,
    quantizeEmbedding,
    packRow,
    unpackRow,
    crc32,
    ROW_BYTES,
    OFFSETS,
    FLAGS,
    H_VERSION,
    EMB_VERSION_BASE,
    EMB_DIM
};
