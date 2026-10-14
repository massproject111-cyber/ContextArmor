import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { PackageRiskEngine, classifyDecision, type SecurityDecision } from '../detectors/packageRisk/index.js';
import { RegistryClient } from '../detectors/packageRisk/registryClient.js';
import { TOP_NPM_PACKAGES, TOP_PYPI_PACKAGES } from '../detectors/packageRisk/topPackages.js';
import { AllowlistManager } from '../core/allowlist.js';
import { DiskCache } from '../core/cache.js';
import type { Ecosystem } from '../core/types.js';
import { EVAL_CORPUS, type EvalCase } from './corpus.js';

function levenshtein(a: string, b: string): number {
  const an = a.length, bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix: number[][] = [];
  for (let i = 0; i <= bn; ++i) matrix[i] = [i];
  for (let i = 0; i <= an; ++i) matrix[0][i] = i;
  for (let i = 1; i <= bn; ++i) {
    for (let j = 1; j <= an; ++j) {
      matrix[i][j] = b.charAt(i - 1) === a.charAt(j - 1)
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
    }
  }
  return matrix[bn][an];
}

function findNearestTopDistance(name: string, ecosystem: Ecosystem): { dist: number; nearest: string } {
  const topSet = ecosystem === 'npm' ? TOP_NPM_PACKAGES : TOP_PYPI_PACKAGES;
  let minD = 999;
  let nearest = '';
  for (const top of topSet) {
    const d = levenshtein(name.toLowerCase(), top.toLowerCase());
    if (d < minD) {
      minD = d;
      nearest = top;
    }
  }
  return { dist: minD, nearest };
}

export function wilsonScoreCI(x: number, n: number, z = 1.95996): { lower: number; upper: number; str: string } {
  if (n <= 0) return { lower: 0, upper: 0, str: '[0.00%, 0.00%]' };
  const p = x / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  const lower = Math.max(0, center - margin) * 100;
  const upper = Math.min(1, center + margin) * 100;
  return {
    lower,
    upper,
    str: `[${lower.toFixed(2)}%, ${upper.toFixed(2)}%]`,
  };
}

interface SplitMetrics {
  total: number;
  nBenign: number;
  nMalicious: number;
  block_tp: number;
  block_fp: number;
  block_tn: number;
  block_fn: number;
  block_FPR: number;
  block_Recall: number;
  alert_tp: number;
  alert_fp: number;
  alert_tn: number;
  alert_fn: number;
  alert_FPR: number;
  alert_Recall: number;
  alert_Precision: number;
}

function calculateSplitMetrics(cases: EvalCase[], decisions: SecurityDecision[]): SplitMetrics {
  let block_tp = 0, block_fp = 0, block_tn = 0, block_fn = 0;
  let alert_tp = 0, alert_fp = 0, alert_tn = 0, alert_fn = 0;
  let nBenign = 0, nMalicious = 0;

  for (let i = 0; i < cases.length; i++) {
    const isMal = cases[i].isMaliciousOrHallucinated;
    const dec = decisions[i];
    const isBlock = dec === 'BLOCK';
    const isAlert = dec === 'BLOCK' || dec === 'ASK';

    if (isMal) {
      nMalicious++;
      if (isBlock) block_tp++; else block_fn++;
      if (isAlert) alert_tp++; else alert_fn++;
    } else {
      nBenign++;
      if (isBlock) block_fp++; else block_tn++;
      if (isAlert) alert_fp++; else alert_tn++;
    }
  }

  const block_FPR = nBenign > 0 ? (block_fp / nBenign) * 100 : 0;
  const block_Recall = nMalicious > 0 ? (block_tp / nMalicious) * 100 : 0;
  const alert_FPR = nBenign > 0 ? (alert_fp / nBenign) * 100 : 0;
  const alert_Recall = nMalicious > 0 ? (alert_tp / nMalicious) * 100 : 0;
  const alert_Precision = (alert_tp + alert_fp) > 0 ? (alert_tp / (alert_tp + alert_fp)) * 100 : 0;

  return {
    total: cases.length,
    nBenign,
    nMalicious,
    block_tp,
    block_fp,
    block_tn,
    block_fn,
    block_FPR,
    block_Recall,
    alert_tp,
    alert_fp,
    alert_tn,
    alert_fn,
    alert_FPR,
    alert_Recall,
    alert_Precision,
  };
}

function createOfflineFetch(fixturesDir: string, noOsv: boolean = false): typeof fetch {
  return (async (url: any, init?: any): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url.toString();

    // 1. npm registry packument
    const npmMatch = urlStr.match(/^https:\/\/registry\.npmjs\.org\/([^?]+)/);
    if (npmMatch) {
      const rawName = decodeURIComponent(npmMatch[1]);
      const safeName = rawName.replace(/[^a-zA-Z0-9._@-]/g, '_');
      const fp = path.join(fixturesDir, 'npm', `${safeName}.json`);
      if (!fs.existsSync(fp)) {
        throw new Error(`[OFFLINE_VIOLATION] Uncached npm fixture requested for ${rawName} at ${fp}`);
      }
      const text = fs.readFileSync(fp, 'utf8');
      const json = JSON.parse(text);
      if (json.status === 404 || json.error === 'Not found') {
        return new Response(text, { status: 404, statusText: 'Not Found' });
      }
      return new Response(text, { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } });
    }

    // 2. PyPI JSON API
    const pypiMatch = urlStr.match(/^https:\/\/pypi\.org\/pypi\/([^/]+)\/json/);
    if (pypiMatch) {
      const rawName = decodeURIComponent(pypiMatch[1]);
      const safeName = rawName.replace(/[^a-zA-Z0-9._@-]/g, '_');
      const fp = path.join(fixturesDir, 'pypi', `${safeName}.json`);
      if (!fs.existsSync(fp)) {
        throw new Error(`[OFFLINE_VIOLATION] Uncached PyPI fixture requested for ${rawName} at ${fp}`);
      }
      const text = fs.readFileSync(fp, 'utf8');
      const json = JSON.parse(text);
      if (json.status === 404 || json.error === 'Not found') {
        return new Response(text, { status: 404, statusText: 'Not Found' });
      }
      return new Response(text, { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } });
    }

    // 3. npm weekly downloads
    const dlMatch = urlStr.match(/^https:\/\/api\.npmjs\.org\/downloads\/point\/last-week\/(.+)/);
    if (dlMatch) {
      const rawList = dlMatch[1];
      if (rawList.includes(',')) {
        const pkgs = rawList.split(',');
        const bulk: Record<string, any> = {};
        for (const p of pkgs) {
          const s = decodeURIComponent(p).replace(/[^a-zA-Z0-9._@-]/g, '_');
          const fp = path.join(fixturesDir, 'downloads', 'npm', `${s}.json`);
          if (fs.existsSync(fp)) {
            const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
            bulk[p] = { downloads: d.downloads || 0 };
          } else {
            bulk[p] = { downloads: 0 };
          }
        }
        return new Response(JSON.stringify(bulk), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } else {
        const rawName = decodeURIComponent(rawList);
        const safeName = rawName.replace(/[^a-zA-Z0-9._@-]/g, '_');
        const fp = path.join(fixturesDir, 'downloads', 'npm', `${safeName}.json`);
        let dl = 0;
        if (fs.existsSync(fp)) {
          const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
          dl = typeof d.downloads === 'number' ? d.downloads : 0;
        }
        return new Response(JSON.stringify({ downloads: dl, package: rawName }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // 4. OSV single query
    if (urlStr === 'https://api.osv.dev/v1/query') {
      if (noOsv) {
        return new Response(JSON.stringify({ vulns: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const pkgName = body.package?.name || '';
      const eco = (body.package?.ecosystem || 'npm').toLowerCase() === 'pypi' ? 'pypi' : 'npm';
      const safeName = pkgName.replace(/[^a-zA-Z0-9._@-]/g, '_');
      const fp = path.join(fixturesDir, 'osv', eco, `${safeName}.json`);
      if (fs.existsSync(fp)) {
        return new Response(fs.readFileSync(fp, 'utf8'), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ vulns: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // 5. OSV querybatch
    if (urlStr === 'https://api.osv.dev/v1/querybatch') {
      if (noOsv) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        const queries = body.queries || [];
        return new Response(JSON.stringify({ results: queries.map(() => ({ vulns: [] })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const queries = body.queries || [];
      const results: any[] = [];
      for (const q of queries) {
        const pkgName = q.package?.name || '';
        const eco = (q.package?.ecosystem || 'npm').toLowerCase() === 'pypi' ? 'pypi' : 'npm';
        const safeName = pkgName.replace(/[^a-zA-Z0-9._@-]/g, '_');
        const fp = path.join(fixturesDir, 'osv', eco, `${safeName}.json`);
        if (fs.existsSync(fp)) {
          const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
          results.push({ vulns: d.vulns || [] });
        } else {
          results.push({ vulns: [] });
        }
      }
      return new Response(JSON.stringify({ results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    throw new Error(`[OFFLINE_VIOLATION] Unhandled external network request: ${urlStr}`);
  }) as any;
}

const EVAL_CLOCK_TIMESTAMP = new Date('2026-10-11T04:26:24.000Z').getTime();

async function runEvaluation() {
  const isOffline = process.argv.includes('--offline');
  const isNoOsv = process.argv.includes('--no-osv');
  const isVerbose = process.argv.includes('--verbose');


  if (isOffline) {
    const originalDateNow = Date.now;
    Date.now = () => EVAL_CLOCK_TIMESTAMP;

    const isHoldout = process.argv.includes('--split=holdout');
    const targetSplit = isHoldout ? 'holdout' : 'dev';
    const holdoutResultFilename = isNoOsv ? 'holdout_noosv_result.json' : 'holdout_result.json';
    const holdoutResultPath = path.resolve(process.cwd(), 'data/eval', holdoutResultFilename);

    if (isHoldout && fs.existsSync(holdoutResultPath)) {
      console.error(`[REFUSAL] Holdout results already exist at ${holdoutResultPath}`);
      console.error('Specification rule strictly enforces exactly ONE holdout run. Refusing to run again.');
      process.exit(1);
    }

    try {
      console.log('=====================================================');
      console.log(`       ContextArmor Benchmark Evaluation Suite       `);
      if (isHoldout) {
        if (isNoOsv) {
          console.log(`   [OFFLINE MODE: FINAL HOLDOUT RUN — SECOND LOOK (--no-osv)]`);
        } else {
          console.log(`    [OFFLINE MODE: FINAL HOLDOUT RUN — ONE-TIME]     `);
        }
      } else if (isNoOsv) {
        console.log(`   [OFFLINE MODE: OSV Stripped (--no-osv) — DEV Only]`);
      } else {
        console.log(`   [OFFLINE MODE: Offline Fixtures — DEV Split Only] `);
      }
      console.log('=====================================================\n');

      const allowlist = new AllowlistManager();
      allowlist.addScope('@myorg');
      allowlist.addScope('@corp');

      const fixturesDir = path.resolve(process.cwd(), 'data/eval/fixtures');
      const offlineFetch = createOfflineFetch(fixturesDir, isNoOsv);
      globalThis.fetch = offlineFetch;

      const tmpOfflineDir = fs.mkdtempSync(path.join(os.tmpdir(), `ca-eval-${targetSplit}-`));
      const cache = new DiskCache(0, 15, path.join(tmpOfflineDir, 'cache'));
      const osvCache = new DiskCache(0, 15, path.join(tmpOfflineDir, 'osv'));
      const regClient = new RegistryClient(cache, osvCache, offlineFetch);
      const engine = new PackageRiskEngine(regClient, allowlist, offlineFetch);

      const corpusPath = path.resolve(process.cwd(), 'data/eval/corpus.json');
      if (!fs.existsSync(corpusPath)) {
        throw new Error(`Frozen corpus not found at ${corpusPath}`);
      }
      const rawCorpus: any[] = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
      const targetEntries = rawCorpus.filter((c) => c.split === targetSplit);
      console.log(`Loaded P2 frozen corpus: ${corpusPath}`);
      console.log(`Running evaluation on ${targetSplit.toUpperCase()} split (${targetEntries.length} packages)...`);
      console.log(`Zero network calls: verified via local fixtures in ${fixturesDir}`);
      console.log(`Pinned eval clock: ${new Date(EVAL_CLOCK_TIMESTAMP).toISOString()}\n`);

      const targetCases: EvalCase[] = targetEntries.map((c) => ({
        name: c.name,
        version: (c.affected_versions && c.affected_versions.length > 0) ? c.affected_versions[0] : undefined,
        ecosystem: c.ecosystem,
        isMaliciousOrHallucinated: c.label === 'MALICIOUS',
        category: c.label === 'MALICIOUS' ? 'malicious_advisory' : 'legit_longtail',
        split: targetSplit as any,
      }));

      const targetDecisions: SecurityDecision[] = [];
      const targetResults: any[] = [];
      for (const item of targetCases) {
        const res = await engine.evaluate({ name: item.name, version: item.version, ecosystem: item.ecosystem });
        const decision = classifyDecision(res);
        targetDecisions.push(decision);
        targetResults.push(res);
        if (isVerbose) {
          const label = item.isMaliciousOrHallucinated ? 'MALICIOUS' : 'BENIGN';
          const score = `${res.riskScore}/100`;
          const nameWithVer = item.version ? `${item.name}@${item.version}` : `${item.name}@latest`;
          const dlCount = res.metadata?.weeklyDownloads !== undefined ? `${res.metadata.weeklyDownloads}/wk` : 'N/A';
          const nearest = findNearestTopDistance(item.name, item.ecosystem);
          const distStr = `dist: ${nearest.dist} (${nearest.nearest})`;
          const signals = res.signals.length > 0
            ? res.signals.map((s) => `${s.name} (${s.score}pts)`).join(', ')
            : 'none';
          const netErrors = res.metadata?.networkError || res.uncheckedReason || 'none';
          console.log(`  [CASE] name: ${nameWithVer.padEnd(36)} | ecosystem: ${item.ecosystem.padEnd(5)} | label: ${label.padEnd(9)} | decision: ${decision.padEnd(5)} | score: ${score.padEnd(7)} | downloads: ${dlCount.padEnd(14)} | ${distStr.padEnd(20)} | signals: ${signals} | network_errors: ${netErrors}`);
        }
      }

      const overallMetrics = calculateSplitMetrics(targetCases, targetDecisions);

      console.log('\n-----------------------------------------------------');
      console.log(`${targetSplit.toUpperCase()} SPLIT RESULTS (n=${overallMetrics.total}, n_benign=${overallMetrics.nBenign}, n_malicious=${overallMetrics.nMalicious}):`);
      console.log(`  block_FPR: ${overallMetrics.block_FPR.toFixed(1)}% (${overallMetrics.block_fp}/${overallMetrics.nBenign}) [Wilson 95% CI: ${wilsonScoreCI(overallMetrics.block_fp, overallMetrics.nBenign).str}] | alert_FPR: ${overallMetrics.alert_FPR.toFixed(1)}% (${overallMetrics.alert_fp}/${overallMetrics.nBenign}) [Wilson 95% CI: ${wilsonScoreCI(overallMetrics.alert_fp, overallMetrics.nBenign).str}]`);
      console.log(`  block_Recall: ${overallMetrics.block_Recall.toFixed(1)}% (${overallMetrics.block_tp}/${overallMetrics.nMalicious}) [Wilson 95% CI: ${wilsonScoreCI(overallMetrics.block_tp, overallMetrics.nMalicious).str}] | alert_Recall: ${overallMetrics.alert_Recall.toFixed(1)}% (${overallMetrics.alert_tp}/${overallMetrics.nMalicious}) [Wilson 95% CI: ${wilsonScoreCI(overallMetrics.alert_tp, overallMetrics.nMalicious).str}] | alert_Precision: ${overallMetrics.alert_Precision.toFixed(1)}% (${overallMetrics.alert_tp}/${overallMetrics.alert_tp + overallMetrics.alert_fp})`);
      console.log(`  Block Breakdown: TP=${overallMetrics.block_tp} | FP=${overallMetrics.block_fp} | TN=${overallMetrics.block_tn} | FN=${overallMetrics.block_fn}`);
      console.log(`  Alert Breakdown: TP=${overallMetrics.alert_tp} | FP=${overallMetrics.alert_fp} | TN=${overallMetrics.alert_tn} | FN=${overallMetrics.alert_fn}`);
      console.log('-----------------------------------------------------\n');

      // Separate ecosystem breakdown for PyPI vs npm
      const npmIndices = targetCases.map((c, i) => c.ecosystem === 'npm' ? i : -1).filter(i => i >= 0);
      const pypiIndices = targetCases.map((c, i) => c.ecosystem === 'pypi' ? i : -1).filter(i => i >= 0);

      const npmCases = npmIndices.map(i => targetCases[i]);
      const npmDecisions = npmIndices.map(i => targetDecisions[i]);
      const npmMetrics = calculateSplitMetrics(npmCases, npmDecisions);

      const pypiCases = pypiIndices.map(i => targetCases[i]);
      const pypiDecisions = pypiIndices.map(i => targetDecisions[i]);
      const pypiMetrics = calculateSplitMetrics(pypiCases, pypiDecisions);

      console.log(`NPM ${targetSplit.toUpperCase()} BREAKDOWN (n=${npmMetrics.total}, n_benign=${npmMetrics.nBenign}, n_malicious=${npmMetrics.nMalicious}):`);
      console.log(`  block_FPR: ${npmMetrics.block_FPR.toFixed(1)}% (${npmMetrics.block_fp}/${npmMetrics.nBenign}) [Wilson 95% CI: ${wilsonScoreCI(npmMetrics.block_fp, npmMetrics.nBenign).str}] | alert_FPR: ${npmMetrics.alert_FPR.toFixed(1)}% (${npmMetrics.alert_fp}/${npmMetrics.nBenign}) [Wilson 95% CI: ${wilsonScoreCI(npmMetrics.alert_fp, npmMetrics.nBenign).str}]`);
      console.log(`  block_Recall: ${npmMetrics.block_Recall.toFixed(1)}% (${npmMetrics.block_tp}/${npmMetrics.nMalicious}) [Wilson 95% CI: ${wilsonScoreCI(npmMetrics.block_tp, npmMetrics.nMalicious).str}] | alert_Recall: ${npmMetrics.alert_Recall.toFixed(1)}% (${npmMetrics.alert_tp}/${npmMetrics.nMalicious}) [Wilson 95% CI: ${wilsonScoreCI(npmMetrics.alert_tp, npmMetrics.nMalicious).str}]`);
      console.log(`  Block: TP=${npmMetrics.block_tp} FP=${npmMetrics.block_fp} TN=${npmMetrics.block_tn} FN=${npmMetrics.block_fn} | Alert: TP=${npmMetrics.alert_tp} FP=${npmMetrics.alert_fp} TN=${npmMetrics.alert_tn} FN=${npmMetrics.alert_fn}\n`);

      console.log(`PYPI ${targetSplit.toUpperCase()} BREAKDOWN (n=${pypiMetrics.total}, n_benign=${pypiMetrics.nBenign}, n_malicious=${pypiMetrics.nMalicious}):`);
      console.log(`  block_FPR: ${pypiMetrics.block_FPR.toFixed(1)}% (${pypiMetrics.block_fp}/${pypiMetrics.nBenign}) [Wilson 95% CI: ${wilsonScoreCI(pypiMetrics.block_fp, pypiMetrics.nBenign).str}] | alert_FPR: ${pypiMetrics.alert_FPR.toFixed(1)}% (${pypiMetrics.alert_fp}/${pypiMetrics.nBenign}) [Wilson 95% CI: ${wilsonScoreCI(pypiMetrics.alert_fp, pypiMetrics.nBenign).str}]`);
      console.log(`  block_Recall: ${pypiMetrics.block_Recall.toFixed(1)}% (${pypiMetrics.block_tp}/${pypiMetrics.nMalicious}) [Wilson 95% CI: ${wilsonScoreCI(pypiMetrics.block_tp, pypiMetrics.nMalicious).str}] | alert_Recall: ${pypiMetrics.alert_Recall.toFixed(1)}% (${pypiMetrics.alert_tp}/${pypiMetrics.nMalicious}) [Wilson 95% CI: ${wilsonScoreCI(pypiMetrics.alert_tp, pypiMetrics.nMalicious).str}]`);
      console.log(`  Block: TP=${pypiMetrics.block_tp} FP=${pypiMetrics.block_fp} TN=${pypiMetrics.block_tn} FN=${pypiMetrics.block_fn} | Alert: TP=${pypiMetrics.alert_tp} FP=${pypiMetrics.alert_fp} TN=${pypiMetrics.alert_tn} FN=${pypiMetrics.alert_fn}\n`);

      if (isNoOsv) {
        let deadNameCount = 0;
        let liveMaliciousCount = 0;
        let heuristicsOnlyCount = 0;
        let osvMalHits = 0;

        let npmDead = 0, npmDeadBlock = 0, npmDeadAsk = 0;
        let npmStub = 0, npmStubBlock = 0, npmStubAsk = 0;
        let npmUnpublished = 0, npmUnpublishedBlock = 0, npmUnpublishedAsk = 0;
        let npmLive = 0, npmLiveBlock = 0, npmLiveAsk = 0;

        let pypiDead = 0, pypiDeadBlock = 0, pypiDeadAsk = 0;
        let pypiStub = 0, pypiStubBlock = 0, pypiStubAsk = 0;
        let pypiUnpublished = 0, pypiUnpublishedBlock = 0, pypiUnpublishedAsk = 0;
        let pypiLive = 0, pypiLiveBlock = 0, pypiLiveAsk = 0;

        for (let i = 0; i < targetCases.length; i++) {
          if (!targetCases[i].isMaliciousOrHallucinated) continue;
          const entry = targetEntries[i];
          const dec = targetDecisions[i];
          const res = targetResults[i];
          const isNpm = targetCases[i].ecosystem === 'npm';

          if (entry.osv_id && entry.osv_id.startsWith('MAL-')) {
            osvMalHits++;
          }

          // One stub definition: dist-tags.latest includes "security" OR a version key includes "security"
          let hasStub = false;
          let hasUnpublished = false;
          if (isNpm) {
            const safeName = entry.name.replace(/[^a-zA-Z0-9._@-]/g, '_');
            const fp = path.join(fixturesDir, 'npm', `${safeName}.json`);
            if (fs.existsSync(fp)) {
              try {
                const pkgJson = JSON.parse(fs.readFileSync(fp, 'utf8'));
                const latest = pkgJson['dist-tags']?.latest;
                const versionKeys = Object.keys(pkgJson.versions || {});
                if ((typeof latest === 'string' && latest.includes('security')) || versionKeys.some(v => v.includes('security'))) {
                  hasStub = true;
                } else if (pkgJson.time && pkgJson.time.unpublished) {
                  hasUnpublished = true;
                }
              } catch {}
            }
          }

          if (entry.live_status === 'dead_name') {
            deadNameCount++;
            if (isNpm) {
              npmDead++;
              if (dec === 'BLOCK') npmDeadBlock++;
              if (dec === 'ASK') npmDeadAsk++;
            } else {
              pypiDead++;
              if (dec === 'BLOCK') pypiDeadBlock++;
              if (dec === 'ASK') pypiDeadAsk++;
            }
          } else if (hasStub) {
            liveMaliciousCount++;
            if (dec === 'BLOCK' || dec === 'ASK') heuristicsOnlyCount++;
            if (isNpm) {
              npmStub++;
              if (dec === 'BLOCK') npmStubBlock++;
              if (dec === 'ASK') npmStubAsk++;
            } else {
              pypiStub++;
              if (dec === 'BLOCK') pypiStubBlock++;
              if (dec === 'ASK') pypiStubAsk++;
            }
          } else if (hasUnpublished) {
            liveMaliciousCount++;
            if (dec === 'BLOCK' || dec === 'ASK') heuristicsOnlyCount++;
            if (isNpm) {
              npmUnpublished++;
              if (dec === 'BLOCK') npmUnpublishedBlock++;
              if (dec === 'ASK') npmUnpublishedAsk++;
            } else {
              pypiUnpublished++;
              if (dec === 'BLOCK') pypiUnpublishedBlock++;
              if (dec === 'ASK') pypiUnpublishedAsk++;
            }
          } else {
            liveMaliciousCount++;
            if (dec === 'BLOCK' || dec === 'ASK') heuristicsOnlyCount++;
            if (isNpm) {
              npmLive++;
              if (dec === 'BLOCK') npmLiveBlock++;
              if (dec === 'ASK') npmLiveAsk++;
            } else {
              pypiLive++;
              if (dec === 'BLOCK') pypiLiveBlock++;
              if (dec === 'ASK') pypiLiveAsk++;
            }
          }
        }

        console.log('RECALL BREAKDOWN (--no-osv mode):');
        console.log(`  osv_mal:          ${osvMalHits} / ${overallMetrics.nMalicious} (${(osvMalHits / overallMetrics.nMalicious * 100).toFixed(1)}%)`);
        console.log(`  dead_name (404):  ${deadNameCount} / ${overallMetrics.nMalicious} (${(deadNameCount / overallMetrics.nMalicious * 100).toFixed(1)}%)`);
        console.log(`  heuristics_only:  ${heuristicsOnlyCount} / ${liveMaliciousCount} (${(heuristicsOnlyCount / liveMaliciousCount * 100).toFixed(1)}% headline recall on live malicious)`);
        console.log(`  headline_recall:  ${heuristicsOnlyCount} / ${liveMaliciousCount} (${(heuristicsOnlyCount / liveMaliciousCount * 100).toFixed(1)}% on live malicious)`);
        console.log(`  overall_no_osv:   ${overallMetrics.alert_tp} / ${overallMetrics.nMalicious} (${overallMetrics.alert_Recall.toFixed(1)}% alert recall, ${overallMetrics.block_tp} / ${overallMetrics.nMalicious} block recall)`);
        console.log('-----------------------------------------------------\n');
        console.log(`NPM Subcategory Recall (--no-osv):`);
        console.log(`  dead_name:        ${npmDead} (BLOCK: ${npmDeadBlock}, ASK: ${npmDeadAsk})`);
        console.log(`  security_stub:    ${npmStub} (BLOCK: ${npmStubBlock}, ASK: ${npmStubAsk})`);
        console.log(`  unpublished:      ${npmUnpublished} (BLOCK: ${npmUnpublishedBlock}, ASK: ${npmUnpublishedAsk})`);
        console.log(`  non_stub_live:    ${npmLive} (BLOCK: ${npmLiveBlock}, ASK: ${npmLiveAsk}, ALERT RECALL: ${npmLive > 0 ? ((npmLiveBlock + npmLiveAsk) / npmLive * 100).toFixed(1) : 0}%)`);
        console.log(`PYPI Subcategory Recall (--no-osv):`);
        console.log(`  dead_name:        ${pypiDead} (BLOCK: ${pypiDeadBlock}, ASK: ${pypiDeadAsk})`);
        console.log(`  security_stub:    ${pypiStub} (BLOCK: ${pypiStubBlock}, ASK: ${pypiStubAsk})`);
        console.log(`  unpublished:      ${pypiUnpublished} (BLOCK: ${pypiUnpublishedBlock}, ASK: ${pypiUnpublishedAsk})`);
        console.log(`  non_stub_live:    ${pypiLive} (BLOCK: ${pypiLiveBlock}, ASK: ${pypiLiveAsk}, ALERT RECALL: ${pypiLive > 0 ? ((pypiLiveBlock + pypiLiveAsk) / pypiLive * 100).toFixed(1) : 0}%)`);
        const totalNonStubLive = npmLive + pypiLive;
        const totalNonStubLiveAlert = npmLiveBlock + npmLiveAsk + pypiLiveBlock + pypiLiveAsk;
        console.log(`HEADLINE RECALL (non_stub_live across ecosystems, n=${totalNonStubLive}):`);
        console.log(`  headline:         ${totalNonStubLiveAlert} / ${totalNonStubLive} (${totalNonStubLive > 0 ? (totalNonStubLiveAlert / totalNonStubLive * 100).toFixed(1) : 0}%)\n`);
      }

      if (isHoldout) {
        // Record holdout result to disk with hash to guarantee ONE run
        let gitCommit = 'unknown';
        let gitTag = 'unknown';
        try {
          gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
          gitTag = execSync('git describe --tags --exact-match 2>/dev/null || true', { encoding: 'utf8' }).trim();
        } catch {}
        const corpusSha256 = crypto.createHash('sha256').update(fs.readFileSync(corpusPath)).digest('hex');
        const blockFPs = targetCases
          .map((c, i) => ({ case: c, decision: targetDecisions[i] }))
          .filter(x => !x.case.isMaliciousOrHallucinated && x.decision === 'BLOCK')
          .map(x => x.case.name);

        const holdoutRecord = {
          label: isNoOsv ? 'second look' : 'holdout',
          date: new Date().toISOString(),
          eval_clock: new Date(EVAL_CLOCK_TIMESTAMP).toISOString(),
          git_commit: gitCommit,
          git_tag: gitTag,
          corpus_sha256: corpusSha256,
          split: 'holdout',
          no_osv: isNoOsv,
          total_cases: overallMetrics.total,
          overall_metrics: overallMetrics,
          npm_metrics: npmMetrics,
          pypi_metrics: pypiMetrics,
          wilson_95_ci_block: wilsonScoreCI(overallMetrics.block_fp, overallMetrics.nBenign).str,
          wilson_95_ci_alert: wilsonScoreCI(overallMetrics.alert_fp, overallMetrics.nBenign).str,
          block_fps: blockFPs,
        };
        fs.writeFileSync(holdoutResultPath, JSON.stringify(holdoutRecord, null, 2), 'utf8');
        console.log(`[HOLDOUT RECORDED] Results permanently committed to: ${holdoutResultPath}\n`);
        if (blockFPs.length > 0) {
          console.log(`Block False Positives (${blockFPs.length}): ${blockFPs.join(', ')}\n`);
        } else {
          console.log(`Block False Positives: none\n`);
        }
      }

      try {
        fs.rmSync(tmpOfflineDir, { recursive: true, force: true });
      } catch {}

      return;
    } finally {
      Date.now = originalDateNow;
    }
  }

  const isFaultMode = process.argv.includes('--fault=registry-timeout');
  console.log('=====================================================');
  console.log(`       ContextArmor Benchmark Evaluation Suite       `);
  if (isFaultMode) {
    console.log(`   [FAULT INJECTION: Registry & OSV Timeout Mode]    `);
  }
  console.log('=====================================================\n');

  const allowlist = new AllowlistManager();
  allowlist.addScope('@myorg');
  allowlist.addScope('@corp');

  const faultFetch = (_url: any, _init?: any): Promise<Response> => {
    return Promise.reject(new Error('ETIMEDOUT: Connection timed out after 8000ms'));
  };

  let engine: PackageRiskEngine;
  let tmpFaultDir: string | undefined;
  if (isFaultMode) {
    tmpFaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-eval-fault-'));
    const cache = new DiskCache(0, 15, path.join(tmpFaultDir, 'cache'));
    const osvCache = new DiskCache(0, 15, path.join(tmpFaultDir, 'osv'));
    const regClient = new RegistryClient(cache, osvCache, faultFetch);
    engine = new PackageRiskEngine(regClient, allowlist, faultFetch);
  } else {
    engine = new PackageRiskEngine(undefined, allowlist);
  }

  const devCases = EVAL_CORPUS.filter((c) => c.split === 'dev');
  const testCases = EVAL_CORPUS.filter((c) => c.split === 'test');

  console.log(`Running on Dev Split (${devCases.length} packages)...`);
  const devDecisions: SecurityDecision[] = [];
  for (const item of devCases) {
    const res = await engine.evaluate({ name: item.name, version: item.version, ecosystem: item.ecosystem });
    const decision = classifyDecision(res);
    devDecisions.push(decision);
    if (isVerbose) {
      const label = item.isMaliciousOrHallucinated ? 'MALICIOUS' : 'BENIGN';
      const score = `${res.riskScore}/100`;
      const nameWithVer = item.version ? `${item.name}@${item.version}` : `${item.name}@latest`;
      const dlCount = res.metadata?.weeklyDownloads !== undefined ? `${res.metadata.weeklyDownloads}/wk` : 'N/A';
      const nearest = findNearestTopDistance(item.name, item.ecosystem);
      const distStr = `dist: ${nearest.dist} (${nearest.nearest})`;
      const signals = res.signals.length > 0
        ? res.signals.map((s) => `${s.name} (${s.score}pts)`).join(', ')
        : 'none';
      const netErrors = res.metadata?.networkError || res.uncheckedReason || 'none';
      console.log(`  [CASE] name: ${nameWithVer.padEnd(36)} | ecosystem: ${item.ecosystem.padEnd(5)} | label: ${label.padEnd(9)} | decision: ${decision.padEnd(5)} | score: ${score.padEnd(7)} | downloads: ${dlCount.padEnd(14)} | ${distStr.padEnd(20)} | signals: ${signals} | network_errors: ${netErrors}`);
    }
  }
  const devMetrics = calculateSplitMetrics(devCases, devDecisions);

  console.log(`\nRunning on Hold-Out Test Split (${testCases.length} packages)...`);
  const testDecisions: SecurityDecision[] = [];
  for (const item of testCases) {
    const res = await engine.evaluate({ name: item.name, version: item.version, ecosystem: item.ecosystem });
    const decision = classifyDecision(res);
    testDecisions.push(decision);
    if (isVerbose) {
      const label = item.isMaliciousOrHallucinated ? 'MALICIOUS' : 'BENIGN';
      const score = `${res.riskScore}/100`;
      const nameWithVer = item.version ? `${item.name}@${item.version}` : `${item.name}@latest`;
      const dlCount = res.metadata?.weeklyDownloads !== undefined ? `${res.metadata.weeklyDownloads}/wk` : 'N/A';
      const nearest = findNearestTopDistance(item.name, item.ecosystem);
      const distStr = `dist: ${nearest.dist} (${nearest.nearest})`;
      const signals = res.signals.length > 0
        ? res.signals.map((s) => `${s.name} (${s.score}pts)`).join(', ')
        : 'none';
      const netErrors = res.metadata?.networkError || res.uncheckedReason || 'none';
      console.log(`  [CASE] name: ${nameWithVer.padEnd(36)} | ecosystem: ${item.ecosystem.padEnd(5)} | label: ${label.padEnd(9)} | decision: ${decision.padEnd(5)} | score: ${score.padEnd(7)} | downloads: ${dlCount.padEnd(14)} | ${distStr.padEnd(20)} | signals: ${signals} | network_errors: ${netErrors}`);
    }
  }
  const testMetrics = calculateSplitMetrics(testCases, testDecisions);

  const totalBenign = devMetrics.nBenign + testMetrics.nBenign;
  const totalMalicious = devMetrics.nMalicious + testMetrics.nMalicious;
  const totalBlockFp = devMetrics.block_fp + testMetrics.block_fp;
  const totalAlertFp = devMetrics.alert_fp + testMetrics.alert_fp;
  const totalBlockTp = devMetrics.block_tp + testMetrics.block_tp;
  const totalAlertTp = devMetrics.alert_tp + testMetrics.alert_tp;
  const overallBlockFPR = totalBenign > 0 ? (totalBlockFp / totalBenign) * 100 : 0;
  const overallAlertFPR = totalBenign > 0 ? (totalAlertFp / totalBenign) * 100 : 0;
  const overallBlockRecall = totalMalicious > 0 ? (totalBlockTp / totalMalicious) * 100 : 0;
  const overallAlertRecall = totalMalicious > 0 ? (totalAlertTp / totalMalicious) * 100 : 0;

  const devBlockUpperBound = devMetrics.nBenign > 0 ? (3 / devMetrics.nBenign) * 100 : 0;
  const testBlockUpperBound = testMetrics.nBenign > 0 ? (3 / testMetrics.nBenign) * 100 : 0;
  const overallBlockUpperBound = totalBenign > 0 ? (3 / totalBenign) * 100 : 0;

  console.log('\n-----------------------------------------------------');
  console.log(`DEV SPLIT RESULTS (n=${devMetrics.total}, n_benign=${devMetrics.nBenign}, n_malicious=${devMetrics.nMalicious}):`);
  console.log(`  block_FPR: ${devMetrics.block_FPR.toFixed(1)}% (${devMetrics.block_fp}/${devMetrics.nBenign}) [Wilson 95% CI: ${wilsonScoreCI(devMetrics.block_fp, devMetrics.nBenign).str}] | alert_FPR: ${devMetrics.alert_FPR.toFixed(1)}% (${devMetrics.alert_fp}/${devMetrics.nBenign}) [Wilson 95% CI: ${wilsonScoreCI(devMetrics.alert_fp, devMetrics.nBenign).str}]`);
  console.log(`  block_Recall: ${devMetrics.block_Recall.toFixed(1)}% (${devMetrics.block_tp}/${devMetrics.nMalicious}) [Wilson 95% CI: ${wilsonScoreCI(devMetrics.block_tp, devMetrics.nMalicious).str}] | alert_Recall: ${devMetrics.alert_Recall.toFixed(1)}% (${devMetrics.alert_tp}/${devMetrics.nMalicious}) [Wilson 95% CI: ${wilsonScoreCI(devMetrics.alert_tp, devMetrics.nMalicious).str}] | alert_Precision: ${devMetrics.alert_Precision.toFixed(1)}% (${devMetrics.alert_tp}/${devMetrics.alert_tp + devMetrics.alert_fp})`);
  console.log(`  Block Breakdown: TP=${devMetrics.block_tp} | FP=${devMetrics.block_fp} | TN=${devMetrics.block_tn} | FN=${devMetrics.block_fn}`);
  console.log(`  Alert Breakdown: TP=${devMetrics.alert_tp} | FP=${devMetrics.alert_fp} | TN=${devMetrics.alert_tn} | FN=${devMetrics.alert_fn}`);

  console.log(`\nHOLD-OUT TEST SPLIT RESULTS (n=${testMetrics.total}, n_benign=${testMetrics.nBenign}, n_malicious=${testMetrics.nMalicious}):`);
  console.log(`  block_FPR: ${testMetrics.block_FPR.toFixed(1)}% (${testMetrics.block_fp}/${testMetrics.nBenign}) [Wilson 95% CI: ${wilsonScoreCI(testMetrics.block_fp, testMetrics.nBenign).str}] | alert_FPR: ${testMetrics.alert_FPR.toFixed(1)}% (${testMetrics.alert_fp}/${testMetrics.nBenign}) [Wilson 95% CI: ${wilsonScoreCI(testMetrics.alert_fp, testMetrics.nBenign).str}]`);
  console.log(`  block_Recall: ${testMetrics.block_Recall.toFixed(1)}% (${testMetrics.block_tp}/${testMetrics.nMalicious}) [Wilson 95% CI: ${wilsonScoreCI(testMetrics.block_tp, testMetrics.nMalicious).str}] | alert_Recall: ${testMetrics.alert_Recall.toFixed(1)}% (${testMetrics.alert_tp}/${testMetrics.nMalicious}) [Wilson 95% CI: ${wilsonScoreCI(testMetrics.alert_tp, testMetrics.nMalicious).str}] | alert_Precision: ${testMetrics.alert_Precision.toFixed(1)}% (${testMetrics.alert_tp}/${testMetrics.alert_tp + testMetrics.alert_fp})`);
  console.log(`  Block Breakdown: TP=${testMetrics.block_tp} | FP=${testMetrics.block_fp} | TN=${testMetrics.block_tn} | FN=${testMetrics.block_fn}`);
  console.log(`  Alert Breakdown: TP=${testMetrics.alert_tp} | FP=${testMetrics.alert_fp} | TN=${testMetrics.alert_tn} | FN=${testMetrics.alert_fn}`);

  console.log('\nOVERALL CORPUS SUMMARY:');
  console.log(`  Total Cases: ${devMetrics.total + testMetrics.total} | Benign: ${totalBenign} | Malicious/Squat: ${totalMalicious}`);
  console.log(`  block_FPR: ${overallBlockFPR.toFixed(1)}% (${totalBlockFp}/${totalBenign}) [Wilson 95% CI: ${wilsonScoreCI(totalBlockFp, totalBenign).str}] | alert_FPR: ${overallAlertFPR.toFixed(1)}% (${totalAlertFp}/${totalBenign}) [Wilson 95% CI: ${wilsonScoreCI(totalAlertFp, totalBenign).str}]`);
  console.log(`  block_Recall: ${overallBlockRecall.toFixed(1)}% (${totalBlockTp}/${totalMalicious}) [Wilson 95% CI: ${wilsonScoreCI(totalBlockTp, totalMalicious).str}] | alert_Recall: ${overallAlertRecall.toFixed(1)}% (${totalAlertTp}/${totalMalicious}) [Wilson 95% CI: ${wilsonScoreCI(totalAlertTp, totalMalicious).str}]`);
  console.log('-----------------------------------------------------\n');

  if (tmpFaultDir) {
    try {
      fs.rmSync(tmpFaultDir, { recursive: true, force: true });
    } catch {}
  }

  if (totalBlockFp > 0) {
    console.error(`[GATE FAILURE] block_FPR is ${overallBlockFPR.toFixed(1)}% (${totalBlockFp}/${totalBenign} false blocks). Gate requirement: block_FPR == 0.0%.`);
    process.exit(1);
  }
}

runEvaluation().catch((err) => {
  console.error(err);
  process.exit(1);
});
