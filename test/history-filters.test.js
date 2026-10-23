const test = require('node:test');
const assert = require('node:assert/strict');

const filters = require('../historyFilters');

const DAY = 24 * 60 * 60 * 1000;
// 2026-10-01 15:00 local time.
const NOW = new Date(2026, 9, 1, 15, 0, 0).getTime();
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();

test('models group by vendor, anchored on the name so gpt-image-mini is not Gemini', () => {
    const cases = {
        'gemini-3.1-flash-image': 'gemini',
        'gemini-3-pro-image-preview': 'gemini',
        'nano-banana-2': 'gemini',
        'nano-banana-pro': 'gemini',
        'google/gemini-3-flash-image': 'gemini',
        'models/imagen-4': 'gemini',
        'gpt-image-2': 'gpt',
        'gpt-image-2.5-sunburst': 'gpt',
        'GPT_Image_Mini': 'gpt',
        'gpt-image-mini': 'gpt',
        'openai/gpt-image-1': 'gpt',
        'dall-e-3': 'gpt',
        'grok-imagine-image': 'grok',
        'xai/grok-2-image': 'grok',
        'doubao-seedream-5-0-pro-260628': 'seedream',
        'seedream-4.0': 'seedream',
        'seedance-1': 'seedream',
        'flux-pro': 'other',
        '': 'other',
        undefined: 'other'
    };
    for (const [model, vendor] of Object.entries(cases)) {
        assert.equal(filters.modelVendor(model === 'undefined' ? undefined : model), vendor, model);
    }
    assert.deepEqual(filters.VENDORS.map(item => item.id), ['gemini', 'gpt', 'grok', 'seedream', 'other']);
});

test('vendorCounts lists only vendors present, in the fixed order, with counts', () => {
    const images = [{ model: 'gpt-image-2' }, { model: 'nano-banana-2' }, { model: 'gemini-3.1-flash-image' }, { model: '' }];
    assert.deepEqual(filters.vendorCounts(images).map(({ id, count }) => [id, count]), [['gemini', 2], ['gpt', 1], ['other', 1]]);
});

test('date presets and a custom range are local whole days, both ends included', () => {
    assert.deepEqual(filters.dateBounds({ preset: '' }, NOW), null);
    const today = filters.dateBounds({ preset: 'today' }, NOW);
    assert.equal(today.from, new Date(2026, 9, 1).getTime());
    assert.equal(today.to, null);
    const week = filters.dateBounds({ preset: '7d' }, NOW);
    assert.equal(week.from, new Date(2026, 8, 25).getTime(), '7 天 = today and the 6 days before');
    const month = filters.dateBounds({ preset: '30d' }, NOW);
    assert.equal(month.from, new Date(2026, 8, 2).getTime());
    const custom = filters.dateBounds({ preset: 'custom', from: '2026-09-15', to: '2026-09-20' }, NOW);
    assert.equal(custom.from, new Date(2026, 8, 15).getTime());
    assert.equal(custom.to, new Date(2026, 8, 21).getTime(), 'exclusive end = the day after');
    const reversed = filters.dateBounds({ preset: 'custom', from: '2026-09-20', to: '2026-09-15' }, NOW);
    assert.deepEqual(reversed, custom, 'a reversed range is swapped');
    const open = filters.dateBounds({ preset: 'custom', from: '2026-09-15' }, NOW);
    assert.equal(open.to, new Date(2026, 8, 16).getTime(), 'a single picked day is that day');
    assert.equal(filters.dateBounds({ preset: 'custom' }, NOW), null, 'nothing picked yet = no date filter');
});

test('matches combines vendors (any of), date and usage', () => {
    const usage = image => image.used || 0;
    const image = { model: 'gpt-image-2', createdAt: at(2026, 9, 18), used: 0 };
    const match = (f) => filters.matches(image, filters.normalize(f), { now: NOW, usageTotal: usage });
    assert.equal(match({}), true);
    assert.equal(match({ vendors: ['gpt'] }), true);
    assert.equal(match({ vendors: ['gemini', 'gpt'] }), true);
    assert.equal(match({ vendors: ['gemini'] }), false);
    assert.equal(match({ date: { preset: 'custom', from: '2026-09-15', to: '2026-09-18' } }), true, 'the end day is included');
    assert.equal(match({ date: { preset: 'custom', from: '2026-09-19', to: '2026-09-30' } }), false);
    assert.equal(match({ date: { preset: '7d' } }), false);
    assert.equal(match({ usage: 'unused' }), true);
    assert.equal(match({ usage: 'used' }), false);
    assert.equal(filters.matches({ ...image, used: 2 }, filters.normalize({ usage: 'used' }), { now: NOW, usageTotal: usage }), true);
});

test('normalize drops unknown values so a stale saved filter can never hide everything silently', () => {
    assert.deepEqual(filters.normalize({ vendors: ['gpt', 'nope', 'gpt'], date: { preset: 'week' }, usage: 'maybe' }),
        { vendors: ['gpt'], date: { preset: '', from: '', to: '' }, usage: '' });
    assert.deepEqual(filters.normalize(null), filters.EMPTY);
    assert.equal(filters.activeCount(filters.EMPTY), 0);
    assert.equal(filters.activeCount(filters.normalize({ vendors: ['gpt', 'grok'], usage: 'unused' })), 2, 'vendors count once');
    assert.equal(filters.activeCount(filters.normalize({ date: { preset: 'custom' } })), 0, 'an empty custom range is not active');
});

test('chips describe what is applied, each with what removing it does', () => {
    const chips = filters.describe(filters.normalize({
        vendors: ['gemini', 'gpt'], date: { preset: 'custom', from: '2026-09-15', to: '2026-09-20' }, usage: 'unused'
    }));
    assert.deepEqual(chips.map(chip => chip.label), ['Gemini', 'GPT', '9/15 – 9/20', '未用过']);
    const removed = filters.remove(filters.normalize({ vendors: ['gemini', 'gpt'], usage: 'unused' }), chips[0]);
    assert.deepEqual(removed.vendors, ['gpt']);
    assert.equal(filters.remove(removed, chips[3]).usage, '');
    assert.deepEqual(filters.describe(filters.normalize({ date: { preset: '7d' } })).map(chip => chip.label), ['7 天内']);
    assert.deepEqual(filters.describe(filters.normalize({ date: { preset: 'custom', from: '2026-09-15', to: '2026-09-15' } })).map(chip => chip.label), ['9/15']);
});

test('sorts: newest, oldest, file name, most used (ties newest first)', () => {
    const usage = image => image.used || 0;
    const images = [
        { id: 'a', fileName: 'b.png', createdAt: 3, used: 1 },
        { id: 'b', fileName: 'a.png', createdAt: 1, used: 5 },
        { id: 'c', fileName: 'c.png', createdAt: 2, used: 1 }
    ];
    const order = sort => [...images].sort(filters.comparator(sort, { usageTotal: usage })).map(image => image.id);
    assert.deepEqual(order('newest'), ['a', 'c', 'b']);
    assert.deepEqual(order('oldest'), ['b', 'c', 'a']);
    assert.deepEqual(order('name'), ['b', 'a', 'c']);
    assert.deepEqual(order('used'), ['b', 'a', 'c']);
    assert.deepEqual(order('bogus'), order('newest'));
    assert.deepEqual(filters.SORTS.map(item => item.id), ['newest', 'oldest', 'name', 'used']);
});
