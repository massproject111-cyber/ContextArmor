import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  extractAllNpmDeps,
  extractAllPypiDeps,
  extractPythonThreats,
  mapCheckResultToDiagnostic,
  type CliCheckResult,
} from '../ui/diagnosticMapper.js';
import type { ThreatItem } from '../ui/treeView.js';
import { McpLinter } from '../mcp/linter.js';
import { loadExistingStrixFindings } from '../integrations/strix.js';

export interface AuditStats {
  auditedFiles: number;
  totalDeps: number;
  cleanDeps: number;
  warningDeps: number;
  blockedDeps: number;
  pythonThreats: number;
  mcpThreats: number;
  strixThreats: number;
}

export interface WorkspaceAuditResult {
  threats: ThreatItem[];
  fileDiagnostics: Map<string, vscode.Diagnostic[]>;
  stats: AuditStats;
  score: number;
}

export type CheckFn = (spec: string, ecosystem: 'npm' | 'pypi') => Promise<CliCheckResult>;

/**
 * Audits the entire workspace or given directory across:
 * 1. Package manifests (package.json, requirements.txt)
 * 2. Python deserialization & pickle risks (*.py)
 * 3. MCP configuration security
 * 4. Strix pentest findings
 */
export async function auditWorkspace(
  workspaceRoot: string,
  checkDep: CheckFn,
  progressCallback?: (message: string, increment?: number) => void
): Promise<WorkspaceAuditResult> {
  const threats: ThreatItem[] = [];
  const fileDiagnostics = new Map<string, vscode.Diagnostic[]>();

  const stats: AuditStats = {
    auditedFiles: 0,
    totalDeps: 0,
    cleanDeps: 0,
    warningDeps: 0,
    blockedDeps: 0,
    pythonThreats: 0,
    mcpThreats: 0,
    strixThreats: 0,
  };

  // 1. Discover relevant files in workspace
  const candidateUris = await vscode.workspace.findFiles(
    '{**/package.json,**/requirements.txt,**/*.py}',
    '{**/node_modules/**,**/.git/**,**/dist/**,**/venv/**,**/.venv/**,**/__pycache__/**,**/site-packages/**}'
  );

  const totalFiles = candidateUris.length;
  let fileIndex = 0;

  for (const uri of candidateUris) {
    fileIndex++;
    const filePath = uri.fsPath;
    const fileName = path.basename(filePath);
    stats.auditedFiles++;

    if (progressCallback) {
      progressCallback(`Auditing [${fileIndex}/${totalFiles}]: ${fileName}`, Math.floor(100 / (totalFiles || 1)));
    }

    let fileContent = '';
    try {
      fileContent = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const currentFileDiags: vscode.Diagnostic[] = [];

    // A. Package.json Audit
    if (fileName === 'package.json') {
      const deps = extractAllNpmDeps(fileContent);
      for (const dep of deps) {
        stats.totalDeps++;
        const spec = dep.version ? `${dep.name}@${dep.version}` : dep.name;
        const result = await checkDep(spec, 'npm');
        const diag = mapCheckResultToDiagnostic(dep, result);

        if (diag) {
          if (diag.severity === 'Error') stats.blockedDeps++;
          else stats.warningDeps++;

          const range = new vscode.Range(
            diag.line,
            diag.startCol,
            diag.line,
            diag.endCol || dep.rawLine.length
          );
          const vDiag = new vscode.Diagnostic(
            range,
            diag.message,
            diag.severity === 'Error'
              ? vscode.DiagnosticSeverity.Error
              : vscode.DiagnosticSeverity.Warning
          );
          vDiag.source = 'ContextArmor';
          vDiag.code = diag.code;
          currentFileDiags.push(vDiag);

          threats.push({
            title: `${dep.name}@${dep.version || 'latest'} (npm)`,
            desc: diag.message,
            severity: diag.severity === 'Error' ? 'CRITICAL' : 'WARNING',
            file: filePath,
            line: diag.line,
          });
        } else {
          stats.cleanDeps++;
        }
      }
    }

    // B. Requirements.txt Audit
    else if (fileName === 'requirements.txt') {
      const deps = extractAllPypiDeps(fileContent);
      for (const dep of deps) {
        stats.totalDeps++;
        const spec = dep.version ? `${dep.name}==${dep.version}` : dep.name;
        const result = await checkDep(spec, 'pypi');
        const diag = mapCheckResultToDiagnostic(dep, result);

        if (diag) {
          if (diag.severity === 'Error') stats.blockedDeps++;
          else stats.warningDeps++;

          const range = new vscode.Range(
            diag.line,
            diag.startCol,
            diag.line,
            diag.endCol || dep.rawLine.length
          );
          const vDiag = new vscode.Diagnostic(
            range,
            diag.message,
            diag.severity === 'Error'
              ? vscode.DiagnosticSeverity.Error
              : vscode.DiagnosticSeverity.Warning
          );
          vDiag.source = 'ContextArmor';
          vDiag.code = diag.code;
          currentFileDiags.push(vDiag);

          threats.push({
            title: `${dep.name}${dep.version ? `==${dep.version}` : ''} (pypi)`,
            desc: diag.message,
            severity: diag.severity === 'Error' ? 'CRITICAL' : 'WARNING',
            file: filePath,
            line: diag.line,
          });
        } else {
          stats.cleanDeps++;
        }
      }
    }

    // C. Python Code Audit (torch.load / pickle)
    else if (fileName.endsWith('.py')) {
      const pyThreats = extractPythonThreats(fileContent);
      for (const py of pyThreats) {
        stats.pythonThreats++;
        const range = new vscode.Range(
          py.line,
          py.startCol,
          py.line,
          py.endCol
        );
        const vDiag = new vscode.Diagnostic(
          range,
          py.message,
          vscode.DiagnosticSeverity.Warning
        );
        vDiag.source = 'ContextArmor';
        vDiag.code = py.code;
        currentFileDiags.push(vDiag);

        threats.push({
          title: py.title,
          desc: py.message,
          severity: 'WARNING',
          file: filePath,
          line: py.line,
        });
      }
    }

    fileDiagnostics.set(filePath, currentFileDiags);
  }

  // 2. Audit MCP Configurations
  if (progressCallback) progressCallback('Auditing MCP configurations and server manifests...');
  const mcpLinter = new McpLinter();
  const mcpConfigs = mcpLinter.discoverConfigFiles(workspaceRoot);
  for (const configPath of mcpConfigs) {
    const findings = mcpLinter.lintConfigFile(configPath);
    for (const f of findings) {
      stats.mcpThreats++;
      threats.push({
        title: `[MCP Security] ${f.serverName} (${f.ruleId})`,
        desc: `${f.message} ${f.remediation}`,
        severity: f.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
        file: configPath,
        line: 0,
      });
    }
  }

  // 3. Strix Pentest Findings
  if (progressCallback) progressCallback('Checking Strix Pentest results and SARIF reports...');
  const strixThreats = loadExistingStrixFindings(workspaceRoot);
  for (const st of strixThreats) {
    stats.strixThreats++;
    threats.push(st);
  }

  // Calculate overall security posture score
  const criticalCount = threats.filter((t) => t.severity === 'CRITICAL').length;
  const warningCount = threats.filter((t) => t.severity === 'WARNING').length;

  let score = 100;
  if (criticalCount > 0) {
    score = Math.max(35, 65 - (criticalCount - 1) * 5);
  } else if (warningCount > 0) {
    score = Math.max(70, 85 - (warningCount - 1) * 3);
  }

  return {
    threats,
    fileDiagnostics,
    stats,
    score,
  };
}
