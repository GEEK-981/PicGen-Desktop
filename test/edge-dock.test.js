const test = require('node:test');
const assert = require('node:assert/strict');
const { EdgeDock, fitBounds, nearestEdge } = require('../edgeDock');

function fixture(area = { x: 0, y: 0, width: 1920, height: 1040 }) {
    let bounds = { x: area.x + 8, y: area.y + 100, width: 460, height: 800 };
    let pointer = { x: area.x + 1000, y: area.y + 500 };
    let expanded = true, busy = false;
    const changes = [];
    const dock = new EdgeDock({ bounds: () => bounds, area: () => area, expanded: () => expanded,
        expandedBounds: b => ({ ...b, width: 460, height: 800 }), pointer: () => pointer, busy: () => busy,
        place: (next, state) => { bounds = next; expanded = state.expanded; }, changed: state => changes.push(state) });
    return { dock, changes, get bounds() { return bounds; }, set bounds(b) { bounds = b; },
        set pointer(p) { pointer = p; }, set busy(value) { busy = value; } };
}

test('snap and delayed auto-hide preserve full size; hover reveal has its own intent threshold', () => {
    const h = fixture(); h.dock.settle();
    assert.equal(h.bounds.x, 0); assert.equal(h.dock.edge, 'left');
    h.dock.tick(0); h.dock.tick(699); assert.equal(h.dock.hidden, false);
    h.dock.tick(700); assert.equal(h.dock.hidden, true); assert.equal(h.bounds.width, 12);
    h.pointer = { x: 5, y: h.bounds.y + 5 };
    h.dock.tick(800); h.dock.tick(919); assert.equal(h.dock.hidden, true);
    h.dock.tick(920); assert.equal(h.dock.hidden, false);
    assert.deepEqual(h.bounds, { x: 0, y: 100, width: 460, height: 800 });
});

test('editing, pinning, returning pointer and dragging interrupt auto-hide', () => {
    const h = fixture(); h.dock.settle(); h.dock.tick(0);
    h.busy = true; h.dock.tick(800); assert.equal(h.dock.hidden, false);
    h.busy = false; h.dock.tick(1000); h.pointer = { x: 100, y: 200 }; h.dock.tick(1500);
    h.pointer = { x: 1000, y: 200 }; h.dock.tick(2000); h.dock.tick(2500);
    assert.equal(h.dock.hidden, false);
    h.dock.pin(true); h.dock.tick(9999); assert.equal(h.dock.hidden, false);
    h.dock.pin(false); h.dock.beginMove(); h.bounds = { x: 250, y: 100, width: 460, height: 800 };
    h.dock.settle(); h.dock.tick(20000); assert.equal(h.dock.edge, null);
});

test('right side docking handles negative display coordinates, small work areas, and monitor removal', () => {
    const area = { x: -1280, y: -200, width: 1280, height: 720 };
    const h = fixture(area); h.bounds = { x: -465, y: -100, width: 460, height: 600 };
    h.dock.settle(); assert.equal(h.dock.edge, 'right');
    h.dock.hide(); assert.equal(h.bounds.x, -12);
    assert.ok(h.bounds.y + h.bounds.height <= 520);
    area.x = 0; area.y = 0; area.width = 800; area.height = 600;
    h.dock.reflow(); assert.equal(h.dock.hidden, true); assert.equal(h.bounds.x, 788);
    h.dock.reveal(); assert.deepEqual(h.bounds, { x: 340, y: 0, width: 460, height: 600 });
    assert.equal(nearestEdge({ x: 100, width: 460 }, area), null);
    assert.deepEqual(fitBounds({ x: -200, y: 900, width: 1000, height: 800 }, area), { x: 0, y: 0, width: 800, height: 600 });
});
