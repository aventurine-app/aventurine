#!/usr/bin/env node
'use strict';

// Regenerates the packaging icons in electron/build/ from the one source of
// truth: static/icons/logo/logo.svg (the same mark the title bar renders).
//
// Run this after ANY logo change, then commit the results — electron-builder
// reads build/icon.png (linux: AppImage/rpm/deb) and build/icon.ico (win: exe +
// NSIS installer), and nothing else derives them at build time. Skipping it is
// how packages end up shipping a stale logo.
//
//   node scripts/make-icons.js        # from electron/
//
// Needs rsvg-convert (Fedora: librsvg2-tools) on PATH for the SVG rasterising.
// The .ico is assembled here — PNG-compressed frames, the Vista+ format every
// current Windows shell reads — so no ImageMagick/icotool dependency.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_SVG = path.join(REPO_ROOT, 'static', 'icons', 'logo', 'logo.svg');
const BUILD_DIR = path.join(REPO_ROOT, 'electron', 'build');

// electron-builder wants >=512 for the Linux icon (it downscales the set
// itself); the .ico carries the classic shell sizes up to 256.
const PNG_SIZE = 512;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const STAMP_FILE = 'icon.source.sha256';

function sourceHash() {
  return crypto.createHash('sha256').update(fs.readFileSync(SRC_SVG)).digest('hex');
}

// Overridable so the renderer can be pointed at a wrapper (e.g. the
// flatpak-spawn dance this repo needs when the host and sandbox disagree on
// which tools are installed).
const RSVG = process.env.RSVG_CONVERT || 'rsvg-convert';

function render(size, outPath) {
  execFileSync(RSVG, [
    '--width', String(size),
    '--height', String(size),
    '--format', 'png',
    '--output', outPath,
    SRC_SVG,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
}

// ICO = 6-byte ICONDIR + one 16-byte ICONDIRENTRY per frame + the frame data.
// Width/height of 256 are stored as 0 (the field is a single byte).
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(frames.length, 4);

  const dir = Buffer.alloc(16 * frames.length);
  let offset = header.length + dir.length;

  frames.forEach((frame, i) => {
    const at = i * 16;
    dir.writeUInt8(frame.size >= 256 ? 0 : frame.size, at);      // width
    dir.writeUInt8(frame.size >= 256 ? 0 : frame.size, at + 1);  // height
    dir.writeUInt8(0, at + 2);             // palette colours (0 = truecolour)
    dir.writeUInt8(0, at + 3);             // reserved
    dir.writeUInt16LE(1, at + 4);          // colour planes
    dir.writeUInt16LE(32, at + 6);         // bits per pixel
    dir.writeUInt32LE(frame.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += frame.data.length;
  });

  return Buffer.concat([header, dir, ...frames.map((f) => f.data)]);
}

function main() {
  if (!fs.existsSync(SRC_SVG)) {
    console.error(`Missing source logo: ${SRC_SVG}`);
    process.exit(1);
  }
  try {
    execFileSync(RSVG, ['--version'], { stdio: 'ignore' });
  } catch {
    console.error(`${RSVG} not found on PATH (Fedora: sudo dnf install librsvg2-tools).`);
    process.exit(1);
  }

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aventurine-icons-'));
  try {
    const pngPath = path.join(BUILD_DIR, 'icon.png');
    render(PNG_SIZE, pngPath);
    console.log(`build/icon.png    ${PNG_SIZE}x${PNG_SIZE}`);

    const frames = ICO_SIZES.map((size) => {
      const framePath = path.join(tmp, `${size}.png`);
      render(size, framePath);
      return { size, data: fs.readFileSync(framePath) };
    });
    fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), buildIco(frames));
    console.log(`build/icon.ico    ${ICO_SIZES.join(', ')}`);

    // Stamp which logo these were rendered from; check-package-files.js compares
    // it against the current SVG and fails the dist build when they diverge.
    fs.writeFileSync(path.join(BUILD_DIR, STAMP_FILE), `${sourceHash()}\n`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) main();

module.exports = { buildIco, sourceHash, SRC_SVG, BUILD_DIR, STAMP_FILE };
