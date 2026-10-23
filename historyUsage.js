// History usage counters and trash rules shared by main and the renderer.
// UMD: `require('./historyUsage')` in main, `window.PicGenHistoryUsage` in desktop.html.
// Pure functions only: no fs, no path, no DOM.
(function expose(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PicGenHistoryUsage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif)$/i;
    const MB = 1024 * 1024;
    const GB = 1024 * MB;
    const LARGE_BATCH = 100;

    function baseName(filePath) {
        return String(filePath || '').split(/[\\/]/).pop();
    }

    // lower(fileName)|fileSize. Contains no directory, so it survives folder and
    // portable-profile moves, index rebuilds and orphan re-discovery.
    function usageKey(record) {
        const name = String(record?.fileName || baseName(record?.filePath)).toLowerCase();
        return name ? `${name}|${Number(record?.fileSize) || 0}` : '';
    }

    // Case- and separator-insensitive path key (Windows semantics) for tombstones and in-flight sets.
    function pathKey(filePath) {
        return String(filePath || '').replace(/[\\/]+/g, '\\').toLowerCase();
    }

    function usageTotal(record) {
        return (Number(record?.dragCount) || 0) + (Number(record?.referenceCount) || 0);
    }

    function isProtected(record) {
        return usageTotal(record) > 0;
    }

    function contains(bounds, point) {
        return point.x >= bounds.x && point.x < bounds.x + bounds.width
            && point.y >= bounds.y && point.y < bounds.y + bounds.height;
    }

    // Where a native drag ended stands in for its (unknowable) drop target:
    // 'outside' every visible PicGen window counts as a drag-out to another app.
    function classifyDragEnd({ point, windows = [] } = {}) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return 'unknown';
        return (windows || []).some(entry => entry?.bounds && contains(entry.bounds, point)) ? 'inside' : 'outside';
    }

    // records: hydrated history records. tombstones: [{path, record, …}].
    // exists(path) → boolean (synchronous; resolve existence beforehand). inFlight: Set of pathKey().
    // - tombstone + file missing → the record is dropped (the tombstone stays until retention ends);
    // - tombstone + file present + not in history → revived from tombstone.record;
    // - tombstone + file present + already in history → the tombstone is cleared;
    // - a path still being trashed is never dropped or revived.
    function applyTombstones(records, tombstones, exists, inFlight = new Set()) {
        const list = Array.isArray(records) ? records : [];
        const entries = Array.isArray(tombstones) ? tombstones : [];
        const flying = inFlight || new Set();
        const byPath = new Map(entries.map(entry => [pathKey(entry.path), entry]));
        const kept = [];
        const dropped = [];
        const revived = [];
        const cleared = [];
        const remaining = [];
        const known = new Set();

        for (const record of list) {
            const key = pathKey(record.filePath);
            if (byPath.has(key) && !flying.has(key) && !exists(record.filePath)) {
                dropped.push(record);
                continue;
            }
            kept.push(record);
            known.add(key);
        }
        for (const entry of entries) {
            const key = pathKey(entry.path);
            if (flying.has(key) || !exists(entry.path)) {
                remaining.push(entry);
                continue;
            }
            if (!known.has(key)) {
                const record = { ...(entry.record || {}), filePath: entry.path };
                kept.push(record);
                revived.push(record);
                known.add(key);
            }
            cleared.push(entry);
        }
        const changed = dropped.length > 0 || revived.length > 0;
        if (revived.length) kept.sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
        return { records: kept, dropped, revived, cleared, tombstones: remaining, changed };
    }

    function formatBytes(bytes) {
        const value = Number(bytes);
        if (!(value > 0)) return '';
        if (value < MB) return `${Math.max(1, Math.round(value / 1024))} KB`;
        if (value < GB) return `${(value / MB).toFixed(1)} MB`;
        return `${(value / GB).toFixed(2)} GB`;
    }

    // One line per fact; the first line is the action and what is kept.
    function buildTrashConfirmText({
        count = 0,
        bytes = 0,
        keptProtected = 0,
        includedProtected = 0,
        large
    } = {}) {
        const total = Math.max(0, Number(count) || 0);
        const size = formatBytes(bytes);
        let first = `将 ${total} 张图片${size ? `（共 ${size}）` : ''}移到回收站。`;
        if (Number(keptProtected) > 0) first += `保留：拖用过的 ${Number(keptProtected)} 张。`;
        const lines = [first];
        if (Number(includedProtected) > 0) lines.push(`其中 ${Number(includedProtected)} 张拖用过（可能正被用作 AI 参考图）`);
        if (large === undefined ? total > LARGE_BATCH : Boolean(large)) lines.push('数量较多，请确认筛选条件');
        return lines.join('\n');
    }

    function pad2(value) {
        return String(value).padStart(2, '0');
    }

    function formatUsedAt(time, now) {
        const date = new Date(time);
        const current = new Date(now instanceof Date ? now.getTime() : Number(now ?? Date.now()));
        const year = date.getFullYear() !== current.getFullYear() ? `${date.getFullYear()}年` : '';
        return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    // Badge tooltip. '' for an image that has never been used. dragCount counts every way an image
    // left PicGen: native drag-out, 复制图片 and 另存为.
    function formatUsageTooltip(usage, now = Date.now()) {
        const drags = Number(usage?.dragCount) || 0;
        const references = Number(usage?.referenceCount) || 0;
        if (drags + references <= 0) return '';
        const counts = [];
        if (drags > 0) counts.push(`拖出/复制/另存 ${drags} 次`);
        if (references > 0) counts.push(`用作参考图 ${references} 次`);
        const lines = [counts.join(' · ')];
        const lastUsedAt = Number(usage?.lastUsedAt) || 0;
        if (lastUsedAt > 0) lines.push(`最近使用：${formatUsedAt(lastUsedAt, now)}`);
        lines.push('批量删除时默认保留');
        return lines.join('\n');
    }

    function isTrashableImageName(filePath) {
        return IMAGE_NAME.test(baseName(filePath));
    }

    return {
        usageKey,
        usageTotal,
        isProtected,
        classifyDragEnd,
        applyTombstones,
        buildTrashConfirmText,
        formatUsageTooltip,
        pathKey,
        isTrashableImageName
    };
});
