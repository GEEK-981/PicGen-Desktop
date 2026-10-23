// Pixel decode for the similarity engine (plan v3.1 §2.4). Runs in the similarity host
// process. One decode produces both inputs a feature row needs:
//   rgb64  — 64x64 RGB, stretched (`fit:'fill'`), for the H colour/pHash features;
//   rgb224 — 224x224 RGB, letterboxed on white (`fit:'contain'`, cubic), for DINOv2.
// Transparency is always flattened on white. There is deliberately no `.rotate()`: the H
// evaluation ignored EXIF orientation, and gate O1 (WP6) validated the DINOv2 input without
// it (the tuning library carries no rotating orientation tag).
//
// Source A reuses the 360px history JPEG, but only for originals whose header has no alpha:
// the app's JPEGs of transparent originals were flattened on black and are unusable.
// Source B decodes the original once to a 256px buffer and derives both outputs from it.
// Its rgb224 goes through an in-memory JPEG q88 round trip first: the DINOv2 constants were
// tuned on JPEG q88 thumbnails, and gate O1 failed without the round trip (agreement 0.979,
// 0.999 with it). rgb64 and logR come from the raw buffer.
//
// This module never calls sharp.cache(), sharp.concurrency() or any other global setting;
// those belong to the host process that owns the sharp instance.
const fs = require('node:fs');

const RGB64_BYTES = 64 * 64 * 3;
const RGB224_BYTES = 224 * 224 * 3;
const WHITE = Object.freeze({ r: 255, g: 255, b: 255 });
// Element search (包含相同元素). Constants from the offline prototype on 2,496 library images.
const CROP_SOURCE = 448;
const CROP_GRID = 3;
const CROP_SIDE = 0.6;
const SUBJECT_SOURCE = 512;
const SUBJECT_TRIM = 24;
const SUBJECT_FAR = 45;
const SUBJECT_PATCH = 0.25;
const PATCH = 14;
const PATCH_GRID = 16;

function rgb64Chain(image) {
    return image
        .flatten({ background: '#ffffff' })
        .resize(64, 64, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer();
}

function rgb224Chain(image) {
    return image
        .flatten({ background: '#ffffff' })
        .removeAlpha()
        .resize(224, 224, { fit: 'contain', background: WHITE, kernel: 'cubic' })
        .raw()
        .toBuffer();
}

// Source B's DINOv2 input: the 256px buffer flattened on white and encoded as JPEG q88 in
// memory (sharp's default JPEG settings otherwise), exactly as gate O1 adopted it.
function jpeg88(image) {
    return image
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 88 })
        .toBuffer();
}

function checkSizes(rgb64, rgb224, label) {
    // sharp converts every colourspace (b-w, CMYK, 16-bit) to 8-bit sRGB for raw output, so
    // these hold for any decodable input; the check turns a surprise into a row failure.
    if (rgb64.length !== RGB64_BYTES || rgb224.length !== RGB224_BYTES) {
        throw new Error(`${label}: unexpected decode size ${rgb64.length}/${rgb224.length}`);
    }
}

function logRatio(width, height) {
    if (!(width > 0) || !(height > 0)) throw new Error(`invalid image size ${width}x${height}`);
    return Math.log(width / height);
}

function createDecoder({ sharp = require('sharp') } = {}) {
    async function probe(originalPath) {
        // Header only: no pixel data is decoded.
        const meta = await sharp(originalPath, { failOn: 'none' }).metadata();
        return {
            hasAlpha: Boolean(meta.hasAlpha),
            width: meta.width,
            height: meta.height,
            format: meta.format
        };
    }

    async function decodeJpeg(jpegPath) {
        // Read once so the three sharp passes see the same bytes even if the thumbnail is
        // rewritten meanwhile.
        const jpeg = await fs.promises.readFile(jpegPath);
        const meta = await sharp(jpeg).metadata();
        const [rgb64, rgb224] = await Promise.all([rgb64Chain(sharp(jpeg)), rgb224Chain(sharp(jpeg))]);
        checkSizes(rgb64, rgb224, 'jpeg360');
        return {
            rgb64,
            rgb224,
            logR: logRatio(meta.width, meta.height),
            source: 'jpeg360',
            originalHasAlpha: false
        };
    }

    async function decodeOriginal(originalPath, hasAlpha) {
        const { data, info } = await sharp(originalPath, { failOn: 'none', sequentialRead: true })
            .resize(256, 256, { fit: 'inside' })
            .raw({ depth: 'uchar' })
            .toBuffer({ resolveWithObject: true });
        // Pass only the geometry. The output `info` also reports `premultiplied: true` when the
        // resize premultiplied internally, but the returned bytes are straight alpha; handing
        // that flag back to sharp would un-premultiply them a second time.
        const raw = { width: info.width, height: info.height, channels: info.channels };
        const [rgb64, rgb224] = await Promise.all([
            rgb64Chain(sharp(data, { raw })),
            jpeg88(sharp(data, { raw })).then(jpeg => rgb224Chain(sharp(jpeg)))
        ]);
        checkSizes(rgb64, rgb224, 'original');
        return {
            rgb64,
            rgb224,
            logR: logRatio(info.width, info.height),
            source: 'original',
            originalHasAlpha: hasAlpha === true || info.channels === 2 || info.channels === 4
        };
    }

    async function decode({ originalPath, jpegPath = null, hasAlpha } = {}) {
        if (jpegPath && hasAlpha === false) {
            try {
                return await decodeJpeg(jpegPath);
            } catch {
                // A thumbnail that vanished or is unreadable is not a row failure: the original
                // is the reference source anyway.
            }
        }
        return decodeOriginal(originalPath, hasAlpha);
    }

    // 包含相同元素 (element search), library side: a 3x3 grid of square crops, side = 0.6 x the short
    // edge, from the original fitted inside 448 px. Each crop goes through the same q88 + letterbox
    // chain as rgb224, so a crop's embedding is comparable to a whole-image one.
    async function decodeCrops({ originalPath } = {}) {
        const jpeg = await sharp(originalPath, { failOn: 'none', sequentialRead: true })
            .resize(CROP_SOURCE, CROP_SOURCE, { fit: 'inside' })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 88 })
            .toBuffer({ resolveWithObject: true });
        const { width, height } = jpeg.info;
        const side = Math.max(1, Math.round(CROP_SIDE * Math.min(width, height)));
        const crops = [];
        for (let gy = 0; gy < CROP_GRID; gy++) {
            for (let gx = 0; gx < CROP_GRID; gx++) {
                const left = Math.round((width - side) * gx / (CROP_GRID - 1));
                const top = Math.round((height - side) * gy / (CROP_GRID - 1));
                const rgb224 = await rgb224Chain(sharp(jpeg.data).extract({ left, top, width: side, height: side }));
                if (rgb224.length !== RGB224_BYTES) throw new Error(`crop: unexpected size ${rgb224.length}`);
                crops.push(rgb224);
            }
        }
        return crops;
    }

    // Element search, query side: the subject of a product shot. A plain background (the corner colour)
    // is trimmed away, the rest letterboxed onto that colour, and `mask` flags the 16x16 patches that are
    // mostly subject. A photo without a plain background keeps every patch.
    async function decodeSubject({ originalPath } = {}) {
        const small = await sharp(originalPath, { failOn: 'none', sequentialRead: true })
            .resize(SUBJECT_SOURCE, SUBJECT_SOURCE, { fit: 'inside' })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 88 })
            .toBuffer();
        const corner = (await sharp(small).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer());
        const background = { r: corner[0], g: corner[1], b: corner[2] };
        let trimmed = small;
        try {
            trimmed = await sharp(small).trim({ background, threshold: SUBJECT_TRIM }).toBuffer();
        } catch {
            // Nothing to trim (a single colour): keep the image.
        }
        const rgb224 = await sharp(trimmed).removeAlpha()
            .resize(224, 224, { fit: 'contain', background, kernel: 'cubic' })
            .raw()
            .toBuffer();
        if (rgb224.length !== RGB224_BYTES) throw new Error(`subject: unexpected size ${rgb224.length}`);
        const mask = new Uint8Array(PATCH_GRID * PATCH_GRID);
        let kept = 0;
        for (let py = 0; py < PATCH_GRID; py++) {
            for (let px = 0; px < PATCH_GRID; px++) {
                let subject = 0;
                for (let y = 0; y < PATCH; y++) {
                    for (let x = 0; x < PATCH; x++) {
                        const i = ((py * PATCH + y) * 224 + px * PATCH + x) * 3;
                        const far = Math.abs(rgb224[i] - background.r) + Math.abs(rgb224[i + 1] - background.g) + Math.abs(rgb224[i + 2] - background.b);
                        if (far > SUBJECT_FAR) subject++;
                    }
                }
                if (subject > PATCH * PATCH * SUBJECT_PATCH) {
                    mask[py * PATCH_GRID + px] = 1;
                    kept++;
                }
            }
        }
        return { rgb224, mask, subjectPatches: kept };
    }

    return { probe, decode, decodeCrops, decodeSubject };
}

module.exports = { createDecoder, RGB64_BYTES, RGB224_BYTES, CROP_COUNT: CROP_GRID * CROP_GRID };
