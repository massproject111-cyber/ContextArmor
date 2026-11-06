import * as vscode from 'vscode';
import type { ThreatItem } from './treeView.js';

export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'contextarmorSidebarView';
  private _view?: vscode.WebviewView;
  private _threats: ThreatItem[] = [];
  private _isScanning: boolean = false;
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
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview();
    }
  }

  public update(threats: ThreatItem[]) {
    this._threats = threats;
    this._isScanning = false;
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

    let contentHtml = '';

    if (this._isScanning) {
      contentHtml = `
        <div style="padding: 20px 12px; text-align: center; border: 1px dashed var(--vscode-editorWidget-border); border-radius: 8px; margin-top: 12px; background: var(--vscode-editorWidget-background);">
          <div class="spinner" style="margin: 0 auto 10px auto;"></div>
          <div style="font-weight: 600; font-size: 13px; color: var(--vscode-focusBorder, #007acc);">Auditing Workspace...</div>
          <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px;">
            ${this._statusMessage || 'Checking dependencies, code deserialization & security risks...'}
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

          // Extract suggested pin if available
          const pinMatch =
            t.desc.match(/Suggested pin:\s*['"`](?:npm\s+i\s+[^@]+@|pip\s+install\s+[^=]+=+|uv\s+add\s+[^=]+=*)([^'"`\s]+)['"`]/i) ||
            t.desc.match(/Newest version older than 72h:\s*['"`]([^'"`]+)['"`]/i);
          const pin = pinMatch ? pinMatch[1] : undefined;

          // Determine category tag
          let tag = 'DEP';
          if (t.title.startsWith('[Strix')) tag = 'STRIX';
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
    .btn-primary {
      width: 100%;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      padding: 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 14px;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 6px;
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .btn-row {
      display: flex;
      gap: 6px;
      margin-top: 6px;
    }
    .btn-secondary {
      flex: 1;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: none;
      padding: 6px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      text-align: center;
    }
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    .spinner {
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-top: 2px solid var(--vscode-focusBorder, #007acc);
      border-radius: 50%;
      width: 18px;
      height: 18px;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="score-card" onclick="openDashboard()" title="Click to view full Security Dashboard">
    <div>
      <div class="score-title">Security Score</div>
      <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">${scoreLabel}</div>
    </div>
    <div class="score-val" style="color: ${scoreColor};">${score} / 100</div>
  </div>

  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
    <span style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--vscode-descriptionForeground);">
      Active Threat Radar
    </span>
    <span style="font-size: 10px; color: var(--vscode-descriptionForeground); cursor: pointer;" onclick="openDashboard()">
      📊 Full Dashboard
    </span>
  </div>

  ${contentHtml}

  <button class="btn-primary" ${this._isScanning ? 'disabled' : ''} onclick="auditWorkspace()">
    🛡️ Run Full Project Audit
  </button>

  <div class="btn-row">
    <button class="btn-secondary" onclick="runStrix()" title="Run autonomous AI pentesting on workspace">
      🦅 Strix Pentest
    </button>
    <button class="btn-secondary" onclick="runDoctor()" title="Inspect hooks & tamper protection">
      🩺 Doctor
    </button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function auditWorkspace() {
      vscode.postMessage({ command: 'auditWorkspace' });
    }
    function runStrix() {
      vscode.postMessage({ command: 'runStrix' });
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
