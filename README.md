# Oliv

**Oliv is an offline and private finance app for people who want a money management suite without worrying about accounts and subscriptions.**

I built Oliv out of a personal need. I had been using a very large spreadsheet
to manage all of my finanaces, accounts, and investing goals for over 7 years. It got 
so big that it became incredibly slow and unwieldable. I wanted something more powerful,
but as someone who treats privacy and security seriously, there were not any tools that 
I felt I could trust. And the spreadsheet I had was making it not only difficult to 
manage my own finances, but impossible to share with anyone else who wanted to use 
my method of money management to improve their financial situation. 

🌐 [olivfinance.com](https://olivfinance.com)

---

## Why Oliv

- **Local & private by design.** Your data lives in a single SQLite file on your
  computer. There is no account, no server, no telemetry. 
- **Optional at-rest encryption.** Databases can be encrypted with SQLCipher at
  creation time; encrypted files start locked and require your passphrase to open. The
  passphrase is never written to disk.
- **Buy it once.** No subscriptions, no recurring fees.
- **Beyond budgeting.** Oliv is built for budgeting *and* wealth management — from
  monthly cash flow all the way to tracking and optimizing capital over the years.


## Install

Grab the latest build for your platform from [olivfinance.com](https://olivfinance.com).
Packaged downloads are available for **Linux (`.deb`)** and **Windows (installer)**.

> Prefer to build it yourself? See [For developers](#for-developers) at the bottom.

## Getting started

1. **Launch Oliv.**
2. **Create a database.** On first run, use the database modal (sidebar) to create a new
   database file at a location you choose. To keep your data encrypted at rest, set a
   passphrase here — you'll be prompted to unlock it on future launches.
3. **Add or import transactions.** Head to **Transactions** to enter activity manually,
   or import a statement file (CSV/OFX/QFX/QIF) from your bank.
4. **Categorize.** Assign categories to transactions — Oliv learns from your choices and
   starts categorizing future activity automatically.
5. **Track your flow.** Use **Cash Flow** to see income and expenses by category and
   month. Turn on **sync** for any category/year to have it computed straight from your
   transactions.
6. **Look ahead and zoom out.** Check the **Cash Flow Forecast**, **Balance Sheet**, and
   **Portfolio** to project ahead and watch your net worth grow.

Your settings (theme, currency, zoom) persist across launches; your financial data stays
in the database file you created — back it up like any other important file.

## Request a feature

Have an idea that would make Oliv better? Use the feature request portal:

👉 **[olivfinance.com/feature-request.html](https://olivfinance.com/feature-request.html)**

It walks you through a short form and opens a prefilled issue on Oliv's public GitHub
tracker — so requests stay out in the open where anyone can follow, weigh in, or pick
them up. (A free GitHub account is needed to post.)

## License

Oliv is released under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0).
See [LICENSE](LICENSE) for details.

---

## For developers

The rest of this README is for people who want to build, run, or hack on Oliv from
source. You'll need [Node.js](https://nodejs.org) and npm.

### Build & run

```bash
git clone <repo-url>
cd oliv-app/electron
npm install        # postinstall fetches the correct native SQLite binaries
npm start          # launch the app
```

> **Note on native modules:** Oliv uses `better-sqlite3-multiple-ciphers`, which is
> ABI-specific. The `postinstall` step (`scripts/setup-native-abis.js`) fetches the
> prebuilt binaries for both your host Node and Electron, so no C toolchain is needed
> for local development.

### Package distributable installers

```bash
npm run dist:linux   # Linux .deb
npm run dist:win     # Windows NSIS installer
```

### Test & verify

```bash
npm test                             # backend test suite (host Node, no Electron)
npm run smoke                        # backend stack under the real Electron runtime
npx electron scripts/verify-e2e.js   # boots the real app, asserts from the renderer
```

### Project layout

The frontend is plain HTML/CSS/JS with **no build step** — edit files in `pages/` and
`static/` and reload the window (Ctrl+R). Backend changes (`electron/backend/`,
`main.js`, `preload.js`) require restarting the app. See [CLAUDE.md](CLAUDE.md) for the
full architecture overview.
