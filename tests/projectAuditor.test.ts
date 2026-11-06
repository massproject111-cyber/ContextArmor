import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractAllNpmDeps,
  extractAllPypiDeps,
} from '../src/ui/diagnosticMapper.js';
import { getStrixStatus, parseStrixSarif } from '../src/integrations/strix.js';

test('extractAllNpmDeps: extracts all dependencies from package.json without git HEAD', () => {
  const samplePkg = JSON.stringify(
    {
      name: 'test-app',
      dependencies: {
        chalk: '^5.6.1',
        express: '4.18.2',
      },
      devDependencies: {
        typescript: '^5.0.0',
      },
    },
    null,
    2
  );

  const deps = extractAllNpmDeps(samplePkg);
  assert.equal(deps.length, 3);
  const names = deps.map((d) => d.name);
  assert.ok(names.includes('chalk'));
  assert.ok(names.includes('express'));
  assert.ok(names.includes('typescript'));
  assert.equal(deps[0].ecosystem, 'npm');
});

test('extractAllPypiDeps: extracts all requirements without git HEAD', () => {
  const sampleReqs = `
# Core dependencies
requests==2.31.0
torch>=2.0.0
durabletask==1.4.2
`;

  const deps = extractAllPypiDeps(sampleReqs);
  assert.equal(deps.length, 3);
  assert.equal(deps[0].name, 'requests');
  assert.equal(deps[0].version, '2.31.0');
  assert.equal(deps[1].name, 'torch');
  assert.equal(deps[1].version, '2.0.0');
  assert.equal(deps[2].name, 'durabletask');
  assert.equal(deps[2].version, '1.4.2');
  assert.equal(deps[0].ecosystem, 'pypi');
});

test('getStrixStatus: accurately detects local strix installation and config', () => {
  const status = getStrixStatus();
  assert.equal(typeof status.installed, 'boolean');
  assert.equal(typeof status.hasConfig, 'boolean');
  if (status.installed) {
    assert.ok(status.binaryPath && status.binaryPath.includes('strix'));
  }
});

test('parseStrixSarif: parses SARIF 2.1.0 findings into ThreatItem model', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strix-test-'));
  const sarifFile = path.join(tmpDir, 'findings.sarif');

  const mockSarif = {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'Strix' } },
        results: [
          {
            ruleId: 'CWE-89',
            message: { text: 'SQL Injection detected in login endpoint' },
            level: 'error',
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'src/auth/login.py' },
                  region: { startLine: 42 },
                },
              },
            ],
          },
          {
            ruleId: 'CWE-79',
            message: { text: 'Cross-Site Scripting (XSS) in user profile render' },
            level: 'warning',
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'templates/profile.html' },
                  region: { startLine: 15 },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  fs.writeFileSync(sarifFile, JSON.stringify(mockSarif, null, 2));

  const threats = parseStrixSarif(sarifFile, tmpDir);
  assert.equal(threats.length, 2);

  assert.equal(threats[0].title, '[ContextArmor Pentest] CWE-89');
  assert.equal(threats[0].severity, 'CRITICAL');
  assert.equal(threats[0].line, 41);
  assert.ok(threats[0].desc.includes('SQL Injection'));

  assert.equal(threats[1].title, '[ContextArmor Pentest] CWE-79');
  assert.equal(threats[1].severity, 'WARNING');
  assert.equal(threats[1].line, 14);

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runLocalSandboxAnalysis: performs zero-Docker sandbox pentest and emits SARIF', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
  const vulnerablePy = path.join(tmpDir, 'vuln.py');
  fs.writeFileSync(
    vulnerablePy,
    `
import sqlite3
import subprocess

def query_user(user_input):
    cursor.execute(f"SELECT * FROM users WHERE id = {user_input}")

def run_command(cmd):
    subprocess.Popen(f"echo {cmd}", shell=True)
`
  );

  const { runLocalSandboxAnalysis } = require('../src/integrations/strix.js');
  const threats = runLocalSandboxAnalysis(tmpDir);

  assert.ok(threats.length >= 2);
  const titles = threats.map((t: any) => t.title);
  assert.ok(titles.includes('[ContextArmor Pentest] CWE-89'));
  assert.ok(titles.includes('[ContextArmor Pentest] CWE-78'));

  const emittedSarif = path.join(tmpDir, 'strix_runs', 'contextarmor_sandbox', 'findings.sarif');
  assert.ok(fs.existsSync(emittedSarif));

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
