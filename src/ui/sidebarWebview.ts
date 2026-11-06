import * as vscode from 'vscode';
import type { ThreatItem } from './treeView.js';
import { getLlmConfig, setProviderKey } from '../integrations/strix.js';

export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'contextarmorSidebarView';
  private _view?: vscode.WebviewView;
  private _threats: ThreatItem[] = [];
  private _isScanning: boolean = false;
  private _scanPercent: number = 0;
  private _statusMessage?: string;
  private _scanLogLine?: string;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'auditWorkspace': {
          vscode.commands.executeCommand('contextarmor.auditWorkspace');
          break;
        }
        case 'runStrix': {
          vscode.commands.executeCommand('contextarmor.runStrix');
          break;
        }
        case 'configureLlm': {
          vscode.commands.executeCommand('contextarmor.configureLlm');
          break;
        }
        case 'startOauthLogin': {
          const term = vscode.window.createTerminal('Strix ChatGPT OAuth Login');
          term.show();
          term.sendText('strix auth login chatgpt');
          setProviderKey('chatgpt-oauth');
          vscode.window.showInformationMessage(
            'Opened terminal for ChatGPT OAuth Login. Please follow the browser prompt to complete sign-in!'
          );
          this.update(this._threats);
          break;
        }
        case 'saveApiKey': {
          setProviderKey(data.provider, data.key);
          vscode.window.showInformationMessage('ContextArmor AI Brain updated successfully!');
          this.update(this._threats);
          break;
        }
        case 'openDashboard': {
          vscode.commands.executeCommand('contextarmor.openDashboard');
          break;
        }
        case 'runDoctor': {
          vscode.commands.executeCommand('contextarmor.doctor');
          break;
        }
        case 'removeDep': {
          if (data.file && data.line !== undefined) {
            const uri = vscode.Uri.file(data.file);
            const doc = await vscode.workspace.openTextDocument(uri);
            const edit = new vscode.WorkspaceEdit();
            const lineRange = doc.lineAt(data.line).rangeIncludingLineBreak;
            edit.delete(uri, lineRange);
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            vscode.commands.executeCommand('contextarmor.auditWorkspace');
          }
          break;
        }
        case 'pinDep': {
          if (data.file && data.line !== undefined && data.pin) {
            const uri = vscode.Uri.file(data.file);
            const doc = await vscode.workspace.openTextDocument(uri);
            const edit = new vscode.WorkspaceEdit();
            const line = doc.lineAt(data.line);
            let updated = line.text;
            if (data.file.endsWith('package.json')) {
              updated = line.text.replace(/:\s*["'][^"']+["']/, `: "${data.pin}"`);
            } else if (data.file.endsWith('requirements.txt')) {
              updated = line.text.replace(/([a-zA-Z0-9_\-\.]+)(?:[=><~!]=*[^#\s]+)?/, `$1==${data.pin}`);
            }
            edit.replace(uri, line.range, updated);
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            vscode.commands.executeCommand('contextarmor.auditWorkspace');
          }
          break;
        }
        case 'fixTorch': {
          if (data.file && data.line !== undefined) {
            const uri = vscode.Uri.file(data.file);
            const doc = await vscode.workspace.openTextDocument(uri);
            const edit = new vscode.WorkspaceEdit();
            const line = doc.lineAt(data.line);
            const updated = line.text.replace(/torch\.load\(([^)]+)\)/, 'torch.load($1, weights_only=True)');
            edit.replace(uri, line.range, updated);
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            vscode.commands.executeCommand('contextarmor.auditWorkspace');
          }
          break;
        }
      }
    });
  }

  public setScanning(isScanning: boolean, statusMessage?: string) {
    this._isScanning = isScanning;
    this._statusMessage = statusMessage;
    this._scanPercent = isScanning ? 15 : 100;
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview();
    }
  }

  public updateProgress(percent: number, stage: string, logLine?: string) {
    this._isScanning = true;
    this._scanPercent = percent;
    this._statusMessage = stage;
    this._scanLogLine = logLine;
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview();
    }
  }

  public update(threats: ThreatItem[]) {
    this._threats = threats;
    this._isScanning = false;
    this._scanPercent = 100;
    this._statusMessage = undefined;
    this._scanLogLine = undefined;
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview();
    }
  }

  private _getHtmlForWebview(): string {
    const criticalCount = this._threats.filter((t) => t.severity === 'CRITICAL').length;
    const warningCount = this._threats.filter((t) => t.severity === 'WARNING').length;
    const score = criticalCount > 0 ? 65 : warningCount > 0 ? 82 : 100;
    const scoreColor = score === 100 ? '#4caf50' : score >= 80 ? '#ff9800' : '#f44336';
    const scoreLabel = score === 100 ? 'Clean' : score >= 80 ? 'Warning' : 'Critical';

    const llm = getLlmConfig();
    const activeProviderName = llm.isConfigured ? llm.provider : 'Not Configured';

    let contentHtml = '';

    if (this._threats.length === 0) {
      contentHtml = `
        <div style="padding: 20px 10px; text-align: center; border: 1px dashed var(--vscode-editorWidget-border); border-radius: 8px; margin-top: 8px; background: rgba(0,0,0,0.1);">
          <div style="font-size: 22px; margin-bottom: 4px;">🛡️</div>
          <div style="font-weight: 600; font-size: 12px; color: #4caf50;">All Dependencies Clean</div>
          <div style="font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 3px;">
            No malicious packages, 404 hallucinations, or code risks detected.
          </div>
        </div>
      `;
    } else {
      contentHtml = this._threats
        .map((t) => {
          const isCrit = t.severity === 'CRITICAL';
          const badgeBg = isCrit ? '#f4433622' : '#ff980022';
          const badgeColor = isCrit ? '#f44336' : '#ff9800';
          const badgeText = isCrit ? 'BLOCK' : 'ASK';

          const pinMatch =
            t.desc.match(/Suggested pin:\s*['"`](?:npm\s+i\s+[^@]+@|pip\s+install\s+[^=]+=+|uv\s+add\s+[^=]+=*)([^'"`\s]+)['"`]/i) ||
            t.desc.match(/Newest version older than 72h:\s*['"`]([^'"`]+)['"`]/i);
          const pin = pinMatch ? pinMatch[1] : undefined;

          let tag = 'DEP';
          if (t.title.includes('Pentest')) tag = 'PENTEST';
          else if (t.title.startsWith('[MCP')) tag = 'MCP';
          else if (t.title.includes('torch.load') || t.file?.endsWith('.py')) tag = 'CODE';

          return `
            <div class="threat-card" style="border-left: 3px solid ${isCrit ? '#f44336' : '#ff9800'};">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; gap: 4px;">
                <span style="font-weight: 700; font-size: 11px; font-family: monospace; word-break: break-all;">${t.title}</span>
                <div style="display: flex; gap: 3px; flex-shrink: 0;">
                  <span style="background: var(--vscode-badge-background, #333); color: var(--vscode-badge-foreground, #ccc); padding: 1px 4px; border-radius: 3px; font-size: 9px; font-weight: 700;">
                    ${tag}
                  </span>
                  <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 1px 4px; border-radius: 3px; font-weight: bold; font-size: 9px;">
                    ${badgeText}
                  </span>
                </div>
              </div>
              <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; line-height: 1.35;">
                ${t.desc}
              </div>
              <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                ${
                  pin
                    ? `<button class="action-mini btn-fix" onclick="pin('${t.file}', ${t.line}, '${pin}')">💡 Pin to ${pin}</button>`
                    : t.desc.includes('weights_only')
                    ? `<button class="action-mini btn-fix" onclick="fixTorch('${t.file}', ${t.line})">💡 Patch weights_only</button>`
                    : ''
                }
                ${
                  t.file && t.line !== undefined
                    ? `<button class="action-mini btn-del" onclick="remove('${t.file}', ${t.line})">🗑️ Remove</button>`
                    : ''
                }
              </div>
            </div>
          `;
        })
        .join('');
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      padding: 10px;
      margin: 0;
      color: var(--text);
      background: transparent;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .score-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .score-card:hover {
      border-color: var(--accent);
    }
    .score-title {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 600;
      letter-spacing: 0.4px;
    }
    .score-val {
      font-size: 18px;
      font-weight: 700;
    }

    /* Core Native Audit Button */
    .btn-audit {
      width: 100%;
      background: linear-gradient(135deg, #0277bd 0%, #0d47a1 100%);
      color: #fff;
      border: 1px solid rgba(120, 180, 255, 0.35);
      border-radius: 6px;
      padding: 10px 12px;
      margin-top: 10px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 6px rgba(2, 119, 189, 0.25);
      transition: all 0.15s ease;
      box-sizing: border-box;
    }
    .btn-audit:hover {
      filter: brightness(1.1);
      transform: translateY(-1px);
    }
    .btn-audit:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .btn-content {
      display: flex;
      align-items: center;
      gap: 8px;
      text-align: left;
    }
    .btn-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }
    .btn-desc {
      font-size: 10px;
      opacity: 0.85;
      margin-top: 2px;
    }
    .badge-pill {
      font-size: 9px;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.2);
      letter-spacing: 0.5px;
    }

    .util-row {
      display: flex;
      gap: 6px;
      margin-top: 6px;
      margin-bottom: 14px;
    }
    .btn-util {
      flex: 1;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: 1px solid var(--border);
      padding: 6px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      text-align: center;
      font-weight: 600;
    }
    .btn-util:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    /* Threat List */
    .threat-section {
      flex: 1;
      margin-bottom: 14px;
    }
    .section-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .threat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      margin-top: 6px;
    }
    .action-mini {
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      border: none;
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
       STRIX PENTEST STATION ANCHORED AT THE BOTTOM OF SIDEBAR
       ========================================================= */
    .strix-bottom-station {
      background: linear-gradient(180deg, rgba(35, 20, 30, 0.7) 0%, rgba(20, 20, 25, 0.95) 100%);
      border: 1.5px solid rgba(229, 57, 53, 0.4);
      border-radius: 8px;
      padding: 12px;
      margin-top: auto;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
    }
    .station-badge {
      background: linear-gradient(135deg, #e53935 0%, #8e24aa 100%);
      color: #fff;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.6px;
      padding: 2px 6px;
      border-radius: 3px;
      display: inline-block;
      margin-bottom: 4px;
    }
    .station-title {
      font-size: 13px;
      font-weight: 700;
      color: #fff;
    }
    .station-desc {
      font-size: 10px;
      color: var(--muted);
      margin-top: 2px;
      line-height: 1.3;
      margin-bottom: 8px;
    }

    .brain-strip {
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 5px;
      padding: 6px 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      font-size: 11px;
      margin-bottom: 8px;
      transition: border-color 0.15s;
    }
    .brain-strip:hover {
      border-color: var(--accent);
    }
    .brain-left {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .brain-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #888;
    }
    .brain-dot.active {
      background: #4caf50;
      box-shadow: 0 0 6px #4caf50;
    }

    .btn-pentest {
      width: 100%;
      background: linear-gradient(135deg, #b71c1c 0%, #6a1b9a 100%);
      color: #fff;
      border: 1px solid rgba(255, 120, 120, 0.4);
      border-radius: 6px;
      padding: 10px 12px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 3px 8px rgba(183, 28, 28, 0.4);
      transition: all 0.15s ease;
      box-sizing: border-box;
    }
    .btn-pentest:hover {
      filter: brightness(1.1);
      transform: translateY(-1px);
    }
    .btn-pentest:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    /* Live Progress Bar */
    .progress-box {
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 10px;
      margin-top: 8px;
    }
    .progress-header {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .progress-track {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      height: 8px;
      overflow: hidden;
    }
    .progress-fill {
      background: linear-gradient(90deg, #e53935 0%, #8e24aa 50%, #00e676 100%);
      height: 100%;
      transition: width 0.3s ease;
      box-shadow: 0 0 8px rgba(229, 57, 53, 0.6);
    }
    .telemetry-mini {
      font-family: monospace;
      font-size: 10px;
      color: #98c379;
      margin-top: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* =========================================================
       IN-WEBVIEW MODAL DIALOG (REPLACES TOP SEARCH BAR DROP-DOWN)
       ========================================================= */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      display: none;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 12px;
      z-index: 9999;
      box-sizing: border-box;
    }
    .modal-card {
      background: var(--card-bg);
      border: 1.5px solid var(--accent);
      border-radius: 8px;
      padding: 14px;
      width: 100%;
      box-sizing: border-box;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    }
    .modal-title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .provider-card-sm {
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 8px 10px;
      margin-top: 8px;
      background: rgba(255, 255, 255, 0.02);
    }
    .provider-card-sm:hover {
      border-color: var(--accent);
    }
    .provider-row-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
  </style>
</head>
<body>

  <!-- TOP SECTION: CONTEXTARMOR CORE SECURITY -->
  <div>
    <div class="score-card" onclick="openDashboard()" title="Click to view full Security Dashboard">
      <div>
        <div class="score-title">Project Safety</div>
        <div style="font-size: 11px; color: ${scoreColor}; font-weight: 600;">Status: ${scoreLabel}</div>
      </div>
      <div class="score-val" style="color: ${scoreColor};">${score} / 100</div>
    </div>

    <!-- MAIN PROJECT AUDIT BUTTON -->
    <button class="btn-audit" ${this._isScanning ? 'disabled' : ''} onclick="auditWorkspace()" title="Fast static audit of manifests, hallucinations & code">
      <div class="btn-content">
        <span style="font-size: 18px;">🛡️</span>
        <div>
          <div class="btn-title">Run Project Audit</div>
          <div class="btn-desc">Manifests • Hallucinations • Deserialization</div>
        </div>
      </div>
      <span class="badge-pill">FAST</span>
    </button>

    <div class="util-row">
      <button class="btn-util" onclick="openDashboard()" title="Open comprehensive visual Security Dashboard">
        📊 Dashboard
      </button>
      <button class="btn-util" onclick="runDoctor()" title="Inspect hooks & system health">
        🩺 System Health
      </button>
    </div>
  </div>

  <!-- MIDDLE SECTION: ACTIVE THREAT RADAR -->
  <div class="threat-section">
    <div class="section-hdr">
      <span>Threat Radar</span>
      <span style="color: var(--muted); font-size: 10px;">${this._threats.length} Active</span>
    </div>
    ${contentHtml}
  </div>

  <!-- BOTTOM SECTION: STRIX PENTEST FLAGSHIP STATION (MAIN MODULE AT BOTTOM) -->
  <div class="strix-bottom-station">
    <span class="station-badge">FLAGSHIP OFFENSIVE MODULE</span>
    <div class="station-title">🦅 Strix Autonomous Pentest</div>
    <div class="station-desc">
      Simulates real cyber attacks in an isolated sandbox. Probes SQLi, command injection & deserialization.
    </div>

    <!-- ACTIVE AI BRAIN STRIP -->
    <div class="brain-strip" onclick="openModal()" title="Click to configure or switch AI Brain">
      <div class="brain-left">
        <span class="brain-dot ${llm.isConfigured ? 'active' : ''}"></span>
        <span style="font-size: 11px; font-weight: 600;">Brain:</span>
        <span style="font-size: 11px; color: ${llm.isConfigured ? '#4caf50' : '#ff9800'}; font-weight: 700;">
          ${activeProviderName}
        </span>
      </div>
      <span style="font-size: 10px; color: var(--muted);">${llm.isConfigured ? '⚙️ Switch' : '🔑 Connect'}</span>
    </div>

    <!-- MAIN PENTEST BUTTON -->
    <button class="btn-pentest" ${this._isScanning ? 'disabled' : ''} onclick="runPentest()" title="Run autonomous deep AI pentest">
      <div class="btn-content">
        <span style="font-size: 18px;">🦅</span>
        <div>
          <div class="btn-title">Run Deep AI Pentest</div>
          <div class="btn-desc">Simulate exploit PoCs in sandbox</div>
        </div>
      </div>
      <span class="badge-pill" style="background: rgba(255,255,255,0.25);">STRIX</span>
    </button>

    <!-- LIVE PROGRESS BAR WHEN SCANNING -->
    ${
      this._isScanning
        ? `
      <div class="progress-box">
        <div class="progress-header">
          <span style="color: #ff5252;">● ${this._statusMessage || 'Executing pentest...'}</span>
          <span>${this._scanPercent}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${Math.max(5, this._scanPercent)}%;"></div>
        </div>
        ${this._scanLogLine ? `<div class="telemetry-mini">${this._scanLogLine.slice(0, 100)}</div>` : ''}
      </div>
    `
        : ''
    }
  </div>

  <!-- IN-WEBVIEW MODAL DIALOG (REPLACES TOP SEARCH BAR POP-UP) -->
  <div class="modal-overlay" id="sidebarModal">
    <div class="modal-card">
      <div class="modal-title-row">
        <strong style="font-size: 13px;">⚙️ Select AI Brain Provider</strong>
        <button style="background: none; border: none; color: #aaa; cursor: pointer; font-size: 16px;" onclick="closeModal()">✕</button>
      </div>
      <div style="font-size: 10px; color: var(--muted); margin-bottom: 6px;">
        Choose the model that drives autonomous exploit testing:
      </div>

      <!-- CHATGPT OAUTH -->
      <div class="provider-card-sm">
        <div class="provider-row-top">
          <strong style="font-size: 11px;">🌐 ChatGPT Subscription</strong>
          <span style="font-size: 9px; color: #4caf50; font-weight: 700;">LUNA 6 · $0</span>
        </div>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 4px;">
          1-click sign-in via browser on your existing plan.
        </div>
        <button style="width: 100%; background: #10a37f; color: #fff; border: none; padding: 6px; border-radius: 4px; font-size: 11px; font-weight: 700; cursor: pointer;" onclick="startOauth()">
          Sign In with OpenAI (OAuth)
        </button>
      </div>

      <!-- GOOGLE GEMINI -->
      <div class="provider-card-sm">
        <div class="provider-row-top">
          <strong style="font-size: 11px;">✨ Google Gemini</strong>
          <span style="font-size: 9px; color: var(--muted);">gemini-3.7-flash</span>
        </div>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 4px;">
          Free tier API key from aistudio.google.com
        </div>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideGemini" placeholder="Paste Gemini Key..." style="flex: 1; background: var(--bg); border: 1px solid var(--border); color: #fff; padding: 4px 6px; font-size: 10px; border-radius: 3px; outline: none;">
          <button style="background: var(--vscode-button-background); color: #fff; border: none; padding: 4px 8px; border-radius: 3px; font-size: 10px; font-weight: 600; cursor: pointer;" onclick="saveKey('gemini', 'sideGemini')">Save</button>
        </div>
      </div>

      <!-- OPENAI API KEY -->
      <div class="provider-card-sm">
        <div class="provider-row-top">
          <strong style="font-size: 11px;">🤖 OpenAI (API Key)</strong>
          <span style="font-size: 9px; color: var(--muted);">gpt-5.6-luna</span>
        </div>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideOpenai" placeholder="Paste OpenAI Key (sk-...)" style="flex: 1; background: var(--bg); border: 1px solid var(--border); color: #fff; padding: 4px 6px; font-size: 10px; border-radius: 3px; outline: none;">
          <button style="background: var(--vscode-button-background); color: #fff; border: none; padding: 4px 8px; border-radius: 3px; font-size: 10px; font-weight: 600; cursor: pointer;" onclick="saveKey('openai', 'sideOpenai')">Save</button>
        </div>
      </div>

      <!-- ANTHROPIC CLAUDE -->
      <div class="provider-card-sm">
        <div class="provider-row-top">
          <strong style="font-size: 11px;">🛡️ Anthropic Claude</strong>
          <span style="font-size: 9px; color: var(--muted);">claude-sonnet-5</span>
        </div>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideClaude" placeholder="Paste Claude Key (sk-ant-...)" style="flex: 1; background: var(--bg); border: 1px solid var(--border); color: #fff; padding: 4px 6px; font-size: 10px; border-radius: 3px; outline: none;">
          <button style="background: var(--vscode-button-background); color: #fff; border: none; padding: 4px 8px; border-radius: 3px; font-size: 10px; font-weight: 600; cursor: pointer;" onclick="saveKey('anthropic', 'sideClaude')">Save</button>
        </div>
      </div>

      <!-- OFFLINE SANDBOX -->
      <div class="provider-card-sm">
        <strong style="font-size: 11px;">⚡ Built-in Offline Sandbox</strong>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 4px;">
          AST taint analysis without external keys or network.
        </div>
        <button style="width: 100%; background: var(--vscode-button-secondaryBackground); color: #fff; border: 1px solid var(--border); padding: 5px; border-radius: 4px; font-size: 10px; font-weight: 600; cursor: pointer;" onclick="saveKey('sandbox', '')">
          Select 100% Offline Mode
        </button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function auditWorkspace() {
      vscode.postMessage({ command: 'auditWorkspace' });
    }
    function runPentest() {
      vscode.postMessage({ command: 'runStrix' });
    }
    function openModal() {
      document.getElementById('sidebarModal').style.display = 'flex';
    }
    function closeModal() {
      document.getElementById('sidebarModal').style.display = 'none';
    }
    function startOauth() {
      closeModal();
      vscode.postMessage({ command: 'startOauthLogin' });
    }
    function saveKey(provider, inputId) {
      const key = inputId ? document.getElementById(inputId).value : '';
      if (inputId && (!key || key.trim().length < 8)) {
        alert('Please paste a valid API key.');
        return;
      }
      closeModal();
      vscode.postMessage({ command: 'saveApiKey', provider: provider, key: key });
    }
    function openDashboard() {
      vscode.postMessage({ command: 'openDashboard' });
    }
    function runDoctor() {
      vscode.postMessage({ command: 'runDoctor' });
    }
    function remove(file, line) {
      vscode.postMessage({ command: 'removeDep', file, line });
    }
    function pin(file, line, pin) {
      vscode.postMessage({ command: 'pinDep', file, line, pin });
    }
    function fixTorch(file, line) {
      vscode.postMessage({ command: 'fixTorch', file, line });
    }
  </script>
</body>
</html>`;
  }
}
