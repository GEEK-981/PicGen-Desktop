// History page search: query parsing and matching, no model involved.
// UMD: `require('./historySearch')` in tests, `window.PicGenHistorySearch` in desktop.html.
// Pure functions only: no fs, no path, no DOM.
//
// Query syntax:
//   雨夜 霓虹          every word must appear (in any field, in any order)
//   "neon city"       a quoted phrase must appear as written (straight or curly quotes)
//   -水墨 / -"low q"   a leading minus excludes a word or a phrase
// Matching is a case-insensitive substring test after NFKC (full-width ＡＢ１：９ → AB1:9, × → x).
(function expose(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PicGenHistorySearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    // Separates fields in the haystack so a word never matches across two of them.
    const FIELD_SEPARATOR = '\u0000';

    function normalize(value) {
        return String(value ?? '')
            .normalize('NFKC')
            .replace(/[“”„‟「」]/g, '"')
            .replace(/×/g, 'x')
            .replace(/\s+/g, ' ')
            .toLocaleLowerCase('zh-CN');
    }

    function parseQuery(input) {
        const text = normalize(input);
        const include = [];
        const exclude = [];
        let i = 0;
        while (i < text.length) {
            while (i < text.length && /\s/.test(text[i])) i++;
            if (i >= text.length) break;
            let negate = false;
            if (text[i] === '-' && i + 1 < text.length && !/\s/.test(text[i + 1])) {
                negate = true;
                i++;
            }
            let word;
            if (text[i] === '"') {
                const end = text.indexOf('"', i + 1);
                word = text.slice(i + 1, end === -1 ? text.length : end).trim();
                i = end === -1 ? text.length : end + 1;
            } else {
                const start = i;
                while (i < text.length && !/\s/.test(text[i])) i++;
                word = text.slice(start, i);
                if (word === '-') word = '';
            }
            if (word) (negate ? exclude : include).push(word);
        }
        return { include, exclude };
    }

    function isEmptyQuery(parsed) {
        return !parsed || (!parsed.include.length && !parsed.exclude.length);
    }

    function haystack(fields) {
        return (fields || []).map(normalize).join(FIELD_SEPARATOR);
    }

    // `fields` is an array of raw strings, or a haystack string already built by haystack().
    function matches(fields, parsed) {
        if (isEmptyQuery(parsed)) return true;
        const text = typeof fields === 'string' ? fields : haystack(fields);
        for (const word of parsed.include) if (!text.includes(word)) return false;
        for (const word of parsed.exclude) if (text.includes(word)) return false;
        return true;
    }

    return { normalize, parseQuery, isEmptyQuery, haystack, matches };
});
