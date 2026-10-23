'use strict';

/**
 * Compatibility entry point for callers that used the role-specific store
 * before image and chat providers moved into the unified provider store.
 *
 * The implementation stays in UnifiedProviderStore#createRoleStore so reads,
 * writes, ordering, and secret handling all use the same canonical data.
 */
class ProviderRoleStore {
    constructor(unifiedStore, role = 'image') {
        if (!unifiedStore || typeof unifiedStore.createRoleStore !== 'function') {
            throw new TypeError('ProviderRoleStore requires a UnifiedProviderStore');
        }
        this.role = role === 'chat' ? 'chat' : 'image';
        this.store = unifiedStore;
        this.delegate = unifiedStore.createRoleStore(this.role);
    }

    load() { return this.delegate.load(); }
    list() { return this.delegate.list(); }
    get(id) { return this.delegate.get(id); }
    create(input) { return this.delegate.create(input); }
    update(id, input) { return this.delegate.update(id, input); }
    delete(id) { return this.delegate.delete(id); }
    reorder(ids) { return this.delegate.reorder(ids); }
    replace(list) { return this.delegate.replace(list); }
    updateCapabilities(id, capabilities, discoveredModels) {
        return this.delegate.updateCapabilities(id, capabilities, discoveredModels);
    }
}

module.exports = { ProviderRoleStore };
