'use strict';

// 尺寸参照物素材目录（assets/size-anchors）。不依赖 sharp，主进程可以直接读。

const fs = require('node:fs');
const path = require('node:path');

const ANCHOR_DIR = path.join(__dirname, 'assets', 'size-anchors');

let catalogCache = null;

function loadAnchorCatalog() {
    if (catalogCache) return catalogCache;
    const manifest = JSON.parse(fs.readFileSync(path.join(ANCHOR_DIR, 'anchors.json'), 'utf8'));
    catalogCache = manifest.anchors.map(anchor => ({
        ...anchor,
        svg: fs.readFileSync(path.join(ANCHOR_DIR, anchor.file), 'utf8')
    }));
    return catalogCache;
}

// 给渲染进程的目录：不带 SVG 正文
function publicAnchor(anchor) {
    const { svg, ...rest } = anchor;
    return rest;
}

function listAnchors() {
    return loadAnchorCatalog().map(publicAnchor);
}

module.exports = { ANCHOR_DIR, loadAnchorCatalog, listAnchors, publicAnchor };
