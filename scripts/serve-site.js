// Serves dist/site on http://127.0.0.1:<port> for a local look before uploading.
//   node scripts/serve-site.js [port]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'dist', 'site');
const PORT = Number(process.argv[2] || process.env.PORT || 4321);
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.exe': 'application/octet-stream' };

http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (error, stat) => {
        if (error || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
        const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
        const headers = { 'Content-Type': type, 'Content-Length': stat.size };
        if (type === 'application/octet-stream') headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
        res.writeHead(200, headers);
        fs.createReadStream(file).pipe(res);
    });
}).listen(PORT, '127.0.0.1', () => console.log(`Site preview: http://127.0.0.1:${PORT}/`));
