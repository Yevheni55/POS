#!/usr/bin/env node
// Syntax gate for every JS file the kasa actually executes.
//
// Why this exists: the POS loads js/*.js as CLASSIC scripts (no modules, no
// bundler). A syntax error in one file silently kills every global function
// declared in it — the cashier taps a button and nothing happens, with no
// error surfaced anywhere in the UI. `node --check` catches that in ~1 s.
//
// Runs on Windows without bash, so it can be used from npm scripts, a
// pre-commit hook, or CI. The deploy script has the same gate inline.
//
//   npm run check

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Directories walked recursively. Everything else is ignored.
const DIRS = [
  'js',
  'components',
  'admin',
  'server/routes',
  'server/lib',
  'server/middleware',
  'server/schemas',
  'server/db',
  'server/jobs',
];

// Individual files at the repo root / server root.
const FILES = [
  'api.js',
  'sw.js',
  'server/server.js',
  'server/app.js',
  'server/load-env.js',
];

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build']);

function walk(dir) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const name of readdirSync(abs)) {
    if (SKIP_DIR.has(name)) continue;
    const rel = path.join(dir, name);
    const st = statSync(path.join(ROOT, rel));
    if (st.isDirectory()) out.push(...walk(rel));
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(rel);
  }
  return out;
}

const targets = [...DIRS.flatMap(walk), ...FILES.filter((f) => existsSync(path.join(ROOT, f)))]
  .map((f) => f.split(path.sep).join('/'))
  .sort();

let failed = 0;
for (const rel of targets) {
  const res = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed++;
    console.error(`\n✖ ${rel}`);
    console.error((res.stderr || '').trim().split('\n').slice(0, 6).join('\n'));
  }
}

if (failed) {
  console.error(`\n${failed} súbor(ov) so syntaktickou chybou z ${targets.length}. Nenasadzuj.`);
  process.exit(1);
}
console.log(`✔ syntax OK — ${targets.length} súborov`);
