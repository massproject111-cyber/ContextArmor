import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import {
  extractAddedNpmDeps,
  extractAddedPypiDeps,
  extractPythonThreats,
  mapCheckResultToDiagnostic,
  CliCheckResult,
} from './ui/diagnosticMapper.js';
import { QuickFixProvider } from './ui/quickFixes.js';
import { ContextArmorTreeProvider, ThreatItem } from './ui/treeView.js';
import { SidebarWebviewProvider } from './ui/sidebarWebview.js';
import { DashboardPanel } from './ui/dashboard.js';

interface CacheEntry {
  result: CliCheckResult;
  timestamp: number;
}

const checkCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Ensures homebrew and local node paths are present in environment
 */
function getNodeCommand(): { nodePath: string; env: NodeJS.ProcessEnv } {
  const customEnv: NodeJS.ProcessEnv = { ...process.env };
  const standardPaths = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  if (customEnv.PATH) {
    if (!customEnv.PATH.includes('/opt/homebrew/bin')) {
      customEnv.PATH = `${standardPaths}:${customEnv.PATH}`;
    }
  } else {
    customEnv.PATH = standardPaths;
  }

  let nodePath = 'node';
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      nodePath = c;
      break;
    }
  }
  return { nodePath, env: customEnv };
}

/**
 * Spawns the standalone ContextArmor CLI check command with --json.
 * Does not import the engine directly.
 */
function spawnCliCheck(
  cliPath: string,
  targetSpec: string,
  ecosystem: 'npm' | 'pypi'
): Promise<CliCheckResult> {
  const cacheKey = `${ecosystem}:${targetSpec}`;
  const cached = checkCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return Promise.resolve(cached.result);
  }

  return new Promise((resolve) => {
    const { nodePath, env } = getNodeCommand();
    const args = [cliPath, 'check', targetSpec, '-e', ecosystem, '--json'];
    child_process.execFile(nodePath, args, { env, timeout: 15000 }, (_err, stdout, _stderr) => {
      try {
        const rawJson = (stdout || '').trim();
        const parsed: CliCheckResult = JSON.parse(rawJson);
        checkCache.set(cacheKey, { result: parsed, timestamp: Date.now() });
        resolve(parsed);
      } catch {
        // Fallback if execution or parse failed
        const fallback: CliCheckResult = {
          decision: 'ASK',
          reason: `[ContextArmor UNCHECKED] Failed to audit package '${targetSpec}' via CLI.`,
          signals: [],
        };
        resolve(fallback);
      }
    });
  });
}

/**
 * Retrieves the contents of the given file in git HEAD.
 */
function getGitHeadContent(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const dir = path.dirname(filePath);
    const filename = path.basename(filePath);
    const { env } = getNodeCommand();
    child_process.execFile(
      'git',
      ['show', `HEAD:./${filename}`],
      { cwd: dir, env, timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve('');
        } else {
          resolve(stdout || '');
        }
      }
    );
  });
}

export function activate(context: vscode.ExtensionContext) {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('contextarmor');
  context.subscriptions.push(diagnosticCollection);

  const sidebarProvider = new SidebarWebviewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarWebviewProvider.viewType,
      sidebarProvider
    )
  );

  let currentThreats: ThreatItem[] = [];

  // Register QuickFix Code Actions Provider
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [
        { language: 'json', pattern: '**/package.json' },
        { language: 'pip-requirements' },
        { language: 'plaintext', pattern: '**/requirements.txt' },
        { language: 'python' },
      ],
      new QuickFixProvider(),
      { providedCodeActionKinds: QuickFixProvider.providedCodeActionKinds }
    )
  );

  // Status Bar Item from contextarmor doctor
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'contextarmor.openDashboard';
  context.subscriptions.push(statusBar);

  const cliPath = path.join(context.extensionPath, 'dist', 'cli.js');

  function updateStatusBar() {
    const { nodePath, env } = getNodeCommand();
    child_process.execFile(nodePath, [cliPath, 'doctor'], { env, timeout: 8000 }, (err, stdout) => {
      if (err && !stdout) {
        statusBar.text = '$(shield-x) ContextArmor: Inactive';
        statusBar.tooltip = 'ContextArmor doctor probe failed';
        statusBar.show();
        return;
      }
      const output = stdout || '';
      const hasWarning = output.includes('[WARN]') || output.includes('[MISSING]');
      if (hasWarning) {
        statusBar.text = '$(warning) ContextArmor: Warning';
        statusBar.tooltip = output.trim();
      } else {
        statusBar.text = '$(shield) ContextArmor: Protected';
        statusBar.tooltip = 'ContextArmor Doctor: All hooks wired & protected';
      }
      statusBar.show();
    });
  }

  // Initial status bar check
  updateStatusBar();

  // Register dashboard command
  context.subscriptions.push(
    vscode.commands.registerCommand('contextarmor.openDashboard', () => {
      DashboardPanel.createOrShow(context.extensionUri, currentThreats);
    })
  );

  // Register doctor command
  context.subscriptions.push(
    vscode.commands.registerCommand('contextarmor.doctor', () => {
      const outputChannel = vscode.window.createOutputChannel('ContextArmor Doctor');
      outputChannel.show();
      outputChannel.appendLine('[Running ContextArmor Doctor...]');
      const { nodePath, env } = getNodeCommand();
      child_process.execFile(nodePath, [cliPath, 'doctor'], { env, timeout: 10000 }, (_err, stdout, stderr) => {
        if (stdout) outputChannel.append(stdout);
        if (stderr) outputChannel.append(stderr);
        updateStatusBar();
      });
    })
  );

  let debounceTimer: NodeJS.Timeout | undefined;

  async function auditDocument(document: vscode.TextDocument) {
    const fileName = document.fileName;
    const isNpm = fileName.endsWith('package.json');
    const isPypi = fileName.endsWith('requirements.txt');
    const isPython = fileName.endsWith('.py');

    if (!isNpm && !isPypi && !isPython) {
      return;
    }

    const currentText = document.getText();

    if (isPython) {
      const pyThreats = extractPythonThreats(currentText);
      const diagnostics: vscode.Diagnostic[] = [];
      const newDocThreats: ThreatItem[] = [];

      for (const t of pyThreats) {
        const line = document.lineAt(t.line);
        const range = new vscode.Range(t.line, t.startCol, t.line, t.endCol || line.text.length);
        const diag = new vscode.Diagnostic(range, t.message, vscode.DiagnosticSeverity.Warning);
        diag.source = 'ContextArmor';
        diag.code = t.code;
        diagnostics.push(diag);

        newDocThreats.push({
          title: t.title,
          desc: t.message,
          severity: 'WARNING',
          file: fileName,
          line: t.line,
        });
      }

      diagnosticCollection.set(document.uri, diagnostics);
      currentThreats = [
        ...currentThreats.filter((t) => t.file !== fileName),
        ...newDocThreats,
      ];
      sidebarProvider.update(currentThreats);
      if (DashboardPanel.currentPanel) {
        DashboardPanel.currentPanel.update(currentThreats);
      }
      return;
    }

    const headText = await getGitHeadContent(fileName);

    const addedDeps = isNpm
      ? extractAddedNpmDeps(currentText, headText)
      : extractAddedPypiDeps(currentText, headText);

    if (addedDeps.length === 0) {
      diagnosticCollection.set(document.uri, []);
      currentThreats = currentThreats.filter((t) => t.file !== fileName);
      sidebarProvider.update(currentThreats);
      if (DashboardPanel.currentPanel) {
        DashboardPanel.currentPanel.update(currentThreats);
      }
      return;
    }

    const diagnostics: vscode.Diagnostic[] = [];
    const newDocThreats: ThreatItem[] = [];

    for (const dep of addedDeps) {
      const spec = dep.version ? `${dep.name}@${dep.version}` : dep.name;
      const result = await spawnCliCheck(cliPath, spec, dep.ecosystem);
      const mapped = mapCheckResultToDiagnostic(dep, result);

      if (mapped) {
        const line = document.lineAt(mapped.line);
        const range = new vscode.Range(mapped.line, mapped.startCol, mapped.line, mapped.endCol || line.text.length);
        const severity =
          mapped.severity === 'Error'
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning;

        const diag = new vscode.Diagnostic(range, mapped.message, severity);
        diag.source = 'ContextArmor';
        diag.code = mapped.code;
        diagnostics.push(diag);

        newDocThreats.push({
          title: `${dep.name}@${dep.version || 'latest'} (${dep.ecosystem})`,
          desc: mapped.message,
          severity: mapped.severity === 'Error' ? 'CRITICAL' : 'WARNING',
          file: fileName,
          line: mapped.line,
        });
      }
    }

    diagnosticCollection.set(document.uri, diagnostics);

    // Update Threat Radar Sidebar & Dashboard
    currentThreats = [
      ...currentThreats.filter((t) => t.file !== fileName),
      ...newDocThreats,
    ];
    sidebarProvider.update(currentThreats);
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.update(currentThreats);
    }
  }

  // Audit on save with debouncing
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        auditDocument(document);
      }, 200);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        auditDocument(editor.document);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      auditDocument(document);
    })
  );

  // Initial audit of active editor
  if (vscode.window.activeTextEditor) {
    auditDocument(vscode.window.activeTextEditor.document);
  }

  // Initial audit of all workspace candidate files
  vscode.workspace.findFiles('{**/package.json,**/requirements.txt,**/*.py}', '**/node_modules/**').then((uris) => {
    for (const uri of uris) {
      vscode.workspace.openTextDocument(uri).then((doc) => {
        auditDocument(doc);
      });
    }
  });
}

export function deactivate() {
  checkCache.clear();
}
