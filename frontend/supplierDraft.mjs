// Pure draft/validation logic for the supplier settings panel. No DOM access —
// the React panel owns focus/highlight; node unit tests exercise this directly.

// rows: [{ name, price, protocol, routingExtras }] where routingExtras carries
// modelRouting fields beyond protocol (group/enabled/unknown keys) so saving a
// row never destroys metadata the UI does not edit.
export function readModelRows(rows = [], { validate = false, activeModel = '' } = {}) {
    const models = [], modelPricing = {}, modelRouting = {}, seen = new Set();
    rows.forEach((row, index) => {
        const name = String(row?.name || '').trim();
        if (!name) return;
        if (seen.has(name)) {
            if (validate) throw rowError(`模型名称重复：${name}`, index, 'name');
            return;
        }
        seen.add(name);
        models.push(name);
        const price = String(row?.price ?? '').trim();
        if (price !== '') {
            const value = Number(price);
            if (!Number.isFinite(value) || value < 0) {
                if (validate) throw rowError(`请为 ${name} 填写有效的非负价格，或留空`, index, 'price');
            } else modelPricing[name] = value;
        }
        modelRouting[name] = { ...(row?.routingExtras || {}), protocol: row?.protocol || 'auto' };
    });
    if (validate && !models.length) throw rowError('请至少填写一个模型名称', 0, 'name');
    return {
        models,
        modelPricing,
        modelRouting,
        activeModel: models.includes(activeModel) ? activeModel : (models[0] || '')
    };
}

function rowError(message, rowIndex, field) {
    const error = new Error(message);
    error.rowIndex = rowIndex;
    error.field = field;
    return error;
}

export function validateSupplierIdentity({ name = '', baseUrl = '' } = {}) {
    if (!String(name).trim() || !String(baseUrl).trim()) throw new Error('请填写供应商名称和 Base URL');
    let parsed;
    try { parsed = new URL(String(baseUrl).trim()); } catch { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
        const error = new Error('请填写有效的 http:// 或 https:// Base URL');
        error.field = 'baseUrl';
        throw error;
    }
}

export function validateGroupCapacity({ role = 'image', maxConcurrent } = {}) {
    if (role !== 'image') return;
    const value = Number(maxConcurrent);
    if (!Number.isInteger(value) || value < 1 || value > 8) {
        const error = new Error('最大并发请填写 1～8 的整数');
        error.field = 'maxConcurrent';
        throw error;
    }
}

// Rows for the editor from a persisted group; blank row when the group is new.
export function rowsFromGroup(group) {
    const models = Array.isArray(group?.models) ? group.models : [];
    const pricing = group?.modelPricing || group?.pricing || {};
    const routing = group?.modelRouting || {};
    if (!models.length) return [emptyRow()];
    return models.map(model => {
        const { protocol, ...routingExtras } = routing[model] || {};
        return {
            ...emptyRow(model),
            price: pricing[model] == null ? '' : String(pricing[model]),
            protocol: protocol || 'auto',
            routingExtras
        };
    });
}

let rowSeed = 0;
export function emptyRow(name = '') {
    rowSeed += 1;
    return { key: `row_${Date.now().toString(36)}_${rowSeed}`, name, price: '', protocol: 'auto', routingExtras: {} };
}

export function mergeDiscoveredModels(existing = [], found = [], now = Date.now()) {
    const merged = [];
    const push = item => {
        const id = typeof item === 'string' ? item : item?.id;
        if (!id || merged.some(entry => entry.id === id)) return;
        merged.push(typeof item === 'string'
            ? { id, supported_endpoint_types: [], discoveredAt: now }
            : { supported_endpoint_types: [], discoveredAt: now, ...item });
    };
    existing.forEach(push);
    found.forEach(push);
    return merged;
}
