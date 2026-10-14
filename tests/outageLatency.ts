import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handlePreToolUseHook } from '../src/hooks/preToolUse.js';
import { PackageRiskEngine } from '../src/detectors/packageRisk/index.js';
import { RegistryClient } from '../src/detectors/packageRisk/registryClient.js';
import { AllowlistManager } from '../src/core/allowlist.js';
import { DiskCache } from '../src/core/cache.js';

function createBlackholeEngine(): { engine: PackageRiskEngine; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-outage-test-'));
  const cache = new DiskCache(0, 15, path.join(tmpDir, 'cache'));
  const osvCache = new DiskCache(0, 15, path.join(tmpDir, 'osv'));
  // Black-hole fetch: never resolves, simulating complete network outage / hang
  const blackholeFetch: typeof fetch = () => new Promise<Response>(() => {});
  const regClient = new RegistryClient(cache, osvCache, blackholeFetch);
  const allowlist = new AllowlistManager();
  const engine = new PackageRiskEngine(regClient, allowlist, blackholeFetch);

  return {
    engine,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

async function runOutageTest() {
  console.log('=====================================================');
  console.log('   ContextArmor Outage Latency Verification Suite    ');
  console.log('=====================================================\n');

  const { engine, cleanup } = createBlackholeEngine();

  const cmd = 'npm i express';
  const payload = JSON.stringify({ tool_input: { command: cmd } });

  console.log(`Command: ${cmd}`);
  console.log('Network condition: Black-holed (injected non-resolving fetch in test code)');

  const startTime = Date.now();
  const res = await handlePreToolUseHook(payload, 'claude', engine);
  const elapsedMs = Date.now() - startTime;

  console.log(`Measured Time: ${elapsedMs} ms`);
  console.log(`Decision: ${res.decision} (Exit Code: ${res.exitCode})`);
  console.log(`Reason: ${res.reason}`);
  console.log(`Payload: ${res.stdoutPayload}`);

  cleanup();

  const isAsk = res.decision === 'ASK' && res.exitCode === 0;
  const listsExpress = res.reason?.includes('express') && res.reason?.includes('exceeded budget');
  const timedOutNear20s = elapsedMs >= 19500 && elapsedMs <= 22000;

  if (isAsk && listsExpress && timedOutNear20s) {
    console.log('\n[PASS] Total hook time capped at 20s budget and fail-open to ASK listing unchecked packages.');
    process.exit(0);
  } else {
    console.error('\n[FAIL] Outage latency test did not meet criteria:');
    console.error(`  isAsk=${isAsk}, listsExpress=${listsExpress}, timedOutNear20s=${timedOutNear20s} (elapsed: ${elapsedMs}ms)`);
    process.exit(1);
  }
}

runOutageTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
