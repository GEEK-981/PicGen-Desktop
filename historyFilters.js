// History page filters: vendor, date and usage, plus the sort orders. The state is one plain object
// owned by desktop.js; the React filter panel only renders it and reports changes.
// UMD: `require('./historyFilters')` in tests, `window.PicGenHistoryFilters` in desktop.html.
// Pure functions only: no fs, no path, no DOM.
(function expose(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PicGenHistoryFilters = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const DAY = 24 * 60 * 60 * 1000;

    // Fixed display order. `icon` names a file in assets/model-icons/.
    const VENDORS = Object.freeze([
        Object.freeze({ id: 'gemini', label: 'Gemini', icon: 'gemini-color' }),
        Object.freeze({ id: 'gpt', label: 'GPT', icon: 'openai' }),
        Object.freeze({ id: 'grok', label: 'Grok', icon: 'grok' }),
        Object.freeze({ id: 'seedream', label: '豆包', icon: 'doubao-color', title: 'Seedream / Seedance' }),
        Object.freeze({ id: 'other', label: '其他', icon: '' })
    ]);
    const VENDOR_IDS = new Set(VENDORS.map(item => item.id));

    const DATE_PRESETS = Object.freeze([
        Object.freeze({ id: '', label: '全部' }),
        Object.freeze({ id: 'today', label: '今天' }),
        Object.freeze({ id: '7d', label: '7 天内' }),
        Object.freeze({ id: '30d', label: '30 天内' }),
        Object.freeze({ id: 'custom', label: '自定义' })
    ]);
    const DATE_IDS = new Set(DATE_PRESETS.map(item => item.id));

    const USAGES = Object.freeze([
        Object.freeze({ id: '', label: '全部' }),
        Object.freeze({ id: 'used', label: '用过的' }),
        Object.freeze({ id: 'unused', label: '未用过' })
    ]);
    const USAGE_IDS = new Set(USAGES.map(item => item.id));

    const SORTS = Object.freeze([
        Object.freeze({ id: 'newest', label: '最新' }),
        Object.freeze({ id: 'oldest', label: '最早' }),
        Object.freeze({ id: 'name', label: '文件名' }),
        Object.freeze({ id: 'used', label: '使用次数最多' })
    ]);
    const SORT_IDS = new Set(SORTS.map(item => item.id));

    const EMPTY = Object.freeze({ vendors: Object.freeze([]), date: Object.freeze({ preset: '', from: '', to: '' }), usage: '' });

    // Anchored on the start of the bare model name (vendor path stripped): a substring test would read
    // gpt-image-mini ("gptimagemini") as Gemini.
    function modelVendor(model) {
        const bare = String(model || '').split('/').pop().toLowerCase().replace(/[\s_.\-]+/g, '');
        if (/^(?:gemini|nanobanana|imagen)/.test(bare)) return 'gemini';
        if (/^(?:gpt|chatgpt|dalle|openai)/.test(bare)) return 'gpt';
        if (/^grok/.test(bare)) return 'grok';
        if (/^(?:doubao|seedream|seedance)/.test(bare)) return 'seedream';
        return 'other';
    }

    function vendorCounts(images) {
        const counts = new Map();
        for (const image of images || []) {
            const id = modelVendor(image?.model);
            counts.set(id, (counts.get(id) || 0) + 1);
        }
        return VENDORS.filter(item => counts.has(item.id)).map(item => ({ ...item, count: counts.get(item.id) }));
    }

    const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
    function dayText(value) {
        return typeof value === 'string' && DAY_TEXT.test(value) ? value : '';
    }

    function normalize(input) {
        const value = input && typeof input === 'object' ? input : {};
        const vendors = [...new Set(Array.isArray(value.vendors) ? value.vendors.filter(id => VENDOR_IDS.has(id)) : [])];
        const date = value.date && typeof value.date === 'object' ? value.date : {};
        const preset = DATE_IDS.has(date.preset) ? date.preset : '';
        return {
            vendors,
            date: { preset, from: preset === 'custom' ? dayText(date.from) : '', to: preset === 'custom' ? dayText(date.to) : '' },
            usage: USAGE_IDS.has(value.usage) ? value.usage : ''
        };
    }

    function localDay(text) {
        const [, y, m, d] = DAY_TEXT.exec(text);
        return new Date(Number(y), Number(m) - 1, Number(d)).getTime();
    }

    function startOfDay(time) {
        const day = new Date(time);
        day.setHours(0, 0, 0, 0);
        return day.getTime();
    }

    function addDays(time, days) {
        const day = new Date(time);
        day.setDate(day.getDate() + days);
        return day.getTime();
    }

    // → null (no date filter) | { from, to } in ms; `to` is exclusive (or null for "until now").
    function dateBounds(date, now = Date.now()) {
        const preset = date?.preset || '';
        if (!preset) return null;
        const today = startOfDay(now);
        if (preset === 'today') return { from: today, to: null };
        if (preset === '7d') return { from: addDays(today, -6), to: null };
        if (preset === '30d') return { from: addDays(today, -29), to: null };
        if (preset !== 'custom') return null;
        let from = dayText(date.from);
        let to = dayText(date.to) || from;
        if (!from) from = to;
        if (!from) return null;
        if (from > to) [from, to] = [to, from];
        return { from: localDay(from), to: addDays(localDay(to), 1) };
    }

    function dateActive(date) {
        return !!date?.preset && (date.preset !== 'custom' || !!(date.from || date.to));
    }

    function activeCount(filters) {
        return (filters.vendors.length ? 1 : 0) + (dateActive(filters.date) ? 1 : 0) + (filters.usage ? 1 : 0);
    }

    // `filters` must come from normalize(). `bounds` may be passed precomputed for a whole list.
    function matches(image, filters, { now = Date.now(), usageTotal = () => 0, bounds } = {}) {
        if (filters.vendors.length && !filters.vendors.includes(modelVendor(image?.model))) return false;
        const range = bounds === undefined ? dateBounds(filters.date, now) : bounds;
        if (range) {
            const created = Number(image?.createdAt || 0);
            if (created < range.from) return false;
            if (range.to !== null && created >= range.to) return false;
        }
        if (filters.usage) {
            const used = usageTotal(image) > 0;
            if (filters.usage === 'used' ? !used : used) return false;
        }
        return true;
    }

    function shortDay(text) {
        const [, , m, d] = DAY_TEXT.exec(text);
        return `${Number(m)}/${Number(d)}`;
    }

    // The chips shown while filters apply: { kind, value, label, title? } in display order.
    function describe(filters) {
        const chips = [];
        for (const id of VENDORS.map(item => item.id).filter(id => filters.vendors.includes(id))) {
            const vendor = VENDORS.find(item => item.id === id);
            chips.push({ kind: 'vendor', value: id, label: vendor.label, icon: vendor.icon, title: vendor.title || vendor.label });
        }
        if (dateActive(filters.date)) {
            let label = DATE_PRESETS.find(item => item.id === filters.date.preset).label;
            if (filters.date.preset === 'custom') {
                let from = filters.date.from || filters.date.to;
                let to = filters.date.to || from;
                if (from > to) [from, to] = [to, from];
                label = from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`;
            }
            chips.push({ kind: 'date', value: filters.date.preset, label });
        }
        if (filters.usage) chips.push({ kind: 'usage', value: filters.usage, label: USAGES.find(item => item.id === filters.usage).label });
        return chips;
    }

    function remove(filters, chip) {
        const next = normalize(filters);
        if (chip?.kind === 'vendor') next.vendors = next.vendors.filter(id => id !== chip.value);
        if (chip?.kind === 'date') next.date = { preset: '', from: '', to: '' };
        if (chip?.kind === 'usage') next.usage = '';
        return next;
    }

    function comparator(sort, { usageTotal = () => 0 } = {}) {
        const newest = (left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0);
        if (sort === 'oldest') return (left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0);
        if (sort === 'name') return (left, right) => String(left.fileName || '').localeCompare(String(right.fileName || ''), 'zh-CN');
        if (sort === 'used') return (left, right) => (usageTotal(right) - usageTotal(left)) || newest(left, right);
        return newest;
    }

    function normalizeSort(sort) {
        return SORT_IDS.has(sort) ? sort : 'newest';
    }

    return {
        DAY,
        VENDORS,
        DATE_PRESETS,
        USAGES,
        SORTS,
        EMPTY,
        modelVendor,
        vendorCounts,
        normalize,
        normalizeSort,
        dateBounds,
        activeCount,
        matches,
        describe,
        remove,
        comparator
    };
});
