export type DiagnosticSeverityLevel = 'Error' | 'Warning';

export interface AddedDependency {
  name: string;
  version?: string;
  ecosystem: 'npm' | 'pypi';
  line: number;
  startCol: number;
  endCol: number;
  rawLine: string;
}

export interface CliCheckResult {
  decision: 'BLOCK' | 'ASK' | 'ALLOW';
  reason: string;
  signals: Array<{ name: string; score: number; weight: number; reason: string }>;
}

export interface MappedDiagnostic {
  severity: DiagnosticSeverityLevel;
  message: string;
  line: number;
  startCol: number;
  endCol: number;
  code: string;
  packageName: string;
  suggestedPin?: string;
}

export interface PythonThreat {
  line: number;
  startCol: number;
  endCol: number;
  message: string;
  severity: DiagnosticSeverityLevel;
  code: string;
  title: string;
}

/**
 * Scans python code for insecure deserialization vulnerabilities (e.g. torch.load without weights_only=True).
 */
export function extractPythonThreats(text: string): PythonThreat[] {
  const threats: PythonThreat[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/torch\.load\s*\(/.test(line) && !line.includes('weights_only=True')) {
      const matchIdx = line.indexOf('torch.load');
      threats.push({
        line: i,
        startCol: matchIdx !== -1 ? matchIdx : 0,
        endCol: line.length,
        message:
          "[ContextArmor SECURITY WARNING] Insecure model deserialization: 'torch.load' without weights_only=True allows arbitrary code execution via malicious pickle payloads.",
        severity: 'Warning',
        code: 'contextarmor-insecure-deserialization',
        title: 'torch.load (Insecure Pickle Deserialization)',
      });
    }
  }
  return threats;
}

/**
 * Extracts added or modified dependencies from package.json by comparing with headContent.
 */
export function extractAddedNpmDeps(currentText: string, headText?: string): AddedDependency[] {
  const added: AddedDependency[] = [];
  let currentJson: any;
  try {
    currentJson = JSON.parse(currentText);
  } catch {
    return [];
  }

  let headDeps: Record<string, string> = {};
  if (headText) {
    try {
      const headJson = JSON.parse(headText);
      headDeps = {
        ...(headJson.dependencies || {}),
        ...(headJson.devDependencies || {}),
        ...(headJson.peerDependencies || {}),
        ...(headJson.optionalDependencies || {}),
      };
    } catch {}
  }

  const currentDeps: Record<string, string> = {
    ...(currentJson.dependencies || {}),
    ...(currentJson.devDependencies || {}),
    ...(currentJson.peerDependencies || {}),
    ...(currentJson.optionalDependencies || {}),
  };

  const lines = currentText.split(/\r?\n/);
  for (const [name, ver] of Object.entries(currentDeps)) {
    const verStr = String(ver).trim();
    // Check if dep is new or changed vs HEAD
    if (!headText || !headDeps[name] || headDeps[name] !== verStr) {
      // Find line in file
      let targetLine = -1;
      let startCol = 0;
      let endCol = 0;
      for (let i = 0; i < lines.length; i++) {
        const lineStr = lines[i];
        const matchIdx = lineStr.indexOf(`"${name}"`);
        if (matchIdx !== -1) {
          targetLine = i;
          startCol = matchIdx;
          endCol = lineStr.length;
          break;
        }
      }
      if (targetLine !== -1) {
        // Strip leading ^ or ~ or >= from verStr if needed for target version
        added.push({
          name,
          version: verStr.replace(/^[\^~>=< ]+/, ''),
          ecosystem: 'npm',
          line: targetLine,
          startCol,
          endCol,
          rawLine: lines[targetLine],
        });
      }
    }
  }

  return added;
}

/**
 * Extracts added or modified dependencies from requirements.txt by comparing with headContent.
 */
export function extractAddedPypiDeps(currentText: string, headText?: string): AddedDependency[] {
  const added: AddedDependency[] = [];
  const headLinesSet = new Set(
    (headText || '')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
  );

  const lines = currentText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const cleaned = rawLine.trim();
    if (!cleaned || cleaned.startsWith('#') || cleaned.startsWith('-')) {
      continue;
    }

    if (!headText || !headLinesSet.has(cleaned)) {
      // Parse package name and version: e.g. requests==2.31.0, flask>=3.0
      const specMatch = cleaned.match(/^([a-zA-Z0-9_\-\.]+)(?:[=><~!]=*([a-zA-Z0-9_\-\.]+))?/);
      if (specMatch) {
        const name = specMatch[1];
        const version = specMatch[2];
        added.push({
          name,
          version,
          ecosystem: 'pypi',
          line: i,
          startCol: 0,
          endCol: rawLine.length,
          rawLine,
        });
      }
    }
  }

  return added;
}

/**
 * Parses the suggested pin version from ASK text.
 */
export function extractSuggestedPin(reason: string): string | undefined {
  const pinMatch = reason.match(/Suggested pin:\s*['"`](?:npm\s+i\s+[^@]+@|pip\s+install\s+[^=]+=+|uv\s+add\s+[^=]+=*)([^'"`\s]+)['"`]/i)
    || reason.match(/Newest version older than 72h:\s*['"`]([^'"`]+)['"`]/i);
  return pinMatch ? pinMatch[1] : undefined;
}

/**
 * Maps a single CLI check result to a diagnostic or null if ALLOW.
 */
export function mapCheckResultToDiagnostic(
  dep: AddedDependency,
  result: CliCheckResult
): MappedDiagnostic | null {
  if (result.decision === 'ALLOW') {
    return null;
  }

  const severity: DiagnosticSeverityLevel = result.decision === 'BLOCK' ? 'Error' : 'Warning';
  const suggestedPin = result.decision === 'ASK' ? extractSuggestedPin(result.reason) : undefined;

  return {
    severity,
    message: result.reason,
    line: dep.line,
    startCol: dep.startCol,
    endCol: dep.endCol,
    code: result.decision === 'BLOCK' ? 'contextarmor-block' : 'contextarmor-ask',
    packageName: dep.name,
    suggestedPin,
  };
}
