const test = require('node:test');
const assert = require('node:assert/strict');
const projection = require('../similarProjection');

// Synthetic fixtures only. Keys follow userExperience.historyKey: id first.
function record(id, createdAt, extra = {}) {
    return { id, filePath: `C:/fixtures/${id}.png`, fileName: `${id}.png`, createdAt, prompt: `prompt ${id}`, ...extra };
}

function group(id, members, extra = {}) {
    return { id, members, pinned: null, latestAt: 0, promptVariants: 1, ratios: ['1:1'], provisional: false, parts: null, rest: [], failed: [], ...extra };
}

function snapshotOf(groups, singles = [], extra = {}) {
    return { version: 3, revision: 1, mode: 'hd', stage: 'final', preset: 'standard', groups, singles, missing: 0, total: 0, ...extra };
}

const byId = images => new Map(images.map(image => [image.id, image]));

test('exports the plan API and attaches the browser global', () => {
    for (const name of ['project', 'coverOf', 'keyedDiff', 'remapOpen']) assert.equal(typeof projection[name], 'function', name);
    assert.equal(globalThis.PicGenSimilarProjection, projection);
});

test('a group with fewer than 2 visible members releases them to singles', () => {
    const images = [record('a', 50), record('b', 40), record('c', 30), record('d', 20), record('e', 10)];
    const snapshot = snapshotOf([group('g1', ['a', 'b', 'c']), group('g2', ['d', 'e'])]);
    const all = projection.project(snapshot, images, { recordsByKey: byId(images) });
    assert.deepEqual(all.groups.map(g => g.id), ['g1', 'g2']);
    assert.deepEqual(all.singles, []);
    assert.equal(all.missing, 0);

    // A filter hides `e`: g2 keeps one visible member and dissolves into singles; g1 keeps 2 of 3.
    const visible = images.filter(image => image.id !== 'e' && image.id !== 'c');
    const filtered = projection.project(snapshot, visible, { recordsByKey: byId(images) });
    assert.deepEqual(filtered.groups.map(g => g.id), ['g1']);
    assert.deepEqual(filtered.groups[0].members.map(m => m.id), ['a', 'b']);
    assert.deepEqual(filtered.groups[0].allKeys, ['a', 'b', 'c']);
    assert.equal(filtered.groups[0].hiddenCount, 1);
    assert.deepEqual(filtered.singles.map(m => m.id), ['d']);
});

test('singles keep the filtered order and every visible image is grouped, single or missing', () => {
    const images = [record('a', 50), record('b', 40), record('x', 35), record('s', 30), record('gone', 20)];
    // `gone` is in history but not in the snapshot (its file is missing), `x` is a snapshot single.
    const snapshot = snapshotOf([group('g1', ['a', 'b'])], ['s', 'x']);
    const result = projection.project(snapshot, images, { recordsByKey: byId(images) });
    assert.deepEqual(result.singles.map(m => m.id), ['x', 's'], 'singles follow the filtered (history sort) order');
    assert.equal(result.missing, 1);
    const grouped = result.groups.reduce((sum, g) => sum + g.members.length, 0);
    assert.equal(grouped + result.singles.length + result.missing, images.length);
    assert.equal(result.grouped, grouped);
});

test('members stay newest first and groups sort by visible recency or by size', () => {
    const images = [record('n1', 100), record('n2', 90), record('m1', 80), record('m2', 70), record('m3', 60), record('o1', 50), record('o2', 40)];
    const snapshot = snapshotOf([
        group('small-new', ['n1', 'n2']),
        group('big-mid', ['m1', 'm2', 'm3']),
        group('small-old', ['o1', 'o2'])
    ]);
    const recent = projection.project(snapshot, images, { sort: 'recent', recordsByKey: byId(images) });
    assert.deepEqual(recent.groups.map(g => g.id), ['small-new', 'big-mid', 'small-old']);
    assert.deepEqual(recent.groups[1].members.map(m => m.id), ['m1', 'm2', 'm3']);
    assert.equal(recent.groups[0].latestAt, 100);

    const size = projection.project(snapshot, images, { sort: 'size', recordsByKey: byId(images) });
    assert.deepEqual(size.groups.map(g => g.id), ['big-mid', 'small-new', 'small-old'], 'size first, then recency');

    // latestAt comes from the visible members only.
    const hidden = images.filter(image => image.id !== 'n1');
    assert.equal(projection.project(snapshot, hidden, { recordsByKey: byId(images) }).groups.find(g => g.id === 'small-new'), undefined);
    const filteredRecent = projection.project(snapshot, images.filter(image => image.id !== 'm1'), { recordsByKey: byId(images) });
    assert.equal(filteredRecent.groups.find(g => g.id === 'big-mid').latestAt, 70);
});

test('coverOf: pinned, then highest usage (ties newest), then newest, over all members', () => {
    const images = [record('a', 50), record('b', 40, { dragCount: 1 }), record('c', 30, { referenceCount: 2 }), record('d', 20, { dragCount: 1, referenceCount: 1 })];
    const records = byId(images);
    assert.equal(projection.coverOf(group('g', ['a', 'b', 'c', 'd']), records), 'c', 'usage 2 beats 1; c is newer than d');
    assert.equal(projection.coverOf(group('g', ['a', 'b', 'c', 'd'], { pinned: 'd' }), records), 'd', 'pinned wins');
    assert.equal(projection.coverOf(group('g', ['a', 'b', 'c'], { pinned: 'zz' }), records), 'c', 'a pin outside the group is ignored');
    assert.equal(projection.coverOf(group('g', ['b', 'a']), records), 'b');
    const unused = byId([record('p', 10), record('q', 30), record('r', 20)]);
    assert.equal(projection.coverOf(group('g', ['q', 'r', 'p']), unused), 'q', 'no usage: the newest member');
    const tied = byId([record('p', 10, { dragCount: 1 }), record('q', 30, { referenceCount: 1 }), record('r', 20, { dragCount: 1 })]);
    assert.equal(projection.coverOf(group('g', ['p', 'r', 'q']), tied), 'q', 'usage tie goes to the newest, whatever the order');

    // The cover may be filtered out; the projection still reports it and says it is hidden.
    const snapshot = snapshotOf([group('g', ['a', 'b', 'c', 'd'])]);
    const visible = images.filter(image => image.id !== 'c');
    const [projected] = projection.project(snapshot, visible, { recordsByKey: records }).groups;
    assert.equal(projected.cover, 'c');
    assert.equal(projected.coverVisible, false);
    assert.equal(projected.usedCount, 3, 'usage counts every member, visible or not');
    const [shown] = projection.project(snapshot, images, { recordsByKey: records }).groups;
    assert.equal(shown.coverVisible, true);
});

test('subgroup parts are filtered to visible members; small parts fall into rest', () => {
    const images = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => record(id, 100 - i));
    const parts = [['a', 'b', 'c'], ['d', 'e']];
    const snapshot = snapshotOf([group('g', ['a', 'b', 'c', 'd', 'e', 'f'], { parts, rest: ['f'] })]);
    const [full] = projection.project(snapshot, images, { recordsByKey: byId(images) }).groups;
    assert.deepEqual(full.parts.map(part => part.map(m => m.id)), [['a', 'b', 'c'], ['d', 'e']]);
    assert.deepEqual(full.rest.map(m => m.id), ['f']);

    // Hiding `e` leaves only one part with 2+ members, so the group goes flat.
    const [flat] = projection.project(snapshot, images.filter(image => image.id !== 'e'), { recordsByKey: byId(images) }).groups;
    assert.equal(flat.parts, null);
    assert.deepEqual(flat.rest, []);
    assert.deepEqual(flat.members.map(m => m.id), ['a', 'b', 'c', 'd', 'f']);

    const snapshot3 = snapshotOf([group('g', ['a', 'b', 'c', 'd', 'e', 'f'], { parts: [['a', 'b'], ['c', 'd'], ['e', 'f']], rest: [] })]);
    const [three] = projection.project(snapshot3, images.filter(image => image.id !== 'f'), { recordsByKey: byId(images) }).groups;
    assert.deepEqual(three.parts.map(part => part.map(m => m.id)), [['a', 'b'], ['c', 'd']]);
    assert.deepEqual(three.rest.map(m => m.id), ['e'], 'a part left with one visible member joins rest');
});

test('project copies snapshot group fields and never mutates its inputs', () => {
    const images = [record('a', 20, { ratio: '16:9' }), record('b', 10)];
    const source = group('g', ['a', 'b'], { provisional: true, promptVariants: 2, ratios: ['16:9', '1:1'], failed: ['b'] });
    const snapshot = snapshotOf([source], []);
    const frozen = JSON.stringify(snapshot);
    const [projected] = projection.project(snapshot, images, { recordsByKey: byId(images) }).groups;
    assert.equal(projected.provisional, true);
    assert.equal(projected.promptVariants, 2);
    assert.deepEqual(projected.ratios, ['16:9', '1:1']);
    assert.deepEqual(projected.failed, ['b']);
    assert.equal(projected.pinned, null);
    assert.equal(JSON.stringify(snapshot), frozen);
    // Without recordsByKey the visible records are the only source; a custom keyOf is honoured.
    const byPath = projection.project(snapshotOf([group('g', ['C:/fixtures/a.png', 'C:/fixtures/b.png'])]), images, { keyOf: image => image.filePath });
    assert.deepEqual(byPath.groups[0].members.map(m => m.id), ['a', 'b']);
    assert.deepEqual(projection.project(null, images), { groups: [], singles: [], missing: 2, grouped: 0 });
});

test('keyedDiff never reorders existing rows', () => {
    const prev = ['g1', 'g2', 'g3', 'g4'];
    // The next projection sorts g4 first and drops g2; g5 is new and belongs between g4 and g1.
    const next = ['g4', 'g5', 'g1', 'g3'].map(id => ({ id }));
    const diff = projection.keyedDiff(prev, next);
    assert.deepEqual(diff.remove, ['g2']);
    assert.deepEqual(diff.patch, ['g1', 'g3', 'g4'], 'existing rows keep their previous relative order');
    assert.deepEqual(diff.insert, [{ id: 'g5', before: 'g1' }]);
    assert.deepEqual(diff.deferred, []);
    assert.deepEqual(diff.order, ['g5', 'g1', 'g3', 'g4']);

    const deferred = projection.keyedDiff(prev, [...next, { id: 'g6' }], { deferNew: true });
    assert.deepEqual(deferred.insert, []);
    assert.deepEqual(deferred.deferred, ['g5', 'g6']);
    assert.deepEqual(deferred.order, ['g1', 'g3', 'g4']);

    const appended = projection.keyedDiff(['a'], [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    assert.deepEqual(appended.insert, [{ id: 'b', before: null }, { id: 'c', before: null }]);
    assert.deepEqual(appended.order, ['a', 'b', 'c']);
    assert.deepEqual(projection.keyedDiff([], ['x', 'y']).order, ['x', 'y'], 'plain ids are accepted');
});

test('remapOpen follows the largest member overlap', () => {
    const prev = [{ id: 'g1', allKeys: ['a', 'b', 'c', 'd'] }, { id: 'g2', allKeys: ['e', 'f'] }, { id: 'g3', allKeys: ['x', 'y'] }];
    // g1 split into n1 (a) and n2 (b, c, d); g2 kept its id; g3 vanished entirely.
    const next = [{ id: 'n1', allKeys: ['a', 'q'] }, { id: 'n2', allKeys: ['b', 'c', 'd'] }, { id: 'g2', allKeys: ['e', 'f', 'g'] }];
    const map = projection.remapOpen(['g1', 'g2', 'g3'], prev, next);
    assert.equal(map.get('g1'), 'n2');
    assert.equal(map.get('g2'), 'g2');
    assert.equal(map.has('g3'), false);
    // Ties go to the earlier group in the next order. Snapshot groups (member keys) work too.
    const tie = projection.remapOpen(['g'], [{ id: 'g', members: ['a', 'b'] }], [{ id: 'p', members: ['b'] }, { id: 'o', members: ['a'] }]);
    assert.equal(tie.get('g'), 'p');
    assert.equal(projection.remapOpen(new Set(['g']), [{ id: 'g', members: ['a'] }], [{ id: 'h', members: ['a'] }]).get('g'), 'h', 'a Set of ids works');
});

// --- the cover under a filter ------------------------------------------------------------------------
test('the most used member is the cover, and a pinned cover hidden by a filter stays the cover', () => {
    const images = [record('a', 60), record('b', 50, { dragCount: 1 }), record('c', 40), record('d', 30, { referenceCount: 2 })];
    const [used] = projection.project(snapshotOf([group('g', ['a', 'b', 'c', 'd'])]), images, { recordsByKey: byId(images) }).groups;
    assert.equal(used.cover, 'd');
    const plain = [record('a', 60), record('b', 50), record('c', 40), record('d', 30)];
    const visible = plain.filter(image => image.id !== 'b');
    const [hidden] = projection.project(snapshotOf([group('g', ['a', 'b', 'c', 'd'], { pinned: 'b' })]), visible, { recordsByKey: byId(plain) }).groups;
    assert.equal(hidden.cover, 'b', 'the pinned cover stays the cover while hidden');
    assert.equal(hidden.hiddenCount, 1);
});
