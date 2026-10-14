import * as vscode from 'vscode';
import type { ThreatItem } from './treeView.js';

export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'contextarmorSidebarView';
  private _view?: vscode.WebviewView;
  private _threats: ThreatItem[] = [];

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
        case 'runDoctor': {
          vscode.commands.executeCommand('contextarmor.doctor');
          break;
        }
      }
    });
  }

  public update(threats: ThreatItem[]) {
    this._threats = threats;
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

    if (this._threats.length === 0) {
      contentHtml = `
        <div style="padding: 24px 12px; text-align: center; border: 1px dashed var(--vscode-editorWidget-border); border-radius: 8px; margin-top: 12px;">
          <div style="font-size: 24px; margin-bottom: 6px;">🛡️</div>
          <div style="font-weight: 600; font-size: 13px; color: #4caf50;">All Dependencies Clean</div>
          <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px;">
            No malicious advisories or unregistered hallucinations detected.
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
          const pinMatch = t.desc.match(/Suggested pin:\s*['"`](?:npm\s+i\s+[^@]+@|pip\s+install\s+[^=]+=+|uv\s+add\s+[^=]+=*)([^'"`\s]+)['"`]/i)
            || t.desc.match(/Newest version older than 72h:\s*['"`]([^'"`]+)['"`]/i);
          const pin = pinMatch ? pinMatch[1] : undefined;

          return `
            <div style="background: var(--vscode-editorWidget-background); border: 1px solid ${
              isCrit ? '#f4433644' : '#ff980044'
            }; border-radius: 6px; padding: 10px; margin-top: 8px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <span style="font-weight: 600; font-size: 12px; font-family: monospace;">${t.title}</span>
                <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 10px;">
                  ${badgeText}
                </span>
              </div>
              <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; line-height: 1.4;">
                ${t.desc}
              </div>
              <div style="display: flex; gap: 6px;">
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
                <button onclick="remove('${t.file}', ${t.line})" style="background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); border: none; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">
                  🗑️ Remove Line
                </button>
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
    .btn-audit {
      width: 100%;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: none;
      padding: 6px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      margin-top: 14px;
    }
    .btn-audit:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="score-card">
    <div>
      <div class="score-title">Security Score</div>
      <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">${scoreLabel}</div>
    </div>
    <div class="score-val" style="color: ${scoreColor};">${score} / 100</div>
  </div>

  <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin-bottom: 4px;">
    Active Threat Radar
  </div>

  ${contentHtml}

  <button class="btn-audit" onclick="runDoctor()">Run Diagnostics Audit</button>

  <script>
    const vscode = acquireVsCodeApi();
    function remove(file, line) {
      vscode.postMessage({ command: 'removeDep', file, line });
    }
    function pin(file, line, pin) {
      vscode.postMessage({ command: 'pinDep', file, line, pin });
    }
    function fixTorch(file, line) {
      vscode.postMessage({ command: 'fixTorch', file, line });
    }
    function runDoctor() {
      vscode.postMessage({ command: 'runDoctor' });
    }
  </script>
</body>
</html>`;
  }
}
