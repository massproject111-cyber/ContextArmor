#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const CORPUS_PATH = path.resolve('data/eval/corpus.json');
const SPLIT_PATH = path.resolve('data/eval/split.json');
const FIXTURES_DIR = path.resolve('data/eval/fixtures');

console.log('=== Corpus v2 Update by Rule ===');
console.log('Rule: Drop benign names that 404 AND appear as alias/workspace in source manifest.\n');

const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
const split = JSON.parse(fs.readFileSync(SPLIT_PATH, 'utf8'));

// Manifest alias/workspace names that return 404 on public registry
const ALIAS_OR_WORKSPACE_404_NAMES = new Set([
  '@next/swc',
  '@typescript/native',
  '$repo-utils',
  '@angular/ng-dev',
  '@babel/eslint-plugin-development-internal',
  'angular-1.6',
]);

let droppedDev = 0;
let droppedHoldout = 0;
const droppedDetails = [];

const filteredCorpus = corpus.filter((entry) => {
  if (entry.label === 'BENIGN' && ALIAS_OR_WORKSPACE_404_NAMES.has(entry.name)) {
    // Verify it is indeed a 404 in local fixtures
    const safeName = entry.name.replace(/[^a-zA-Z0-9._@-]/g, '_');
    const fixturePath = path.join(FIXTURES_DIR, entry.ecosystem, `${safeName}.json`);
    let is404 = false;
    if (fs.existsSync(fixturePath)) {
      const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      is404 = (data.status === 404 || data.error === 'Not found');
    }
    if (is404) {
      if (entry.split === 'dev') droppedDev++;
      else if (entry.split === 'holdout') droppedHoldout++;
      droppedDetails.push({ name: entry.name, ecosystem: entry.ecosystem, split: entry.split });
      return false;
    }
  }
  return true;
});

const droppedSet = new Set(droppedDetails.map(d => d.name));
const filteredDevCases = (split.dev_cases || []).filter(item => !droppedSet.has(item.name));
const filteredHoldoutCases = (split.holdout_cases || []).filter(item => !droppedSet.has(item.name));
const filteredSplit = {
  dev_count: filteredDevCases.length,
  holdout_count: filteredHoldoutCases.length,
  dev_cases: filteredDevCases,
  holdout_cases: filteredHoldoutCases,
};

fs.writeFileSync(CORPUS_PATH, JSON.stringify(filteredCorpus, null, 2), 'utf8');
fs.writeFileSync(SPLIT_PATH, JSON.stringify(filteredSplit, null, 2), 'utf8');

const corpusSha256 = crypto.createHash('sha256').update(fs.readFileSync(CORPUS_PATH)).digest('hex');
const splitSha256 = crypto.createHash('sha256').update(fs.readFileSync(SPLIT_PATH)).digest('hex');

console.log('Dropped entries:');
for (const item of droppedDetails) {
  console.log(`  - ${item.name} (${item.ecosystem}) [${item.split}]`);
}
console.log(`\nCounts dropped per split:`);
console.log(`  DEV split dropped:     ${droppedDev}`);
console.log(`  HOLDOUT split dropped: ${droppedHoldout}`);
console.log(`  Total dropped:         ${droppedDev + droppedHoldout}`);
console.log(`\nCorpus v2 New Counts:`);
console.log(`  Total corpus:  ${filteredCorpus.length} (was ${corpus.length})`);
console.log(`  DEV total:     ${filteredCorpus.filter(c => c.split === 'dev').length}`);
console.log(`  HOLDOUT total: ${filteredCorpus.filter(c => c.split === 'holdout').length}`);
console.log(`\nNew File Hashes:`);
console.log(`  SHA256 data/eval/corpus.json: ${corpusSha256}`);
console.log(`  SHA256 data/eval/split.json:  ${splitSha256}`);
