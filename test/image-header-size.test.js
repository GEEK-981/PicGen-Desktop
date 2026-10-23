const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { readImageSizeFromBuffer, readImageSizeFromFile } = require('../imageHeaderSize');

function tmpFile(name, buffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-header-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, buffer);
    return file;
}

// --- synthetic containers: one per format branch -------------------------

function pngHeader(width, height) {
    const buffer = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'latin1');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

function jpegHeader(width, height, padding = 0) {
    const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    const filler = Buffer.alloc(padding);
    const sof = Buffer.alloc(11);
    sof.writeUInt8(0xff, 0);
    sof.writeUInt8(0xc0, 1);
    sof.writeUInt16BE(8, 2);
    sof.writeUInt8(8, 4);
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    return Buffer.concat([head, filler, sof, Buffer.from([0xff, 0xd9])]);
}

function gifHeader(width, height) {
    const buffer = Buffer.alloc(13);
    buffer.write('GIF89a', 0, 'latin1');
    buffer.writeUInt16LE(width, 6);
    buffer.writeUInt16LE(height, 8);
    return buffer;
}

function bmpHeader(width, height) {
    const buffer = Buffer.alloc(54);
    buffer.write('BM', 0, 'latin1');
    buffer.writeInt32LE(54, 10);
    buffer.writeInt32LE(40, 14);
    buffer.writeInt32LE(width, 18);
    buffer.writeInt32LE(height, 22);
    return buffer;
}

function webpVp8xHeader(width, height) {
    const buffer = Buffer.alloc(30);
    buffer.write('RIFF', 0, 'latin1');
    buffer.write('WEBP', 8, 'latin1');
    buffer.write('VP8X', 12, 'latin1');
    buffer.writeUIntLE(width - 1, 24, 3);
    buffer.writeUIntLE(height - 1, 27, 3);
    return buffer;
}

test('reads dimensions from every container PicGen stores', () => {
    assert.deepEqual(readImageSizeFromBuffer(pngHeader(4800, 3584)), { width: 4800, height: 3584 });
    assert.deepEqual(readImageSizeFromBuffer(jpegHeader(3264, 2448)), { width: 3264, height: 2448 });
    assert.deepEqual(readImageSizeFromBuffer(gifHeader(320, 200)), { width: 320, height: 200 });
    assert.deepEqual(readImageSizeFromBuffer(bmpHeader(1024, 768)), { width: 1024, height: 768 });
    assert.deepEqual(readImageSizeFromBuffer(webpVp8xHeader(4096, 4096)), { width: 4096, height: 4096 });
});

test('finds a JPEG frame header that sits behind large metadata segments', () => {
    // Providers ship EXIF/ICC ahead of SOF; the scan must walk past them rather
    // than assume the frame header is at a fixed offset.
    const buffer = jpegHeader(3840, 2160, 200000);
    assert.deepEqual(readImageSizeFromBuffer(buffer), { width: 3840, height: 2160 });
});

test('returns null instead of guessing on unrecognised or truncated input', () => {
    assert.equal(readImageSizeFromBuffer(Buffer.alloc(0)), null);
    assert.equal(readImageSizeFromBuffer(Buffer.from('not an image at all, honestly')), null);
    assert.equal(readImageSizeFromBuffer(pngHeader(100, 100).subarray(0, 20)), null);
    // A JPEG whose SOF never appears in the head must not report a bogus size.
    assert.equal(readImageSizeFromBuffer(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(64)])), null);
    // A malformed IHDR (zero dimensions) is not a usable size.
    assert.equal(readImageSizeFromBuffer(pngHeader(0, 0)), null);
});

test('agrees with a real encoder, from buffer and from disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picgen-header-real-'));
    const cases = [
        { name: 'real.png', format: 'png', width: 640, height: 427 },
        { name: 'real.jpg', format: 'jpeg', width: 511, height: 333 },
        { name: 'real.webp', format: 'webp', width: 300, height: 217 }
    ];

    for (const { name, format, width, height } of cases) {
        const file = path.join(dir, name);
        await sharp({ create: { width, height, channels: 3, background: { r: 20, g: 40, b: 60 } } })
            .toFormat(format)
            .toFile(file);

        const expected = { width, height };
        assert.deepEqual(readImageSizeFromBuffer(fs.readFileSync(file)), expected, `${name} from buffer`);
        assert.deepEqual(await readImageSizeFromFile(file), expected, `${name} from disk`);
    }
});

test('a truthy-looking but unreadable file resolves to null rather than throwing', async () => {
    const file = tmpFile('broken.png', Buffer.from('definitely not png bytes here'));
    assert.equal(await readImageSizeFromFile(file), null);
    assert.equal(await readImageSizeFromFile(path.join(path.dirname(file), 'missing.png')), null);
});
