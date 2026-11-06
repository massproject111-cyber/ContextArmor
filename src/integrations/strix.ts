import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child_process from 'node:child_process';
import type { ThreatItem } from '../ui/treeView.js';

export interface StrixStatus {
  installed: boolean;
  binaryPath?: string;
  hasConfig: boolean;
  version?: string;
}

/**
 * Probes environment for local Strix penetration testing tool.
 */
export function getStrixStatus(): StrixStatus {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'strix'),
    '/usr/local/bin/strix',
    '/opt/homebrew/bin/strix',
  ];

  let binaryPath: string | undefined;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      binaryPath = c;
      break;
    }
  }

  const configPath = path.join(home, '.strix', 'cli-config.json');
  const hasConfig = fs.existsSync(configPath);

  return {
    installed: !!binaryPath,
    binaryPath,
    hasConfig,
  };
}

/**
 * Searches for any strix_runs directory in workspace and extracts SARIF / JSON findings.
 */
export function loadExistingStrixFindings(workspaceRoot: string): ThreatItem[] {
  const threats: ThreatItem[] = [];
  const runsDir = path.join(workspaceRoot, 'strix_runs');

  if (!fs.existsSync(runsDir)) {
    return threats;
  }

  try {
    const entries = fs.readdirSync(runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const runFolder = path.join(runsDir, entry.name);
        const sarifPath = path.join(runFolder, 'findings.sarif');
        if (fs.existsSync(sarifPath)) {
          const parsed = parseStrixSarif(sarifPath, workspaceRoot);
          threats.push(...parsed);
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  return threats;
}

/**
 * Parses a SARIF 2.1.0 document produced by Strix and returns ThreatItems.
 */
export function parseStrixSarif(sarifPath: string, workspaceRoot: string): ThreatItem[] {
  const threats: ThreatItem[] = [];
  try {
    const raw = fs.readFileSync(sarifPath, 'utf8');
    const doc = JSON.parse(raw);
    const runs = doc.runs || [];

    for (const run of runs) {
      const results = run.results || [];
      for (const res of results) {
        const ruleId = res.ruleId || 'VULN';
        const message = res.message?.text || 'Vulnerability detected by Strix';
        const level = res.level === 'error' ? 'CRITICAL' : 'WARNING';

        let relativeFile = '';
        let line = 0;

        const loc = res.locations?.[0]?.physicalLocation;
        if (loc) {
          relativeFile = loc.artifactLocation?.uri || '';
          line = loc.region?.startLine ? loc.region.startLine - 1 : 0;
        }

        const absoluteFile = relativeFile
          ? path.isAbsolute(relativeFile)
            ? relativeFile
            : path.join(workspaceRoot, relativeFile)
          : workspaceRoot;

        threats.push({
          title: `[Strix Pentest] ${ruleId}`,
          desc: message,
          severity: level,
          file: absoluteFile,
          line,
        });
      }
    }
  } catch {
    // Return whatever was collected
  }

  return threats;
}

/**
 * Spawns Strix CLI in non-interactive mode against target directory.
 */
export function runStrixScan(
  targetDir: string,
  mode: 'quick' | 'standard' | 'deep' = 'quick',
  onLog?: (line: string) => void
): Promise<{ success: boolean; output: string; threats: ThreatItem[] }> {
  return new Promise((resolve) => {
    const status = getStrixStatus();
    if (!status.installed || !status.binaryPath) {
      resolve({
        success: false,
        output: 'Strix CLI is not installed at ~/.local/bin/strix',
        threats: [],
      });
      return;
    }

    const args = ['--target', targetDir, '-n', '-m', mode];
    const env = {
      ...process.env,
      PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
    };

    const proc = child_process.spawn(status.binaryPath, args, { env, cwd: targetDir });
    let stdoutData = '';
    let stderrData = '';

    proc.stdout.on('data', (d) => {
      const text = d.toString();
      stdoutData += text;
      if (onLog) onLog(text);
    });

    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderrData += text;
      if (onLog) onLog(text);
    });

    proc.on('close', (code) => {
      const combined = stdoutData + '\n' + stderrData;
      // Ingest any findings generated during this run
      const threats = loadExistingStrixFindings(targetDir);
      resolve({
        success: code === 0 || threats.length > 0,
        output: combined,
        threats,
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        output: `Failed to launch Strix: ${err.message}`,
        threats: [],
      });
    });
  });
}
