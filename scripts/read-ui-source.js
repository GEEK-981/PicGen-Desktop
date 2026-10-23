// Source-contract assertions follow the React page split instead of the old
// monolithic HTML. End-to-end tests validate the actual mounted DOM separately.
const fs = require('node:fs');
const path = require('node:path');
module.exports = function readUiSource() {
    const root = path.resolve(__dirname, '..');
    const pages = fs.readdirSync(path.join(root, 'frontend/pages')).filter(name => name.endsWith('.jsx'));
    return ['desktop.html', 'frontend/App.jsx', 'frontend/components.jsx', ...pages.map(name => `frontend/pages/${name}`)]
        .map(name => fs.readFileSync(path.join(root, name), 'utf8'))
        .join('\n').replaceAll('\\"', '"');
};
