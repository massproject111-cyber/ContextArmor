import * as vscode from 'vscode';
import type { ThreatItem } from './treeView.js';
import { getLlmConfig, setProviderKey } from '../integrations/strix.js';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _threats: ThreatItem[] = [];
  private _isScanning: boolean = false;
  private _scanPercent: number = 0;
  private _scanStage: string = '';
  private _scanLogs: string[] = [];

  public static createOrShow(extensionUri: vscode.Uri, threats: ThreatItem[]) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(column);
      DashboardPanel.currentPanel.update(threats);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'contextarmorDashboard',
      'ContextArmor: Security Dashboard',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri, threats);
  }

  private constructor(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri, threats: ThreatItem[]) {
    this._panel = panel;
    this._threats = threats;

    this.update(threats);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'auditWorkspace':
            vscode.commands.executeCommand('contextarmor.auditWorkspace');
            return;
          case 'runStrix':
            vscode.commands.executeCommand('contextarmor.runStrix');
            return;
          case 'configureLlm':
            vscode.commands.executeCommand('contextarmor.configureLlm');
            return;
          case 'startOauthLogin': {
            const term = vscode.window.createTerminal('Strix ChatGPT OAuth Login');
            term.show();
            term.sendText('strix auth login chatgpt');
            setProviderKey('chatgpt-oauth');
            vscode.window.showInformationMessage(
              'Opened terminal for ChatGPT OAuth Login. Please follow the browser prompt to complete sign-in!'
            );
            this.update(this._threats);
            return;
          }
          case 'saveApiKey': {
            setProviderKey(message.provider, message.key);
            vscode.window.showInformationMessage('ContextArmor AI Brain updated successfully!');
            this.update(this._threats);
            return;
          }
          case 'openUrl': {
            if (message.url) {
              vscode.env.openExternal(vscode.Uri.parse(message.url));
            }
            return;
          }
          case 'runDoctor':
            vscode.commands.executeCommand('contextarmor.doctor');
            return;
          case 'removeDep': {
            if (message.file && message.line !== undefined) {
              const uri = vscode.Uri.file(message.file);
              const doc = await vscode.workspace.openTextDocument(uri);
              const edit = new vscode.WorkspaceEdit();
              const lineRange = doc.lineAt(message.line).rangeIncludingLineBreak;
              edit.delete(uri, lineRange);
              await vscode.workspace.applyEdit(edit);
              await doc.save();
              vscode.commands.executeCommand('contextarmor.auditWorkspace');
            }
            return;
          }
          case 'pinDep': {
            if (message.file && message.line !== undefined && message.pin) {
              const uri = vscode.Uri.file(message.file);
              const doc = await vscode.workspace.openTextDocument(uri);
              const edit = new vscode.WorkspaceEdit();
              const line = doc.lineAt(message.line);
              let updated = line.text;
              if (message.file.endsWith('package.json')) {
                updated = line.text.replace(/:\s*["'][^"']+["']/, `: "${message.pin}"`);
              } else if (message.file.endsWith('requirements.txt')) {
                updated = line.text.replace(/([a-zA-Z0-9_\-\.]+)(?:[=><~!]=*[^#\s]+)?/, `$1==${message.pin}`);
              }
              edit.replace(uri, line.range, updated);
              await vscode.workspace.applyEdit(edit);
              await doc.save();
              vscode.commands.executeCommand('contextarmor.auditWorkspace');
            }
            return;
          }
          case 'fixTorch': {
            if (message.file && message.line !== undefined) {
              const uri = vscode.Uri.file(message.file);
              const doc = await vscode.workspace.openTextDocument(uri);
              const edit = new vscode.WorkspaceEdit();
              const line = doc.lineAt(message.line);
              const updated = line.text.replace(/torch\.load\(([^)]+)\)/, 'torch.load($1, weights_only=True)');
              edit.replace(uri, line.range, updated);
              await vscode.workspace.applyEdit(edit);
              await doc.save();
              vscode.commands.executeCommand('contextarmor.auditWorkspace');
            }
            return;
          }
        }
      },
      null,
      this._disposables
    );
  }

  public update(threats: ThreatItem[]) {
    this._threats = threats;
    this._panel.webview.html = this._getHtmlForWebview();
  }

  public updateProgress(percent: number, stage: string, logLine?: string) {
    this._isScanning = true;
    this._scanPercent = percent;
    this._scanStage = stage;
    if (logLine) {
      this._scanLogs.push(logLine);
      if (this._scanLogs.length > 80) this._scanLogs.shift();
    }
    this._panel.webview.html = this._getHtmlForWebview();
  }

  public finishProgress(threats: ThreatItem[]) {
    this._isScanning = false;
    this._scanPercent = 100;
    this._threats = threats;
    this._panel.webview.html = this._getHtmlForWebview();
  }

  public dispose() {
    DashboardPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview(): string {
    const llm = getLlmConfig();
    const criticalCount = this._threats.filter((t) => t.severity === 'CRITICAL').length;
    const warningCount = this._threats.filter((t) => t.severity === 'WARNING').length;
    const score = criticalCount > 0 ? Math.max(35, 65 - (criticalCount - 1) * 5) : warningCount > 0 ? Math.max(70, 85 - (warningCount - 1) * 3) : 100;
    const scoreColor = score === 100 ? '#4caf50' : score >= 80 ? '#ff9800' : '#f44336';
    const statusText =
      criticalCount > 0
        ? 'Dangerous issues detected — Review below'
        : warningCount > 0
        ? 'Unverified packages detected — Review recommendations'
        : 'All packages & code verified clean';

    const threatsHtml =
      this._threats.length === 0
        ? `<tr><td colspan="5" style="text-align: center; color: var(--vscode-descriptionForeground); padding: 32px; font-size: 13px;">All dependencies and code files are verified safe. No vulnerabilities or hallucinations found.</td></tr>`
        : this._threats
            .map((t) => {
              const isCrit = t.severity === 'CRITICAL';
              const pinMatch =
                t.desc.match(/Suggested pin:\s*['"`](?:npm\s+i\s+[^@]+@|pip\s+install\s+[^=]+=+|uv\s+add\s+[^=]+=*)([^'"`\s]+)['"`]/i) ||
                t.desc.match(/Newest version older than 72h:\s*['"`]([^'"`]+)['"`]/i);
              const pin = pinMatch ? pinMatch[1] : undefined;

              const isManifest = !!(t.file?.endsWith('package.json') || t.file?.endsWith('requirements.txt'));
              const isMaliciousPackage = isManifest && (t.severity === 'CRITICAL' || t.desc.toLowerCase().includes('hallucinat') || t.desc.toLowerCase().includes('not found on npm') || t.desc.toLowerCase().includes('not found on pypi'));
              const showRemove = isMaliciousPackage && t.file && t.line !== undefined;
              const isTorchFix = !!(t.file?.endsWith('.py') && (t.title.includes('torch.load') || t.desc.includes('weights_only')));

              return `
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 12px; font-weight: 600; font-family: var(--font-mono); font-size: 12px; word-break: break-all;">${t.title}</td>
            <td style="padding: 12px;">
              <span style="background: ${isCrit ? 'var(--crit-bg)' : 'var(--warn-bg)'}; color: ${isCrit ? 'var(--crit-text)' : 'var(--warn-text)'}; border: 1px solid ${isCrit ? 'var(--crit-border)' : 'var(--warn-border)'}; padding: 2px 7px; border-radius: 4px; font-weight: 700; font-size: 10px; font-family: var(--font-header); text-transform: uppercase; letter-spacing: 0.06em;">
                ${isCrit ? 'CRITICAL RISK' : 'WARNING'}
              </span>
            </td>
            <td style="padding: 12px; color: var(--text); font-size: 12px; line-height: 1.4;">${t.desc}</td>
            <td style="padding: 12px; color: var(--muted); font-size: 11px; font-family: var(--font-mono);">
              ${t.file ? t.file.split('/').slice(-2).join('/') : 'Workspace'}${t.line !== undefined ? `:${t.line + 1}` : ''}
            </td>
            <td style="padding: 12px; text-align: right; white-space: nowrap;">
              ${
                pin
                  ? `<button class="btn-sm btn-fix" onclick="pinDep('${t.file}', ${t.line}, '${pin}')">Auto-Fix to ${pin}</button>`
                  : ''
              }
              ${
                isTorchFix && t.file && t.line !== undefined
                  ? `<button class="btn-sm btn-fix" onclick="fixTorch('${t.file}', ${t.line})">Add weights_only=True</button>`
                  : ''
              }
              ${
                showRemove
                  ? `<button class="btn-sm btn-del" onclick="removeDep('${t.file}', ${t.line})">Remove Package</button>`
                  : ''
              }
            </td>
          </tr>`;
            })
            .join('');

    const activeProviderName = llm.isConfigured ? llm.provider : 'Not Configured';
    const activeModelName = llm.model || 'No model chosen';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ContextArmor Security Dashboard</title>
  <style>
    :root {
      --font-header: "Geist", "Geist Sans", "Space Grotesk", -apple-system, BlinkMacSystemFont, sans-serif;
      --font-ui: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      --font-mono: var(--vscode-editor-font-family, "JetBrains Mono", "SF Mono", Monaco, Menlo, Consolas, monospace);
      
      /* Bespoke Obsidian Palette */
      --bg: #090a0c;
      --card-bg: #111315;
      --border: #22252b;
      --text: #f4f4f5;
      --muted: #8b949e;
      --accent: #f4f4f5;

      /* Refined Severity Palette */
      --crit-bg: rgba(244, 63, 94, 0.12);
      --crit-text: #fb7185;
      --crit-border: rgba(244, 63, 94, 0.28);
      --warn-bg: rgba(245, 158, 11, 0.12);
      --warn-text: #fbbf24;
      --warn-border: rgba(245, 158, 11, 0.28);
      --safe-bg: rgba(16, 185, 129, 0.12);
      --safe-text: #34d399;
      --safe-border: rgba(16, 185, 129, 0.28);
    }
    body {
      font-family: var(--font-ui);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      font-feature-settings: "cv02", "cv03", "cv04", "cv11", "tnum";
      font-variant-numeric: tabular-nums;
      padding: 24px 32px;
      color: var(--text);
      background-color: var(--bg);
      margin: 0;
      box-sizing: border-box;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header-title {
      font-family: var(--font-header);
      font-size: 16px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text);
    }
    .header-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
    }
    .header-actions {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .card-title {
      font-family: var(--font-header);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      font-weight: 700;
      margin-bottom: 6px;
    }
    .card-value {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 26px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .card-desc {
      font-size: 11px;
      color: var(--muted);
      line-height: 1.3;
    }
    .section-title {
      font-family: var(--font-header);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-top: 28px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--text);
    }
    .table-container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 28px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th {
      background: #0d0e11;
      padding: 10px 14px;
      font-family: var(--font-header);
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
    }
    .btn {
      background: #f4f4f5;
      color: #090a0c;
      border: 1px solid #ffffff;
      padding: 8px 16px;
      border-radius: 5px;
      cursor: pointer;
      font-weight: 700;
      font-size: 11.5px;
      font-family: var(--font-header);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .btn:hover {
      background: #ffffff;
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(255, 255, 255, 0.15);
    }
    .btn-secondary {
      background: #16181c;
      color: #e4e4e7;
      border: 1px solid var(--border);
      padding: 7px 14px;
      border-radius: 5px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .btn-secondary:hover {
      background: #1e2127;
      border-color: #383d47;
    }
    .btn-sm {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      font-weight: 600;
      border: none;
      margin-left: 4px;
    }
    .btn-fix {
      background: rgba(59, 130, 246, 0.12);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.28);
      transition: all 0.15s ease;
    }
    .btn-fix:hover {
      background: rgba(59, 130, 246, 0.22);
      border-color: rgba(59, 130, 246, 0.45);
    }
    .btn-del {
      background: rgba(244, 63, 94, 0.12);
      color: #fb7185;
      border: 1px solid rgba(244, 63, 94, 0.28);
      transition: all 0.15s ease;
    }
    .btn-del:hover {
      background: rgba(244, 63, 94, 0.22);
      border-color: rgba(244, 63, 94, 0.45);
    }

    /* =========================================================
       SECURITY AUDIT MODULE
       ========================================================= */
    .strix-station {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px 24px;
      margin-top: 32px;
      position: relative;
    }
    .strix-station-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 18px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .strix-badge {
      background: #1c1e24;
      color: #a1a1aa;
      border: 1px solid #2b2f38;
      font-family: var(--font-header);
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 2px 7px;
      border-radius: 3px;
      display: inline-block;
      margin-bottom: 6px;
    }
    .strix-title {
      font-family: var(--font-header);
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text);
    }
    .strix-desc {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
      max-width: 600px;
      line-height: 1.4;
    }
    .strix-ctrls {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .btn-strix-run {
      background: #f4f4f5;
      color: #090a0c;
      border: 1px solid #ffffff;
      padding: 8px 18px;
      border-radius: 5px;
      font-size: 11.5px;
      font-weight: 700;
      font-family: var(--font-header);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.15s ease;
    }
    .btn-strix-run:hover {
      background: #ffffff;
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(255, 255, 255, 0.15);
    }
    .btn-strix-run:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .brain-pill {
      background: #14161a;
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 6px 12px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .brain-pill:hover {
      border-color: #383d47;
    }

    /* Progress Bar */
    .progress-box {
      background: #0d0e11;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      margin-top: 16px;
    }
    .progress-header {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .progress-track {
      background: #1a1c22;
      border-radius: 4px;
      height: 6px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      background: #f4f4f5;
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }
    .telemetry-console {
      background: #090a0c;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px 12px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      height: 130px;
      overflow-y: auto;
      margin-top: 12px;
      white-space: pre-wrap;
      line-height: 1.45;
    }

    /* =========================================================
       IN-WEBVIEW MODAL DIALOG
       ========================================================= */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 9999;
    }
    .modal-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      width: 580px;
      max-width: 90%;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
      padding: 24px;
      box-sizing: border-box;
      max-height: 85vh;
      overflow-y: auto;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .modal-title {
      font-family: var(--font-header);
      font-size: 14px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .modal-close {
      background: transparent;
      border: none;
      color: var(--muted);
      font-size: 18px;
      cursor: pointer;
    }
    .modal-close:hover {
      color: #fff;
    }
    .provider-option {
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.03);
      border-radius: 8px;
      padding: 14px;
      margin-top: 12px;
      transition: border-color 0.15s;
    }
    .provider-option:hover {
      border-color: var(--accent);
    }
    .provider-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .provider-name {
      font-family: var(--font-header);
      font-weight: 700;
      font-size: 13px;
      letter-spacing: -0.015em;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .provider-tag {
      font-size: 9px;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.1);
      color: var(--muted);
    }
    .provider-desc {
      font-size: 11px;
      color: var(--muted);
      line-height: 1.3;
      margin-bottom: 10px;
    }
    .input-row {
      display: flex;
      gap: 8px;
    }
    .input-field {
      flex: 1;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 10px;
      color: var(--text);
      font-size: 12px;
      outline: none;
    }
    .input-field:focus {
      border-color: var(--accent);
    }
  </style>
</head>
<body>

  <!-- HEADER -->
  <div class="header">
    <div class="header-left">
      <div>
        <div class="header-title">ContextArmor Security Operations</div>
        <div class="header-sub">Pre-Execution AI Supply Chain Defense & Pentest Operations</div>
      </div>
    </div>
    <div class="header-actions">
      <button class="btn" onclick="vscode.postMessage({command: 'auditWorkspace'})" title="Fast static scan of all manifests and code">
        Run Project Audit
      </button>
      <button class="btn-secondary" onclick="vscode.postMessage({command: 'runDoctor'})" title="Inspect system hooks">
        System Health
      </button>
    </div>
  </div>

  <!-- SECTION 1: SYSTEM DEFENSE POSTURE METRICS (PLAIN HUMAN LABELS) -->
  <div class="grid">
    <div class="card">
      <div class="card-title">Project Safety Posture</div>
      <div class="card-value" style="color: ${scoreColor};">${score} / 100</div>
      <div class="card-desc">${statusText}</div>
    </div>
    <div class="card">
      <div class="card-title">Blocked Dangerous Packages</div>
      <div class="card-value" style="color: ${criticalCount > 0 ? '#f44336' : '#4caf50'};">${criticalCount}</div>
      <div class="card-desc">Known malware and AI hallucination 404s blocked from execution</div>
    </div>
    <div class="card">
      <div class="card-title">Unvetted / New Packages</div>
      <div class="card-value" style="color: ${warningCount > 0 ? '#ff9800' : '#4caf50'};">${warningCount}</div>
      <div class="card-desc">Packages published less than 72 hours ago requiring verification</div>
    </div>
  </div>

  <!-- SECTION 2: ACTIVE THREAT RADAR -->
  <div class="section-title">
    <span>Active Findings & Manifest Audit</span>
    <span style="font-size: 11px; color: var(--muted); font-weight: normal;">${this._threats.length} issues needing review</span>
  </div>
  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Finding / Package</th>
          <th>Risk Level</th>
          <th>Details & Rationale</th>
          <th>File Location</th>
          <th style="text-align: right;">Action</th>
        </tr>
      </thead>
      <tbody>
        ${threatsHtml}
      </tbody>
    </table>
  </div>

  <!-- SECTION 3: SECURITY AUDIT STATION -->
  <div class="strix-station">
    <div class="strix-station-header">
      <div>
        <span class="strix-badge">SECURITY AUDIT</span>
        <div class="strix-title">Security Simulation</div>
        <div class="strix-desc">
          Simulates attack patterns in an isolated sandbox to verify code vulnerabilities and defenses before deployment.
        </div>
      </div>
      <div class="strix-ctrls">
        <div class="brain-pill" onclick="openLlmModal()" title="Click to change engine or connect API keys">
          <span>Engine:</span>
          <strong style="color: var(--text);">${activeProviderName}</strong>
          <span style="font-size: 10px; color: var(--muted);">${activeModelName}</span>
        </div>
        <button class="btn-strix-run" ${this._isScanning ? 'disabled' : ''} onclick="runPentest()">
          <span>Run Security Audit</span>
        </button>
      </div>
    </div>

    ${
      this._isScanning
        ? `
      <div class="progress-box">
        <div class="progress-header">
          <span style="color: var(--text); font-weight: 600;">Security Test in Progress: ${this._scanStage || 'Executing security simulation...'}</span>
          <span>${this._scanPercent}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${Math.max(5, this._scanPercent)}%;"></div>
        </div>
        <div class="telemetry-console" id="telemetryBox">${this._scanLogs.join('\n') || '[ContextArmor] Initializing security analysis...'}</div>
      </div>
    `
        : `
      <div style="background: rgba(0, 0, 0, 0.25); border: 1px dashed rgba(255, 255, 255, 0.12); border-radius: 6px; padding: 14px 18px; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 12px; color: var(--muted);">
          Ready to test project. Simulates attack patterns in a safe sandbox to verify your defenses.
        </span>
        <span style="font-size: 11px; color: #4caf50; font-weight: 600;">Sandbox Ready</span>
      </div>
    `
    }
  </div>

  <!-- IN-WEBVIEW MODAL DIALOG (SELECT / CONFIGURE PROVIDER) -->
  <div class="modal-overlay" id="llmModal">
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-title">Configure Security Engine</div>
        <button class="modal-close" onclick="closeLlmModal()">✕</button>
      </div>
      <div style="font-size: 12px; color: var(--muted); margin-bottom: 12px;">
        Choose which engine or model powers security testing:
      </div>

      <!-- OPTION 1: CHATGPT SUBSCRIPTION -->
      <div class="provider-option">
        <div class="provider-top">
          <span class="provider-name">ChatGPT Subscription (OAuth Login)</span>
          <span class="provider-tag">OAuth Login</span>
        </div>
        <div class="provider-desc">
          1-click browser sign-in directly on your existing ChatGPT subscription. No API keys required.
        </div>
        <button class="btn" style="background: #10a37f; width: 100%; justify-content: center;" onclick="startOauth()">
          Sign in with OpenAI (Browser OAuth)
        </button>
      </div>

      <!-- OPTION 2: GOOGLE GEMINI -->
      <div class="provider-option">
        <div class="provider-top">
          <span class="provider-name">Google Gemini</span>
          <span class="provider-tag">Free Tier</span>
        </div>
        <div class="provider-desc">
          Ultra-fast multi-turn reasoning. Free with any personal Google account via Google AI Studio.
        </div>
        <div style="margin-bottom: 8px;">
          <button class="btn-secondary" style="width: 100%; justify-content: center; font-size: 11px;" onclick="openExternal('https://aistudio.google.com/app/apikey')">
            1-Click: Open Google AI Studio (Copy Free Key)
          </button>
        </div>
        <div class="input-row">
          <input type="password" class="input-field" id="geminiKey" placeholder="Paste Gemini API Key (AIzaSy...)">
          <button class="btn" onclick="saveKey('gemini', 'geminiKey')">Save</button>
        </div>
      </div>

      <!-- OPTION 3: OPENAI API KEY -->
      <div class="provider-option">
        <div class="provider-top">
          <span class="provider-name">OpenAI (API Key)</span>
          <span class="provider-tag">GPT-4o</span>
        </div>
        <div class="provider-desc">
          Use pay-as-you-go API key from <a href="https://platform.openai.com/api-keys" target="_blank" style="color: var(--accent);">platform.openai.com</a>.
        </div>
        <div class="input-row">
          <input type="password" class="input-field" id="openaiKey" placeholder="Paste OpenAI Key (sk-...)">
          <button class="btn" onclick="saveKey('openai', 'openaiKey')">Save</button>
        </div>
      </div>

      <!-- OPTION 4: ANTHROPIC CLAUDE -->
      <div class="provider-option">
        <div class="provider-top">
          <span class="provider-name">Anthropic Claude</span>
          <span class="provider-tag">Claude 3.5 Sonnet</span>
        </div>
        <div class="provider-desc">
          Anthropic requires a direct API key (consumer web OAuth is not supported for third-party CLIs).
        </div>
        <div style="margin-bottom: 8px;">
          <button class="btn-secondary" style="width: 100%; justify-content: center; font-size: 11px;" onclick="openExternal('https://console.anthropic.com/settings/keys')">
            1-Click: Open Anthropic Console (Copy Key)
          </button>
        </div>
        <div class="input-row">
          <input type="password" class="input-field" id="claudeKey" placeholder="Paste Claude Key (sk-ant-...)">
          <button class="btn" onclick="saveKey('anthropic', 'claudeKey')">Save</button>
        </div>
      </div>

      <!-- OPTION 5: OFFLINE SANDBOX -->
      <div class="provider-option">
        <div class="provider-top">
          <span class="provider-name">Offline Security Engine</span>
          <span class="provider-tag">Offline</span>
        </div>
        <div class="provider-desc">
          Executes in-process AST and taint flow analysis across workspace files. No external keys, subscriptions, or network access needed.
        </div>
        <button class="btn-secondary" style="width: 100%; justify-content: center;" onclick="saveKey('sandbox', '')">
          Select Offline Analysis
        </button>
      </div>

    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function runPentest() {
      const isConfigured = ${llm.isConfigured};
      if (!isConfigured) {
        openLlmModal();
        return;
      }
      vscode.postMessage({ command: 'runStrix' });
    }

    function openLlmModal() {
      document.getElementById('llmModal').style.display = 'flex';
    }

    function closeLlmModal() {
      document.getElementById('llmModal').style.display = 'none';
    }

    function openExternal(url) {
      vscode.postMessage({ command: 'openUrl', url: url });
    }

    function startOauth() {
      closeLlmModal();
      vscode.postMessage({ command: 'startOauthLogin' });
    }

    function saveKey(provider, inputId) {
      const key = inputId ? document.getElementById(inputId).value : '';
      if (inputId && (!key || key.trim().length < 8)) {
        alert('Please paste a valid API key.');
        return;
      }
      closeLlmModal();
      vscode.postMessage({ command: 'saveApiKey', provider: provider, key: key });
    }

    function pinDep(file, line, pin) {
      vscode.postMessage({ command: 'pinDep', file, line, pin });
    }

    function removeDep(file, line) {
      vscode.postMessage({ command: 'removeDep', file, line });
    }

    function fixTorch(file, line) {
      vscode.postMessage({ command: 'fixTorch', file, line });
    }

    // Auto-scroll telemetry box if active
    const tBox = document.getElementById('telemetryBox');
    if (tBox) {
      tBox.scrollTop = tBox.scrollHeight;
    }
  </script>
</body>
</html>`;
  }
}
