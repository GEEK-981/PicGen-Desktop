const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'frontend', file)).href);

test('every supplier template passes the form validation it will be saved through', async () => {
    const { SUPPLIER_TEMPLATES } = await load('supplierTemplates.mjs');
    const { rowsFromGroup, readModelRows, validateSupplierIdentity, validateGroupCapacity } = await load('supplierDraft.mjs');
    const profiles = require('../imageApiProfiles');
    const { PROTOCOLS } = require('../protocolRouter');
    const protocols = new Set(Object.values(PROTOCOLS));
    assert.ok(SUPPLIER_TEMPLATES.length >= 2);
    for (const template of SUPPLIER_TEMPLATES) {
        validateSupplierIdentity(template);
        validateGroupCapacity({ role: 'image', maxConcurrent: template.group.maxConcurrent });
        assert.match(template.signupUrl, /^https:\/\//, template.id);
        assert.equal(new URL(template.signupUrl).hostname, new URL(template.baseUrl).hostname, `${template.id} signs up on its own host`);
        const draft = readModelRows(rowsFromGroup(template.group), { validate: true });
        assert.deepEqual(draft.models, template.group.models);
        for (const model of draft.models) {
            assert.ok(protocols.has(draft.modelRouting[model].protocol), `${template.id} ${model} protocol`);
            assert.notEqual(profiles.imageApiKind(model), 'legacy', `${template.id} ${model} is a recognised image model`);
        }
    }
});

test('template icons come from the supplier icon library', async () => {
    const { SUPPLIER_TEMPLATES } = await load('supplierTemplates.mjs');
    const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'SupplierManager.jsx'), 'utf8');
    const library = source.slice(source.indexOf('const SUPPLIER_ICON_LIBRARY'), source.indexOf('];', source.indexOf('const SUPPLIER_ICON_LIBRARY')));
    for (const template of SUPPLIER_TEMPLATES) assert.ok(library.includes(`'${template.icon}'`), template.icon);
});
