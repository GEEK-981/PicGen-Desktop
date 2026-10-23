const EDGE_SNAP_DISTANCE = 16;
const EDGE_TAB_WIDTH = 12;
const EDGE_TAB_HEIGHT = 72;

function fitBounds(bounds, area) {
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    return { width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) };
}

function nearestEdge(bounds, area) {
    const left = Math.abs(bounds.x - area.x);
    const right = Math.abs(bounds.x + bounds.width - area.x - area.width);
    if (Math.min(left, right) > EDGE_SNAP_DISTANCE) return null;
    return left <= right ? 'left' : 'right';
}

class EdgeDock {
    constructor(adapter) {
        this.adapter = adapter;
        this.edge = null;
        this.hidden = false;
        this.pinned = false;
        this.moving = false;
        this.outsideSince = null;
        this.insideSince = null;
    }
    state() { return { edge: this.edge, hidden: this.hidden, pinned: this.pinned }; }
    changed() { this.adapter.changed(this.state()); }
    resetTimer() { this.outsideSince = null; this.insideSince = null; }
    beginMove() {
        this.moving = true;
        this.edge = null;
        this.hidden = false;
        this.resetTimer();
        this.changed();
    }
    settle() {
        this.moving = false;
        const bounds = this.adapter.bounds();
        const area = this.adapter.area(bounds);
        this.edge = nearestEdge(bounds, area);
        if (this.edge) {
            this.revealBounds = fitBounds(this.adapter.expandedBounds(bounds), area);
            this.revealBounds.x = this.edge === 'left' ? area.x : area.x + area.width - this.revealBounds.width;
            const snapped = fitBounds(bounds, area);
            snapped.x = this.edge === 'left' ? area.x : area.x + area.width - snapped.width;
            this.adapter.place(snapped, { expanded: this.adapter.expanded(), hidden: false });
        }
        this.resetTimer();
        this.changed();
    }
    pin(pinned) {
        this.pinned = !!pinned;
        if (this.pinned && this.hidden) this.reveal();
        this.resetTimer();
        this.changed();
    }
    hide() {
        if (!this.edge || this.hidden || this.moving) return;
        const current = this.adapter.bounds();
        const area = this.adapter.area(current);
        this.revealBounds = fitBounds(this.adapter.expandedBounds(current), area);
        this.revealBounds.x = this.edge === 'left' ? area.x : area.x + area.width - this.revealBounds.width;
        const tab = fitBounds({ x: this.edge === 'left' ? area.x : area.x + area.width - EDGE_TAB_WIDTH,
            y: current.y + 16, width: EDGE_TAB_WIDTH, height: EDGE_TAB_HEIGHT }, area);
        this.hidden = true;
        this.adapter.place(tab, { expanded: false, hidden: true });
        this.resetTimer();
        this.changed();
    }
    reveal() {
        if (!this.edge || !this.hidden) return;
        const area = this.adapter.area(this.adapter.bounds());
        const next = fitBounds(this.revealBounds, area);
        next.x = this.edge === 'left' ? area.x : area.x + area.width - next.width;
        this.hidden = false;
        this.adapter.place(next, { expanded: true, hidden: false });
        this.resetTimer();
        this.changed();
    }
    reflow() {
        if (!this.edge) return;
        if (this.hidden) { this.reveal(); this.hide(); }
        else this.settle();
    }
    tick(now) {
        if (!this.edge || this.moving || this.pinned || (!this.hidden && this.adapter.busy())) { this.resetTimer(); return; }
        const p = this.adapter.pointer();
        const b = this.adapter.bounds();
        const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
        if (this.hidden) {
            if (!inside) { this.insideSince = null; return; }
            this.insideSince ??= now;
            if (now - this.insideSince >= 120) this.reveal();
        } else {
            if (inside) { this.outsideSince = null; return; }
            this.outsideSince ??= now;
            if (now - this.outsideSince >= 700) this.hide();
        }
    }
}

module.exports = { EdgeDock, fitBounds, nearestEdge };
