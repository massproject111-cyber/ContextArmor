import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAddedNpmDeps,
  extractAddedPypiDeps,
  extractPythonThreats,
  extractSuggestedPin,
  mapCheckResultToDiagnostic,
  type AddedDependency,
  type CliCheckResult,
} from '../src/ui/diagnosticMapper.js';

test('extractAddedNpmDeps: detects new dependency vs HEAD', () => {
  const headJson = JSON.stringify({
    name: 'my-app',
    dependencies: {
      express: '^4.18.2',
    },
  }, null, 2);

  const currentJson = JSON.stringify({
    name: 'my-app',
    dependencies: {
      express: '^4.18.2',
      chalk: '^5.6.1',
    },
  }, null, 2);

  const added = extractAddedNpmDeps(currentJson, headJson);
  assert.equal(added.length, 1);
  assert.equal(added[0].name, 'chalk');
  assert.equal(added[0].version, '5.6.1');
  assert.equal(added[0].ecosystem, 'npm');
  assert.ok(added[0].line > 0);
  assert.ok(added[0].rawLine.includes('chalk'));
});

test('extractAddedNpmDeps: detects version bump on existing dependency vs HEAD', () => {
  const headJson = JSON.stringify({
    name: 'my-app',
    dependencies: {
      chalk: '5.3.0',
    },
  }, null, 2);

  const currentJson = JSON.stringify({
    name: 'my-app',
    dependencies: {
      chalk: '5.6.1',
    },
  }, null, 2);

  const added = extractAddedNpmDeps(currentJson, headJson);
  assert.equal(added.length, 1);
  assert.equal(added[0].name, 'chalk');
  assert.equal(added[0].version, '5.6.1');
});

test('extractAddedNpmDeps: unchanged dependencies yield empty list', () => {
  const headJson = JSON.stringify({
    name: 'my-app',
    dependencies: {
      chalk: '5.3.0',
    },
  }, null, 2);

  const added = extractAddedNpmDeps(headJson, headJson);
  assert.equal(added.length, 0);
});

test('extractAddedPypiDeps: detects new dependency in requirements.txt', () => {
  const headReqs = `requests==2.31.0\nurllib3==2.0.0\n`;
  const currentReqs = `requests==2.31.0\nurllib3==2.0.0\ndurabletask==1.4.2\n`;

  const added = extractAddedPypiDeps(currentReqs, headReqs);
  assert.equal(added.length, 1);
  assert.equal(added[0].name, 'durabletask');
  assert.equal(added[0].version, '1.4.2');
  assert.equal(added[0].ecosystem, 'pypi');
  assert.equal(added[0].line, 2);
});

test('extractAddedPypiDeps: unchanged requirements yield empty list', () => {
  const reqs = `requests==2.31.0\nurllib3==2.0.0\n`;
  const added = extractAddedPypiDeps(reqs, reqs);
  assert.equal(added.length, 0);
});

test('extractSuggestedPin: parses versions correctly from ASK reasons', () => {
  const npmAskReason = "[ContextArmor WARNING] Flagged packages: [my-cool-pkg: Package 'my-cool-pkg@2.0.0' was published 5.0 hours ago (< 72h cooldown). High risk of unvetted fresh release or hijack. Newest version older than 72h: '1.0.0'. Suggested pin: 'npm i my-cool-pkg@1.0.0'.]. Confirm installation?";
  assert.equal(extractSuggestedPin(npmAskReason), '1.0.0');

  const pypiAskReason = "[ContextArmor WARNING] Flagged packages: [my-py-pkg: Package 'my-py-pkg@2.0.0' was published 5.0 hours ago (< 72h cooldown). High risk of unvetted fresh release or hijack. Newest version older than 72h: '1.0.0'. Suggested pin: 'pip install my-py-pkg==1.0.0'.]. Confirm installation?";
  assert.equal(extractSuggestedPin(pypiAskReason), '1.0.0');

  const noPinReason = "[ContextArmor WARNING] Flagged packages: [unknown-pkg: Registry error 503]";
  assert.equal(extractSuggestedPin(noPinReason), undefined);
});

test('mapCheckResultToDiagnostic: BLOCK maps to Error with contextarmor-block code', () => {
  const dep: AddedDependency = {
    name: 'chalk',
    version: '5.6.1',
    ecosystem: 'npm',
    line: 5,
    startCol: 4,
    endCol: 25,
    rawLine: '    "chalk": "^5.6.1",',
  };

  const blockFixture: CliCheckResult = {
    decision: 'BLOCK',
    reason: "[ContextArmor CIRCUIT BREAKER] Blocked installation of 'chalk' (npm): Package has confirmed malicious advisory: MAL-2025-46969",
    signals: [
      { name: 'osv_malicious_advisory', score: 100, weight: 0.5, reason: 'Confirmed MAL-2025-46969' }
    ],
  };

  const diag = mapCheckResultToDiagnostic(dep, blockFixture);
  assert.ok(diag);
  assert.equal(diag.severity, 'Error');
  assert.equal(diag.code, 'contextarmor-block');
  assert.equal(diag.line, 5);
  assert.equal(diag.message, blockFixture.reason);
  assert.equal(diag.suggestedPin, undefined);
});

test('mapCheckResultToDiagnostic: ASK maps to Warning with contextarmor-ask code and suggested pin', () => {
  const dep: AddedDependency = {
    name: 'my-cool-pkg',
    version: '2.0.0',
    ecosystem: 'npm',
    line: 8,
    startCol: 4,
    endCol: 30,
    rawLine: '    "my-cool-pkg": "^2.0.0",',
  };

  const askFixture: CliCheckResult = {
    decision: 'ASK',
    reason: "[ContextArmor WARNING] Flagged packages: [my-cool-pkg: Package 'my-cool-pkg@2.0.0' was published 5.0 hours ago (< 72h cooldown). High risk of unvetted fresh release or hijack. Newest version older than 72h: '1.0.0'. Suggested pin: 'npm i my-cool-pkg@1.0.0'.]. Confirm installation?",
    signals: [
      { name: 'version_cooldown_72h', score: 40, weight: 1, reason: 'Cooldown hit' }
    ],
  };

  const diag = mapCheckResultToDiagnostic(dep, askFixture);
  assert.ok(diag);
  assert.equal(diag.severity, 'Warning');
  assert.equal(diag.code, 'contextarmor-ask');
  assert.equal(diag.suggestedPin, '1.0.0');
});

test('mapCheckResultToDiagnostic: ALLOW maps to null (no diagnostic)', () => {
  const dep: AddedDependency = {
    name: 'chalk',
    version: '5.3.0',
    ecosystem: 'npm',
    line: 5,
    startCol: 4,
    endCol: 25,
    rawLine: '    "chalk": "^5.3.0",',
  };

  const allowFixture: CliCheckResult = {
    decision: 'ALLOW',
    reason: 'Package passed clean',
    signals: [],
  };

  const diag = mapCheckResultToDiagnostic(dep, allowFixture);
  assert.equal(diag, null);
});

test('extractPythonThreats: flags insecure torch.load without weights_only=True', () => {
  const code = 'import torch\nmodel = torch.load("checkpoint.pt")\n';
  const threats = extractPythonThreats(code);
  assert.equal(threats.length, 1);
  assert.equal(threats[0].line, 1);
  assert.equal(threats[0].severity, 'Warning');
  assert.ok(threats[0].message.includes('torch.load'));
  assert.ok(threats[0].message.includes('weights_only=True'));
});

test('extractPythonThreats: ignores secure torch.load with weights_only=True', () => {
  const code = 'import torch\nmodel = torch.load("checkpoint.pt", weights_only=True)\n';
  const threats = extractPythonThreats(code);
  assert.equal(threats.length, 0);
});

