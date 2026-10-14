#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const isNoOsv = process.argv.includes('--no-osv');
const resultFilename = isNoOsv ? 'holdout_noosv_result.json' : 'holdout_result.json';
const HOLDOUT_RESULT_PATH = path.resolve(process.cwd(), 'data/eval', resultFilename);

if (fs.existsSync(HOLDOUT_RESULT_PATH)) {
  console.error(`[REFUSAL] Holdout results already exist at: ${HOLDOUT_RESULT_PATH}`);
  console.error('Specification rule strictly enforces exactly ONE holdout run. Refusing to execute a second run.');
  process.exit(1);
}

// Ensure git tag/commit info
try {
  const currentTag = execSync('git describe --tags --exact-match 2>/dev/null || true', { encoding: 'utf8' }).trim();
  console.log(`Current Git Tag: ${currentTag || 'none'}`);
  const gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  console.log(`Current Git Commit: ${gitCommit}`);
} catch (e) {
  console.error('Git check error:', e);
}

// Run node dist/eval.js --offline --split=holdout [--no-osv]
try {
  const cmd = isNoOsv
    ? 'node dist/eval.js --offline --split=holdout --no-osv'
    : 'node dist/eval.js --offline --split=holdout';
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  console.error('Holdout evaluation failed:', err);
  process.exit(1);
}
