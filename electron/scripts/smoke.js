'use strict';

// Backend smoke test under the REAL Electron runtime (not host Node): proves
// the native module loads on Electron's ABI and the full conn → router →
// handlers stack works in the main process. No window. Exits 0 on success.
//
//   npm run smoke

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.whenReady().then(() => {
  let failed = false;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-smoke-'));
  process.env.FINANCE_LAB_DATA_DIR = tmp;
  delete process.env.FINANCE_LAB_DB_PATH;

  try {
    const { createConn } = require('../backend/conn');
    const { dispatch } = require('../backend/routes');
    const conn = createConn();
    conn.init();

    const check = (label, cond) => {
      console.log(`${cond ? 'ok ' : 'FAIL'}  ${label}`);
      if (!cond) failed = true;
    };

    const status = dispatch(conn, 'GET', '/api/db/status', null);
    check('db status 200 + unlocked', status.status === 200 && status.body.locked === false);

    const data = dispatch(conn, 'GET', '/api/data', null);
    check('I&E data has seeded columns', data.status === 200 && data.body.columns.length === 11);

    const tx = dispatch(conn, 'POST', '/api/transactions', {
      date: '2026-06-11', description: 'smoke tx', tx_type: 'expense', amount: 12.345,
    });
    check('create tx rounds to cents', tx.status === 200 && tx.body.transaction.amount === 12.35);

    const list = dispatch(conn, 'GET', '/api/transactions', null);
    check('tx listed', list.body.transactions.length === 1);

    const enc = dispatch(conn, 'POST', '/api/db/create', {
      path: path.join(tmp, 'enc.db'), encrypt: true, password: 'smoke-pw',
    });
    check('encrypted db created', enc.status === 200 && enc.body.encrypted === true);
    const probe = dispatch(conn, 'GET', '/api/data', null);
    check('encrypted db serves data', probe.status === 200);

    conn.closeAll();
  } catch (e) {
    console.error('FAIL  exception:', e);
    failed = true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? 'SMOKE: FAIL' : 'SMOKE: PASS');
  app.exit(failed ? 1 : 0);
});
