// Builds the download landing page into dist/site: a static folder that can be
// uploaded as is to any host reachable from mainland China (OSS / COS / your
// own server). Everything is same-origin: no web fonts, no third-party CDN.
//
//   node scripts/build-site.js            uses dist/release/PicGen-<version>-x64.exe
//   node scripts/build-site.js --no-exe   page only, the EXE stays where it is
//
// site/site.config.json:
//   siteUrl            public address of the page (canonical link), optional
//   directDownloadUrl  where the EXE is downloaded from; empty = download/<file>
//                      on the same host (the EXE is copied there)
//   copyExeToSite      copy the EXE into dist/site/download (default true)
//   baiduPanUrl / baiduPanCode   Baidu Netdisk share link and extraction code
//   contact            optional footer text (e.g. a QQ group or email)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const SHOTS = ['generate', 'optimize', 'history', 'history-detail', 'queue', 'settings-suppliers',
    'settings-routing', 'reverse-prompt', 'workspace-annotate', 'workspace-scale', 'workspace-mask'];

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function sha256(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
    });
}

// The Baidu Netdisk button and its extraction-code row (both empty-safe).
function baiduParts(config) {
    const url = String(config.baiduPanUrl || '').trim();
    const code = String(config.baiduPanCode || '').trim();
    if (!url) {
        return {
            button: '<span class="btn btn-light btn-lg" aria-disabled="true" style="opacity:.55;cursor:default"><svg class="i"><use href="#i-cloud"/></svg>百度网盘 · 整理中</span>',
            code: ''
        };
    }
    if (!/^https:\/\/pan\.baidu\.com\//i.test(url)) throw new Error(`baiduPanUrl 不是百度网盘链接: ${url}`);
    return {
        button: `<a class="btn btn-light btn-lg" href="${escapeHtml(url)}" target="_blank" rel="noopener" data-pan="${escapeHtml(code)}"><svg class="i"><use href="#i-cloud"/></svg>百度网盘</a>`,
        code: code
            ? `<div class="pan">提取码 <span class="code">${escapeHtml(code)}</span><button class="copy" type="button" data-copy="${escapeHtml(code)}">复制</button></div>`
            : ''
    };
}

// Relay cards come from the same templates the app's "新增供应商" form offers,
// so the page always recommends exactly what PicGen fills in.
const RELAY_ICONS = { zap: 'i-zap', atom: 'i-atom' };
async function relayCards() {
    const { SUPPLIER_TEMPLATES } = await import(pathToFileURL(path.join(ROOT, 'frontend', 'supplierTemplates.mjs')).href);
    return SUPPLIER_TEMPLATES.map(template => {
        const models = template.group.models;
        const shown = models.slice(0, 4).map(model => `<span>${escapeHtml(model)}</span>`).join('');
        const more = models.length > 4 ? `<span>+${models.length - 4}</span>` : '';
        return `<div class="relay">`
            + `<div class="relay-head"><span class="ico"><svg class="i"><use href="#${RELAY_ICONS[template.icon] || 'i-server'}"/></svg></span>`
            + `<div><b>${escapeHtml(template.name)}</b><span>${escapeHtml(new URL(template.baseUrl).host)} · ${models.length} 个生图模型</span></div></div>`
            + `<div class="relay-models">${shown}${more}</div>`
            + `<a class="btn btn-dark" href="${escapeHtml(template.signupUrl)}" target="_blank" rel="sponsored noopener"><svg class="i"><use href="#i-key"/></svg>注册获取 Key</a>`
            + '</div>';
    }).join('\n        ');
}

// LobeHub model icons (MIT), inlined so the page makes no extra requests.
function modelIcon(name) {
    const svg = fs.readFileSync(path.join(ROOT, 'assets', 'model-icons', `${name}.svg`), 'utf8');
    return svg.replace(/<\?xml[^>]*>\s*/i, '').replace(/<title>[\s\S]*?<\/title>/i, '').trim()
        .replace(/<svg\b/, '<svg aria-hidden="true"');
}

async function buildImages(out) {
    const img = path.join(out, 'img');
    fs.mkdirSync(img, { recursive: true });
    // Shown at most ~330 CSS px wide; 640 px covers 2x screens at a fraction of the PNG size.
    for (const name of SHOTS) {
        await sharp(path.join(ROOT, 'docs', 'images', `${name}.png`)).resize({ width: 640 }).webp({ quality: 80 }).toFile(path.join(img, `${name}.webp`));
    }
    fs.copyFileSync(path.join(SITE, 'assets', 'wechat-qr.png'), path.join(img, 'wechat-qr.png'));
    const icon = path.join(ROOT, 'assets', 'picgen-icon.png');
    await sharp(icon).resize(64, 64).png().toFile(path.join(img, 'icon-64.png'));
    await sharp(icon).resize(180, 180).png().toFile(path.join(img, 'icon-180.png'));
    // Share card for WeChat / QQ link previews.
    const shot = await sharp(path.join(ROOT, 'docs', 'images', 'generate.png')).resize({ height: 540 }).png().toBuffer();
    const iconLarge = await sharp(icon).resize(120, 120).png().toBuffer();
    // Same palette as azglb.top: white canvas, ink headline, indigo eyebrow.
    const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
        <text x="80" y="290" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="22" font-weight="700" letter-spacing="4" fill="#3a45c4">AZGLB · PICGEN</text>
        <text x="80" y="370" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="64" font-weight="800" fill="#16181d">贴在屏幕边上的</text>
        <text x="80" y="450" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="64" font-weight="800" fill="#16181d">AI 生图小窗</text>
        <text x="80" y="510" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="26" fill="#64748b">Windows 免安装 · 国内直接下载</text>
    </svg>`);
    await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#f8fafc' } })
        .composite([{ input: iconLarge, left: 80, top: 110 }, { input: text, left: 0, top: 0 }, { input: shot, left: 820, top: 45 }])
        .png().toFile(path.join(img, 'og.png'));
}

async function buildSite({ copyExe = true } = {}) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(SITE, 'site.config.json'), 'utf8'));
    const version = pkg.version;
    const fileName = `${pkg.build.productName}-${version}-x64.exe`;
    const exe = path.join(ROOT, 'dist', 'release', fileName);
    if (!fs.existsSync(exe)) throw new Error(`找不到 ${exe}，先运行 npm run build:win:portable`);
    const size = fs.statSync(exe).size;
    const hash = await sha256(exe);

    const out = path.join(ROOT, 'dist', 'site');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    await buildImages(out);

    const external = String(config.directDownloadUrl || '').trim();
    const directUrl = external || `download/${fileName}`;
    if (!external && copyExe && config.copyExeToSite !== false) {
        fs.mkdirSync(path.join(out, 'download'), { recursive: true });
        fs.copyFileSync(exe, path.join(out, 'download', fileName));
    }
    const buildDate = new Date().toISOString().slice(0, 10);
    const siteUrl = String(config.siteUrl || '').trim().replace(/\/+$/, '');
    const mainSiteUrl = String(config.mainSiteUrl || 'https://azglb.top').trim().replace(/\/+$/, '');
    const baidu = baiduParts(config);
    const values = {
        MAIN_SITE_URL: escapeHtml(mainSiteUrl),
        RELAY_CARDS: await relayCards(),
        BAIDU_BUTTON: baidu.button,
        BAIDU_CODE: baidu.code,
        ICON_OPENAI: modelIcon('openai'),
        ICON_GEMINI: modelIcon('gemini-color'),
        ICON_GROK: modelIcon('grok'),
        ICON_DOUBAO: modelIcon('doubao-color'),
        VERSION: escapeHtml(version),
        FILE_NAME: escapeHtml(fileName),
        SIZE_MB: (size / 1024 / 1024).toFixed(1),
        SIZE_BYTES: size.toLocaleString('en-US'),
        SHA256: hash,
        DIRECT_URL: escapeHtml(directUrl),
        BUILD_DATE: buildDate,
        OG_IMAGE: escapeHtml(siteUrl ? `${siteUrl}/img/og.png` : 'img/og.png'),
        CANONICAL: siteUrl ? `<link rel="canonical" href="${escapeHtml(siteUrl)}/">` : '',
        CONTACT: config.contact ? `<span>${escapeHtml(config.contact)}</span>` : ''
    };
    let html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
    html = html.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
        if (!(key in values)) throw new Error(`模板里有未知占位符 ${match}`);
        return values[key];
    });
    const leftover = html.match(/\{\{[^}]*\}\}/);
    if (leftover) throw new Error(`模板里有没替换的占位符 ${leftover[0]}`);
    fs.writeFileSync(path.join(out, 'index.html'), html);
    // Machine-readable latest version, e.g. for an in-app update check later.
    fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({ version, file: fileName, size, sha256: hash, url: directUrl, date: buildDate }, null, 2));
    return { out, version, fileName, size, sha256: hash, directUrl, copied: !external && copyExe && config.copyExeToSite !== false };
}

if (require.main === module) {
    buildSite({ copyExe: !process.argv.includes('--no-exe') }).then(result => {
        console.log(`Site: ${result.out}`);
        console.log(`  v${result.version}  ${result.fileName}  ${(result.size / 1024 / 1024).toFixed(1)} MB`);
        console.log(`  download: ${result.directUrl}${result.copied ? ' (EXE copied into the site)' : ''}`);
        console.log(`  sha256: ${result.sha256}`);
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { buildSite };
