const { parentPort } = require('node:worker_threads');
const { readFile } = require('node:fs/promises');
const sharp = require('sharp');
const { buildDragIcon } = require('./dragIcon');
parentPort.on('message', async ({ id, source, size, format, dragIcon }) => {
    try {
        // Native drag image (single card or a counted stack), composed off the main thread.
        if (format === 'drag-icon') {
            const icon = await buildDragIcon(dragIcon);
            parentPort.postMessage({ id, data: icon.buffer, width: icon.width, height: icon.height });
            return;
        }
        // Clipboard bitmap: any format (EXIF-rotated, GIF = first frame) as premultiplied BGRA, the layout
        // nativeImage.createFromBitmap expects on Windows. Capped at 8192 px on the long side. A path is read
        // into memory first: libvips keeps a decoded WebP file open in its cache, and Windows then refuses
        // to delete it (a purge from the in-app bin would fail).
        if (format === 'bitmap') {
            const input = typeof source === 'string' ? await readFile(source) : source;
            const { data, info } = await sharp(input).rotate()
                .resize({ width: 8192, height: 8192, fit: 'inside', withoutEnlargement: true })
                .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            if (info.channels !== 4) throw new Error(`unexpected ${info.channels}-channel bitmap`);
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], b = data[i + 2], a = data[i + 3];
                if (a === 255) { data[i] = b; data[i + 2] = r; }
                else if (a === 0) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
                else { data[i] = (b * a + 127) / 255 | 0; data[i + 1] = (data[i + 1] * a + 127) / 255 | 0; data[i + 2] = (r * a + 127) / 255 | 0; }
            }
            // Transfer only an ArrayBuffer the result owns outright, never a shared pool. Plain Node hands
            // back external (non-V8) memory that cannot be transferred at all: that one is copied.
            const message = { id, data, width: info.width, height: info.height };
            const own = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
            try { parentPort.postMessage(message, own ? [data.buffer] : []); }
            catch { parentPort.postMessage(message); }
            return;
        }
        const resized = sharp(source).rotate().resize({ ...size, fit: 'inside', withoutEnlargement: true });
        // History grid thumbnails: transparency is flattened on white (D5) and stored as JPEG.
        const encoded = format === 'jpeg'
            ? resized.flatten({ background: '#ffffff' }).jpeg({ quality: 78 })
            : resized.png({ compressionLevel: 3 });
        const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
        parentPort.postMessage({ id, data, width: info.width, height: info.height });
    } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
