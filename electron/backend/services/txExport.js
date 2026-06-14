'use strict';

// Transaction export serialisers — CSV, OFX/QFX (SGML v1), and QIF. Pure
// functions, no DB handle: the handler feeds rows that already carry the
// derived direction (COALESCE(category.cat_type, tx_type)) and the category
// name, and writes the returned strings to disk.
//
// Every format is split into header / body / footer so the export route can
// stream chunk by chunk: the header is written with the first chunk, each
// chunk appends its rows, and the footer lands with the last one. `meta`
// (date range, net balance, "now") is only consulted by the OFX family.
//
// Amounts are stored as positive magnitudes with tx_type carrying the
// direction (see services/transactions.js); export files use the signed
// convention every importer expects — income positive, everything else
// negative — which is also exactly how txfileimport.js reads them back in.

const EXPORT_FORMATS = ['csv', 'ofx', 'qfx', 'qif'];

// Bank-export convention (and RFC 4180 for CSV) is CRLF line endings.
const CRLF = '\r\n';

function signedAmount(t) {
  const amt = t.tx_type === 'income' ? t.amount : -t.amount;
  return amt.toFixed(2);
}

// ISO 'YYYY-MM-DD' → OFX compact 'YYYYMMDD'.
const compactDate = (iso) => String(iso || '').replace(/-/g, '');

// Local date-time as 'YYYYMMDDHHMMSS' — OFX timestamps, like the rest of the
// app's notion of "today" (services/predictions.js), are local time.
function compactDateTime(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// RFC 4180 quoting: only fields containing a quote, comma, or newline are
// wrapped, with embedded quotes doubled.
function csvField(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// OFX SGML uses XML entities for markup characters in values; the import
// parser (txfileimport.js unescapeXml) reverses exactly this set.
function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const csv = {
  header: () => 'Date,Description,Type,Category,Amount,Notes' + CRLF,
  row: (t) =>
    [t.date, t.description, t.tx_type, t.category_name || '', signedAmount(t), t.notes || '']
      .map(csvField)
      .join(',') + CRLF,
  footer: () => '',
};

const qif = {
  header: () => '!Type:Bank' + CRLF,
  // One record per transaction: D date · T signed amount · P payee ·
  // L category · M memo, terminated by '^'. Quicken's native date dialect
  // is US MM/DD/YYYY.
  row: (t) => {
    const [y, m, d] = String(t.date || '').split('-');
    const lines = [`D${m}/${d}/${y}`, `T${signedAmount(t)}`, `P${t.description || ''}`];
    if (t.category_name) lines.push(`L${t.category_name}`);
    if (t.notes) lines.push(`M${t.notes}`);
    lines.push('^');
    return lines.join(CRLF) + CRLF;
  },
  footer: () => '',
};

// OFX 1.x SGML — the dialect banks actually emit (unclosed value tags), and
// the one both Quicken and our own importer understand. QFX is the same
// stream plus Intuit's <INTU.BID> tag in the signon block; 3000 is the
// generic placeholder ID commonly used for non-bank exports.
function ofxVariant(intuBid) {
  return {
    header: (meta) => {
      const now = compactDateTime(meta.now);
      // An empty ledger still produces a well-formed file: the transaction
      // list's range collapses to "now".
      const start = compactDate(meta.firstDate) || now.slice(0, 8);
      const end = compactDate(meta.lastDate) || now.slice(0, 8);
      return [
        'OFXHEADER:100',
        'DATA:OFXSGML',
        'VERSION:102',
        'SECURITY:NONE',
        'ENCODING:UTF-8',
        'CHARSET:NONE',
        'COMPRESSION:NONE',
        'OLDFILEUID:NONE',
        'NEWFILEUID:NONE',
        '',
        '<OFX>',
        '<SIGNONMSGSRSV1>',
        '<SONRS>',
        '<STATUS>',
        '<CODE>0',
        '<SEVERITY>INFO',
        '</STATUS>',
        `<DTSERVER>${now}`,
        '<LANGUAGE>ENG',
        ...(intuBid ? [`<INTU.BID>${intuBid}`] : []),
        '</SONRS>',
        '</SIGNONMSGSRSV1>',
        '<BANKMSGSRSV1>',
        '<STMTTRNRS>',
        '<TRNUID>1',
        '<STATUS>',
        '<CODE>0',
        '<SEVERITY>INFO',
        '</STATUS>',
        '<STMTRS>',
        '<CURDEF>USD',
        '<BANKACCTFROM>',
        '<BANKID>FINANCELAB',
        '<ACCTID>TRANSACTIONS',
        '<ACCTTYPE>CHECKING',
        '</BANKACCTFROM>',
        '<BANKTRANLIST>',
        `<DTSTART>${start}`,
        `<DTEND>${end}`,
        '',
      ].join(CRLF);
    },
    row: (t) => {
      const lines = [
        '<STMTTRN>',
        `<TRNTYPE>${t.tx_type === 'income' ? 'CREDIT' : 'DEBIT'}`,
        `<DTPOSTED>${compactDate(t.date)}`,
        `<TRNAMT>${signedAmount(t)}`,
        // FITID must be unique within the account; the row id is exactly that.
        `<FITID>FL-${t.id}`,
        `<NAME>${escapeXml(t.description)}`,
      ];
      if (t.notes) lines.push(`<MEMO>${escapeXml(t.notes)}`);
      lines.push('</STMTTRN>');
      return lines.join(CRLF) + CRLF;
    },
    footer: (meta) =>
      [
        '</BANKTRANLIST>',
        '<LEDGERBAL>',
        `<BALAMT>${(meta.balance ?? 0).toFixed(2)}`,
        `<DTASOF>${compactDateTime(meta.now)}`,
        '</LEDGERBAL>',
        '</STMTRS>',
        '</STMTTRNRS>',
        '</BANKMSGSRSV1>',
        '</OFX>',
        '',
      ].join(CRLF),
  };
}

const SERIALISERS = {
  csv,
  qif,
  ofx: ofxVariant(null),
  qfx: ofxVariant('3000'),
};

/** Opening section of the file, written once with the first chunk. */
function exportHeader(format, meta) {
  return SERIALISERS[format].header(meta);
}

/** Serialise one chunk of rows (each already carrying derived tx_type and
 *  category_name). */
function exportBody(format, txs) {
  const ser = SERIALISERS[format];
  let out = '';
  for (const t of txs) out += ser.row(t);
  return out;
}

/** Closing section, appended after the last chunk. */
function exportFooter(format, meta) {
  return SERIALISERS[format].footer(meta);
}

module.exports = { EXPORT_FORMATS, exportHeader, exportBody, exportFooter };
