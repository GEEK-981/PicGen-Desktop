// Renderer projection of a v3.1 similarity snapshot (plan §2.1, §2.14; WP11).
// UMD: `require('./similarProjection')` in tests, `window.PicGenSimilarProjection` in desktop.html.
// Pure functions only: no DOM, no IPC. Filters are applied after grouping, so typing in a filter only
// re-runs project() over the cached snapshot.
(function expose(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PicGenSimilarProjection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    // Same definition as userExperience.historyKey (the snapshot's member keys).
    function historyKey(record) {
        return String(record?.id || record?.filePath || record?.fileName || '');
    }

    // historyUsage.usageTotal; inlined so the module has no load-order dependency.
    function usageTotal(record) {
        return (Number(record?.dragCount) || 0) + (Number(record?.referenceCount) || 0);
    }

    function timeOf(record) {
        return Number(record?.createdAt) || 0;
    }

    function lookup(records, key) {
        if (!records) return undefined;
        return typeof records.get === 'function' ? records.get(key) : records[key];
    }

    function keysOf(group) {
        const keys = Array.isArray(group?.allKeys) ? group.allKeys : (Array.isArray(group?.members) ? group.members : []);
        return keys.map(key => (typeof key === 'string' ? key : historyKey(key)));
    }

    // §2.1 cover over *all* members, visible or filtered out:
    // the pinned member → the highest usageTotal (ties go to the newest) → the newest member.
    function coverOf(group, recordsByKey) {
        const members = keysOf(group);
        if (!members.length) return null;
        if (group?.pinned && members.includes(group.pinned)) return group.pinned;
        let best = members[0];
        let bestUsage = usageTotal(lookup(recordsByKey, best));
        let bestTime = timeOf(lookup(recordsByKey, best));
        for (let i = 1; i < members.length; i++) {
            const record = lookup(recordsByKey, members[i]);
            const usage = usageTotal(record);
            const time = timeOf(record);
            if (usage > bestUsage || (usage === bestUsage && time > bestTime)) {
                best = members[i];
                bestUsage = usage;
                bestTime = time;
            }
        }
        return best;
    }

    // project(snapshot, filteredImages, {sort, keyOf, recordsByKey})
    //   groups: multi-image groups with at least 2 visible members, in display order;
    //   singles: visible records outside those groups, in the filtered (history sort) order;
    //   missing: visible records the snapshot does not know (missing files, not yet synced).
    function project(snapshot, filteredImages, options = {}) {
        const keyOf = typeof options.keyOf === 'function' ? options.keyOf : historyKey;
        const sort = options.sort === 'size' ? 'size' : 'recent';
        const images = Array.isArray(filteredImages) ? filteredImages : [];
        const visible = new Map();
        for (const image of images) {
            const key = keyOf(image);
            if (key && !visible.has(key)) visible.set(key, image);
        }
        const records = options.recordsByKey || visible;
        const known = new Set();
        const taken = new Set();
        const groups = [];
        const sourceGroups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
        sourceGroups.forEach((source, order) => {
            const allKeys = [];
            for (const key of keysOf(source)) {
                if (known.has(key)) continue;
                known.add(key);
                allKeys.push(key);
            }
            const members = allKeys.filter(key => visible.has(key)).map(key => visible.get(key));
            if (members.length < 2) return;
            for (const member of members) taken.add(keyOf(member));
            let latestAt = 0;
            for (const member of members) latestAt = Math.max(latestAt, timeOf(member));
            let usedCount = 0;
            for (const key of allKeys) if (usageTotal(lookup(records, key) || visible.get(key)) > 0) usedCount++;
            const cover = coverOf({ members: allKeys, pinned: source.pinned }, {
                get: key => lookup(records, key) || visible.get(key)
            });
            groups.push({
                id: String(source.id),
                members,
                allKeys,
                hiddenCount: allKeys.length - members.length,
                cover,
                coverVisible: visible.has(cover),
                pinned: source.pinned || null,
                latestAt,
                promptVariants: Number(source.promptVariants) || 0,
                ratios: Array.isArray(source.ratios) ? source.ratios.slice() : [],
                provisional: Boolean(source.provisional),
                failed: Array.isArray(source.failed) ? source.failed.slice() : [],
                usedCount,
                order,
                ...projectParts(source, members, keyOf)
            });
        });
        for (const key of Array.isArray(snapshot?.singles) ? snapshot.singles : []) known.add(String(key));
        groups.sort(sort === 'size'
            ? (a, b) => b.members.length - a.members.length || b.latestAt - a.latestAt || a.order - b.order
            : (a, b) => b.latestAt - a.latestAt || a.order - b.order);
        for (const entry of groups) delete entry.order;
        const singles = [];
        let missing = 0;
        let grouped = 0;
        for (const [key, image] of visible) {
            if (taken.has(key)) grouped++;
            else if (known.has(key)) singles.push(image);
            else missing++;
        }
        return { groups, singles, missing, grouped };
    }

    // Subgroups (§2.1) survive a filter only while at least 2 parts keep at least 2 visible members;
    // a part left with one visible member joins "其余". Otherwise the group goes flat.
    function projectParts(source, members, keyOf) {
        if (!Array.isArray(source.parts) || !source.parts.length) return { parts: null, rest: [] };
        const byKey = new Map(members.map(member => [keyOf(member), member]));
        const placed = new Set();
        const parts = [];
        const loose = new Set();
        for (const part of source.parts) {
            const shown = (Array.isArray(part) ? part : []).filter(key => byKey.has(key) && !placed.has(key));
            shown.forEach(key => placed.add(key));
            if (shown.length >= 2) parts.push(shown);
            else shown.forEach(key => loose.add(key));
        }
        if (parts.length < 2) return { parts: null, rest: [] };
        for (const key of Array.isArray(source.rest) ? source.rest : []) if (byKey.has(key)) loose.add(key);
        for (const key of byKey.keys()) if (!placed.has(key)) loose.add(key);
        return {
            parts: parts.map(part => part.map(key => byKey.get(key))),
            rest: members.filter(member => loose.has(keyOf(member)))
        };
    }

    // keyedDiff(prevIds, nextGroups, {deferNew}) → {patch, insert, remove, deferred, order}
    // Existing rows are never reordered: `order` keeps the previous relative order of every surviving
    // id and places each new id just before the next surviving row that follows it in nextGroups
    // (`before`, or null for the end). With deferNew, new ids are held back in `deferred` instead.
    function keyedDiff(prevIds, nextGroups, options = {}) {
        const prev = Array.from(prevIds || [], String);
        const next = Array.from(nextGroups || [], entry => String(typeof entry === 'string' ? entry : entry?.id));
        const nextSet = new Set(next);
        const prevSet = new Set(prev);
        const remove = prev.filter(id => !nextSet.has(id));
        const patch = prev.filter(id => nextSet.has(id));
        const insert = [];
        const deferred = [];
        let following = null;
        for (let i = next.length - 1; i >= 0; i--) {
            const id = next[i];
            if (prevSet.has(id)) following = id;
            else if (options.deferNew) deferred.unshift(id);
            else insert.unshift({ id, before: following });
        }
        const order = patch.slice();
        const tail = [];
        for (const entry of insert) {
            if (entry.before === null) {
                tail.push(entry.id);
                continue;
            }
            order.splice(order.indexOf(entry.before), 0, entry.id);
        }
        order.push(...tail);
        return { patch, insert, remove, deferred, order };
    }

    // remapOpen(openIds, prevGroups, nextGroups) → Map<oldId, newId>
    // An open id that survives maps to itself; a lost one maps to the next group with the largest
    // member overlap (ties go to the earlier group in nextGroups). No overlap → no entry.
    function remapOpen(openIds, prevGroups, nextGroups) {
        const map = new Map();
        const nextList = Array.from(nextGroups || []);
        const nextIds = new Set(nextList.map(entry => String(entry.id)));
        const prevById = new Map(Array.from(prevGroups || [], entry => [String(entry.id), entry]));
        const nextKeys = nextList.map(entry => new Set(keysOf(entry)));
        for (const raw of openIds || []) {
            const id = String(raw);
            if (nextIds.has(id)) {
                map.set(id, id);
                continue;
            }
            const before = prevById.get(id);
            if (!before) continue;
            const keys = keysOf(before);
            let best = -1;
            let bestOverlap = 0;
            nextKeys.forEach((set, index) => {
                let overlap = 0;
                for (const key of keys) if (set.has(key)) overlap++;
                if (overlap > bestOverlap) {
                    best = index;
                    bestOverlap = overlap;
                }
            });
            if (best >= 0) map.set(id, String(nextList[best].id));
        }
        return map;
    }

    return { project, coverOf, keyedDiff, remapOpen, historyKey, usageTotal };
});
