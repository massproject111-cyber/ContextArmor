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

  public updateProgress(percent: number, stage: string) {
    this._isScanning = true;
    this._scanPercent = percent;
    this._statusMessage = stage;
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview();
    }
  }

  public update(threats: ThreatItem[]) {
    this._threats = threats;
    this._isScanning = false;
    this._scanPercent = 100;
    this._statusMessage = undefined;
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
    const brainText = llm.isConfigured ? `🤖 ${llm.provider}` : '🔑 Connect AI Key';

    let contentHtml = '';

    if (this._isScanning) {
      contentHtml = `
        <div style="padding: 16px 12px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; margin-top: 12px; background: var(--vscode-editorWidget-background);">
          <div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: 600; margin-bottom: 8px;">
            <span style="color: #e53935;">● ${this._statusMessage || 'Running test...'}</span>
            <span>${this._scanPercent}%</span>
          </div>
          <div style="background: rgba(255, 255, 255, 0.1); border-radius: 6px; height: 8px; overflow: hidden;">
            <div style="background: linear-gradient(90deg, #e53935 0%, #8e24aa 50%, #00e676 100%); height: 100%; width: ${Math.max(5, this._scanPercent)}%; transition: width 0.3s ease;"></div>
          </div>
        </div>
      `;
    } else if (this._threats.length === 0) {
      contentHtml = `
        <div style="padding: 24px 12px; text-align: center; border: 1px dashed var(--vscode-editorWidget-border); border-radius: 8px; margin-top: 12px;">
          <div style="font-size: 24px; margin-bottom: 6px;">🛡️</div>
          <div style="font-weight: 600; font-size: 13px; color: #4caf50;">All Dependencies Clean</div>
          <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px;">
            No malicious advisories, unregistered hallucinations, or code risks detected.
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
            <div style="background: var(--vscode-editorWidget-background); border: 1px solid ${
              isCrit ? '#f4433644' : '#ff980044'
            }; border-radius: 6px; padding: 10px; margin-top: 8px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <span style="font-weight: 600; font-size: 12px; font-family: monospace;">${t.title}</span>
                <div style="display: flex; gap: 4px;">
                  <span style="background: var(--vscode-badge-background, #333); color: var(--vscode-badge-foreground, #ccc); padding: 1px 4px; border-radius: 3px; font-size: 9px; font-weight: 600;">
                    ${tag}
                  </span>
                  <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 1px 5px; border-radius: 4px; font-weight: bold; font-size: 10px;">
                    ${badgeText}
                  </span>
                </div>
              </div>
              <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; line-height: 1.4;">
                ${t.desc}
              </div>
              <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                ${
                  pin
                    ? `<button onclick="pin('${t.file}', ${t.line}, '${pin}')" style="background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">
                        💡 Pin to ${pin}
                      </button>`
                    : t.desc.includes('weights_only')
                    ? `<button onclick="fixTorch('${t.file}', ${t.line})" style="background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">
                        💡 Add weights_only=True
                      </button>`
                    : ''
                }
                ${
                  t.file && t.line !== undefined
                    ? `<button onclick="remove('${t.file}', ${t.line})" style="background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); border: none; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">
                        🗑️ Remove Line
                      </button>`
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
    body {
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      padding: 12px;
      margin: 0;
      color: var(--vscode-foreground);
      background: transparent;
      box-sizing: border-box;
    }
    .score-card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      padding: 10px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      cursor: pointer;
    }
    .score-card:hover {
      border-color: var(--vscode-focusBorder);
    }
    .score-title {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .score-val {
      font-size: 18px;
      font-weight: 700;
    }
    .deck-section {
      margin-top: 14px;
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .action-btn {
      width: 100%;
      border-radius: 6px;
      padding: 10px 12px;
      cursor: pointer;
      text-align: left;
      transition: all 0.15s ease-in-out;
      border: 1px solid transparent;
      box-sizing: border-box;
    }
    .action-btn:hover {
      filter: brightness(1.1);
      transform: translateY(-1px);
    }
    .action-btn:active {
      transform: translateY(0);
    }
    .action-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
      filter: none;
    }
    .btn-pentest-hero {
      background: linear-gradient(135deg, #b71c1c 0%, #4a148c 100%);
      color: #ffffff;
      border-color: rgba(255, 120, 120, 0.35);
      box-shadow: 0 4px 12px rgba(183, 28, 28, 0.35);
    }
    .btn-audit-hero {
      background: linear-gradient(135deg, #0277bd 0%, #0d47a1 100%);
      color: #ffffff;
      border-color: rgba(120, 180, 255, 0.35);
      box-shadow: 0 3px 8px rgba(2, 119, 189, 0.25);
    }
    .action-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 3px;
    }
    .action-heading {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.3px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .action-tag {
      font-size: 9px;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.2);
      letter-spacing: 0.5px;
    }
    .action-sub {
      font-size: 10px;
      opacity: 0.85;
      line-height: 1.3;
    }
    .brain-strip {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #3c3c3c);
      border-radius: 5px;
      padding: 6px 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      font-size: 11px;
      transition: border-color 0.15s;
    }
    .brain-strip:hover {
      border-color: var(--vscode-focusBorder, #007acc);
    }
    .brain-pill {
      font-weight: 600;
      color: ${llm.isConfigured ? '#4caf50' : '#ff9800'};
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .btn-row {
      display: flex;
      gap: 6px;
      margin-top: 4px;
    }
    .btn-secondary {
      flex: 1;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: 1px solid var(--vscode-editorWidget-border, #444);
      padding: 7px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      text-align: center;
      font-weight: 600;
      transition: background 0.15s;
    }
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    /* Modal for Sidebar */
    .sidebar-modal {
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
    }
    .sidebar-modal-card {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-focusBorder, #007acc);
      border-radius: 8px;
      padding: 14px;
      width: 100%;
      box-sizing: border-box;
      max-height: 90vh;
      overflow-y: auto;
    }
    .provider-card-sm {
      border: 1px solid var(--vscode-editorWidget-border, #3c3c3c);
      border-radius: 5px;
      padding: 8px 10px;
      margin-top: 8px;
    }
    .provider-card-sm:hover {
      border-color: var(--vscode-focusBorder, #007acc);
    }
  </style>
</head>
<body>
  <div class="score-card" onclick="openDashboard()" title="Click to view full Security Dashboard">
    <div>
      <div class="score-title">Project Safety</div>
      <div style="font-size: 11px; color: var(--vscode-descriptionForeground); font-weight: 500;">Status: ${scoreLabel}</div>
    </div>
    <div class="score-val" style="color: ${scoreColor};">${score} / 100</div>
  </div>

  <div class="deck-section">
    <!-- STRIX DEEP PENTEST MODULE (HERO) -->
    <button class="action-btn btn-pentest-hero" ${this._isScanning ? 'disabled' : ''} onclick="runStrix()" title="Run autonomous deep AI pentest (Strix or Sandbox AST/SARIF)">
      <div class="action-top">
        <span class="action-heading">🦅 Run Deep AI Pentest</span>
        <span class="action-tag">STRIX AI</span>
      </div>
      <div class="action-sub">Autonomous exploit PoCs • Sandbox AST • SARIF 2.1</div>
    </button>

    <!-- AI ENGINE STATUS STRIP -->
    <div class="brain-strip" onclick="openModal()" title="Click to configure AI Provider directly">
      <div class="brain-pill">
        <span>⚡ Brain:</span>
        <span>${llm.isConfigured ? llm.provider : 'Not Configured'}</span>
      </div>
      <span style="font-size: 10px; color: var(--vscode-descriptionForeground);">${llm.isConfigured ? '⚙️ Change' : '🔑 Connect'}</span>
    </div>

    <!-- FULL WORKSPACE PROJECT AUDIT -->
    <button class="action-btn btn-audit-hero" ${this._isScanning ? 'disabled' : ''} onclick="auditWorkspace()" title="Audit all package manifests, AI hallucinations & deserialization">
      <div class="action-top">
        <span class="action-heading">🛡️ Run Full Project Audit</span>
        <span class="action-tag">FAST AUDIT</span>
      </div>
      <div class="action-sub">Manifests • Hallucinations • Deserialization • MCP</div>
    </button>

    <div class="btn-row">
      <button class="btn-secondary" onclick="openDashboard()" title="Open comprehensive visual Security Dashboard">
        📊 Dashboard
      </button>
      <button class="btn-secondary" onclick="runDoctor()" title="Inspect hooks & system health">
        🩺 System Health
      </button>
    </div>
  </div>

  <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px; margin-bottom: 4px;">
    <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--vscode-descriptionForeground); letter-spacing: 0.5px;">
      Active Threat Radar
    </span>
    <span style="font-size: 10px; color: var(--vscode-descriptionForeground);">
      ${this._threats.length} Active Findings
    </span>
  </div>

  ${contentHtml}

  <!-- IN-WEBVIEW MODAL FOR SIDEBAR -->
  <div class="sidebar-modal" id="sidebarModal">
    <div class="sidebar-modal-card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <strong style="font-size: 13px;">⚙️ Connect AI Brain</strong>
        <button style="background: none; border: none; color: #aaa; cursor: pointer; font-size: 14px;" onclick="closeModal()">✕</button>
      </div>

      <div class="provider-card-sm">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <strong style="font-size: 11px;">🌐 ChatGPT Subscription</strong>
          <span style="font-size: 9px; color: #4caf50;">Luna 6 · $0</span>
        </div>
        <button style="width: 100%; background: #10a37f; color: #fff; border: none; padding: 6px; border-radius: 4px; font-size: 11px; cursor: pointer; margin-top: 4px;" onclick="startOauth()">
          Sign In with OpenAI (OAuth)
        </button>
      </div>

      <div class="provider-card-sm">
        <div style="font-size: 11px; font-weight: bold; margin-bottom: 4px;">✨ Google Gemini</div>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideGemini" placeholder="Gemini API Key..." style="flex: 1; background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); color: #fff; padding: 4px; font-size: 10px; border-radius: 3px;">
          <button style="background: var(--vscode-button-background); color: #fff; border: none; padding: 4px 8px; border-radius: 3px; font-size: 10px; cursor: pointer;" onclick="saveKey('gemini', 'sideGemini')">Save</button>
        </div>
      </div>

      <div class="provider-card-sm">
        <div style="font-size: 11px; font-weight: bold; margin-bottom: 4px;">🤖 OpenAI (API Key)</div>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideOpenai" placeholder="OpenAI Key (sk-...)" style="flex: 1; background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); color: #fff; padding: 4px; font-size: 10px; border-radius: 3px;">
          <button style="background: var(--vscode-button-background); color: #fff; border: none; padding: 4px 8px; border-radius: 3px; font-size: 10px; cursor: pointer;" onclick="saveKey('openai', 'sideOpenai')">Save</button>
        </div>
      </div>

      <div class="provider-card-sm">
        <div style="font-size: 11px; font-weight: bold; margin-bottom: 4px;">🛡️ Anthropic Claude</div>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideClaude" placeholder="Claude Key (sk-ant-...)" style="flex: 1; background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); color: #fff; padding: 4px; font-size: 10px; border-radius: 3px;">
          <button style="background: var(--vscode-button-background); color: #fff; border: none; padding: 4px 8px; border-radius: 3px; font-size: 10px; cursor: pointer;" onclick="saveKey('anthropic', 'sideClaude')">Save</button>
        </div>
      </div>

      <div class="provider-card-sm">
        <div style="font-size: 11px; font-weight: bold; margin-bottom: 2px;">⚡ Built-in Offline Sandbox</div>
        <button style="width: 100%; background: var(--vscode-button-secondaryBackground); color: #fff; border: 1px solid var(--vscode-editorWidget-border); padding: 5px; border-radius: 4px; font-size: 10px; cursor: pointer; margin-top: 4px;" onclick="saveKey('sandbox', '')">
          Select Offline Sandbox
        </button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function auditWorkspace() {
      vscode.postMessage({ command: 'auditWorkspace' });
    }
    function runStrix() {
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
