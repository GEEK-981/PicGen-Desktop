// File name of a history grid thumbnail in desktop-cache/thumbnails (v3.1 plan §2.4, §2.9).
// Extracted verbatim from getHistoryThumbnail in electron-main.js so main (which writes the
// thumbnails) and the similarity host (which reuses opaque ones as a decode source) agree.
// The key changes whenever the file is replaced, resized on disk or touched.
const crypto = require('node:crypto');

function historyThumbnailKey(resolvedPath, stat) {
    const hash = crypto.createHash('sha1')
        .update(`${String(resolvedPath).toLowerCase()}:${stat.size}:${stat.mtimeMs}`)
        .digest('hex');
    return `${hash}.jpg`;
}

module.exports = { historyThumbnailKey };
