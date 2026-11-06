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
        ? `<tr><td colspan="5" style="text-align: center; color: var(--vscode-descriptionForeground); padding: 32px; font-size: 13px;">🛡️ All dependencies and code files are verified safe. No vulnerabilities or hallucinations found.</td></tr>`
        : this._threats
            .map((t) => {
              const isCrit = t.severity === 'CRITICAL';
              const pinMatch =
                t.desc.match(/Suggested pin:\s*['"`](?:npm\s+i\s+[^@]+@|pip\s+install\s+[^=]+=+|uv\s+add\s+[^=]+=*)([^'"`\s]+)['"`]/i) ||
                t.desc.match(/Newest version older than 72h:\s*['"`]([^'"`]+)['"`]/i);
              const pin = pinMatch ? pinMatch[1] : undefined;

              return `
          <tr style="border-bottom: 1px solid var(--vscode-editorWidget-border);">
            <td style="padding: 12px; font-weight: 600; font-family: monospace;">${t.title}</td>
            <td style="padding: 12px;">
              <span style="background: ${isCrit ? '#f4433622' : '#ff980022'}; color: ${isCrit ? '#f44336' : '#ff9800'}; padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 11px;">
                ${isCrit ? 'CRITICAL RISK' : 'WARNING'}
              </span>
            </td>
            <td style="padding: 12px; color: var(--vscode-foreground); font-size: 12px; line-height: 1.4;">${t.desc}</td>
            <td style="padding: 12px; color: var(--vscode-descriptionForeground); font-size: 11px;">
              ${t.file ? t.file.split('/').slice(-2).join('/') : 'Workspace'}${t.line !== undefined ? `:${t.line + 1}` : ''}
            </td>
            <td style="padding: 12px; text-align: right; white-space: nowrap;">
              ${
                pin
                  ? `<button class="btn-sm btn-fix" onclick="pinDep('${t.file}', ${t.line}, '${pin}')">💡 Pin to ${pin}</button>`
                  : t.desc.includes('weights_only')
                  ? `<button class="btn-sm btn-fix" onclick="fixTorch('${t.file}', ${t.line})">💡 Patch weights_only</button>`
                  : ''
              }
              ${
                t.file && t.line !== undefined
                  ? `<button class="btn-sm btn-del" onclick="removeDep('${t.file}', ${t.line})">🗑️ Remove</button>`
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
      --bg: var(--vscode-editor-background);
      --card-bg: var(--vscode-editorWidget-background, #1e1e1e);
      --border: var(--vscode-editorWidget-border, #333333);
      --text: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground, #888888);
      --accent: var(--vscode-focusBorder, #007acc);
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
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
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.3px;
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
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--muted);
      font-weight: 600;
      margin-bottom: 6px;
    }
    .card-value {
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
      font-size: 15px;
      font-weight: 700;
      margin-top: 28px;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
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
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      padding: 10px 14px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
    }
    .btn {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
      transform: translateY(-1px);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: 1px solid var(--border);
      padding: 7px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    .btn-sm {
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
      font-weight: 600;
      border: none;
      margin-left: 4px;
    }
    .btn-fix {
      background: var(--vscode-button-background, #0e639c);
      color: #fff;
    }
    .btn-del {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: #ccc;
    }

    /* =========================================================
       FLAGSHIP STRIX PENTEST COMMAND STATION (BOTTOM MODULE)
       ========================================================= */
    .strix-station {
      background: linear-gradient(180deg, rgba(30, 20, 35, 0.7) 0%, rgba(20, 20, 25, 0.95) 100%);
      border: 1.5px solid rgba(229, 57, 53, 0.4);
      border-radius: 10px;
      padding: 24px;
      margin-top: 32px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
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
      background: linear-gradient(135deg, #e53935 0%, #8e24aa 100%);
      color: #fff;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.8px;
      padding: 3px 8px;
      border-radius: 4px;
      display: inline-block;
      margin-bottom: 6px;
    }
    .strix-title {
      font-size: 18px;
      font-weight: 700;
      color: #fff;
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
      background: linear-gradient(135deg, #b71c1c 0%, #6a1b9a 100%);
      color: #fff;
      border: 1px solid rgba(255, 120, 120, 0.4);
      padding: 10px 20px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(183, 28, 28, 0.4);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.15s ease;
    }
    .btn-strix-run:hover {
      background: linear-gradient(135deg, #c62828 0%, #7b1fa2 100%);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(183, 28, 28, 0.5);
    }
    .btn-strix-run:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .brain-pill {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    .brain-pill:hover {
      border-color: var(--accent);
      background: rgba(255, 255, 255, 0.12);
    }

    /* Progress Bar */
    .progress-box {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
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
      background: rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      height: 10px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      background: linear-gradient(90deg, #e53935 0%, #8e24aa 50%, #00e676 100%);
      height: 100%;
      border-radius: 10px;
      transition: width 0.3s ease;
      box-shadow: 0 0 10px rgba(229, 57, 53, 0.6);
    }
    .telemetry-console {
      background: #0d0e11;
      border: 1px solid #22252a;
      border-radius: 6px;
      padding: 12px;
      font-family: monospace;
      font-size: 11px;
      color: #98c379;
      height: 140px;
      overflow-y: auto;
      margin-top: 12px;
      white-space: pre-wrap;
      line-height: 1.4;
    }

    /* =========================================================
       IN-WEBVIEW MODAL DIALOG (REPLACES TOP SEARCH BAR POPUP)
       ========================================================= */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 9999;
    }
    .modal-card {
      background: var(--card-bg);
      border: 1.5px solid var(--accent);
      border-radius: 10px;
      width: 580px;
      max-width: 90%;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
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
      font-size: 17px;
      font-weight: 700;
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
      font-weight: 700;
      font-size: 13px;
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
      <span style="font-size: 26px;">🛡️</span>
      <div>
        <div class="header-title">ContextArmor Security Operations</div>
        <div class="header-sub">Pre-Execution AI Supply Chain Defense & Pentest Operations</div>
      </div>
    </div>
    <div class="header-actions">
      <button class="btn" onclick="vscode.postMessage({command: 'auditWorkspace'})" title="Fast static scan of all manifests and code">
        🛡️ Run Project Audit
      </button>
      <button class="btn-secondary" onclick="vscode.postMessage({command: 'runDoctor'})" title="Inspect system hooks">
        🩺 System Health
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

  <!-- SECTION 3: STRIX AUTONOMOUS PENTEST COMMAND STATION (FLAGSHIP BOTTOM MODULE) -->
  <div class="strix-station">
    <div class="strix-station-header">
      <div>
        <span class="strix-badge">DEEP AI SECURITY TEST</span>
        <div class="strix-title">🦅 Autonomous AI Vulnerability Simulation</div>
        <div class="strix-desc">
          Simulates real-world attack scenarios in an isolated sandbox. Autonomous AI agents discover code vulnerabilities and dependency exploits before deployment.
        </div>
      </div>
      <div class="strix-ctrls">
        <div class="brain-pill" onclick="openLlmModal()" title="Click to change AI Brain or connect API keys">
          <span>⚡ Active AI Engine:</span>
          <strong style="color: #4caf50;">${activeProviderName}</strong>
          <span style="font-size: 10px; color: var(--muted);">${activeModelName}</span>
          <span style="font-size: 11px;">⚙️</span>
        </div>
        <button class="btn-strix-run" ${this._isScanning ? 'disabled' : ''} onclick="runPentest()">
          <span>🦅 Start Deep Security Test</span>
        </button>
      </div>
    </div>

    ${
      this._isScanning
        ? `
      <div class="progress-box">
        <div class="progress-header">
          <span style="color: #64b5f6; font-weight: 600;">● Security Test in Progress: ${this._scanStage || 'Executing security simulation...'}</span>
          <span>${this._scanPercent}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${Math.max(5, this._scanPercent)}%;"></div>
        </div>
        <div class="telemetry-console" id="telemetryBox">${this._scanLogs.join('\n') || '[ContextArmor Telemetry] Initializing containerized attack agents...'}</div>
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

  <!-- IN-WEBVIEW MODAL DIALOG (SELECT / CONFIGURE AI PROVIDER) -->
  <div class="modal-overlay" id="llmModal">
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-title">⚙️ Connect AI Assistant</div>
        <button class="modal-close" onclick="closeLlmModal()">✕</button>
      </div>
      <div style="font-size: 12px; color: var(--muted); margin-bottom: 12px;">
        Choose which AI model powers your deep security testing:
      </div>

      <!-- OPTION 1: CHATGPT SUBSCRIPTION (LUNA 6) -->
      <div class="provider-option">
        <div class="provider-top">
          <span class="provider-name">🌐 ChatGPT Subscription (OAuth Login)</span>
          <span class="provider-tag" style="background: rgba(76, 175, 80, 0.2); color: #4caf50;">LUNA 6 · $0.00</span>
        </div>
        <div class="provider-desc">
          Uses <strong>Luna 6 (chatgpt/gpt-5.6-luna)</strong>. 1-click browser sign-in directly on your existing ChatGPT subscription. No API keys required.
        </div>
        <button class="btn" style="background: #10a37f; width: 100%; justify-content: center;" onclick="startOauth()">
          🌐 Sign in with OpenAI (Browser OAuth)
        </button>
      </div>

      <!-- OPTION 2: GOOGLE GEMINI -->
      <div class="provider-option">
        <div class="provider-top">
          <span class="provider-name">✨ Google Gemini</span>
          <span class="provider-tag">gemini-3.7-flash</span>
        </div>
        <div class="provider-desc">
          Ultra-fast multi-turn reasoning. Get a free API key at <a href="https://aistudio.google.com/apikey" target="_blank" style="color: var(--accent);">aistudio.google.com</a>.
        </div>
        <div class="input-row">
          <input type="password" class="input-field" id="geminiKey" placeholder="Paste Gemini API Key (AIzaSy...)">
          <button class="btn" onclick="saveKey('gemini', 'geminiKey')">Save</button>
        </div>
      </div>

      <!-- OPTION 3: OPENAI API KEY -->
      <div class="provider-option">
        <div class="provider-top">
          <span class="provider-name">🤖 OpenAI (API Key)</span>
          <span class="provider-tag">openai/gpt-5.6-luna</span>
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
          <span class="provider-name">🛡️ Anthropic Claude</span>
          <span class="provider-tag">claude-sonnet-5</span>
        </div>
        <div class="provider-desc">
          Best-in-class coding accuracy from <a href="https://console.anthropic.com/settings/keys" target="_blank" style="color: var(--accent);">console.anthropic.com</a>.
        </div>
        <div class="input-row">
          <input type="password" class="input-field" id="claudeKey" placeholder="Paste Claude Key (sk-ant-...)">
          <button class="btn" onclick="saveKey('anthropic', 'claudeKey')">Save</button>
        </div>
      </div>

      <!-- OPTION 5: OFFLINE SANDBOX -->
      <div class="provider-option">
        <div class="provider-top">
          <span class="provider-name">⚡ Built-in Offline Sandbox (Zero-LLM Mode)</span>
          <span class="provider-tag">100% Offline</span>
        </div>
        <div class="provider-desc">
          Executes in-process AST and taint flow analysis across workspace files. No external keys, subscriptions, or network access needed.
        </div>
        <button class="btn-secondary" style="width: 100%; justify-content: center;" onclick="saveKey('sandbox', '')">
          ⚡ Select 100% Offline Mode
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
