import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import * as os from 'node:os';
import {
  extractAddedNpmDeps,
  extractAddedPypiDeps,
  extractAllNpmDeps,
  extractAllPypiDeps,
  extractPythonThreats,
  mapCheckResultToDiagnostic,
  CliCheckResult,
} from './ui/diagnosticMapper.js';
import { QuickFixProvider } from './ui/quickFixes.js';
import { ThreatItem } from './ui/treeView.js';
import { SidebarWebviewProvider } from './ui/sidebarWebview.js';
import { DashboardPanel } from './ui/dashboard.js';
import { auditWorkspace } from './core/projectAuditor.js';
import { runStrixScan, getStrixStatus, promptLlmSetup, getLlmConfig } from './integrations/strix.js';
import { PackageRiskEngine, classifyDecision } from './detectors/packageRisk/index.js';

interface CacheEntry {
  result: CliCheckResult;
  timestamp: number;
}

const checkCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// In-process risk engine instance for 100% zero-dependency execution
const inProcessEngine = new PackageRiskEngine();

/**
 * Ensures homebrew and local node paths are present in environment
 */
function getNodeCommand(): { nodePath: string; env: NodeJS.ProcessEnv } {
  const customEnv: NodeJS.ProcessEnv = { ...process.env };
  const standardPaths = `${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
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
 * Evaluates package risk 100% in-process without requiring external node binary.
 * Falls back to CLI subprocess only if in-process evaluation fails.
 */
async function evaluatePackageSafe(
  cliPath: string,
  targetSpec: string,
  ecosystem: 'npm' | 'pypi'
): Promise<CliCheckResult> {
  const cacheKey = `${ecosystem}:${targetSpec}`;
  const cached = checkCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  // Parse name@ver or @scope/name@ver
  let packageName = targetSpec;
  let version: string | undefined;
  const lastAt = targetSpec.lastIndexOf('@');
  if (lastAt > 0) {
    packageName = targetSpec.slice(0, lastAt);
    version = targetSpec.slice(lastAt + 1);
  }

  try {
    const result = await inProcessEngine.evaluate({
      name: packageName,
      version,
      ecosystem,
      isDirect: true,
    });
    const decision = classifyDecision(result);

    let reason = 'Package passed clean';
    if (decision === 'BLOCK') {
      const topReason =
        result.signals[0]?.reason ||
        'High risk AI hallucination or malicious package detected';
      reason = `[ContextArmor CIRCUIT BREAKER] Blocked installation of '${packageName}' (${ecosystem}): ${topReason}`;
    } else if (decision === 'ASK') {
      const prioritizedSignal =
        result.signals.find((s) => s.name === 'version_cooldown_72h') ||
        [...result.signals].sort((a, b) => b.score * b.weight - a.score * a.weight)[0];
      const topReason = result.uncheckedReason
        ? `[UNCHECKED] ${result.uncheckedReason}`
        : prioritizedSignal?.reason || 'Package flagged in warning tier';
      reason = `[ContextArmor WARNING] Flagged package: '${packageName}': ${topReason}`;
    }

    const checkResult: CliCheckResult = {
      decision,
      reason,
      signals: result.signals,
    };
    checkCache.set(cacheKey, { result: checkResult, timestamp: Date.now() });
    return checkResult;
  } catch {
    // If in-process encounters an issue, fallback to CLI if node is present
    return spawnCliCheck(cliPath, targetSpec, ecosystem);
  }
}

/**
 * Spawns the standalone ContextArmor CLI check command with --json.
 */
function spawnCliCheck(
  cliPath: string,
  targetSpec: string,
  ecosystem: 'npm' | 'pypi'
): Promise<CliCheckResult> {
  return new Promise((resolve) => {
    const { nodePath, env } = getNodeCommand();
    const args = [cliPath, 'check', targetSpec, '-e', ecosystem, '--json'];
    child_process.execFile(nodePath, args, { env, timeout: 15000 }, (_err, stdout, _stderr) => {
      try {
        const rawJson = (stdout || '').trim();
        const parsed: CliCheckResult = JSON.parse(rawJson);
        resolve(parsed);
      } catch {
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

  // Status Bar Item
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'contextarmor.openDashboard';
  context.subscriptions.push(statusBar);

  const cliPath = path.join(context.extensionPath, 'dist', 'cli.js');

  function updateStatusBar() {
    let hooksWired = false;
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const cwd = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : process.cwd();
      const claudeSettings = path.join(cwd, '.claude', 'settings.json');
      if (fs.existsSync(claudeSettings)) {
        const raw = fs.readFileSync(claudeSettings, 'utf8');
        if (raw.includes('contextarmor')) hooksWired = true;
      }
      const agHooks = path.join(cwd, '.agents', 'hooks.json');
      if (fs.existsSync(agHooks)) {
        const raw = fs.readFileSync(agHooks, 'utf8');
        if (raw.includes('contextarmor')) hooksWired = true;
      }
    } catch {}

    if (hooksWired) {
      statusBar.text = '$(shield) ContextArmor: Protected';
      statusBar.tooltip = 'ContextArmor: PreToolUse circuit breaker hooks active & protected';
    } else {
      statusBar.text = '$(shield) ContextArmor: Active';
      statusBar.tooltip = 'ContextArmor: AI Supply Chain & Deserialization Defense Active';
    }
    statusBar.show();
  }

  // Initial status bar check
  updateStatusBar();

  // Full Project Audit Command
  async function runFullWorkspaceAudit() {
    sidebarProvider.setScanning(true, 'Auditing workspace dependencies & code...');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const rootPath =
      workspaceFolders && workspaceFolders.length > 0
        ? workspaceFolders[0].uri.fsPath
        : process.cwd();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'ContextArmor: Project Audit',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Scanning project manifests and code...' });
        const result = await auditWorkspace(
          rootPath,
          (spec, eco) => evaluatePackageSafe(cliPath, spec, eco),
          (msg, inc) => progress.report({ message: msg, increment: inc })
        );

        // Clear and set diagnostics across all audited files
        diagnosticCollection.clear();
        for (const [filePath, diags] of result.fileDiagnostics.entries()) {
          diagnosticCollection.set(vscode.Uri.file(filePath), diags);
        }

        currentThreats = result.threats;
        sidebarProvider.update(currentThreats);
        if (DashboardPanel.currentPanel) {
          DashboardPanel.currentPanel.update(currentThreats);
        }

        const critCount = result.threats.filter((t) => t.severity === 'CRITICAL').length;
        const warnCount = result.threats.filter((t) => t.severity === 'WARNING').length;

        if (critCount > 0) {
          vscode.window
            .showErrorMessage(
              `ContextArmor Audit: Found ${critCount} critical threats and ${warnCount} warnings across ${result.stats.auditedFiles} files!`,
              'Open Dashboard'
            )
            .then((choice) => {
              if (choice === 'Open Dashboard') {
                vscode.commands.executeCommand('contextarmor.openDashboard');
              }
            });
        } else if (warnCount > 0) {
          vscode.window
            .showWarningMessage(
              `ContextArmor Audit: Found ${warnCount} warnings across ${result.stats.auditedFiles} files.`,
              'Open Dashboard'
            )
            .then((choice) => {
              if (choice === 'Open Dashboard') {
                vscode.commands.executeCommand('contextarmor.openDashboard');
              }
            });
        } else {
          vscode.window.showInformationMessage(
            `ContextArmor Audit: All ${result.stats.totalDeps} dependencies & code files verified clean! (Score: 100/100)`
          );
        }
      }
    );
  }

  // Register audit command
  context.subscriptions.push(
    vscode.commands.registerCommand('contextarmor.auditWorkspace', runFullWorkspaceAudit)
  );

  // Strix / Deep Pentest Command
  async function runStrixPentest() {
    const llm = getLlmConfig();
    if (!llm.isConfigured) {
      const choice = await vscode.window.showInformationMessage(
        'ContextArmor Deep Pentest: AI LLM Brain is not configured yet. Would you like to connect an AI key (Gemini, Claude, OpenAI, OpenRouter, or local Ollama)?',
        'Connect AI Key',
        'Run Built-in Sandbox'
      );
      if (choice === 'Connect AI Key') {
        const configured = await promptLlmSetup();
        sidebarProvider.update(currentThreats);
        if (DashboardPanel.currentPanel) {
          DashboardPanel.currentPanel.update(currentThreats);
        }
      }
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const rootPath =
      workspaceFolders && workspaceFolders.length > 0
        ? workspaceFolders[0].uri.fsPath
        : process.cwd();

    const outputChannel = vscode.window.createOutputChannel('ContextArmor: Deep Pentest');
    outputChannel.show();
    outputChannel.appendLine(`[ContextArmor Pentest] Launching autonomous security scan against: ${rootPath}`);

    const updateProgress = (pct: number, stage: string, log?: string) => {
      sidebarProvider.updateProgress(pct, stage);
      if (DashboardPanel.currentPanel) {
        DashboardPanel.currentPanel.updateProgress(pct, stage, log);
      }
    };

    updateProgress(10, 'Initializing pentest sandbox environment...', '[ContextArmor Sandbox] Starting environment...');

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'ContextArmor: Running Deep Pentest',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Executing security tests...' });
        let currentPct = 15;
        const res = await runStrixScan(rootPath, 'quick', (chunk) => {
          outputChannel.append(chunk);

          if (chunk.includes('Docker daemon active') || chunk.includes('Penetration test initiated')) {
            currentPct = 35;
            updateProgress(currentPct, 'Sandbox ready · Dispatching attack agents...', chunk);
          } else if (chunk.includes('Waiting for the first model response') || chunk.includes('gpt-5.6-luna')) {
            currentPct = 55;
            updateProgress(currentPct, 'Simulating exploits with Luna 6...', chunk);
          } else if (chunk.includes('ast') || chunk.includes('Analyzing') || chunk.includes('Scanning')) {
            currentPct = 75;
            updateProgress(currentPct, 'Analyzing code taint & vulnerabilities...', chunk);
          } else if (chunk.includes('findings.sarif') || chunk.includes('complete')) {
            currentPct = 90;
            updateProgress(currentPct, 'Synthesizing OASIS SARIF report...', chunk);
          } else {
            updateProgress(Math.min(85, currentPct + 1), 'Executing exploit tests...', chunk);
          }
        });

        if (res.hasLlmError) {
          vscode.window
            .showWarningMessage(
              'Strix LLM connection issue detected. ContextArmor completed the scan using the built-in Sandbox engine. Would you like to log in to your AI provider?',
              'Log In / Connect AI Brain',
              'Dismiss'
            )
            .then((choice) => {
              if (choice === 'Log In / Connect AI Brain') {
                vscode.commands.executeCommand('contextarmor.configureLlm');
              }
            });
        }

        if (res.threats.length > 0) {
          currentThreats = [
            ...currentThreats.filter((t) => !t.title.includes('Pentest')),
            ...res.threats,
          ];
          sidebarProvider.update(currentThreats);
          if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel.finishProgress(currentThreats);
          }
          vscode.window
            .showErrorMessage(
              `ContextArmor Deep Pentest completed: ${res.threats.length} vulnerabilities detected!`,
              'View Dashboard'
            )
            .then((choice) => {
              if (choice === 'View Dashboard') {
                vscode.commands.executeCommand('contextarmor.openDashboard');
              }
            });
        } else {
          sidebarProvider.update(currentThreats);
          if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel.finishProgress(currentThreats);
          }
          vscode.window.showInformationMessage(
            'ContextArmor Deep Pentest completed. No exploitable vulnerabilities detected.'
          );
        }
      }
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('contextarmor.runStrix', runStrixPentest)
  );

  // Register AI Brain configuration command
  context.subscriptions.push(
    vscode.commands.registerCommand('contextarmor.configureLlm', async () => {
      const configured = await promptLlmSetup();
      if (configured) {
        sidebarProvider.update(currentThreats);
        if (DashboardPanel.currentPanel) {
          DashboardPanel.currentPanel.update(currentThreats);
        }
      }
    })
  );

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
      outputChannel.appendLine('[Running ContextArmor Diagnostics...]');
      const { nodePath, env } = getNodeCommand();
      child_process.execFile(nodePath, [cliPath, 'doctor'], { env, timeout: 10000 }, (err, stdout, stderr) => {
        if (stdout) outputChannel.append(stdout);
        if (stderr) outputChannel.append(stderr);
        if (err && !stdout) {
          outputChannel.appendLine('[ContextArmor] Extension running in self-contained in-process mode.');
        }
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

    // If file has git diff, check added deps. If clean/untracked, check all deps.
    let depsToCheck = isNpm
      ? extractAddedNpmDeps(currentText, headText)
      : extractAddedPypiDeps(currentText, headText);

    if (depsToCheck.length === 0 && !headText) {
      depsToCheck = isNpm ? extractAllNpmDeps(currentText) : extractAllPypiDeps(currentText);
    }

    if (depsToCheck.length === 0) {
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

    for (const dep of depsToCheck) {
      const spec = dep.version ? `${dep.name}@${dep.version}` : dep.name;
      const result = await evaluatePackageSafe(cliPath, spec, dep.ecosystem);
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

  // Perform initial project audit in background on workspace open
  runFullWorkspaceAudit().catch(() => {});
}

export function deactivate() {
  checkCache.clear();
}
