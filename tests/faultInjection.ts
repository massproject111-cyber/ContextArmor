import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handlePreToolUseHook } from '../src/hooks/preToolUse.js';
import { PackageRiskEngine } from '../src/detectors/packageRisk/index.js';
import { RegistryClient } from '../src/detectors/packageRisk/registryClient.js';
import { VersionResolver } from '../src/detectors/packageRisk/versionResolver.js';
import { AllowlistManager } from '../src/core/allowlist.js';
import { DiskCache } from '../src/core/cache.js';

function createIsolatedEngine(fetchFn: typeof fetch): { engine: PackageRiskEngine; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-fault-test-'));
  const cache = new DiskCache(0, 15, path.join(tmpDir, 'cache'));
  const osvCache = new DiskCache(0, 15, path.join(tmpDir, 'osv'));
  const regClient = new RegistryClient(cache, osvCache, fetchFn);
  const allowlist = new AllowlistManager();
  const vResolver = new VersionResolver(cache, fetchFn);
  const engine = new PackageRiskEngine(regClient, allowlist, fetchFn, vResolver);

  return {
    engine,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

async function runFaultTests() {
  console.log('=====================================================');
  console.log('       ContextArmor Fault Injection Test Suite       ');
  console.log('=====================================================\n');

  let failures = 0;

  // --------------------------------------------------------------------------
  // (a) Registry Timeout Fault
  // --------------------------------------------------------------------------
  console.log('=== (a) Fault Injection: Registry Timeout ===');
  const timeoutFetch: typeof fetch = async (input, _init) => {
    const url = String(input);
    if (url.includes('registry.npmjs.org') || url.includes('pypi.org')) {
      throw new Error('ETIMEDOUT: Connection timed out after 8000ms');
    }
    return globalThis.fetch(input, _init);
  };

  const { engine: engineTimeout, cleanup: cleanupA } = createIsolatedEngine(timeoutFetch);

  const testCommandsA = [
    'npm i express',
    'npm i nope-xyz-9',
    'npm i chalk@5.6.1',
  ];

  for (const cmd of testCommandsA) {
    const payload = JSON.stringify({ tool_input: { command: cmd } });
    const res = await handlePreToolUseHook(payload, 'claude', engineTimeout);
    console.log(`Command: ${cmd}`);
    console.log(`  Decision: ${res.decision} (Exit Code: ${res.exitCode})`);
    console.log(`  Payload: ${res.stdoutPayload}`);

    const isAsk = res.decision === 'ASK' && res.exitCode === 0;
    const isUnchecked = res.stdoutPayload?.toLowerCase().includes('unchecked');
    const isBlock = res.decision === 'BLOCK' || res.exitCode === 2;
    const isAllow = res.decision === 'ALLOW';

    if (isAsk && isUnchecked && !isBlock && !isAllow) {
      console.log(`  [PASS] Correctly dispatched to ASK with unchecked warning.\n`);
    } else {
      console.error(`  [FAIL] Expected ASK unchecked, got decision=${res.decision}, exitCode=${res.exitCode}\n`);
      failures++;
    }
  }
  cleanupA();

  // --------------------------------------------------------------------------
  // (b) OSV Only Down Fault
  // --------------------------------------------------------------------------
  console.log('=== (b) Fault Injection: OSV Only Down ===');
  const osvDownFetch: typeof fetch = async (input, _init) => {
    const url = String(input);
    if (url.includes('api.osv.dev')) {
      throw new Error('OSV API down: 503 Service Unavailable');
    }
    return globalThis.fetch(input, _init);
  };

  const { engine: engineOsvDown, cleanup: cleanupB } = createIsolatedEngine(osvDownFetch);

  const cmdB = 'npm i chalk@5.6.1';
  const payloadB = JSON.stringify({ tool_input: { command: cmdB } });
  const resB = await handlePreToolUseHook(payloadB, 'claude', engineOsvDown);
  console.log(`Command: ${cmdB}`);
  console.log(`  Decision: ${resB.decision} (Exit Code: ${resB.exitCode})`);
  console.log(`  Payload: ${resB.stdoutPayload}`);

  const isAskB = resB.decision === 'ASK' && resB.exitCode === 0;
  const isOsvUnchecked = resB.stdoutPayload?.toLowerCase().includes('osv') && resB.stdoutPayload?.toLowerCase().includes('unchecked');

  if (isAskB && isOsvUnchecked) {
    console.log(`  [PASS] Correctly dispatched to ASK with OSV unchecked warning.\n`);
  } else {
    console.error(`  [FAIL] Expected ASK with OSV unchecked, got decision=${resB.decision}, exitCode=${resB.exitCode}\n`);
    failures++;
  }
  cleanupB();

  // --------------------------------------------------------------------------
  // (c) Registry 429 and 503 Fault
  // --------------------------------------------------------------------------
  console.log('=== (c) Fault Injection: Registry 429 and 503 ===');
  const fetch429: typeof fetch = async (input, _init) => {
    const url = String(input);
    if (url.includes('registry.npmjs.org') || url.includes('pypi.org')) {
      return new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' });
    }
    return globalThis.fetch(input, _init);
  };
  const { engine: engine429, cleanup: cleanupC1 } = createIsolatedEngine(fetch429);

  const res429 = await handlePreToolUseHook(JSON.stringify({ tool_input: { command: 'npm i express' } }), 'claude', engine429);
  console.log(`1. Registry 429 Rate Limit (npm i express):`);
  console.log(`  Decision: ${res429.decision} (Exit Code: ${res429.exitCode})`);
  console.log(`  Payload: ${res429.stdoutPayload}`);
  if (res429.decision === 'ASK' && res429.exitCode === 0 && res429.stdoutPayload?.toLowerCase().includes('unchecked')) {
    console.log(`  [PASS] Correctly dispatched to ASK with unchecked on 429.\n`);
  } else {
    console.error(`  [FAIL] Expected ASK unchecked on 429, got ${res429.decision}\n`);
    failures++;
  }
  cleanupC1();

  const fetch503: typeof fetch = async (input, _init) => {
    const url = String(input);
    if (url.includes('registry.npmjs.org') || url.includes('pypi.org')) {
      return new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });
    }
    return globalThis.fetch(input, _init);
  };
  const { engine: engine503, cleanup: cleanupC2 } = createIsolatedEngine(fetch503);

  const res503 = await handlePreToolUseHook(JSON.stringify({ tool_input: { command: 'npm i express' } }), 'claude', engine503);
  console.log(`2. Registry 503 Service Unavailable (npm i express):`);
  console.log(`  Decision: ${res503.decision} (Exit Code: ${res503.exitCode})`);
  console.log(`  Payload: ${res503.stdoutPayload}`);
  if (res503.decision === 'ASK' && res503.exitCode === 0 && res503.stdoutPayload?.toLowerCase().includes('unchecked')) {
    console.log(`  [PASS] Correctly dispatched to ASK with unchecked on 503.\n`);
  } else {
    console.error(`  [FAIL] Expected ASK unchecked on 503, got ${res503.decision}\n`);
    failures++;
  }
  cleanupC2();

  // --------------------------------------------------------------------------
  // (d) Real 404 on nope-xyz-9, Network Up
  // --------------------------------------------------------------------------
  console.log('=== (d) Real 404 on nope-xyz-9 (Network Up) ===');
  const { engine: normalEngine, cleanup: cleanupD } = createIsolatedEngine(globalThis.fetch);
  const cmdD = 'npm i nope-xyz-9';
  const resD = await handlePreToolUseHook(JSON.stringify({ tool_input: { command: cmdD } }), 'claude', normalEngine);
  console.log(`Command: ${cmdD}`);
  console.log(`  Decision: ${resD.decision} (Exit Code: ${resD.exitCode})`);
  console.log(`  Payload: ${resD.stdoutPayload}`);

  const isBlockD = resD.decision === 'BLOCK' && resD.exitCode === 2;
  const isHallucination = resD.stdoutPayload?.includes('unregistered AI hallucination') || resD.reason?.includes('unregistered AI hallucination');

  if (isBlockD && isHallucination) {
    console.log(`  [PASS] Correctly BLOCKED on confirmed HTTP 404 unregistered hallucination.\n`);
  } else {
    console.error(`  [FAIL] Expected BLOCK with unregistered hallucination, got decision=${resD.decision}, exitCode=${resD.exitCode}\n`);
    failures++;
  }
  cleanupD();

  // --------------------------------------------------------------------------
  // (e) Cooldown ASK Text Demonstration (npm & PyPI)
  // --------------------------------------------------------------------------
  console.log('=== (e) Cooldown ASK Text Demonstration ===');
  const nowMs = Date.now();
  const fiveHoursAgo = new Date(nowMs - 5 * 3600 * 1000).toISOString();
  const fourDaysAgo = new Date(nowMs - 4 * 24 * 3600 * 1000).toISOString();

  const cooldownFetch: typeof fetch = async (input, _init) => {
    const url = String(input);
    if (url.includes('registry.npmjs.org/my-cool-pkg')) {
      return new Response(JSON.stringify({
        name: 'my-cool-pkg',
        'dist-tags': { latest: '2.0.0' },
        time: {
          created: fourDaysAgo,
          '1.0.0': fourDaysAgo,
          '2.0.0': fiveHoursAgo,
        },
        versions: {
          '1.0.0': { name: 'my-cool-pkg', version: '1.0.0' },
          '2.0.0': { name: 'my-cool-pkg', version: '2.0.0' },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('pypi.org/pypi/my-py-pkg/json')) {
      return new Response(JSON.stringify({
        info: { name: 'my-py-pkg', version: '2.0.0' },
        releases: {
          '1.0.0': [{ upload_time_iso_8601: fourDaysAgo }],
          '2.0.0': [{ upload_time_iso_8601: fiveHoursAgo }],
        },
        urls: [{ upload_time_iso_8601: fiveHoursAgo }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('api.npmjs.org/downloads')) {
      return new Response(JSON.stringify({ downloads: 25000 }), { status: 200 });
    }
    if (url.includes('api.osv.dev')) {
      return new Response(JSON.stringify({ vulns: [] }), { status: 200 });
    }
    return globalThis.fetch(input, _init);
  };

  const { engine: engineCooldown, cleanup: cleanupE } = createIsolatedEngine(cooldownFetch);

  // npm test
  const resNpm = await handlePreToolUseHook(JSON.stringify({ tool_input: { command: 'npm i my-cool-pkg' } }), 'claude', engineCooldown);
  console.log('1. npm Cooldown Test (npm i my-cool-pkg):');
  console.log(`  Decision: ${resNpm.decision} (Exit Code: ${resNpm.exitCode})`);
  console.log(`  Reason: ${resNpm.reason}`);
  console.log(`  Payload: ${resNpm.stdoutPayload}`);

  const hasNpmVersion = resNpm.reason?.includes('my-cool-pkg@2.0.0') && resNpm.reason?.includes('hours ago');
  const hasNpmStable = resNpm.reason?.includes("Newest version older than 72h: '1.0.0'");
  const hasNpmPin = resNpm.reason?.includes("Suggested pin: 'npm i my-cool-pkg@1.0.0'");

  if (resNpm.decision === 'ASK' && hasNpmVersion && hasNpmStable && hasNpmPin) {
    console.log('  [PASS] Correctly formatted npm cooldown ASK text with latest version, age, stable version, and suggested pin command.\n');
  } else {
    console.error('  [FAIL] npm cooldown text missing required fields.\n');
    failures++;
  }

  // pypi test
  const resPypi = await handlePreToolUseHook(JSON.stringify({ tool_input: { command: 'pip install my-py-pkg' } }), 'claude', engineCooldown);
  console.log('2. PyPI Cooldown Test (pip install my-py-pkg):');
  console.log(`  Decision: ${resPypi.decision} (Exit Code: ${resPypi.exitCode})`);
  console.log(`  Reason: ${resPypi.reason}`);
  console.log(`  Payload: ${resPypi.stdoutPayload}`);

  const hasPypiVersion = resPypi.reason?.includes('my-py-pkg@2.0.0') && resPypi.reason?.includes('hours ago');
  const hasPypiStable = resPypi.reason?.includes("Newest version older than 72h: '1.0.0'");
  const hasPypiPin = resPypi.reason?.includes("Suggested pin: 'pip install my-py-pkg==1.0.0'");

  if (resPypi.decision === 'ASK' && hasPypiVersion && hasPypiStable && hasPypiPin) {
    console.log('  [PASS] Correctly formatted PyPI cooldown ASK text with latest version, age, stable version, and suggested pin command.\n');
  } else {
    console.error('  [FAIL] PyPI cooldown text missing required fields.\n');
    failures++;
  }

  cleanupE();

  // --------------------------------------------------------------------------
  // (f) Unresolved Version on Registered Package (OSV Unchecked)
  // --------------------------------------------------------------------------
  console.log('=== (f) Fault Injection: Unresolved Version on Registered Package ===');
  const unresolvedVerFetch: typeof fetch = async (input, _init) => {
    const url = String(input);
    if (url.includes('registry.npmjs.org/unresolved-ver-pkg')) {
      return new Response(JSON.stringify({
        name: 'unresolved-ver-pkg',
        'dist-tags': {}, // No latest tag!
        time: { created: '2020-01-01T00:00:00Z', '1.0.0': '2020-01-01T00:00:00Z' },
        versions: { '1.0.0': { name: 'unresolved-ver-pkg', version: '1.0.0' } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('api.npmjs.org/downloads')) {
      return new Response(JSON.stringify({ downloads: 10000 }), { status: 200 });
    }
    return globalThis.fetch(input, _init);
  };

  const { engine: engineUnresolved, cleanup: cleanupF } = createIsolatedEngine(unresolvedVerFetch);


  const cmdF = 'npm i unresolved-ver-pkg';
  const payloadF = JSON.stringify({ tool_input: { command: cmdF } });
  const resF = await handlePreToolUseHook(payloadF, 'claude', engineUnresolved);
  console.log(`Command: ${cmdF}`);
  console.log(`  Decision: ${resF.decision} (Exit Code: ${resF.exitCode})`);
  console.log(`  Reason: ${resF.reason}`);
  console.log(`  Payload: ${resF.stdoutPayload}`);

  const isAskF = resF.decision === 'ASK' && resF.exitCode === 0;
  const hasUnresolvedWarning = resF.stdoutPayload?.includes('version unresolved; OSV unchecked') || resF.reason?.includes('version unresolved; OSV unchecked');

  if (isAskF && hasUnresolvedWarning) {
    console.log('  [PASS] Correctly dispatched to ASK when version cannot be resolved for registered package.\n');
  } else {
    console.error(`  [FAIL] Expected ASK with "version unresolved; OSV unchecked", got decision=${resF.decision}, exitCode=${resF.exitCode}\n`);
    failures++;
  }
  cleanupF();

  console.log('-----------------------------------------------------');
  if (failures > 0) {
    console.error(`Fault Injection Suite Failed: ${failures} failure(s).`);
    process.exit(1);
  } else {
    console.log('All Fault Injection Tests Passed Successfully (0 failures).');
    process.exit(0);
  }
}

runFaultTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
