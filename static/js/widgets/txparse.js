'use strict';

// ─── txparse.js ───────────────────────────────────────────────────────────────
// The PURE parsing core of transaction import — extracted from
// txfileimport.js so it can be regression-tested under `node --test`
// (electron/backend/__tests__/txParse.test.js runs it against a fixture
// corpus of messy bank exports). txfileimport.js owns everything with a DOM
// or network dependency (modals, dup-hash fetch, commit); this file must
// stay free of both so the tests exercise exactly what production runs.
//
// Dual-environment: in the browser it attaches window.TxParse (loaded by
// pages/transactions.html before txfileimport.js); under Node it exports the
// same object via module.exports. The only platform APIs used are ones both
// environments provide: TextDecoder, Blob, Response, DecompressionStream
// (Node ≥ 18).
//
// Supported formats (see parseFile, the dispatcher):
//   • Delimited text — CSV / TSV / semicolon / pipe (delimiter auto-detected)
//   • Excel .xlsx    — parsed natively (zip + DecompressionStream); no library,
//                      because the CSP forbids remote scripts and the project
//                      has no build step to vendor one
//   • OFX / QFX      — Open Financial Exchange, both SGML and XML flavours
//   • QIF            — Quicken Interchange Format
//   • JSON           — an array of flat objects (or the first such array found)
// Legacy binary .xls, PDF, and unrecognised binaries are rejected with a
// message telling the user what to export instead.

(function () {

    // ── Text decoding ────────────────────────────────────────────────────────
    // Bank exports are usually UTF-8, but some tools still emit Windows-1252.
    // Try strict UTF-8 first; on failure fall back rather than render
    // replacement characters into descriptions.
    //
    // The Windows-1252 fallback is a hand-rolled table rather than
    // `new TextDecoder('windows-1252')`: that call's output for bytes
    // 0x80-0x9F (smart quotes, dashes, €, …) has been observed to differ
    // across Node/ICU builds — same input, different decoded characters on
    // different machines. A fixed table decodes identically everywhere this
    // code runs, which matters because this exact path is what turns a real
    // user's "ANSI" bank CSV into transaction descriptions.
    const CP1252_C1 = [
        0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
        0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
        0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
        0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
    ];

    function decodeWindows1252(buf) {
        const bytes = new Uint8Array(buf);
        let out = '';
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            out += String.fromCharCode(b >= 0x80 && b <= 0x9F ? CP1252_C1[b - 0x80] : b);
        }
        return out;
    }

    function decodeText(buf) {
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(buf);
        } catch {
            return decodeWindows1252(buf);
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
    // native DecompressionStream, so no third-party code is needed.

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
    // Split-amount headers: money out and money in as two separate columns
    // ("Debit"/"Credit", "Withdrawal Amount"/"Deposit Amount"). Only a header
    // matching exactly one side counts — "Debit/Credit" matches both and is
    // treated as a single signed column.
    const RX_DEBIT  = /debit|withdrawal|money\s*out|paid\s*out/i;
    const RX_CREDIT = /credit|deposit|money\s*in|paid\s*in/i;

    function detectColumns(headers, rows) {
        const d = { date: null, description: null, amount: null, debit: null, credit: null, notes: null };

        headers.forEach((h, i) => {
            const isDebit  = RX_DEBIT.test(h)  && !RX_CREDIT.test(h);
            const isCredit = RX_CREDIT.test(h) && !RX_DEBIT.test(h);
            if (d.date        === null && RX_DATE.test(h))   d.date        = i;
            if (d.debit       === null && isDebit)           d.debit       = i;
            if (d.credit      === null && isCredit)          d.credit      = i;
            if (d.amount === null && RX_AMOUNT.test(h) && !isDebit && !isCredit) d.amount = i;
            if (d.description === null && RX_DESC.test(h))   d.description = i;
            if (d.notes       === null && RX_NOTES.test(h))  d.notes       = i;
        });

        // Split (Debit/Credit) mode only when BOTH sides exist and no combined
        // Amount column does — a file with a real Amount column usually signs
        // it, and a lone "Debit Amount" header falls back to being the single
        // amount column (its rows then direction by sign, as before).
        if (d.amount !== null || d.debit === null || d.credit === null) {
            if (d.amount === null) d.amount = d.debit ?? d.credit;
            d.debit = d.credit = null;
        }

        // Data-shape fallbacks for unmatched required fields.
        if (rows.length > 0) {
            headers.forEach((h, i) => {
                const vals = rows.map(r => (r[i] || '')).filter(Boolean);
                if (!vals.length) return;
                if (d.date === null) {
                    const hits = vals.filter(v => parseIsoDate(v) !== null).length;
                    if (hits / vals.length > 0.8) d.date = i;
                }
                // A column already claimed as the date can't also be the
                // amount — date strings like "2026-01-01" pass parseAmount
                // (parseFloat reads the leading year), so without this guard
                // an anonymous-header file pre-selects the same column for
                // both fields. Split mode (debit set) needs no amount at all.
                if (d.amount === null && d.debit === null && i !== d.date) {
                    const hits = vals.filter(v => !Number.isNaN(parseAmount(v))).length;
                    if (hits / vals.length > 0.8) d.amount = i;
                }
            });

            // Description fallback: longest average text, excluding claimed columns.
            if (d.description === null) {
                let best = null, bestAvg = 0;
                headers.forEach((h, i) => {
                    if (i === d.date || i === d.amount || i === d.notes
                        || i === d.debit || i === d.credit) return;
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

    // Which decimal convention an amount column uses: 'dot' (US "1,234.56")
    // or 'comma' (European "1.234,56"). Votes are cast only by unambiguous
    // values — both separators present (the last one is the decimal), or a
    // lone separator followed by 1-2 trailing digits. Grouped-only values
    // like "1.234" abstain: applyMapping infers ONE convention per file so
    // the decisive rows carry the ambiguous ones. Ties fall back to 'dot'.
    function detectDecimalStyle(values) {
        let comma = 0, dot = 0;
        for (const raw of values) {
            let s = String(raw ?? '').trim();
            const m = s.match(/^\((.*)\)$/);
            if (m) s = m[1];
            s = s.replace(/[$£€\s]/g, '');
            const hasDot = s.includes('.'), hasComma = s.includes(',');
            if (hasDot && hasComma) {
                if (s.lastIndexOf(',') > s.lastIndexOf('.')) comma++; else dot++;
            } else if (hasComma && /,\d{1,2}$/.test(s)) {
                comma++;                       // decimal comma: "12,5" / "12,50"
            } else if (hasDot && /\.\d{1,2}$/.test(s)) {
                dot++;                         // decimal dot: "12.5" / "12.50"
            }
        }
        return comma > dot ? 'comma' : 'dot';
    }

    // Strips currency symbols, grouping separators, whitespace; understands
    // accountant parentheses ("(12.34)" → -12.34) and European decimal commas
    // ("1.234,56" → 1234.56 — stripping the comma as grouping would corrupt
    // the amount 100×). `style` is the file-level convention from
    // detectDecimalStyle; without it the value's own shape decides (both
    // separators → the last one is the decimal; a lone comma with 1-2
    // trailing digits is a decimal comma; anything else reads as US).
    // Returns float or NaN.
    function parseAmount(s, style = null) {
        if (s === null || s === undefined) return NaN;
        s = String(s).trim();
        let neg = false;
        const m = s.match(/^\((.*)\)$/);
        if (m) { neg = true; s = m[1]; }
        s = s.replace(/[$£€\s]/g, '');
        if (style === null) {
            if (s.includes('.') && s.includes(',')) {
                style = s.lastIndexOf(',') > s.lastIndexOf('.') ? 'comma' : 'dot';
            } else {
                style = /,\d{1,2}$/.test(s) ? 'comma' : 'dot';
            }
        }
        s = style === 'comma'
            ? s.replace(/\./g, '').replace(/,/g, '.')
            : s.replace(/,/g, '');
        const v = parseFloat(s);
        return neg ? -v : v;
    }

    // Fingerprint for dup detection — must match the backend formula in
    // api_transactions_hashes: "date|amount|description.lower()"
    function fingerprint(row) {
        return `${row.date}|${Math.abs(row.amount).toFixed(2)}|${(row.description || '').toLowerCase().trim()}`;
    }

    // ── Apply a column mapping → validated row objects ───────────────────────
    // firstRowNum is what "row N" means in error messages: 2 for tabular
    // files (row 1 is the header line), 1 for record formats like OFX/QIF.
    //
    // Two amount shapes: a single signed column (mapping.amount — direction by
    // sign, the bank convention) or split Debit/Credit columns (mapping.debit/
    // mapping.credit — direction by WHICH column holds the value, since banks
    // list positive magnitudes in both). Either split side may be unmapped.
    function applyMapping(rawRows, mapping, firstRowNum = 2) {
        const split = mapping.debit != null || mapping.credit != null;

        // One decimal convention per file, inferred over every amount cell
        // (both columns in split mode), so an ambiguous grouped value like
        // "1.234" is read under the same convention as the decisive rows.
        const amountCells = [];
        for (const row of rawRows) {
            if (split) {
                if (mapping.debit  != null) amountCells.push(row[mapping.debit]  ?? '');
                if (mapping.credit != null) amountCells.push(row[mapping.credit] ?? '');
            } else {
                amountCells.push(row[mapping.amount] ?? '');
            }
        }
        const style = detectDecimalStyle(amountCells);

        const parsed = [], errors = [];
        rawRows.forEach((row, i) => {
            const rowNum   = i + firstRowNum;
            const dateRaw  = row[mapping.date]        ?? '';
            const descRaw  = (row[mapping.description] ?? '').trim();
            const notesRaw = mapping.notes !== null ? (row[mapping.notes] ?? '').trim() : '';

            const date = parseIsoDate(dateRaw);
            if (!date) {
                errors.push({ row: rowNum, reason: `unparseable date "${dateRaw}"` });
                return;
            }

            let amount, tx_type;
            if (split) {
                // null = side unmapped or cell blank; {bad} = present but
                // unparseable; {value} = a parsed number.
                const readSide = (idx) => {
                    if (idx == null) return null;
                    const raw = String(row[idx] ?? '').trim();
                    if (raw === '') return null;
                    const v = parseAmount(raw, style);
                    return Number.isNaN(v) ? { raw, bad: true } : { raw, value: v };
                };
                const deb = readSide(mapping.debit);
                const cre = readSide(mapping.credit);
                if (deb?.bad || cre?.bad) {
                    errors.push({ row: rowNum, reason: `unparseable amount "${(deb?.bad ? deb : cre).raw}"` });
                    return;
                }
                if (deb && cre && deb.value !== 0 && cre.value !== 0) {
                    // Direction would be a guess — refuse rather than pick.
                    errors.push({ row: rowNum, reason: 'both debit and credit have values' });
                    return;
                }
                // The non-zero side wins; a lone zero cell still carries its
                // column's direction (a zero in the other column is filler).
                const side = (deb && deb.value !== 0) ? 'debit'
                           : (cre && cre.value !== 0) ? 'credit'
                           : deb ? 'debit' : cre ? 'credit' : null;
                if (side === null) {
                    errors.push({ row: rowNum, reason: 'empty amount' });
                    return;
                }
                amount  = Math.abs(side === 'debit' ? deb.value : cre.value);
                tx_type = side === 'debit' ? 'expense' : 'income';
            } else {
                const amtRaw = row[mapping.amount] ?? '';
                const v = parseAmount(amtRaw, style);
                if (Number.isNaN(v)) {
                    errors.push({ row: rowNum, reason: `unparseable amount "${amtRaw}"` });
                    return;
                }
                amount  = Math.abs(v);
                tx_type = v >= 0 ? 'income' : 'expense';
            }

            if (!descRaw) {
                errors.push({ row: rowNum, reason: 'empty description' });
                return;
            }
            parsed.push({ date, description: descRaw, tx_type, amount, notes: notesRaw });
        });
        return { parsed, errors };
    }

    const TxParse = {
        parseFile,
        parseDelimited, detectDelimiter, parseOFX, parseQIF, parseJSONTable, parseXLSX,
        detectColumns, applyMapping,
        parseIsoDate, parseAmount, detectDecimalStyle, fingerprint,
        decodeText, unescapeXml,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = TxParse;
    else window.TxParse = TxParse;
}());
