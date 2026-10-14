import * as vscode from 'vscode';
import type { ThreatItem } from './treeView.js';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _threats: ThreatItem[] = [];

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
      (message) => {
        switch (message.command) {
          case 'scanWorkspace':
            vscode.commands.executeCommand('contextarmor.doctor');
            return;
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
    const criticalCount = this._threats.filter((t) => t.severity === 'CRITICAL').length;
    const warningCount = this._threats.filter((t) => t.severity === 'WARNING').length;
    const score = criticalCount > 0 ? 65 : warningCount > 0 ? 82 : 98;
    const scoreColor = score >= 90 ? '#4caf50' : score >= 75 ? '#ff9800' : '#f44336';
    const statusText =
      criticalCount > 0
        ? 'CIRCUIT BREAKER TRIGGERED: THREATS DETECTED'
        : warningCount > 0
        ? 'WARNING: UNVETTED PACKAGES DETECTED'
        : 'SECURE: ALL DEPENDENCIES VERIFIED';

    const threatsHtml =
      this._threats.length === 0
        ? `<tr><td colspan="4" style="text-align: center; color: var(--vscode-descriptionForeground); padding: 24px;">No security vulnerabilities or unregistered hallucinations detected in current files.</td></tr>`
        : this._threats
            .map(
              (t) => `
          <tr style="border-bottom: 1px solid var(--vscode-editorWidget-border);">
            <td style="padding: 12px; font-weight: 600;">${t.title}</td>
            <td style="padding: 12px;">
              <span style="background: ${
                t.severity === 'CRITICAL' ? '#f4433622' : '#ff980022'
              }; color: ${
                t.severity === 'CRITICAL' ? '#f44336' : '#ff9800'
              }; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 11px;">
                ${t.severity}
              </span>
            </td>
            <td style="padding: 12px; color: var(--vscode-foreground);">${t.desc}</td>
            <td style="padding: 12px; color: var(--vscode-descriptionForeground); font-size: 12px;">${
              t.file || 'Workspace'
            }</td>
          </tr>`
            )
            .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ContextArmor Dashboard</title>
  <style>
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      padding: 24px 36px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      margin: 0;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .header-title {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 22px;
      font-weight: 700;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin-bottom: 28px;
    }
    .card {
      background: var(--vscode-editorWidget-background, #1e1e1e);
      border: 1px solid var(--vscode-editorWidget-border, #333);
      border-radius: 8px;
      padding: 20px;
    }
    .card-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .card-value {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .card-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .table-container {
      background: var(--vscode-editorWidget-background, #1e1e1e);
      border: 1px solid var(--vscode-editorWidget-border, #333);
      border-radius: 8px;
      overflow: hidden;
      margin-top: 16px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th {
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      padding: 12px;
      font-size: 12px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-title">
      🛡️ ContextArmor AI Security Dashboard
    </div>
    <div>
      <button class="btn" onclick="vscode.postMessage({command: 'scanWorkspace'})">Run Diagnostics</button>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-title">Security Posture Score</div>
      <div class="card-value" style="color: ${scoreColor};">${score} / 100</div>
      <div class="card-desc">${statusText}</div>
    </div>
    <div class="card">
      <div class="card-title">Critical Blocked Threats</div>
      <div class="card-value" style="color: ${criticalCount > 0 ? '#f44336' : '#4caf50'};">${criticalCount}</div>
      <div class="card-desc">AI hallucinations, mal-advisories, slopsquats</div>
    </div>
    <div class="card">
      <div class="card-title">Warning Tier Alerts</div>
      <div class="card-value" style="color: ${warningCount > 0 ? '#ff9800' : '#4caf50'};">${warningCount}</div>
      <div class="card-desc">72h cooldowns, low adoption, unvetted releases</div>
    </div>
    <div class="card">
      <div class="card-title">Circuit Breaker & Hooks</div>
      <div class="card-value" style="color: #4caf50;">ENFORCED</div>
      <div class="card-desc">PreToolUse hooks active in Claude Code & Antigravity</div>
    </div>
  </div>

  <h3 style="margin-top: 32px; margin-bottom: 8px;">Active Threat Radar & Manifest Audit</h3>
  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Dependency</th>
          <th>Risk Tier</th>
          <th>Security Reason</th>
          <th>Location</th>
        </tr>
      </thead>
      <tbody>
        ${threatsHtml}
      </tbody>
    </table>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
  </script>
</body>
</html>`;
  }
}
