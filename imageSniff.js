const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MIME_BY_EXTENSION = Object.freeze({
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    avif: 'image/avif'
});

// 按文件头认格式（扩展名可能和内容对不上）→ 'png' | 'jpg' | 'webp' | 'gif' | 'bmp' | 'avif'，认不出为 ''
function sniffImageExtension(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
    if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'gif';
    if (buffer.toString('ascii', 0, 2) === 'BM') return 'bmp';
    if (buffer.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(buffer.toString('ascii', 8, 12))) return 'avif';
    return '';
}

module.exports = { sniffImageExtension, MIME_BY_EXTENSION };
