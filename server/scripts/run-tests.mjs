import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_TEST_DB_URL = 'postgresql://pos:pos@localhost:5432/pos_test';

const mode = process.argv[2] || 'full';

function collectTestFiles(dir) {
  const entries = readdirSync(dir)
    .map((name) => path.join(dir, name))
    .sort((left, right) => left.localeCompare(right));

  const files = [];
  for (const entry of entries) {
    const stats = statSync(entry);
    if (stats.isDirectory()) {
      files.push(...collectTestFiles(entry));
      continue;
    }

    if (entry.endsWith('.test.js')) {
      files.push(entry);
    }
  }

  return files;
}

const allTestFiles = collectTestFiles('test');

// Voliteľný strop na jeden test. Bez neho node:test čaká donekonečna a jeden
// zaseknutý test spáli celý CI budget bez mena vinníka — CI preto posiela
// TEST_TIMEOUT_MS, lokálne (a v deploy bráne) ostáva pôvodné správanie.
const perTestTimeout = Number(process.env.TEST_TIMEOUT_MS) > 0
  ? [`--test-timeout=${Number(process.env.TEST_TIMEOUT_MS)}`]
  : [];

const modeArgs = {
  full: ['--test', ...perTestTimeout, '--test-concurrency=1', ...allTestFiles],
  watch: ['--test', ...perTestTimeout, '--watch', '--test-concurrency=1', ...allTestFiles],
  coverage: ['--test', ...perTestTimeout, '--experimental-test-coverage', '--test-concurrency=1', ...allTestFiles],
  stock: ['--test', ...perTestTimeout, '--test-concurrency=1', 'test/lib/stock.test.js'],
  'order-queries': ['--test', ...perTestTimeout, '--test-concurrency=1', 'test/lib/order-queries.test.js'],
};

const childEnv = {
  ...process.env,
  DATABASE_URL: process.env.TEST_DATABASE_URL || DEFAULT_TEST_DB_URL,
};

function runNodeTest(args) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: childEnv,
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  return result.status ?? 1;
}

if (mode === 'lib') {
  for (const nestedMode of ['order-queries', 'stock']) {
    const exitCode = runNodeTest(modeArgs[nestedMode]);
    if (exitCode !== 0) process.exit(exitCode);
  }
  process.exit(0);
}

if (!modeArgs[mode]) {
  console.error(`Unknown test mode: ${mode}`);
  process.exit(1);
}

process.exit(runNodeTest(modeArgs[mode]));
