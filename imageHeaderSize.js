'use strict';

// Header-only image dimension reader.
//
// `nativeImage.createFromPath(file).getSize()` decodes the whole frame before it
// can answer. On the real corpus that costs ~120 ms for a 12 MB 4800x3584 PNG,
// paid on the Electron main process — the same process that owns the window,
// the tray, native drag and every in-flight download. Every container we store
// (PNG/JPEG/WebP/GIF/BMP) writes its dimensions into the first few bytes, so we
// read a small head and parse it instead: ~0.3 ms, same answer.
//
// Returns null for anything unrecognised so callers can fall back to a real decode.

const fs = require('node:fs');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// JPEG puts SOF after its APP segments, and PicGen's own XMP packet plus a
// provider's ICC profile can both be large, so the head is generous. Reading
// 256 KB from the OS page cache is still well under a millisecond.
const HEAD_BYTES = 256 * 1024;

// SOF markers carrying frame dimensions. C4 (DHT), C8 (JPG) and CC (DAC) share
// the range but are not frame headers.
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function usable(width, height) {
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
        ? { width, height }
        : null;
}

function readPngSize(buffer) {
    // Signature (8) then the mandatory IHDR: length(4) type(4) width(4) height(4).
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
    return usable(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

function readGifSize(buffer) {
    const header = buffer.length >= 10 ? buffer.toString('latin1', 0, 6) : '';
    if (header !== 'GIF87a' && header !== 'GIF89a') return null;
    return usable(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
}

function readBmpSize(buffer) {
    if (buffer.length < 26 || buffer[0] !== 0x42 || buffer[1] !== 0x4d) return null;
    // Height is signed: a negative value means the rows are stored top-down.
    return usable(buffer.readInt32LE(18), Math.abs(buffer.readInt32LE(22)));
}

function readWebpSize(buffer) {
    if (buffer.length < 30) return null;
    if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') return null;
    const format = buffer.toString('latin1', 12, 16);

    if (format === 'VP8X') {
        // Extended format: 24-bit canvas size, stored minus one.
        return usable(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1);
    }
    if (format === 'VP8 ') {
        // Lossy: after the chunk header, a 3-byte frame tag then the 3-byte sync code.
        if (buffer.length < 30 || buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
        return usable(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
    }
    if (format === 'VP8L') {
        // Lossless: 1-byte signature 0x2f, then 14-bit (size - 1) pairs.
        if (buffer[20] !== 0x2f || buffer.length < 25) return null;
        const bits = buffer.readUInt32LE(21);
        return usable((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    return null;
}

function readJpegSize(buffer) {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 3 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset++; continue; }
        const marker = buffer[offset + 1];
        // Padding and standalone markers carry no payload.
        if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) return null;
        if (JPEG_SOF_MARKERS.has(marker)) {
            // precision(1) height(2) width(2)
            if (offset + 9 > buffer.length) return null;
            return usable(buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5));
        }
        offset += 2 + length;
    }
    return null;
}

function readImageSizeFromBuffer(buffer) {
    // 10 bytes is the shortest header any of these containers can carry (a GIF's
    // signature plus its 2x2 screen size); each reader validates its own length.
    if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;
    return readPngSize(buffer)
        || readJpegSize(buffer)
        || readWebpSize(buffer)
        || readGifSize(buffer)
        || readBmpSize(buffer);
}

async function readImageSizeFromFile(filePath) {
    let handle;
    try {
        handle = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
        return readImageSizeFromBuffer(bytesRead === HEAD_BYTES ? buffer : buffer.subarray(0, bytesRead));
    } catch {
        return null;
    } finally {
        await handle?.close().catch(() => {});
    }
}

module.exports = { readImageSizeFromBuffer, readImageSizeFromFile, HEAD_BYTES };
