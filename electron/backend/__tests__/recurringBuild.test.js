'use strict';

// The schedule builder — GET /api/recurring/merchants, GET
// /api/recurring/similar, POST /api/recurring/preview, POST /api/recurring/build.
//
// These cover the two ledger shapes detection cannot reach on its own, both
// taken from a real database (see services/recurringRules.js):
//
//   1. A RENAMED series. One biweekly payroll arriving under three bank
//      spellings is three short series, and the older two fall outside
//      LAPSED_GRACE_DAYS and disappear. Aliasing the three keys makes it one.
//   2. A POLLUTED series. A small off-cycle reimbursement sharing the paycheck's
//      description is counted as a charge; it splits a clean 14-day gap and
//      drags regularity under MIN_REGULARITY, deleting the series outright. An
//      amount band drops it.
//
// Fixture descriptions are invented, per the synthetic-fixture rule.

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');

function insertTx(c, { date, amount, description, tx_type = 'income' }) {
  c.conn
    .db()
    .prepare(
      `INSERT INTO transactions (date, description, display_name, category_id, amount, notes, tx_type)
       VALUES (?, ?, NULL, NULL, ?, '', ?)`
    )
    .run(date, description, amount, tx_type);
}

function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * A biweekly payroll the bank renamed twice. The oldest spelling stops ~11
 * months back, the middle one ~5 months back, and only the newest is current —
 * so the two older runs are perfectly regular AND individually invisible,
 * which is the whole point of the fixture.
 */
function seedRenamedPayroll(c) {
  const names = ['DIRECT DEP NORTHWIND LABS', 'PAYROLL NORTHWIND LABS', 'NORTHWIND LABS'];
  // 24 fortnights back to now, oldest name first, switching every 8 deposits.
  for (let i = 23; i >= 0; i--) {
    const name = names[Math.min(2, Math.floor((23 - i) / 8))];
    insertTx(c, { date: daysAgoIso(i * 14), amount: 1400 + (i % 5) * 10, description: name });
  }
  return names;
}

test('builder: a renamed series is invisible to detection but assembles into one schedule', (t) => {
  const c = makeClient(t);
  seedRenamedPayroll(c);

  // Detection alone finds only the still-current spelling, and cannot even
  // measure that one: 8 deposits under the newest name is a real series, but
  // the other 16 sit in two runs that lapsed.
  const found = c.get('/api/recurring/candidates').body.candidates;
  const byKey = new Map(found.map((s) => [s.key, s]));
  assert.ok(!byKey.has('direct dep northwind labs'), 'the oldest spelling has lapsed out of detection');
  assert.ok(!byKey.has('payroll northwind labs'), 'the middle spelling has lapsed out of detection');

  const similar = c.get('/api/recurring/similar?key=northwind labs');
  assert.equal(similar.status, 200, JSON.stringify(similar.body));
  const keys = similar.body.matches.map((m) => m.key).sort();
  assert.deepStrictEqual(
    keys,
    ['direct dep northwind labs', 'northwind labs', 'payroll northwind labs'],
    'all three spellings are offered, and nothing else'
  );
  assert.equal(similar.body.matches.filter((m) => m.exact).length, 1, 'exactly one match is the seed itself');

  const built = c.post('/api/recurring/build', { keys });
  assert.equal(built.status, 200, JSON.stringify(built.body));
  assert.equal(built.body.key, 'northwind labs', 'the current spelling becomes the schedule key');
  assert.equal(built.body.aliases, 2);
  assert.equal(built.body.detected, true, 'the assembled set is long enough to measure');

  const series = c.get('/api/recurring').body.series;
  assert.equal(series.length, 1, 'one schedule, not three');
  assert.equal(series[0].key, 'northwind labs');
  assert.equal(series[0].cycle, 'biweekly');
  assert.equal(series[0].occurrences, 24, 'all three spellings count as one history');
});

test('builder: an off-cycle extra under the same description is excluded by the amount band', (t) => {
  const c = makeClient(t);
  // Six clean biweekly paychecks...
  for (let i = 5; i >= 0; i--) {
    insertTx(c, { date: daysAgoIso(i * 14), amount: 1450, description: 'NORTHWIND LABS' });
  }
  // ...plus one small reimbursement, on an off-cycle day, identically worded.
  insertTx(c, { date: daysAgoIso(37), amount: 72.51, description: 'NORTHWIND LABS' });

  assert.equal(
    c.get('/api/recurring/candidates').body.candidates.length, 0,
    'one $72 row breaks the cadence measured from six clean paychecks'
  );

  const preview = c.post('/api/recurring/preview', { keys: ['northwind labs'] });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.ok(preview.body.suggested_band, 'a band is suggested');
  assert.ok(preview.body.suggested_band.min > 72.51, 'the suggested band clears the outlier');
  assert.ok(preview.body.suggested_band.max > 1450, 'and still admits the real charges');

  const band = preview.body.suggested_band;
  const withBand = c.post('/api/recurring/preview', {
    keys: ['northwind labs'], amount_min: band.min, amount_max: band.max,
  });
  assert.equal(withBand.body.excluded_count, 1);
  assert.equal(withBand.body.needs_cycle, false);
  assert.equal(withBand.body.series.cycle, 'biweekly');

  c.post('/api/recurring/build', { keys: ['northwind labs'], amount_min: band.min, amount_max: band.max });
  const series = c.get('/api/recurring').body.series;
  assert.equal(series.length, 1);
  assert.equal(series[0].cycle, 'biweekly');
  assert.equal(series[0].occurrences, 6, 'the reimbursement is not an occurrence');
});

test('builder: a schedule too short to measure needs a cycle, then saves as a manual one', (t) => {
  const c = makeClient(t);
  insertTx(c, { date: daysAgoIso(30), amount: 60, description: 'CEDAR CREEK GYM', tx_type: 'expense' });
  insertTx(c, { date: daysAgoIso(0), amount: 60, description: 'CEDAR CREEK GYM', tx_type: 'expense' });

  const preview = c.post('/api/recurring/preview', { keys: ['cedar creek gym'] });
  assert.equal(preview.body.needs_cycle, true, 'two charges cannot produce a cadence');
  assert.equal(preview.body.series, null);

  const refused = c.post('/api/recurring/build', { keys: ['cedar creek gym'] });
  assert.equal(refused.status, 422, 'building without a cycle is refused, not guessed');

  const built = c.post('/api/recurring/build', { keys: ['cedar creek gym'], cycle: 'monthly' });
  assert.equal(built.status, 200, JSON.stringify(built.body));
  assert.equal(built.body.detected, false);

  const series = c.get('/api/recurring').body.series;
  assert.equal(series.length, 1);
  assert.equal(series[0].cycle, 'monthly');
  assert.equal(series[0].direction, 'expense', 'direction comes from the picked rows');
  assert.ok(series[0].next_date > daysAgoIso(0), 'it projects forward rather than sitting in the past');
});

test('builder: future charges join a built schedule with no further action', (t) => {
  const c = makeClient(t);
  seedRenamedPayroll(c);
  const keys = c.get('/api/recurring/similar?key=northwind labs').body.matches.map((m) => m.key);
  c.post('/api/recurring/build', { keys });
  assert.equal(c.get('/api/recurring').body.series[0].occurrences, 24);

  // A later import lands another deposit under an ALIASED spelling. Membership
  // is recomputed from transactions on every read, so nothing needs re-running.
  insertTx(c, { date: daysAgoIso(-14), amount: 1455, description: 'PAYROLL NORTHWIND LABS' });
  const series = c.get('/api/recurring').body.series;
  assert.equal(series.length, 1, 'still one schedule');
  assert.equal(series[0].occurrences, 25, 'the new charge joined it');
});

test('builder: a fragment already adopted as its own schedule is absorbed, not refused', (t) => {
  const c = makeClient(t);
  seedRenamedPayroll(c);

  // The shape a real ledger was found in: a middle spelling was adopted months
  // ago, back when it was still detectable, and it has since lapsed off the
  // calendar without being deleted. Its override row is still adopted.
  c.post('/api/recurring/adopt', { keys: ['payroll northwind labs'] });

  const matches = c.get('/api/recurring/similar?key=northwind labs').body.matches;
  assert.equal(
    matches.find((m) => m.key === 'payroll northwind labs').adopted, true,
    'the dialog is told that row is a schedule today'
  );

  const built = c.post('/api/recurring/build', { keys: matches.map((m) => m.key) });
  assert.equal(built.status, 200, JSON.stringify(built.body));
  assert.equal(built.body.absorbed, 1, 'the stale schedule is folded in rather than blocking the build');

  const series = c.get('/api/recurring').body.series;
  assert.equal(series.length, 1, 'the absorbed fragment is not listed beside the schedule that now owns it');
  assert.equal(series[0].key, 'northwind labs');
  assert.equal(series[0].occurrences, 24);
});

test('builder: a description already owned by another schedule is refused', (t) => {
  const c = makeClient(t);
  seedRenamedPayroll(c);
  const keys = c.get('/api/recurring/similar?key=northwind labs').body.matches.map((m) => m.key);
  c.post('/api/recurring/build', { keys });

  const stolen = c.post('/api/recurring/build', { keys: ['payroll northwind labs'], cycle: 'monthly' });
  assert.equal(stolen.status, 409, JSON.stringify(stolen.body));
});

test('builder: rebuilding a schedule replaces its aliases rather than accumulating them', (t) => {
  const c = makeClient(t);
  seedRenamedPayroll(c);
  const all = c.get('/api/recurring/similar?key=northwind labs').body.matches.map((m) => m.key);
  c.post('/api/recurring/build', { keys: all });
  assert.equal(c.get('/api/recurring').body.series[0].occurrences, 24);

  // Rebuild with the oldest spelling unticked: its charges must leave.
  const fewer = all.filter((k) => k !== 'direct dep northwind labs');
  const again = c.post('/api/recurring/build', { keys: fewer });
  assert.equal(again.body.aliases, 1);
  assert.equal(
    c.conn.db().prepare('SELECT COUNT(*) n FROM recurring_aliases').get().n, 1,
    'the dropped alias row is gone, not merely unused'
  );
  assert.equal(c.get('/api/recurring').body.series[0].occurrences, 16);
});

test('builder: deleting a built schedule takes its aliases with it', (t) => {
  const c = makeClient(t);
  insertTx(c, { date: daysAgoIso(30), amount: 60, description: 'CEDAR CREEK GYM', tx_type: 'expense' });
  insertTx(c, { date: daysAgoIso(0), amount: 60, description: 'CEDAR GYM', tx_type: 'expense' });
  c.post('/api/recurring/build', { keys: ['cedar creek gym', 'cedar gym'], cycle: 'monthly' });
  assert.equal(c.conn.db().prepare('SELECT COUNT(*) n FROM recurring_aliases').get().n, 1);

  // Not detected (two charges), so this is a hard delete and must not leave an
  // alias row pointing at a schedule that no longer exists.
  c.del('/api/recurring/schedule/cedar gym');
  assert.equal(c.conn.db().prepare('SELECT COUNT(*) n FROM recurring_aliases').get().n, 0);
  assert.equal(c.get('/api/recurring').body.series.length, 0);
});

test('builder: merchant search finds a merchant detection never surfaced', (t) => {
  const c = makeClient(t);
  seedRenamedPayroll(c);

  const r = c.get('/api/recurring/merchants?q=northwind');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.merchants.length, 3);
  // Newest first: the spelling in use now is the one the user is looking for.
  assert.equal(r.body.merchants[0].key, 'northwind labs');
  assert.ok(r.body.merchants[0].count > 0);
  assert.ok(r.body.merchants[0].amount_median > 0);

  assert.deepStrictEqual(c.get('/api/recurring/merchants?q=').body.merchants, [],
    'an empty search returns nothing rather than the whole ledger');
});

test('builder: an unrelated merchant with a similar name is offered, not assumed', (t) => {
  const c = makeClient(t);
  for (let i = 5; i >= 0; i--) {
    insertTx(c, { date: daysAgoIso(i * 30), amount: 200, description: 'ZELLE PAYMENT FROM RIVER STONE' });
  }
  insertTx(c, { date: daysAgoIso(10), amount: 40, description: 'ZELLE PAYMENT FROM MAPLE FIELD' });

  const matches = c.get('/api/recurring/similar?key=zelle payment from river stone').body.matches;
  const other = matches.find((m) => m.key === 'zelle payment from maple field');
  assert.ok(other, 'the similar name is surfaced for the user to judge');
  assert.equal(other.exact, false, 'and is not marked as the seed');
  assert.equal(other.count, 1);
  // Building with only the exact key must leave the other merchant alone.
  c.post('/api/recurring/build', { keys: ['zelle payment from river stone'] });
  assert.equal(c.get('/api/recurring').body.series[0].occurrences, 6);
});

test('builder: bands and aliases do not disturb an ordinary detected schedule', (t) => {
  const c = makeClient(t);
  for (let i = 5; i >= 0; i--) {
    insertTx(c, { date: daysAgoIso(i * 30), amount: 15, description: 'ORCHARD STREAMING', tx_type: 'expense' });
  }
  const before = c.get('/api/recurring/candidates').body.candidates;
  assert.equal(before.length, 1);
  assert.equal(before[0].cycle, 'monthly');

  // Build an unrelated schedule; the untouched one must be byte-identical.
  insertTx(c, { date: daysAgoIso(0), amount: 900, description: 'HARBOR POINT RENT', tx_type: 'expense' });
  insertTx(c, { date: daysAgoIso(30), amount: 900, description: 'HARBOR RENT', tx_type: 'expense' });
  c.post('/api/recurring/build', { keys: ['harbor point rent', 'harbor rent'], cycle: 'monthly' });

  const after = c.get('/api/recurring/candidates').body.candidates;
  assert.deepStrictEqual(after, before, 'the streaming schedule is unchanged');
});
