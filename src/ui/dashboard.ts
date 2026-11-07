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
    const scoreColor = score === 100 ? '#05ffa1' : score >= 80 ? '#fcee0a' : '#ff003c';
    const statusText =
      criticalCount > 0
        ? 'DANGEROUS ANOMALIES DETECTED — IMMEDIATE REVIEW REQUIRED'
        : warningCount > 0
        ? 'UNVERIFIED PACKAGES DETECTED — AUDIT RECOMMENDED'
        : 'ALL PACKAGES & CODE VERIFIED SECURE';

    const threatsHtml =
      this._threats.length === 0
        ? `<tr><td colspan="5" style="text-align: center; color: var(--muted); padding: 36px; font-size: 12px; font-family: var(--font-mono); letter-spacing: 0.05em;">All dependencies and code files are verified safe. Zero vulnerabilities detected.</td></tr>`
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
            <td style="padding: 12px; font-weight: 600; font-family: var(--font-mono); font-size: 12px; word-break: break-all; color: var(--text);">${t.title}</td>
            <td style="padding: 12px;">
              <span class="cyber-badge ${isCrit ? 'badge-crit' : 'badge-warn'}">
                ${isCrit ? 'CRITICAL RISK' : 'WARNING'}
              </span>
            </td>
            <td style="padding: 12px; color: var(--text-dim); font-size: 12px; line-height: 1.4;">${t.desc}</td>
            <td style="padding: 12px; color: var(--neon-cyan); font-size: 11px; font-family: var(--font-mono);">
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
                  ? `<button class="btn-sm btn-del" onclick="removeDep('${t.file}', ${t.line})">Purge Package</button>`
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
    @import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700;800&family=Orbitron:wght@600;700;800;900&family=Share+Tech+Mono&display=swap');

    :root {
      --font-header: "Orbitron", "Chakra Petch", -apple-system, BlinkMacSystemFont, sans-serif;
      --font-ui: "Chakra Petch", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: "Share Tech Mono", "JetBrains Mono", Monaco, Menlo, Consolas, monospace;
      
      /* Cyberpunk HUD Palette */
      --cyber-bg: #06070a;
      --cyber-surface: #0a0d14;
      --cyber-card-bg: #0d111a;
      --cyber-card-hover: #121824;
      --border: #162032;
      --border-accent: rgba(0, 240, 255, 0.35);
      --text: #e3edf8;
      --text-dim: #8fa0be;
      --muted: #596c88;
      
      /* Neon Accent Channels */
      --neon-cyan: #00f0ff;
      --neon-yellow: #fcee0a;
      --neon-pink: #ff003c;
      --neon-green: #05ffa1;

      /* Threat Badges */
      --crit-bg: rgba(255, 0, 60, 0.12);
      --crit-text: #ff3366;
      --crit-border: rgba(255, 0, 60, 0.45);
      --warn-bg: rgba(252, 238, 10, 0.12);
      --warn-text: #fcee0a;
      --warn-border: rgba(252, 238, 10, 0.45);
      --safe-bg: rgba(5, 255, 161, 0.12);
      --safe-text: #05ffa1;
      --safe-border: rgba(5, 255, 161, 0.45);
    }

    /* Custom Cyberpunk Scrollbars */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: #06070a;
    }
    ::-webkit-scrollbar-thumb {
      background: #1a2336;
      border-radius: 2px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--neon-cyan);
    }

    body {
      font-family: var(--font-ui);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      padding: 24px 32px;
      color: var(--text);
      background-color: var(--cyber-bg);
      margin: 0;
      box-sizing: border-box;
      min-height: 100vh;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 24px;
      position: relative;
    }
    .header::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      width: 140px;
      height: 2px;
      background: var(--neon-cyan);
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
      letter-spacing: 0.1em;
      color: #ffffff;
    }
    .header-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 3px;
      letter-spacing: 0.04em;
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
      background: var(--cyber-card-bg);
      border: 1px solid var(--border);
      border-left: 2px solid var(--border-accent);
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: background 0.15s ease, border-color 0.15s ease;
      position: relative;
    }
    .card:hover {
      background: var(--cyber-card-hover);
      border-color: rgba(0, 240, 255, 0.45);
    }
    .card-title {
      font-family: var(--font-header);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
      font-weight: 700;
      margin-bottom: 6px;
    }
    .card-value {
      font-family: var(--font-header);
      font-variant-numeric: tabular-nums;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: 0.04em;
      margin-bottom: 4px;
    }
    .card-desc {
      font-size: 11px;
      color: var(--text-dim);
      line-height: 1.35;
    }
    .section-title {
      font-family: var(--font-header);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-top: 28px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--text);
    }
    .table-container {
      background: var(--cyber-card-bg);
      border: 1px solid var(--border);
      overflow: hidden;
      margin-bottom: 28px;
      position: relative;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th {
      background: #080a10;
      padding: 10px 14px;
      font-family: var(--font-header);
      font-size: 9.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
    }
    .cyber-badge {
      font-family: var(--font-header);
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 2px 7px;
      clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));
      display: inline-block;
    }
    .badge-crit {
      background: var(--crit-bg);
      color: var(--crit-text);
      border: 1px solid var(--crit-border);
    }
    .badge-warn {
      background: var(--warn-bg);
      color: var(--warn-text);
      border: 1px solid var(--warn-border);
    }
    .badge-safe {
      background: var(--safe-bg);
      color: var(--safe-text);
      border: 1px solid var(--safe-border);
    }
    /* Primary Tactical Dark HUD Button */
    .btn {
      background: #121824;
      color: #00f0ff;
      border: 1px solid rgba(0, 240, 255, 0.45);
      padding: 8px 18px;
      cursor: pointer;
      font-weight: 800;
      font-size: 11px;
      font-family: var(--font-header);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .btn:hover {
      background: rgba(0, 240, 255, 0.15);
      color: #ffffff;
      border-color: #00f0ff;
      transform: translateY(-1px);
    }
    .btn:active {
      transform: translateY(1px);
    }
    /* Secondary Tactical Dark Button */
    .btn-secondary {
      background: #0d121c;
      color: #9ab0cf;
      border: 1px solid var(--border);
      padding: 7px 16px;
      cursor: pointer;
      font-weight: 700;
      font-size: 11px;
      font-family: var(--font-header);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px));
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .btn-secondary:hover {
      background: #151d2d;
      border-color: rgba(0, 240, 255, 0.35);
      color: #ffffff;
      transform: translateY(-1px);
    }
    .btn-sm {
      padding: 4px 10px;
      font-size: 10px;
      cursor: pointer;
      font-weight: 700;
      font-family: var(--font-header);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border: none;
      margin-left: 4px;
      clip-path: polygon(0 0, calc(100% - 5px) 0, 100% 5px, 100% 100%, 5px 100%, 0 calc(100% - 5px));
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .btn-fix {
      background: rgba(0, 240, 255, 0.12);
      color: var(--neon-cyan);
      border: 1px solid rgba(0, 240, 255, 0.4);
    }
    .btn-fix:hover {
      background: rgba(0, 240, 255, 0.25);
    }
    .btn-del {
      background: rgba(255, 0, 60, 0.15);
      color: #ff3366;
      border: 1px solid rgba(255, 0, 60, 0.45);
    }
    .btn-del:hover {
      background: rgba(255, 0, 60, 0.3);
    }

    /* =========================================================
       SECURITY AUDIT MODULE
       ========================================================= */
    .strix-station {
      background: var(--cyber-card-bg);
      border: 1px solid var(--border);
      border-top: 2px solid var(--neon-cyan);
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
      background: rgba(0, 240, 255, 0.1);
      color: var(--neon-cyan);
      border: 1px solid rgba(0, 240, 255, 0.35);
      font-family: var(--font-header);
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      padding: 2px 7px;
      display: inline-block;
      margin-bottom: 6px;
    }
    .strix-title {
      font-family: var(--font-header);
      font-size: 14px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text);
    }
    .strix-desc {
      font-size: 12px;
      color: var(--text-dim);
      margin-top: 4px;
      max-width: 600px;
      line-height: 1.45;
    }
    .strix-ctrls {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .btn-strix-run {
      background: #121824;
      color: #00f0ff;
      border: 1px solid rgba(0, 240, 255, 0.45);
      padding: 8px 20px;
      font-size: 11px;
      font-weight: 800;
      font-family: var(--font-header);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .btn-strix-run:hover {
      background: rgba(0, 240, 255, 0.15);
      border-color: #00f0ff;
      color: #ffffff;
      transform: translateY(-1px);
    }
    .btn-strix-run:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }
    .brain-pill {
      background: #090c13;
      border: 1px solid var(--border);
      padding: 6px 14px;
      font-size: 11.5px;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      transition: border-color 0.15s;
      clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px));
    }
    .brain-pill:hover {
      border-color: var(--neon-cyan);
    }

    /* Progress Bar */
    .progress-box {
      background: #06080d;
      border: 1px solid var(--border);
      padding: 16px;
      margin-top: 16px;
    }
    .progress-header {
      display: flex;
      justify-content: space-between;
      font-family: var(--font-header);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 8px;
    }
    .progress-track {
      background: #111622;
      height: 6px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      background: linear-gradient(90deg, var(--neon-cyan), var(--neon-green));
      height: 100%;
      transition: width 0.3s ease;
    }
    .telemetry-console {
      background: #030407;
      border: 1px solid rgba(0, 240, 255, 0.25);
      padding: 10px 14px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--neon-cyan);
      height: 130px;
      overflow-y: auto;
      margin-top: 12px;
      white-space: pre-wrap;
      line-height: 1.5;
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
      background: rgba(3, 4, 7, 0.88);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 9999;
    }
    .modal-card {
      background: #0a0d15;
      border: 1px solid rgba(0, 240, 255, 0.4);
      width: 580px;
      max-width: 90%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.85);
      padding: 24px;
      box-sizing: border-box;
      max-height: 85vh;
      overflow-y: auto;
      position: relative;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
    }
    .modal-title {
      font-family: var(--font-header);
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--neon-cyan);
    }
    .modal-close {
      background: transparent;
      border: none;
      color: var(--muted);
      font-size: 18px;
      cursor: pointer;
      transition: color 0.15s;
    }
    .modal-close:hover {
      color: var(--neon-cyan);
    }
    .provider-option {
      border: 1px solid var(--border);
      background: rgba(0, 240, 255, 0.02);
      padding: 14px;
      margin-top: 12px;
      transition: all 0.15s;
      border-left: 2px solid rgba(0, 240, 255, 0.3);
    }
    .provider-option:hover {
      border-color: rgba(0, 240, 255, 0.5);
      background: rgba(0, 240, 255, 0.04);
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
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--text);
    }
    .provider-tag {
      font-family: var(--font-header);
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 2px 6px;
      background: rgba(0, 240, 255, 0.1);
      color: var(--neon-cyan);
      border: 1px solid rgba(0, 240, 255, 0.25);
    }
    .provider-desc {
      font-size: 11px;
      color: var(--text-dim);
      line-height: 1.35;
      margin-bottom: 10px;
    }
    .input-row {
      display: flex;
      gap: 8px;
    }
    .input-field {
      flex: 1;
      background: #040508;
      border: 1px solid var(--border);
      padding: 7px 10px;
      color: var(--neon-cyan);
      font-family: var(--font-mono);
      font-size: 11.5px;
      outline: none;
      transition: border-color 0.15s;
    }
    .input-field:focus {
      border-color: var(--neon-cyan);
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
      <div class="card-value" style="color: ${criticalCount > 0 ? 'var(--neon-pink)' : 'var(--neon-green)'};">${criticalCount}</div>
      <div class="card-desc">Known malware and AI hallucination 404s blocked from execution</div>
    </div>
    <div class="card">
      <div class="card-title">Unvetted / New Packages</div>
      <div class="card-value" style="color: ${warningCount > 0 ? 'var(--neon-yellow)' : 'var(--neon-green)'};">${warningCount}</div>
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
      <div style="background: rgba(0, 240, 255, 0.02); border: 1px dashed rgba(0, 240, 255, 0.2); padding: 14px 18px; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 12px; color: var(--muted); font-family: var(--font-ui);">
          Ready to test project. Simulates attack patterns in a safe sandbox to verify your defenses.
        </span>
        <span style="font-size: 11px; color: var(--neon-green); font-weight: 700; font-family: var(--font-header); letter-spacing: 0.06em;">SANDBOX READY</span>
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
        <button class="btn" style="background: #10a37f; border-color: #10a37f; color: #fff; width: 100%; justify-content: center;" onclick="startOauth()">
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
          Use pay-as-you-go API key from <a href="https://platform.openai.com/api-keys" target="_blank" style="color: var(--neon-cyan);">platform.openai.com</a>.
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
