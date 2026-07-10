'use strict';

// ─── txfileimport.js ──────────────────────────────────────────────────────────
// Multi-format transaction import for the Transactions page.
//
// Supported formats:
//   • Delimited text — CSV / TSV / semicolon / pipe (delimiter auto-detected)
//   • Excel .xlsx    — parsed natively (zip + DecompressionStream); no library,
//                      because the CSP forbids remote scripts and the project
//                      has no build step to vendor one
//   • OFX / QFX      — Open Financial Exchange, both SGML and XML flavours
//   • QIF            — Quicken Interchange Format
//   • JSON           — an array of flat objects (or the first such array found)
// Legacy binary .xls, PDF, and unrecognised binaries are rejected with a
// message telling the user what to export instead.
//
// Flow:
//   1. File picker  — format identified by magic bytes + content sniffing,
//                     so a misnamed file (OFX saved as .txt) still imports
//   2. Parse        — format-specific parser → uniform {headers, rows, fixed}
//   3. Map columns  — auto-detect then confirm in a modal; skipped when the
//                     format's schema is fixed (OFX/QIF define their fields)
//   4. Preview      — show all parsed rows; flag likely duplicates; user
//                     checks/unchecks before committing
//   5. Commit       — POST confirmed rows to /api/transactions/import
//   6. Reload       — fire 'transactions:reload' so the ledger refreshes
//
// All parsing is client-side. The server only receives clean row objects.
// On import the server auto-categorizes confident rows on-device (learned
// per-user rules first, then the built-in merchant lexicon); the count comes
// back as `auto_categorized`. Anything left blank the user categorises inline.

(function () {
    const TxFileImport = (() => {

        // ── HTML safety ──────────────────────────────────────────────────────────
        // Alias of the shared global in escape.js (loaded by base.html).
        const esc = escapeHtml;

        // ── Text decoding ────────────────────────────────────────────────────────
        // Bank exports are usually UTF-8, but some tools still emit Windows-1252.
        // Try strict UTF-8 first; on failure fall back rather than render
        // replacement characters into descriptions.
        function decodeText(buf) {
            try {
                return new TextDecoder('utf-8', { fatal: true }).decode(buf);
            } catch {
                return new TextDecoder('windows-1252').decode(buf);
            }
        }

        // Minimal XML entity unescape for OFX/XLSX field values.
        function unescapeXml(s) {
            return s
                .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
                .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
                .replace(/&amp;/g, '&');
        }

        // ── Delimited-text parser (CSV / TSV / ; / |) ────────────────────────────
        // Handles quoted fields, embedded delimiters/newlines in quoted fields,
        // escaped quotes ("" inside a quoted field), and Windows line endings.
        function parseDelimited(text, delim = ',') {
            // Normalise line endings; strip BOM if present.
            text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

            const allRows = [];
            let row       = [];
            let field     = '';
            let inQuote   = false;

            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                if (inQuote) {
                    if (ch === '"') {
                        // "" inside a quoted field → literal quote
                        if (text[i + 1] === '"') { field += '"'; i++; }
                        else inQuote = false;       // end of quoted field
                    } else {
                        field += ch;
                    }
                } else {
                    if (ch === '"')  { inQuote = true; }
                    else if (ch === delim) { row.push(field.trim()); field = ''; }
                    else if (ch === '\n') {
                        row.push(field.trim());
                        field = '';
                        if (row.length > 1 || row[0] !== '') allRows.push(row);
                        row = [];
                    } else {
                        field += ch;
                    }
                }
            }
            // Flush the last field / row (file may not end with \n).
            row.push(field.trim());
            if (row.length > 1 || row[0] !== '') allRows.push(row);

            if (allRows.length === 0) return { headers: [], rows: [], fixed: false };
            return { headers: allRows[0], rows: allRows.slice(1), fixed: false };
        }

        // Pick the delimiter that splits the sample lines most consistently.
        // Quote-aware so a comma inside "Acme, Inc." doesn't vote for comma in a
        // semicolon-delimited file. Comma wins ties (the most common dialect).
        function detectDelimiter(text) {
            const lines = [];
            for (const ln of text.split(/\r?\n/)) {
                if (ln.trim()) { lines.push(ln); if (lines.length >= 10) break; }
            }
            if (!lines.length) return ',';

            const countOutsideQuotes = (ln, d) => {
                let n = 0, inQ = false;
                for (const ch of ln) {
                    if (ch === '"') inQ = !inQ;
                    else if (ch === d && !inQ) n++;
                }
                return n;
            };

            let best = ',', bestScore = 0;
            for (const d of ['\t', ';', '|', ',']) {
                const counts = lines.map(ln => countOutsideQuotes(ln, d));
                const min = Math.min(...counts);
                if (min < 1) continue;  // delimiter must appear on every line
                // Uniform per-line counts are the signature of real columns.
                const uniform = counts.every(c => c === counts[0]);
                const score = min + (uniform ? 0.5 : 0);
                if (score > bestScore) { bestScore = score; best = d; }
            }
            return best;
        }

        // ── OFX / QFX parser ─────────────────────────────────────────────────────
        // OFX comes in two flavours: SGML (v1, unclosed tags, value runs to end
        // of line) and XML (v2, closed tags). Matching "<TAG>value-up-to-<-or-EOL"
        // handles both. Each transaction is a <STMTTRN> block; the closing tag is
        // optional in SGML, so chunks are cut at whichever boundary comes first.
        function parseOFX(text) {
            const field = (chunk, tag) => {
                const m = chunk.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
                return m ? unescapeXml(m[1].trim()) : '';
            };

            const rows = [];
            for (let chunk of text.split(/<STMTTRN>/i).slice(1)) {
                const end = chunk.search(/<\/STMTTRN>|<STMTTRN/i);
                if (end !== -1) chunk = chunk.slice(0, end);

                // DTPOSTED is YYYYMMDD optionally followed by time + timezone —
                // the first 8 digits are the date.
                const dt   = (field(chunk, 'DTPOSTED') || field(chunk, 'DTUSER')).match(/\d{8}/);
                const date = dt ? `${dt[0].slice(0, 4)}-${dt[0].slice(4, 6)}-${dt[0].slice(6, 8)}` : '';
                const name = field(chunk, 'NAME');
                const memo = field(chunk, 'MEMO');
                // NAME is the payee; MEMO is supplementary. When NAME is absent
                // MEMO is promoted to the description instead of duplicating.
                rows.push([date, name || memo, field(chunk, 'TRNAMT'), name ? memo : '']);
            }
            return { headers: ['Date', 'Description', 'Amount', 'Notes'], rows, fixed: true };
        }

        // ── QIF parser ───────────────────────────────────────────────────────────
        // Line-oriented: first character is the field code, '^' ends a record.
        //   D date · T/U amount · P payee · M memo · L category
        function parseQIF(text) {
            // Quicken's classic "M/D'YY" date — the apostrophe marks a 2000-era
            // year. Rewritten to M/D/YYYY so the shared date parser accepts it.
            const qifDate = (s) => {
                s = s.replace(/\s+/g, '');
                const m = s.match(/^(\d{1,2})\/(\d{1,2})'(\d{2}|\d{4})$/);
                if (!m) return s;
                const y = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
                return `${m[1]}/${m[2]}/${y}`;
            };

            const rows = [];
            let rec = {};
            const flush = () => {
                if (rec.D || rec.T || rec.P) {
                    // Memo is the natural notes field; fall back to the Quicken
                    // category label so that context isn't silently dropped.
                    rows.push([qifDate(rec.D || ''), rec.P || '', rec.T ?? rec.U ?? '', rec.M || rec.L || '']);
                }
                rec = {};
            };

            for (const raw of text.split(/\r?\n/)) {
                const line = raw.trim();
                if (!line) continue;
                if (line[0] === '!') continue;             // section header (!Type:Bank)
                if (line[0] === '^') { flush(); continue; }
                const code = line[0].toUpperCase();
                if (!(code in rec)) rec[code] = line.slice(1).trim();
            }
            flush();  // file may not end with '^'
            return { headers: ['Date', 'Description', 'Amount', 'Notes'], rows, fixed: true };
        }

        // ── JSON parser ──────────────────────────────────────────────────────────
        // Accepts an array of flat objects, or an envelope object whose first
        // array-of-objects value is the transaction list ({"transactions": […]}).
        // Goes through the normal mapping modal — JSON keys are arbitrary.
        function parseJSONTable(text) {
            let data;
            try { data = JSON.parse(text); }
            catch { throw new Error('the file is not valid JSON.'); }

            let arr = Array.isArray(data) ? data : Object.values(data || {}).find(
                v => Array.isArray(v) && v.length && typeof v[0] === 'object'
            );
            arr = (arr || []).filter(o => o && typeof o === 'object' && !Array.isArray(o));
            if (!arr.length) throw new Error('no array of transaction objects found in the JSON.');

            // Headers = union of keys, in order of first appearance.
            const headers = [];
            for (const obj of arr) {
                for (const k of Object.keys(obj)) {
                    if (!headers.includes(k)) headers.push(k);
                }
            }
            const rows = arr.map(obj => headers.map(h => {
                const v = obj[h];
                if (v === null || v === undefined) return '';
                return typeof v === 'object' ? JSON.stringify(v) : String(v);
            }));
            return { headers, rows, fixed: false };
        }

        // ── XLSX parser ──────────────────────────────────────────────────────────
        // An .xlsx file is a zip of XML parts. The zip is read by hand (central
        // directory → local headers) and deflate entries are inflated with the
        // browser-native DecompressionStream, so no third-party code is needed.

        // Index the archive: EOCD record → central directory → {name → entry}.
        function readZip(buf) {
            const bytes = new Uint8Array(buf);
            const view  = new DataView(buf);

            // End-of-central-directory record: scan backwards from the end (it
            // sits after an up-to-64KB zip comment).
            let eocd = -1;
            const minPos = Math.max(0, bytes.length - 65557);
            for (let i = bytes.length - 22; i >= minPos; i--) {
                if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
            }
            if (eocd < 0) throw new Error('not a valid zip archive.');

            const count   = view.getUint16(eocd + 10, true);
            const entries = new Map();
            const td      = new TextDecoder();
            let p = view.getUint32(eocd + 16, true);  // central directory offset
            for (let n = 0; n < count; n++) {
                if (view.getUint32(p, true) !== 0x02014b50) break;
                const method     = view.getUint16(p + 10, true);
                const compSize   = view.getUint32(p + 20, true);
                const nameLen    = view.getUint16(p + 28, true);
                const extraLen   = view.getUint16(p + 30, true);
                const commentLen = view.getUint16(p + 32, true);
                const localOff   = view.getUint32(p + 42, true);
                const name       = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
                entries.set(name, { method, compSize, localOff });
                p += 46 + nameLen + extraLen + commentLen;
            }
            return { bytes, view, entries };
        }

        // Extract one entry as text. The local header's name/extra lengths can
        // differ from the central directory's copy, so they're re-read here.
        async function readZipFile(zip, name) {
            const e = zip.entries.get(name);
            if (!e) return null;
            const nameLen  = zip.view.getUint16(e.localOff + 26, true);
            const extraLen = zip.view.getUint16(e.localOff + 28, true);
            const start    = e.localOff + 30 + nameLen + extraLen;
            const data     = zip.bytes.subarray(start, start + e.compSize);

            if (e.method === 0) return new TextDecoder().decode(data);   // stored
            if (e.method !== 8) throw new Error('unsupported zip compression method.');
            const stream = new Blob([data]).stream()
                .pipeThrough(new DecompressionStream('deflate-raw'));
            return await new Response(stream).text();
        }

        // "BC" → 0-based column index (A=0, Z=25, AA=26, …).
        function colIndex(letters) {
            let n = 0;
            for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
            return n - 1;
        }

        async function parseXLSX(buf) {
            const zip = readZip(buf);

            // Shared strings: cells with t="s" store an index into this table.
            // Each <si> may hold several rich-text <t> runs — concatenate them.
            const shared = [];
            const ssXml = await readZipFile(zip, 'xl/sharedStrings.xml');
            if (ssXml) {
                for (const si of ssXml.match(/<si>[\s\S]*?<\/si>/g) || []) {
                    let s = '';
                    for (const t of si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += unescapeXml(t[1]);
                    shared.push(s);
                }
            }

            // Sheet choice: bank exports are single-sheet workbooks, so the
            // lowest-numbered worksheet part is taken rather than resolving the
            // workbook.xml relationship chain.
            const sheetName = [...zip.entries.keys()]
                .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
                .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))[0];
            if (!sheetName) throw new Error('no worksheet found — is this really an .xlsx workbook?');
            const xml = await readZipFile(zip, sheetName);

            // Sheet XML is machine-generated and regular, so targeted regexes are
            // reliable here and keep the parser dependency-free (no DOMParser
            // quirks with namespaced documents).
            const grid = [];
            for (const rowM of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
                const cells = [];
                for (const cellM of rowM[1].matchAll(/<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
                    const attrs = cellM[1] ?? cellM[2] ?? '';
                    const inner = cellM[3] ?? '';
                    const ref   = attrs.match(/\br="([A-Z]+)\d+"/);
                    const type  = attrs.match(/\bt="([^"]+)"/)?.[1];

                    let val = '';
                    if (type === 'inlineStr') {
                        for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) val += unescapeXml(t[1]);
                    } else {
                        const v = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
                        val = v ? unescapeXml(v[1]) : '';
                        if (type === 's') val = shared[parseInt(val, 10)] ?? '';
                        if (type === 'b') val = val === '1' ? 'TRUE' : 'FALSE';
                    }
                    // Missing r= attribute means "next column" — append in order.
                    cells[ref ? colIndex(ref[1]) : cells.length] = val.trim();
                }
                // Sparse holes (skipped cells) become empty strings.
                grid.push(Array.from(cells, c => c ?? ''));
            }

            // Bank exports often put a title or metadata above the real table.
            // Skip leading rows until one with at least two non-empty cells
            // appears (a usable transaction table needs date + amount at
            // minimum); that row becomes the headers — same convention as the
            // delimited parser. Date cells stored as Excel serial numbers are
            // handled later by parseIsoDate.
            while (grid.length && grid[0].filter(c => c).length < 2) grid.shift();
            if (!grid.length) return { headers: [], rows: [], fixed: false };
            const headers = grid[0];
            const rows = grid.slice(1).filter(r => r.some(c => c));
            return { headers, rows, fixed: false };
        }

        // ── Format dispatch ──────────────────────────────────────────────────────
        // Magic bytes identify binary containers (extensions lie); text formats
        // are sniffed by content with the extension as a tie-breaker.
        async function parseFile(name, buf) {
            const bytes = new Uint8Array(buf);
            const at = (i, b) => bytes[i] === b;

            if (at(0, 0x50) && at(1, 0x4B)) return await parseXLSX(buf);  // zip container
            if (at(0, 0xD0) && at(1, 0xCF)) {
                throw new Error('legacy .xls workbooks are not supported — re-save the file as .xlsx or CSV.');
            }
            if (at(0, 0x25) && at(1, 0x50) && at(2, 0x44) && at(3, 0x46)) {
                throw new Error('PDF statements cannot be imported — download a CSV, OFX, or Excel export from your bank instead.');
            }

            const text = decodeText(buf);
            if (text.slice(0, 4096).includes('\u0000')) {
                throw new Error('unrecognised binary file. Supported formats: CSV/TSV, Excel (.xlsx), OFX/QFX, QIF, JSON.');
            }

            const ext  = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
            const head = text.slice(0, 4096).trimStart();

            if (ext === 'ofx' || ext === 'qfx' || /^OFXHEADER/i.test(head) || /<OFX[\s>]/i.test(head)) {
                return parseOFX(text);
            }
            if (ext === 'qif' || /^!(Type|Account|Option)/i.test(head)) {
                return parseQIF(text);
            }
            // JSON by extension, or by shape when the extension is unknown.
            const knownText = new Set(['csv', 'tsv', 'txt']);
            if (ext === 'json' || (!knownText.has(ext) && /^[[{]/.test(head))) {
                return parseJSONTable(text);
            }
            return parseDelimited(text, detectDelimiter(text));
        }

        // ── Column detection ─────────────────────────────────────────────────────
        // Fuzzy-match header names first; fall back to data-shape heuristics.
        const RX_DATE   = /date|posted|trans(?:action)?|when/i;
        const RX_AMOUNT = /amount|debit|credit|sum|total/i;
        const RX_DESC   = /desc(?:ription)?|merchant|payee|memo|narrative|detail|name/i;
        const RX_NOTES  = /notes?|comment|remark|reference|ref/i;

        function detectColumns(headers, rows) {
            const d = { date: null, description: null, amount: null, notes: null };

            headers.forEach((h, i) => {
                if (d.date        === null && RX_DATE.test(h))   d.date        = i;
                if (d.amount      === null && RX_AMOUNT.test(h)) d.amount      = i;
                if (d.description === null && RX_DESC.test(h))   d.description = i;
                if (d.notes       === null && RX_NOTES.test(h))  d.notes       = i;
            });

            // Data-shape fallbacks for unmatched required fields.
            if (rows.length > 0) {
                headers.forEach((h, i) => {
                    const vals = rows.map(r => (r[i] || '')).filter(Boolean);
                    if (!vals.length) return;
                    if (d.date === null) {
                        const hits = vals.filter(v => parseIsoDate(v) !== null).length;
                        if (hits / vals.length > 0.8) d.date = i;
                    }
                    if (d.amount === null) {
                        const hits = vals.filter(v => !Number.isNaN(parseAmount(v))).length;
                        if (hits / vals.length > 0.8) d.amount = i;
                    }
                });

                // Description fallback: longest average text, excluding claimed columns.
                if (d.description === null) {
                    let best = null, bestAvg = 0;
                    headers.forEach((h, i) => {
                        if (i === d.date || i === d.amount || i === d.notes) return;
                        const avg = rows.reduce((s, r) => s + (r[i] || '').length, 0) / rows.length;
                        if (avg > bestAvg) { bestAvg = avg; best = i; }
                    });
                    d.description = best;
                }
            }
            return d;
        }

        // ── Date / amount parsing ─────────────────────────────────────────────────
        const MONTH_NUM = {
            jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
            jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
        };

        // Validate + zero-pad into ISO 'YYYY-MM-DD'; null when out of range.
        function mkIso(y, mo, d) {
            if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
            return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }

        // Returns ISO 'YYYY-MM-DD' string, or null on failure.
        function parseIsoDate(s) {
            if (!s) return null;
            s = String(s).trim();
            let m;

            // ISO: YYYY-MM-DD (also YYYY/MM/DD)
            if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)))
                return mkIso(+m[1], +m[2], +m[3]);
            // US: MM/DD/YYYY or MM-DD-YYYY (banks love this)
            if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)))
                return mkIso(+m[3], +m[1], +m[2]);
            // US short: MM/DD/YY
            if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/)))
                return mkIso(2000 + +m[3], +m[1], +m[2]);
            // European: DD.MM.YYYY
            if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)))
                return mkIso(+m[3], +m[2], +m[1]);
            // Compact: YYYYMMDD (OFX-style)
            if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/)))
                return mkIso(+m[1], +m[2], +m[3]);
            // Month name: "Jan 5, 2026" / "January 5 2026"
            if ((m = s.match(/^([a-z]{3,9})\.?[ -]+(\d{1,2}),?[ -]+(\d{4})$/i)))
                return MONTH_NUM[m[1].slice(0, 3).toLowerCase()]
                    ? mkIso(+m[3], MONTH_NUM[m[1].slice(0, 3).toLowerCase()], +m[2]) : null;
            // Month name: "5 Jan 2026" / "05-Jan-2026"
            if ((m = s.match(/^(\d{1,2})[ -]([a-z]{3,9})\.?,?[ -]+(\d{4})$/i)))
                return MONTH_NUM[m[2].slice(0, 3).toLowerCase()]
                    ? mkIso(+m[3], MONTH_NUM[m[2].slice(0, 3).toLowerCase()], +m[1]) : null;
            // Excel serial date (xlsx cells store dates as day counts from
            // 1899-12-30). Five digits covers 1954–2173 — beyond that range a
            // bare number is more likely an ID than a date.
            if ((m = s.match(/^(\d{5})(\.\d+)?$/))) {
                const serial = parseInt(m[1], 10);
                const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
                return mkIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
            }
            return null;
        }

        // Strips currency symbols, commas, whitespace; understands accountant
        // parentheses ("(12.34)" → -12.34). Returns float or NaN.
        function parseAmount(s) {
            if (s === null || s === undefined) return NaN;
            s = String(s).trim();
            let neg = false;
            const m = s.match(/^\((.*)\)$/);
            if (m) { neg = true; s = m[1]; }
            const v = parseFloat(s.replace(/[$£€,\s]/g, ''));
            return neg ? -v : v;
        }

        // Fingerprint for dup detection — must match the backend formula in
        // api_transactions_hashes: "date|amount|description.lower()"
        function fingerprint(row) {
            return `${row.date}|${Math.abs(row.amount).toFixed(2)}|${(row.description || '').toLowerCase().trim()}`;
        }

        // ── API ───────────────────────────────────────────────────────────────────
        async function fetchHashes(since) {
            const url = since ? `/api/transactions/hashes?since=${encodeURIComponent(since)}` : '/api/transactions/hashes';
            try {
                const r    = await apiFetch(url);
                const data = await r.json().catch(() => ({}));
                return new Set(data.hashes || []);
            } catch {
                return new Set();  // dup detection is best-effort; don't block import
            }
        }

        async function commitRows(rows) {
            const r = await apiFetch('/api/transactions/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'import failed');
            return data; // { ok, inserted, skipped }
        }

        // ── Modal shell ───────────────────────────────────────────────────────────
        // Returns { dialog, body, close } where body is the scrollable content div.
        function buildModal(title) {
            const overlay = document.createElement('div');
            overlay.className = 'tx-import-overlay';

            const dialog = document.createElement('div');
            dialog.className = 'tx-import-dialog';

            const header = document.createElement('div');
            header.className = 'tx-import-dialog-header';
            header.innerHTML = `
            <span class="tx-import-dialog-title">${esc(title)}</span>
            <button class="tx-import-close" title="Close">&times;</button>
        `;

            const body = document.createElement('div');
            body.className = 'tx-import-dialog-body';

            dialog.append(header, body);
            overlay.append(dialog);
            document.body.append(overlay);

            const close = () => overlay.remove();
            header.querySelector('.tx-import-close').addEventListener('click', close);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

            return { overlay, dialog, body, close };
        }

        // ── Step 1: Mapping modal ─────────────────────────────────────────────────
        function showMappingModal(headers, rows, detected, onContinue) {
            const { body, close } = buildModal('Map Columns');

            // Preview of first 3 raw rows so the user can visually verify the mapping.
            const previewHtml = `
            <p class="tx-import-hint">Match the columns in your file to the transaction fields below.</p>
            <div class="tx-import-section-label">File preview (first 3 rows)</div>
            <div class="tx-import-preview-wrap">
                <table class="tx-import-preview-table">
                    <thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
                    <tbody>
                        ${rows.slice(0, 3).map(r =>
                            `<tr>${headers.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`
                        ).join('')}
                    </tbody>
                </table>
            </div>
        `;

            // Build one <select> row per required/optional field.
            function mapSelect(label, field, required) {
                const detectedIdx = detected[field];
                const opts = (required ? '' : '<option value="">— skip —</option>') +
                    headers.map((h, i) =>
                        `<option value="${i}"${i === detectedIdx ? ' selected' : ''}>${esc(h)}</option>`
                    ).join('');
                return `
                <div class="tx-import-map-row">
                    <span class="tx-import-map-label">${esc(label)}</span>
                    <select class="tx-select tx-import-map-select" data-field="${field}">${opts}</select>
                </div>
            `;
            }

            body.innerHTML = previewHtml + `
            <div class="tx-import-section-label">Column mapping</div>
            <div class="tx-import-map-form">
                ${mapSelect('Date *',        'date',        true)}
                ${mapSelect('Description *', 'description', true)}
                ${mapSelect('Amount *',      'amount',      true)}
                ${mapSelect('Notes',         'notes',       false)}
            </div>
            <div class="tx-import-footer">
                <span class="tx-import-row-count">${rows.length} row${rows.length !== 1 ? 's' : ''} in file</span>
                <button class="button-primary tx-import-continue-btn">Continue →</button>
            </div>
        `;

            body.querySelector('.tx-import-continue-btn').addEventListener('click', () => {
                const get = (field) => {
                    const v = body.querySelector(`[data-field="${field}"]`)?.value;
                    return (v !== '' && v !== undefined && v !== null) ? parseInt(v, 10) : null;
                };
                const mapping = {
                    date:        get('date'),
                    description: get('description'),
                    amount:      get('amount'),
                    notes:       get('notes'),
                };
                if (mapping.date        === null) { alert('Please select the Date column.');        return; }
                if (mapping.description === null) { alert('Please select the Description column.'); return; }
                if (mapping.amount      === null) { alert('Please select the Amount column.');      return; }
                close();
                onContinue(mapping);
            });
        }

        // ── Step 2: Apply mapping → parsed rows ──────────────────────────────────
        // firstRowNum is what "row N" means in error messages: 2 for tabular
        // files (row 1 is the header line), 1 for record formats like OFX/QIF.
        function applyMapping(rawRows, mapping, firstRowNum = 2) {
            const parsed = [], errors = [];
            rawRows.forEach((row, i) => {
                const dateRaw  = row[mapping.date]        ?? '';
                const descRaw  = (row[mapping.description] ?? '').trim();
                const amtRaw   = row[mapping.amount]       ?? '';
                const notesRaw = mapping.notes !== null ? (row[mapping.notes] ?? '').trim() : '';

                const date   = parseIsoDate(dateRaw);
                const amount = parseAmount(amtRaw);

                if (!date) {
                    errors.push({ row: i + firstRowNum, reason: `unparseable date "${dateRaw}"` });
                    return;
                }
                if (Number.isNaN(amount)) {
                    errors.push({ row: i + firstRowNum, reason: `unparseable amount "${amtRaw}"` });
                    return;
                }
                if (!descRaw) {
                    errors.push({ row: i + firstRowNum, reason: 'empty description' });
                    return;
                }
                const tx_type = amount >= 0 ? 'income' : 'expense';
                parsed.push({ date, description: descRaw, tx_type, amount: Math.abs(amount), notes: notesRaw });
            });
            return { parsed, errors };
        }

        // ── Step 3: Preview modal ─────────────────────────────────────────────────
        function showPreviewModal(parsed, errors, dupeSet) {
            const { body, close } = buildModal('Review Import');

            // Augment each row with a stable index, fingerprint, and dup flag.
            const rows     = parsed.map((r, i) => ({ ...r, _idx: i, _fp: fingerprint(r), _dup: dupeSet.has(fingerprint(r)) }));
            const checked  = new Set(rows.filter(r => !r._dup).map(r => r._idx));

            const CURRENCY = (typeof CURRENCY_SYMBOL !== 'undefined') ? CURRENCY_SYMBOL : '$';
            const fmtAmt   = (n) => CURRENCY + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

            // Error banner (parse failures from applyMapping).
            const errBanner = errors.length ? `
            <div class="tx-import-errors-banner">
                ${errors.length} row${errors.length !== 1 ? 's' : ''} could not be parsed and will be skipped:
                ${errors.slice(0, 3).map(e => `row ${e.row} — ${esc(e.reason)}`).join('; ')}${errors.length > 3 ? '…' : ''}
            </div>` : '';

            // Footer lives outside body so it stays visible while the table scrolls.
            const footer = document.createElement('div');
            footer.className = 'tx-import-footer tx-import-footer--preview';
            footer.innerHTML = `
            <span class="tx-import-row-count"></span>
            <button class="button-primary tx-import-do-btn" disabled>Import</button>
        `;

            body.closest('.tx-import-dialog').append(footer);

            function updateFooter() {
                const n = checked.size;
                footer.querySelector('.tx-import-row-count').textContent = `${n} of ${rows.length} selected`;
                const btn = footer.querySelector('.tx-import-do-btn');
                btn.textContent = `Import ${n} row${n !== 1 ? 's' : ''}`;
                btn.disabled    = n === 0;
            }

            function renderTable() {
                const allChecked = rows.length > 0 && rows.every(r => checked.has(r._idx));
                body.innerHTML = errBanner + `
                <div class="tx-import-preview-wrap">
                    <table class="tx-import-preview-table tx-import-preview-full">
                        <thead>
                            <tr>
                                <th><input type="checkbox" class="tx-import-check-all"${allChecked ? ' checked' : ''}></th>
                                <th>Date</th>
                                <th>Description</th>
                                <th>Amount</th>
                                <th>Notes</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(r => `
                                <tr class="${r._dup ? 'tx-import-row-dup' : ''}">
                                    <td><input type="checkbox" class="tx-import-row-check" data-idx="${r._idx}"${checked.has(r._idx) ? ' checked' : ''}></td>
                                    <td>${esc(r.date)}</td>
                                    <td>${esc(r.description)}${r._dup ? ' <span class="tx-import-dup-badge">duplicate</span>' : ''}</td>
                                    <td class="tx-import-col-amount">${esc(fmtAmt(r.amount))}</td>
                                    <td>${esc(r.notes)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;

                body.querySelector('.tx-import-check-all')?.addEventListener('change', (e) => {
                    if (e.target.checked) rows.forEach(r => checked.add(r._idx));
                    else checked.clear();
                    renderTable();
                    updateFooter();
                });

                body.querySelectorAll('.tx-import-row-check').forEach(cb => {
                    cb.addEventListener('change', (e) => {
                        const idx = parseInt(e.target.dataset.idx, 10);
                        e.target.checked ? checked.add(idx) : checked.delete(idx);
                        // Update check-all state without re-rendering the whole table.
                        body.querySelector('.tx-import-check-all').checked =
                            rows.every(r => checked.has(r._idx));
                        updateFooter();
                    });
                });
            }

            renderTable();
            updateFooter();

            footer.querySelector('.tx-import-do-btn').addEventListener('click', async () => {
                const toSend = rows
                    .filter(r => checked.has(r._idx))
                    .map(({ date, description, tx_type, amount, notes }) => ({ date, description, tx_type, amount, notes }));
                try {
                    const result = await commitRows(toSend);
                    close();
                    const msg = `Imported ${result.inserted} transaction${result.inserted !== 1 ? 's' : ''}.`
                        + (result.auto_categorized ? ` ${result.auto_categorized} categorized automatically.` : '')
                        + (result.skipped?.length ? ` ${result.skipped.length} skipped.` : '');
                    alert(msg);
                    window.dispatchEvent(new Event('transactions:reload'));
                } catch (err) {
                    alert('Import failed: ' + err.message);
                }
            });
        }

        // ── Entry point ───────────────────────────────────────────────────────────
        async function run() {
            const input   = document.createElement('input');
            input.type    = 'file';
            // Every format the dispatcher understands; sniffing still rescues
            // files whose extension doesn't match their content.
            input.accept  = '.csv,.tsv,.txt,.ofx,.qfx,.qif,.json,.xlsx,text/csv,application/json';
            input.style.display = 'none';
            document.body.append(input);

            input.addEventListener('change', async () => {
                const file = input.files?.[0];
                input.remove();
                if (!file) return;

                const buf = await file.arrayBuffer().catch(() => null);
                if (!buf || !buf.byteLength) { alert('Could not read the file.'); return; }

                let table;
                try {
                    table = await parseFile(file.name, buf);
                } catch (err) {
                    alert('Could not import this file: ' + err.message);
                    return;
                }
                if (!table.headers.length || !table.rows.length) {
                    alert('The file appears to be empty or has no data rows.');
                    return;
                }

                // Shared continuation for both paths: validate rows, fetch
                // duplicate fingerprints, open the preview.
                const proceed = async (mapping, firstRowNum) => {
                    const { parsed, errors } = applyMapping(table.rows, mapping, firstRowNum);
                    if (!parsed.length) {
                        const sample = errors.slice(0, 3).map(e => `  Row ${e.row}: ${e.reason}`).join('\n');
                        alert(`No valid rows could be parsed (${errors.length} error${errors.length > 1 ? 's' : ''}).\n\nFirst errors:\n${sample}`);
                        return;
                    }

                    // Fetch existing fingerprints for dup detection, bounded to the
                    // date range in the file so we don't scan the full history.
                    const minDate = parsed.reduce((min, r) => (r.date < min ? r.date : min), parsed[0].date);
                    const dupeSet = await fetchHashes(minDate);

                    showPreviewModal(parsed, errors, dupeSet);
                };

                if (table.fixed) {
                    // Known-schema formats (OFX/QIF): the parser already emitted
                    // [Date, Description, Amount, Notes], so mapping is identity
                    // and the modal would be a pointless extra click.
                    proceed({ date: 0, description: 1, amount: 2, notes: 3 }, 1);
                } else {
                    const detected = detectColumns(table.headers, table.rows);
                    showMappingModal(table.headers, table.rows, detected,
                        (mapping) => proceed(mapping, 2));
                }
            });

            input.click();
        }

        // _internals is exposed for tests/debugging only — application code goes
        // through run().
        return {
            run,
            _internals: {
                parseDelimited, detectDelimiter, parseOFX, parseQIF,
                parseJSONTable, parseXLSX, parseFile, parseIsoDate, parseAmount,
            },
        };
    })();

    window.TxFileImport = TxFileImport;
}());
