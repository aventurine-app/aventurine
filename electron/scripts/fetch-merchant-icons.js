'use strict';

// ─── fetch-merchant-icons.js ────────────────────────────────────────────────
// DEV-ONLY BUILD TOOL. Downloads a favicon for each brand in the merchant
// lexicon (backend/services/merchantCategories.js) and normalizes it into
// static/merchant-icons/<slug>.png, then writes the renderer's lookup table
// static/js/core/merchant-icons.js.
//
// This is the ONLY place a network call happens, and it happens on a
// developer's machine, never in the app: the icons are committed and shipped
// as ordinary bundled assets (static/ goes into the package via
// electron-builder's extraResources), so the "local-first & offline, no
// required network calls" guardrail in .claude/PRODUCT.md still holds at
// runtime. Nothing regenerates these during a build — same deal as the
// packaging icons in build/ (see make-icons.js).
//
//   node scripts/fetch-merchant-icons.js              # resolve + download
//   node scripts/fetch-merchant-icons.js --manifest   # re-audit + rewrite the
//                                                     #   manifest, no network
//   node scripts/fetch-merchant-icons.js --only nike  # one brand (debugging)
//   node scripts/fetch-merchant-icons.js --refresh    # ignore caches, redo
//   node scripts/fetch-merchant-icons.js --retry      # reopen settled failures
//   node scripts/fetch-merchant-icons.js --reverify   # re-test cached domains
//                                                     #   against the current gates
//   …plus --limit N and -v/--verbose (per-URL reasons for every rejection).
//
// A plain re-run is incremental and safe: it skips brands that already have an
// icon and brands cached as having no domain, so it retries exactly the ones
// that had a domain but no usable favicon. Requires ImageMagick (`magick`) on
// PATH, and curl (see curlFetch for why not Node's fetch).
//
// ── How a brand gets an icon ────────────────────────────────────────────────
// 1. DOMAIN. From data/merchant-domain-overrides.json when the brand is listed
//    there (a `null` value means "we looked, there is no usable site — stop
//    asking"), otherwise guessed from the display name (traderjoes.com,
//    trader-joes.com, …) and VERIFIED: the candidate site's <title> /
//    og:site_name / application-name must contain the brand name. The gate is
//    what keeps a domain squatter's parking page from becoming "Trader Joe's".
//    Results land in data/merchant-domains.json, which is committed so a re-run
//    is cheap and reviewable.
// 2. ICON. The verified page's <link rel="…icon…"> tags, best-first (biggest
//    declared size wins, apple-touch-icon is a good fallback because it is
//    usually a clean 180px square), then the conventional paths (/favicon.ico
//    and friends) — which are worth trying even when the homepage itself was
//    refused, since bot walls guard HTML and rarely the icon.
// 3. NORMALIZE. ImageMagick to a 48×48 PNG8 — ~1.5KB each instead of ~6KB, and
//    48px covers the largest place an avatar is drawn (28px) at 2× device
//    pixels. SVG favicons are skipped: rendering one needs librsvg, which is
//    not a dependency of this repo, and every brand that ships an SVG ships a
//    raster fallback too.
// 4. PRUNE. Three defects, none of them visible one brand at a time: an all-
//    but-transparent icon (a blank grey disc, worse than the initials it
//    replaced); DEFAULT art that isn't the brand's at all — the stock WordPress
//    mark, a hosting panel's house glyph — caught by the same bytes turning up
//    under several unrelated merchants and then blocklisted by hash; and art
//    left behind by a domain that has since been retracted. See
//    pruneGenericIcons.
//
// Precision-first, like the lexicon itself: every step abstains rather than
// guess. A brand with no verified domain, no readable icon, a favicon that
// fails to convert, or art that turns out to be generic simply gets no entry,
// and merchantAvatarHtml falls back to the initials circle it has always drawn.
// Expect roughly half the lexicon to end up with an icon; that is the design
// working, not a shortfall.
//
// ── Coverage is machine- and network-dependent ──────────────────────────────
// Big US retail sites (Home Depot, CVS, McDonald's, Planet Fitness) sit behind
// Akamai/Cloudflare bot walls that answer 403 to everything from some networks
// and regions, icon paths included. Re-running from elsewhere may pick them up;
// nothing here can, and they degrade to initials like any other miss.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execFileAsync = promisify(execFile);

const { MERCHANTS, merchantDisplayFor } = require('../backend/services/merchantCategories.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(__dirname, 'data');
const OVERRIDES_FILE = path.join(DATA_DIR, 'merchant-domain-overrides.json');
const DOMAINS_FILE = path.join(DATA_DIR, 'merchant-domains.json');
const GENERIC_FILE = path.join(DATA_DIR, 'generic-icon-hashes.json');
const ICON_DIR = path.join(REPO_ROOT, 'static', 'merchant-icons');
const MANIFEST_FILE = path.join(REPO_ROOT, 'static', 'js', 'core', 'merchant-icons.js');

// Sites reject or fingerprint an obviously scripted client; a plain desktop UA
// gets the same HTML a human would see, which is all we want to read.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_TIMEOUT = 10000;
const ICON_TIMEOUT = 10000;
const CONCURRENCY = 20;
const ICON_PX = 48;
const MAX_ICON_BYTES = 2 * 1024 * 1024; // a "favicon" bigger than this is a mistake
const HEAD_BYTES = 300 * 1024; // enough of the document to hold <head>

const argv = process.argv.slice(2);
const FLAG = {
    manifestOnly: argv.includes('--manifest'),
    refresh: argv.includes('--refresh'),
    retry: argv.includes('--retry') || argv.includes('--refresh'),
    only: (() => {
        const i = argv.indexOf('--only');
        if (i < 0) return null;
        return String(argv[i + 1] || '').split(',').map(slugifyArg).filter(Boolean);
    })(),
    limit: (() => {
        const i = argv.indexOf('--limit');
        return i >= 0 ? parseInt(argv[i + 1], 10) || 0 : 0;
    })(),
    reverify: argv.includes('--reverify'),
    verbose: argv.includes('-v') || argv.includes('--verbose'),
};

const vlog = (...a) => { if (FLAG.verbose) console.log('   ', ...a); };

function slugifyArg(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ── Slugs ───────────────────────────────────────────────────────────────────
// The renderer has no access to this lexicon (nodeIntegration is off), so the
// join between a label on screen and a file on disk is a slug both sides
// compute the same way: lowercase, alphanumerics only. It must stay identical
// to merchantIconSlug() in static/js/core/avatar.js.
function slugify(str) {
    return String(str || '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '');
}

// ── Brands ──────────────────────────────────────────────────────────────────
// One entry per DISPLAY NAME, not per needle: 'wendys' and "wendy's" are two
// needles for one restaurant, and duplicating the download (and the file)
// per spelling would be silly. Every needle that resolves to the display name
// becomes an alias slug pointing at the same icon, which widens what the
// renderer can match for free — a hand-typed recurring schedule called "Wendy's"
// hits the same file as an imported row named by the lexicon.
function collectBrands() {
    const brands = new Map(); // slug -> { slug, display, aliases:Set }
    for (const [needle] of MERCHANTS) {
        const display = merchantDisplayFor(needle);
        if (!display) continue; // generic needle: categorizes, never names
        const slug = slugify(display);
        if (!slug) continue;
        let brand = brands.get(slug);
        if (!brand) {
            brand = { slug, display, aliases: new Set([slug]) };
            brands.set(slug, brand);
        }
        const alias = slugify(needle);
        if (alias) brand.aliases.add(alias);
    }
    return [...brands.values()];
}

// ── Domain candidates ───────────────────────────────────────────────────────
// Cheap guesses in decreasing likelihood. Every one is gated by verifyPage(),
// so a wrong guess costs a request, not a wrong logo.
const GENERIC_TAIL = new Set([
    'market', 'markets', 'store', 'stores', 'company', 'co', 'inc',
    'restaurant', 'restaurants', 'shop', 'group', 'brands',
]);

function domainCandidates(display) {
    const words = String(display)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’.]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);
    if (!words.length) return [];

    const out = [];
    const push = (w) => {
        if (!w.length) return;
        out.push(w.join('') + '.com');
        if (w.length > 1) out.push(w.join('-') + '.com');
    };

    push(words);
    // "Kettle & Fire" is kettleandfire.com, but some brands drop the
    // conjunction entirely — try both.
    const noAnd = words.filter((w) => w !== 'and');
    if (noAnd.join('') !== words.join('')) push(noAnd);
    // NB: no "the<brand>.com" variant. It looks harmless (thefreshmarket.com
    // really is The Fresh Market) and it is not: on a trial run it resolved
    // Best Buy to thebestbuy.com and Marriott to themarriott.com, both of
    // which mention the brand often enough to pass the title check while being
    // nobody's official site. Prefixed guesses go in the overrides file, where
    // a human has looked at them.
    // Trailing generics are frequently absent from the domain ("Sprouts
    // Farmers Market" → sprouts.com). Peeling them is only safe because the
    // title check still has to see the full brand name.
    const trimmed = words.slice();
    while (trimmed.length > 1 && GENERIC_TAIL.has(trimmed[trimmed.length - 1])) {
        trimmed.pop();
        push(trimmed);
    }
    return [...new Set(out)];
}

// ── HTTP (curl, not fetch) ──────────────────────────────────────────────────
// Node's built-in fetch is refused by a good share of large retail sites:
// undici's TLS/ALPN fingerprint doesn't look like a browser, so Akamai and
// Cloudflare either hang it or answer a challenge page. Measured on this
// lexicon, curl with browser headers gets through where fetch times out
// (doordash.com, exxon.com among others), and it costs a process instead of a
// dependency. `--http1.1` is retried on curl 92 (HTTP/2 INTERNAL_ERROR), which
// a few CDNs return to clients they dislike.
async function curlFetch(url, { timeout, accept, maxBytes }) {
    const body = path.join(os.tmpdir(), `avfetch-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const base = [
        '-sSL', '--compressed',
        '--max-time', String(Math.ceil(timeout / 1000)),
        '--max-redirs', '10',
        '--max-filesize', String(maxBytes),
        '-A', UA,
        '-H', `Accept: ${accept}`,
        '-H', 'Accept-Language: en-US,en;q=0.9',
        '-o', body,
        '-w', '%{http_code}\t%{content_type}\t%{url_effective}',
    ];
    try {
        for (const args of [base, ['--http1.1', ...base]]) {
            let stdout;
            try {
                ({ stdout } = await execFileAsync('curl', [...args, url], { maxBuffer: 1 << 20 }));
            } catch (err) {
                // curl 92 is worth one HTTP/1.1 retry; anything else is final.
                if (err.code === 92 && args === base) continue;
                throw new Error(`curl ${err.code}`);
            }
            const [code, contentType, finalUrl] = String(stdout).split('\t');
            if (!/^2\d\d$/.test(code)) throw new Error(`HTTP ${code}`);
            const buf = fs.existsSync(body) ? fs.readFileSync(body) : Buffer.alloc(0);
            if (!buf.length) throw new Error('empty body');
            return { buf, contentType: (contentType || '').split(';')[0].trim(), finalUrl: finalUrl || url };
        }
        throw new Error('curl 92');
    } finally {
        fs.rmSync(body, { force: true });
    }
}

async function getPage(url) {
    const res = await curlFetch(url, {
        timeout: PAGE_TIMEOUT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        maxBytes: 4 * 1024 * 1024,
    });
    if (!/html|xml/i.test(res.contentType)) throw new Error(`not html (${res.contentType})`);
    // Only <head> matters; some retail homepages are megabytes of markup.
    return { finalUrl: res.finalUrl, html: res.buf.subarray(0, HEAD_BYTES).toString('utf8') };
}

// Magic bytes for the raster formats ImageMagick will take from us. Checking
// them is not paranoia: a bot-protected host answers /favicon.ico with a 200
// HTML challenge page often enough that trusting the status code alone would
// hand ImageMagick a pile of markup.
function imageKind(buf) {
    if (buf.length < 12) return null;
    if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
    if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
    if (buf.toString('latin1', 0, 2) === 'BM') return 'bmp';
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) return 'ico';
    return null;
}

async function getImage(url) {
    const res = await curlFetch(url, {
        timeout: ICON_TIMEOUT,
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        maxBytes: MAX_ICON_BYTES,
    });
    if (!imageKind(res.buf)) throw new Error('not a raster image');
    return res.buf;
}

// ── Verification ────────────────────────────────────────────────────────────
// The whole precision story rests here. A candidate domain is only accepted if
// the page NAMES the brand in one of the three places a site states its own
// identity. Comparing on the slug (alphanumerics only) makes the check immune
// to the punctuation and casing differences between "Trader Joe's" the lexicon
// entry and "Trader Joe's" the page title.
function pageIdentity(html) {
    const head = html.slice(0, HEAD_BYTES);
    const parts = [];
    const title = head.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
    if (title) parts.push(title[1]);
    const metaRe = /<meta\s+[^>]*>/gi;
    let m;
    while ((m = metaRe.exec(head))) {
        const tag = m[0];
        const name = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (!name) continue;
        if (!/^(og:site_name|application-name|apple-mobile-web-app-title|og:title)$/i.test(name)) continue;
        const content = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
        if (content) parts.push(content);
    }
    return slugify(parts.join(' '));
}

// Two ways a candidate can pass, in descending confidence:
//
//   'verified' — the page names the brand. The strong case, and the only one
//                available to a guessed variant (hyphenated, tail-trimmed).
//   'exact'    — the page states NO identity at all (a client-rendered shell
//                whose <title> is filled in by JavaScript we don't run —
//                nordstrom.com is one) AND the candidate is the brand's exact
//                name as a .com. Restricting the weaker rule to title-less
//                pages is what keeps it safe: a squatter's parking page has a
//                title, so it is rejected outright rather than falling through
//                to the name match. A page that names a DIFFERENT brand is
//                always a reject.
// Domain parking defeats the name check on its own, because a parking page
// ADVERTISES the name it is squatting: ajisenramen.com redirects to
// HugeDomains, whose title reads "AjisenRamen.com is for sale", which contains
// the brand and sails through. The icon that follows is the broker's, and it
// lands on a dozen unrelated merchants at once (pruneGenericIcons found exactly
// this cluster). So parking is rejected before the name is even considered —
// by where the redirect landed, and by the sales pitch in the title.
const PARKING_HOSTS = [
    'hugedomains.com', 'sedo.com', 'sedoparking.com', 'dan.com', 'afternic.com',
    'buydomains.com', 'domainmarket.com', 'undeveloped.com', 'squadhelp.com',
    'atom.com', 'namecheap.com', 'godaddy.com', 'parkingcrew.net', 'bodis.com',
    'above.com', 'brandbucket.com', 'domainnameshop.com', 'name.com',
];
const PARKING_PHRASES = /(isforsale|forsale|buythisdomain|domainforsale|domainisavailable|parkeddomain|domainparking|inquireaboutthisdomain)/;

function isParked(html, finalUrl) {
    try {
        const host = new URL(finalUrl).hostname.replace(/^www\./, '');
        if (PARKING_HOSTS.some((p) => host === p || host.endsWith(`.${p}`))) return true;
    } catch { /* unparseable URL — fall through to the text check */ }
    return PARKING_PHRASES.test(pageIdentity(html));
}

function verifyPage(html, brandSlug, candidate, finalUrl) {
    if (brandSlug.length < 3) return null;
    if (isParked(html, finalUrl)) return null;
    const identity = pageIdentity(html);
    if (identity.includes(brandSlug)) return 'verified';
    if (!identity && candidate === `${brandSlug}.com`) return 'exact';
    return null;
}

// ── Icon discovery ──────────────────────────────────────────────────────────
// Rank the <link rel="…icon…"> tags a page declares. Bigger is better (we
// downscale, never upscale); SVG is unusable here (no librsvg) so it is dropped
// outright rather than downloaded and thrown away.
function iconCandidates(html, finalUrl) {
    const found = [];
    const linkRe = /<link\s+[^>]*>/gi;
    let m;
    while ((m = linkRe.exec(html))) {
        const tag = m[0];
        const rel = (tag.match(/rel\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (!rel || !/\bicon\b/i.test(rel)) continue;
        const href = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (!href) continue;
        const type = (tag.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
        let url;
        try { url = new URL(href, finalUrl).href; } catch { continue; }
        if (/\.svg(\?|#|$)/i.test(url) || /svg/i.test(type)) continue;

        const sizes = (tag.match(/sizes\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
        const px = Math.max(0, ...sizes.split(/\s+/).map((s) => parseInt(s, 10) || 0));
        const apple = /apple-touch/i.test(rel);
        // An undeclared size is usually a 16-32px favicon; an apple-touch-icon
        // is usually 180px even when it says nothing. Score accordingly.
        const score = px || (apple ? 180 : 24);
        found.push({ url, score });
    }
    found.sort((a, b) => b.score - a.score);
    const urls = found.map((f) => f.url);
    try { urls.push(new URL('/favicon.ico', finalUrl).href); } catch { /* ignore */ }
    return [...new Set(urls)].slice(0, 5);
}

// ── Normalize ───────────────────────────────────────────────────────────────
// ImageMagick, because .ico is a container: Starbucks' favicon.ico holds 16,
// 32 and 48px frames and `magick file.ico out.png` would write three files.
// Pick the largest frame explicitly, then flatten everything to one 48px PNG8.
async function largestFrame(file) {
    try {
        const { stdout } = await execFileAsync('magick', ['identify', file], { maxBuffer: 4 << 20 });
        let best = { index: 0, px: 0 };
        stdout.trim().split('\n').forEach((line, i) => {
            const dim = line.match(/\s(\d+)x(\d+)\s/);
            const px = dim ? Math.max(+dim[1], +dim[2]) : 0;
            if (px > best.px) best = { index: i, px };
        });
        return best.index;
    } catch {
        return 0;
    }
}

async function normalizeIcon(buf, outFile) {
    // The extension is load-bearing, not cosmetic: ImageMagick sniffs PNG from
    // its header but refuses a headerless-looking .ico with "no decode
    // delegate", and .ico is the single most common favicon format. imageKind()
    // already identified the bytes — spell it out for magick.
    const kind = imageKind(buf);
    if (!kind) throw new Error('not a raster image');
    const tmp = path.join(os.tmpdir(), `avicon-${process.pid}-${Math.random().toString(36).slice(2)}.${kind}`);
    fs.writeFileSync(tmp, buf);
    try {
        const frame = await largestFrame(tmp);
        await execFileAsync('magick', [
            `${tmp}[${frame}]`,
            '-background', 'none',
            '-alpha', 'on',
            '-resize', `${ICON_PX}x${ICON_PX}`,
            '-gravity', 'center',
            '-extent', `${ICON_PX}x${ICON_PX}`,
            '-strip',
            '-colors', '128',
            '-define', 'png:compression-level=9',
            `PNG8:${outFile}`,
        ], { maxBuffer: 4 << 20 });
        if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
            throw new Error('magick produced nothing');
        }
        // A favicon that is (nearly) all transparency converts fine and ships a
        // blank grey disc — strictly worse than the initials it replaced, since
        // it says nothing while looking like it should. Two brands' "favicons"
        // in the lexicon are exactly this.
        const ink = await inkCoverage(outFile);
        if (ink < 0.02) throw new Error(`blank icon (${(ink * 100).toFixed(1)}% ink)`);
        // Generic art we have already caught wearing another brand's name (see
        // pruneGenericIcons) must not come back on the next run.
        if (GENERIC_HASHES.has(hashFile(outFile))) throw new Error('known generic icon');
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

function hashFile(file) {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

/** Fraction of the 48×48 canvas that is not transparent. */
async function inkCoverage(file) {
    try {
        const { stdout } = await execFileAsync('magick', [
            file, '-alpha', 'extract', '-threshold', '12%',
            '-format', '%[fx:mean]', 'info:',
        ], { maxBuffer: 1 << 20 });
        const v = parseFloat(stdout);
        return Number.isFinite(v) ? v : 1;
    } catch {
        return 1; // unmeasurable — keep it, the other gates still applied
    }
}

// ── Per-brand pipeline ──────────────────────────────────────────────────────
async function fetchHomepage(domain) {
    for (const url of [`https://${domain}/`, `https://www.${domain}/`]) {
        try {
            return await getPage(url);
        } catch { /* try the other host */ }
    }
    return null;
}

async function resolveDomain(brand, overrides) {
    // A hand-picked domain is trusted — that is what curating one means — so no
    // title check runs against it. This is also the escape hatch for the brands
    // whose homepage we can never read: Home Depot and CVS answer this machine
    // with an Akamai "Access Denied" page, and an override plus the blind icon
    // paths below is the only way they ever get an icon.
    if (Object.prototype.hasOwnProperty.call(overrides, brand.display)) {
        const domain = overrides[brand.display];
        if (!domain) return { domain: null, why: 'override:none' };
        return { domain, why: 'override', page: await fetchHomepage(domain) };
    }

    for (const cand of domainCandidates(brand.display)) {
        for (const url of [`https://${cand}/`, `https://www.${cand}/`]) {
            let page;
            try {
                page = await getPage(url);
            } catch {
                continue;
            }
            const why = verifyPage(page.html, brand.slug, cand, page.finalUrl);
            if (why) return { domain: cand, why, page };
            // The bare host answered and is not this brand; www. of the same
            // host will not be either.
            break;
        }
    }
    return { domain: null, why: 'unresolved' };
}

// Conventional icon paths, tried when the page's own <link> tags are
// unavailable or all failed. Worth doing even for a homepage we could not read
// at all: bot protection guards the HTML, while the icon usually sits on a CDN
// that answers anyone (this is how Trader Joe's and GEICO get an icon despite
// both homepages returning 403).
const BLIND_ICON_PATHS = [
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
    '/favicon.png',
    '/favicon-32x32.png',
];

async function downloadIcon(brand, domain, page) {
    const outFile = path.join(ICON_DIR, `${brand.slug}.png`);
    const urls = page ? iconCandidates(page.html, page.finalUrl) : [];
    const origin = page ? page.finalUrl : `https://www.${domain}/`;
    for (const p of BLIND_ICON_PATHS) {
        try { urls.push(new URL(p, origin).href); } catch { /* ignore */ }
    }

    for (const url of [...new Set(urls)]) {
        let buf;
        try {
            buf = await getImage(url);
        } catch (err) {
            vlog(`${brand.display}: ${url} — ${err.message}`);
            continue;
        }
        try {
            await normalizeIcon(buf, outFile);
            return { ok: true, from: url };
        } catch (err) {
            vlog(`${brand.display}: ${url} — convert failed: ${err.message}`);
            fs.rmSync(outFile, { force: true });
        }
    }
    return { ok: false };
}

// ── Generic-icon pruning ────────────────────────────────────────────────────
// The failure this catches: a site serves a DEFAULT favicon rather than its
// own — the stock WordPress mark, a hosting panel's house glyph, a registrar's
// parking-page art — and it lands under a real merchant's name. Every gate
// upstream passed; the domain is right and the file is a valid icon. It just
// isn't the brand's.
//
// The tell is that the same bytes show up under several unrelated merchants.
// So: group the icons by content hash, and drop any group whose members come
// from THREE OR MORE DIFFERENT DOMAINS. The domain count is what makes this
// safe — a corporate family legitimately shares one mark (Courtyard,
// SpringHill and Fairfield all resolve to marriott.com; Apple Music, Apple TV
// and the Apple Store all to apple.com), and those groups have one domain
// between them, so they survive. Ten brands on ten domains wearing one blue
// "HD" tile do not.
//
// Confirmed hashes go in data/generic-icon-hashes.json so a later run rejects
// the art at download time instead of re-discovering it here (a group can fall
// under three domains once its other members have been pruned away).
// Runs over the WHOLE set, not just this run's downloads, so tightening a rule
// cleans up what earlier runs already shipped — `--manifest` re-audits offline.
async function pruneGenericIcons(resolved) {
    const bySlug = new Map(Object.entries(resolved));
    const files = fs.readdirSync(ICON_DIR).filter((n) => n.endsWith('.png'));
    const groups = new Map(); // hash -> [slug]
    for (const f of files) {
        const slug = f.slice(0, -4);
        const hash = hashFile(path.join(ICON_DIR, f));
        if (!groups.has(hash)) groups.set(hash, []);
        groups.get(hash).push(slug);
    }

    const known = new Set(readJson(GENERIC_FILE, []));
    const pruned = [];
    const drop = (slug) => {
        fs.rmSync(path.join(ICON_DIR, `${slug}.png`), { force: true });
        pruned.push(slug);
    };

    for (const [hash, slugs] of groups) {
        const domains = new Set(slugs.map((s) => bySlug.get(s)).filter(Boolean));
        if (!known.has(hash) && !(slugs.length >= 3 && domains.size >= 3)) continue;
        known.add(hash);
        slugs.forEach(drop);
    }
    if (pruned.length) {
        fs.writeFileSync(GENERIC_FILE, JSON.stringify([...known].sort(), null, 2) + '\n');
    }

    // An icon whose brand's domain has since been RETRACTED (cached as an
    // explicit null — --reverify decided the site fails the current gates) has
    // no source left to stand on. Keeping it would leave art on screen that
    // nothing now vouches for, which is exactly what the retraction was for:
    // every one of these turned out to be a squatter's stock swirl or a generic
    // blue triangle. An absent cache entry is different — that brand was simply
    // never processed — so only an explicit null counts.
    const orphaned = files.map((f) => f.slice(0, -4))
        .filter((s) => !pruned.includes(s) && resolved[s] === null);
    orphaned.forEach(drop);

    // Blanks are a third defect with the same cure. They are not
    // hash-blocklisted: the same all-transparent bytes are not a fingerprint of
    // anything, and inkCoverage catches them on sight anyway.
    const survivors = files.map((f) => f.slice(0, -4)).filter((s) => !pruned.includes(s));
    const blank = [];
    await mapLimit(survivors, CONCURRENCY, async (slug) => {
        const p = path.join(ICON_DIR, `${slug}.png`);
        if (fs.existsSync(p) && await inkCoverage(p) < 0.02) blank.push(slug);
    });
    blank.forEach(drop);

    return pruned;
}

// ── Full-bleed detection ────────────────────────────────────────────────────
// Favicons come in two shapes and they want opposite treatment in a round
// avatar:
//
//   glyph      — a mark on transparency (Apple's apple, Chevron's chevron).
//                Wants to sit INSET on a neutral disc, or it has no ground to
//                stand on and vanishes against a dark theme.
//   full-bleed — the brand's colour tile, mark included (Netflix's red square,
//                Burger King's, Amazon's). Wants to FILL the circle and be
//                clipped round, because it already is the disc. Inset on a grey
//                pill it reads as a tiny square stamp instead of an avatar.
//
// Which one it is has to be decided here, not in CSS: the browser can't ask an
// <img> whether its corners are transparent. Reading the four corners of the
// NORMALIZED file is the whole test — and it is why `-extent` pads with
// transparency rather than a colour, so a non-square wordmark keeps see-through
// corners and stays correctly classified as a glyph.
async function isFullBleed(file) {
    try {
        const { stdout } = await execFileAsync('magick', [
            file, '-alpha', 'extract',
            '-format', `%[fx:(p{0,0}+p{${ICON_PX - 1},0}+p{0,${ICON_PX - 1}}+p{${ICON_PX - 1},${ICON_PX - 1}})/4]`,
            'info:',
        ], { maxBuffer: 1 << 20 });
        return parseFloat(stdout) > 0.9;
    } catch {
        return false; // the inset glyph treatment is the safe default
    }
}

// ── Manifest ────────────────────────────────────────────────────────────────
// slug -> icon basename. Aliases share a basename, so the map is bigger than
// the icon count. Written sorted so a re-run produces a reviewable diff instead
// of a reshuffle.
async function writeManifest(brands) {
    const have = new Set(
        fs.existsSync(ICON_DIR)
            ? fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4))
            : [],
    );
    const map = {};
    for (const brand of brands) {
        if (!have.has(brand.slug)) continue;
        for (const alias of brand.aliases) {
            // First brand to claim an alias keeps it. A collision means two
            // display names share a needle spelling, which the lexicon lint
            // would already flag; abstaining is the safe half either way.
            if (!(alias in map)) map[alias] = brand.slug;
        }
    }
    const files = [...have].sort();
    const bleed = [];
    await mapLimit(files, CONCURRENCY, async (file) => {
        if (await isFullBleed(path.join(ICON_DIR, `${file}.png`))) bleed.push(file);
    });
    bleed.sort();

    const keys = Object.keys(map).sort();
    const body = keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(map[k])},`).join('\n');
    const bleedBody = bleed.map((f) => `    ${JSON.stringify(f)},`).join('\n');
    const src = `'use strict';

/* GENERATED FILE — do not edit by hand.
 * Rebuild with:  node electron/scripts/fetch-merchant-icons.js --manifest
 *
 * MERCHANT_ICONS maps a merchant slug (see merchantIconSlug in avatar.js —
 * lowercase, alphanumerics only) to the basename of a bundled brand icon in
 * static/merchant-icons/. Several slugs can share one icon: every lexicon
 * needle that names a brand ("wendys", "wendy's") is an alias for that brand's
 * display-name slug, so a hand-typed label matches the same file an imported
 * row does.
 *
 * MERCHANT_ICONS_BLEED lists the icons whose artwork reaches all four corners —
 * a brand-colour tile rather than a mark on transparency. Those fill the avatar
 * circle and get clipped round; the rest sit inset on a neutral disc so a dark
 * monogram has something to stand on. Measured from the pixels at build time,
 * because CSS cannot ask an image whether its corners are transparent.
 *
 * ${have.size} icons (${bleed.length} full-bleed), ${keys.length} slugs. */

window.MERCHANT_ICONS = {
${body}
};

window.MERCHANT_ICONS_BLEED = [
${bleedBody}
];
`;
    fs.writeFileSync(MANIFEST_FILE, src);
    return { icons: have.size, slugs: keys.length, bleed: bleed.length };
}

// ── Driver ──────────────────────────────────────────────────────────────────
async function mapLimit(items, limit, fn) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            await fn(items[i], i);
        }
    });
    await Promise.all(workers);
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

// Read once at startup: normalizeIcon consults it per download, and reading the
// file there would be thousands of stats for a set that never changes mid-run.
const GENERIC_HASHES = new Set(readJson(GENERIC_FILE, []));

async function main() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(ICON_DIR, { recursive: true });

    let brands = collectBrands();
    if (FLAG.only) {
        brands = brands.filter((b) => FLAG.only.some((f) => b.slug.includes(f)));
    }

    // Both the prune and the manifest are pure functions of what is on disk, so
    // --manifest re-derives the whole published set without touching the network
    // — the way to re-audit or re-tune after a sweep.
    const finish = async (resolved) => {
        const pruned = await pruneGenericIcons(resolved);
        if (pruned.length) {
            console.log(`[merchant-icons] pruned ${pruned.length} generic icon(s): ` +
                `${pruned.slice(0, 12).join(', ')}${pruned.length > 12 ? ', …' : ''}`);
        }
        const stats = await writeManifest(collectBrands());
        console.log(`[merchant-icons] manifest: ${stats.icons} icons ` +
            `(${stats.bleed} full-bleed), ${stats.slugs} slugs`);
    };

    if (FLAG.manifestOnly) {
        await finish(readJson(DOMAINS_FILE, {}));
        return;
    }

    // Re-run the CURRENT verification gates against the cached domains and drop
    // the ones that no longer pass. Tightening a rule is otherwise only half a
    // fix: new lookups obey it, while every domain an earlier, looser run
    // already wrote stays in the committed cache looking settled. (This is how
    // the parked-domain gate got applied to the brands that predated it.)
    // Overrides are hand-picked and exempt, as everywhere else.
    if (FLAG.reverify) {
        const cached = readJson(DOMAINS_FILE, {});
        const overrideDomains = new Set(Object.values(readJson(OVERRIDES_FILE, {}))
            .filter((v) => typeof v === 'string'));
        const bySlug = new Map(collectBrands().map((b) => [b.slug, b]));
        const suspects = Object.keys(cached)
            .filter((s) => cached[s] && !overrideDomains.has(cached[s]) && bySlug.has(s));
        console.log(`[merchant-icons] re-verifying ${suspects.length} cached domains`);

        const dropped = [];
        await mapLimit(suspects, CONCURRENCY, async (slug) => {
            const domain = cached[slug];
            const page = await fetchHomepage(domain);
            // Unreachable is not disproof — bot walls answer 403 to everything
            // and those domains are usually right. Only a page we CAN read and
            // that fails the gates loses its cache entry.
            if (!page) return;
            if (verifyPage(page.html, slug, domain, page.finalUrl)) return;
            cached[slug] = null;
            dropped.push(`${slug} (${domain})`);
        });

        const ordered = {};
        for (const k of Object.keys(cached).sort()) ordered[k] = cached[k];
        fs.writeFileSync(DOMAINS_FILE, JSON.stringify(ordered, null, 2) + '\n');
        console.log(`[merchant-icons] dropped ${dropped.length}: ${dropped.join(', ') || '(none)'}`);
        await finish(cached);
        return;
    }


    const overrides = readJson(OVERRIDES_FILE, {});
    delete overrides._comment;
    // An override keyed on a name no merchant actually has is dead weight that
    // reads as coverage — the same trap DISPLAY_OVERRIDES has, which
    // lexiconLint.test.js fences by checking its keys against MERCHANTS. Same
    // check, same reason: a typo should be visible, not silent.
    const known = new Set(collectBrands().map((b) => b.display));
    const orphans = Object.keys(overrides).filter((k) => !known.has(k));
    if (orphans.length) {
        console.warn(`[merchant-icons] ${orphans.length} override key(s) match no merchant ` +
            `display name and are being ignored:\n    ${orphans.join('\n    ')}`);
    }

    const resolved = FLAG.refresh ? {} : readJson(DOMAINS_FILE, {});

    let todo = brands.filter((b) => {
        const iconExists = fs.existsSync(path.join(ICON_DIR, `${b.slug}.png`));
        if (iconExists && !FLAG.refresh) return false;
        const cached = resolved[b.slug];
        // A cached null is a settled "no domain" — only --retry reopens it.
        if (cached === null && !FLAG.retry) return false;
        return true;
    });
    if (FLAG.limit) todo = todo.slice(0, FLAG.limit);

    // The sweep is thousands of requests over tens of minutes; checkpoint the
    // resolved-domain cache so an interrupted run resumes instead of restarting.
    const flushDomains = () => {
        const ordered = {};
        for (const k of Object.keys(resolved).sort()) ordered[k] = resolved[k];
        fs.writeFileSync(DOMAINS_FILE, JSON.stringify(ordered, null, 2) + '\n');
    };

    console.log(`[merchant-icons] ${brands.length} brands, ${todo.length} to work on ` +
        `(concurrency ${CONCURRENCY})`);

    let done = 0;
    let gotIcon = 0;
    let gotDomain = 0;
    await mapLimit(todo, CONCURRENCY, async (brand) => {
        try {
            let page = null;
            let domain = resolved[brand.slug] || null;

            // A domain already in the cache is settled; re-fetch its homepage
            // only to read the icon links, and skip re-resolving.
            if (domain && !FLAG.refresh) {
                page = await fetchHomepage(domain);
            } else {
                const r = await resolveDomain(brand, overrides);
                domain = r.domain;
                page = r.page || null;
                resolved[brand.slug] = domain;
            }
            if (!domain) return;
            gotDomain++;

            const icon = await downloadIcon(brand, domain, page);
            if (icon.ok) gotIcon++;
        } catch (err) {
            console.error(`[merchant-icons] ${brand.display}: ${err.message}`);
        } finally {
            done++;
            if (done % 25 === 0) {
                process.stdout.write(`  … ${done}/${todo.length} (${gotIcon} icons)\n`);
                flushDomains();
            }
        }
    });

    flushDomains();
    console.log(`[merchant-icons] done — ${gotDomain} domains, ${gotIcon} new icons this run`);
    await finish(resolved);
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { slugify, domainCandidates, verifyPage, iconCandidates, collectBrands };
