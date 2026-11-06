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
    const totalIssues = this._threats.length;

    let statusTitle = 'Your Project is Safe';
    let statusColor = '#4caf50';
    let statusDesc = 'All dependencies and code files are verified safe.';
    let statusIcon = '🛡️';
    let statusBadge = 'PROTECTED';

    if (criticalCount > 0) {
      statusTitle = `${criticalCount} Security Risk${criticalCount > 1 ? 's' : ''} Found`;
      statusColor = '#f44336';
      statusDesc = 'Dangerous packages or vulnerabilities require immediate attention.';
      statusIcon = '🚨';
      statusBadge = 'ACTION NEEDED';
    } else if (warningCount > 0) {
      statusTitle = `${warningCount} Item${warningCount > 1 ? 's' : ''} to Review`;
      statusColor = '#ff9800';
      statusDesc = 'Newly published or unverified packages detected.';
      statusIcon = '⚠️';
      statusBadge = 'REVIEW';
    }

    const llm = getLlmConfig();
    let activeProviderName = 'Not Connected';
    if (llm.isConfigured) {
      if (llm.provider === 'ChatGPT (OAuth)') activeProviderName = 'ChatGPT (Luna 6)';
      else if (llm.provider === 'Google Gemini') activeProviderName = 'Google Gemini';
      else if (llm.provider === 'Anthropic Claude') activeProviderName = 'Anthropic Claude';
      else if (llm.provider === 'OpenAI') activeProviderName = 'OpenAI';
      else if (llm.provider === 'Built-in Sandbox') activeProviderName = 'Offline Mode';
      else activeProviderName = llm.provider || 'Active AI';
    }

    let contentHtml = '';

    if (totalIssues === 0) {
      contentHtml = `
        <div class="empty-state">
          <div style="font-size: 24px; margin-bottom: 6px;">✨</div>
          <div style="font-weight: 700; font-size: 13px; color: #4caf50;">Everything Looks Great</div>
          <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; line-height: 1.4;">
            No fake packages, malicious dependencies, or code vulnerabilities detected.
          </div>
        </div>
      `;
    } else {
      contentHtml = this._threats
        .map((t) => {
          const isCrit = t.severity === 'CRITICAL';
          const badgeBg = isCrit ? '#f4433622' : '#ff980022';
          const badgeColor = isCrit ? '#f44336' : '#ff9800';
          const badgeText = isCrit ? 'High Risk' : 'Review';

          const pinMatch =
            t.desc.match(/Suggested pin:\s*['"`](?:npm\s+i\s+[^@]+@|pip\s+install\s+[^=]+=+|uv\s+add\s+[^=]+=*)([^'"`\s]+)['"`]/i) ||
            t.desc.match(/Newest version older than 72h:\s*['"`]([^'"`]+)['"`]/i);
          const pin = pinMatch ? pinMatch[1] : undefined;

          let categoryLabel = 'Package';
          if (t.title.includes('Pentest') || t.desc.includes('pentest')) categoryLabel = 'Security Finding';
          else if (t.title.startsWith('[MCP')) categoryLabel = 'MCP Server';
          else if (t.title.includes('torch.load') || t.file?.endsWith('.py')) categoryLabel = 'Python Code';

          // Make description simple and readable for non-experts
          let humanDesc = t.desc
            .replace(/Suggested pin:\s*['"`][^'"`]+['"`]/i, '')
            .replace(/Package is younger than 72h\./i, 'Published less than 72 hours ago. Unverified packages can be risky.')
            .replace(/Blocked by ContextArmor circuit breaker\./i, 'Blocked to prevent potential malware execution.')
            .trim();

          return `
            <div class="threat-card" style="border-left: 3px solid ${badgeColor};">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; gap: 4px;">
                <span style="font-weight: 700; font-size: 12px; font-family: monospace; word-break: break-all;">${t.title}</span>
                <div style="display: flex; gap: 4px; flex-shrink: 0;">
                  <span style="background: var(--vscode-badge-background, #333); color: var(--vscode-badge-foreground, #ccc); padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 700;">
                    ${categoryLabel}
                  </span>
                  <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 1px 5px; border-radius: 3px; font-weight: 700; font-size: 9px;">
                    ${badgeText}
                  </span>
                </div>
              </div>
              <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; line-height: 1.4;">
                ${humanDesc}
              </div>
              <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                ${
                  pin
                    ? `<button class="action-mini btn-fix" onclick="pin('${t.file}', ${t.line}, '${pin}')">✨ Auto-Fix to ${pin}</button>`
                    : t.desc.includes('weights_only')
                    ? `<button class="action-mini btn-fix" onclick="fixTorch('${t.file}', ${t.line})">✨ Safe Load Fix</button>`
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
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      padding: 10px;
      margin: 0;
      color: var(--text);
      background: transparent;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    /* TOP STATUS HERO BANNER */
    .hero-banner {
      background: var(--card-bg);
      border: 1.5px solid ${statusColor}44;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
    .hero-banner:hover {
      border-color: ${statusColor};
      transform: translateY(-1px);
    }
    .hero-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .hero-icon {
      font-size: 24px;
    }
    .hero-title {
      font-size: 13px;
      font-weight: 700;
      color: ${statusColor};
      letter-spacing: 0.2px;
    }
    .hero-desc {
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
    }
    .hero-badge {
      font-size: 9px;
      font-weight: 800;
      padding: 3px 6px;
      border-radius: 4px;
      background: ${statusColor}22;
      color: ${statusColor};
      letter-spacing: 0.5px;
    }

    /* QUICK SECURITY CHECK BUTTON */
    .btn-quick-scan {
      width: 100%;
      background: linear-gradient(135deg, #0288d1 0%, #0d47a1 100%);
      color: #fff;
      border: 1px solid rgba(120, 180, 255, 0.35);
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 6px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 8px rgba(2, 136, 209, 0.3);
      transition: all 0.15s ease;
      box-sizing: border-box;
    }
    .btn-quick-scan:hover {
      filter: brightness(1.1);
      transform: translateY(-1px);
    }
    .btn-quick-scan:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .btn-content {
      display: flex;
      align-items: center;
      gap: 10px;
      text-align: left;
    }
    .btn-title {
      font-size: 12px;
      font-weight: 700;
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
    }

    /* UTILITY NAVIGATION ROW */
    .util-row {
      display: flex;
      gap: 6px;
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
      transition: background 0.15s ease;
    }
    .btn-util:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    /* FINDINGS / THREAT RADAR LIST */
    .findings-section {
      flex: 1;
      margin-bottom: 14px;
    }
    .findings-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .threat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 8px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.1);
    }
    .action-mini {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: filter 0.15s;
    }
    .action-mini:hover {
      filter: brightness(1.15);
    }
    .btn-fix {
      background: var(--vscode-button-background, #0e639c);
      color: #fff;
    }
    .btn-del {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: #ccc;
    }

    /* EMPTY SAFE STATE */
    .empty-state {
      padding: 22px 14px;
      text-align: center;
      border: 1px dashed var(--vscode-editorWidget-border);
      border-radius: 8px;
      background: rgba(76, 175, 80, 0.04);
    }

    /* =========================================================
       DEEP AI SECURITY TEST (STRIX) ANCHORED AT BOTTOM
       ========================================================= */
    .deep-station {
      background: linear-gradient(180deg, rgba(30, 25, 35, 0.8) 0%, rgba(18, 18, 22, 0.98) 100%);
      border: 1.5px solid rgba(229, 57, 53, 0.45);
      border-radius: 8px;
      padding: 12px;
      margin-top: auto;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
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
      margin-bottom: 5px;
    }
    .station-title {
      font-size: 13px;
      font-weight: 700;
      color: #fff;
    }
    .station-desc {
      font-size: 11px;
      color: var(--muted);
      margin-top: 3px;
      line-height: 1.35;
      margin-bottom: 10px;
    }

    /* AI MODEL CHIP */
    .ai-chip {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 8px 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      font-size: 11px;
      margin-bottom: 10px;
      transition: all 0.15s ease;
    }
    .ai-chip:hover {
      border-color: var(--accent);
      background: rgba(255, 255, 255, 0.04);
    }
    .ai-chip-left {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #888;
    }
    .status-dot.active {
      background: #4caf50;
      box-shadow: 0 0 8px #4caf50;
    }

    /* MAIN RUN DEEP TEST BUTTON */
    .btn-deep-run {
      width: 100%;
      background: linear-gradient(135deg, #c62828 0%, #6a1b9a 100%);
      color: #fff;
      border: 1px solid rgba(255, 120, 120, 0.4);
      border-radius: 6px;
      padding: 11px 12px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 3px 10px rgba(198, 40, 40, 0.35);
      transition: all 0.15s ease;
      box-sizing: border-box;
    }
    .btn-deep-run:hover {
      filter: brightness(1.12);
      transform: translateY(-1px);
    }
    .btn-deep-run:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    /* LIVE PROGRESS INDICATOR */
    .progress-box {
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 10px;
      margin-top: 10px;
    }
    .progress-hdr {
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
    .telemetry-line {
      font-family: monospace;
      font-size: 10px;
      color: #98c379;
      margin-top: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* =========================================================
       IN-WEBVIEW MODAL DIALOG (REPLACES TOP SEARCH BAR POP-UP)
       ========================================================= */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.8);
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
    .modal-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .provider-card {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 9px 10px;
      margin-top: 8px;
      background: rgba(255, 255, 255, 0.02);
      transition: border-color 0.15s;
    }
    .provider-card:hover {
      border-color: var(--accent);
    }
    .provider-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 3px;
    }
  </style>
</head>
<body>

  <!-- TOP SECTION: OVERALL PROJECT SAFETY STATUS -->
  <div>
    <div class="hero-banner" onclick="openDashboard()" title="Click to view full Security Dashboard">
      <div class="hero-left">
        <span class="hero-icon">${statusIcon}</span>
        <div>
          <div class="hero-title">${statusTitle}</div>
          <div class="hero-desc">${statusDesc}</div>
        </div>
      </div>
      <span class="hero-badge">${statusBadge}</span>
    </div>

    <!-- MAIN QUICK SCAN BUTTON -->
    <button class="btn-quick-scan" ${this._isScanning ? 'disabled' : ''} onclick="auditWorkspace()" title="Fast 1-second check of dependencies and code">
      <div class="btn-content">
        <span style="font-size: 18px;">⚡</span>
        <div>
          <div class="btn-title">Quick Security Check</div>
          <div class="btn-desc">Instant 1-second check of packages & code</div>
        </div>
      </div>
      <span class="badge-pill">FAST</span>
    </button>

    <!-- NAVIGATION UTILITY BUTTONS -->
    <div class="util-row">
      <button class="btn-util" onclick="openDashboard()" title="Open comprehensive visual Security Dashboard">
        📊 Full Dashboard
      </button>
      <button class="btn-util" onclick="runDoctor()" title="Inspect system health & security status">
        🩺 System Health
      </button>
    </div>
  </div>

  <!-- MIDDLE SECTION: ACTIVE PROJECT FINDINGS -->
  <div class="findings-section">
    <div class="findings-header">
      <span>Project Findings</span>
      <span style="color: var(--muted); font-size: 10px;">${totalIssues} Detected</span>
    </div>
    ${contentHtml}
  </div>

  <!-- BOTTOM SECTION: DEEP AI SECURITY TEST (AUTONOMOUS PENTEST) -->
  <div class="deep-station">
    <span class="station-badge">DEEP AI SECURITY TEST</span>
    <div class="station-title">🤖 AI Vulnerability Simulation</div>
    <div class="station-desc">
      Simulates attack scenarios in an isolated sandbox to verify your code won't get exploited.
    </div>

    <!-- AI ENGINE CONNECTION CHIP -->
    <div class="ai-chip" onclick="openModal()" title="Click to connect or switch AI model">
      <div class="ai-chip-left">
        <span class="status-dot ${llm.isConfigured ? 'active' : ''}"></span>
        <span style="font-size: 11px; font-weight: 600;">AI Engine:</span>
        <span style="font-size: 11px; color: ${llm.isConfigured ? '#4caf50' : '#ff9800'}; font-weight: 700;">
          ${activeProviderName}
        </span>
      </div>
      <span style="font-size: 10px; color: var(--muted);">${llm.isConfigured ? 'Change ▾' : 'Connect ▾'}</span>
    </div>

    <!-- MAIN START DEEP TEST BUTTON -->
    <button class="btn-deep-run" ${this._isScanning ? 'disabled' : ''} onclick="runPentest()" title="Run autonomous deep AI security test">
      <div class="btn-content">
        <span style="font-size: 18px;">▶</span>
        <div>
          <div class="btn-title">Start Deep Security Test</div>
          <div class="btn-desc">Simulate exploit scenarios in sandbox</div>
        </div>
      </div>
      <span class="badge-pill" style="background: rgba(255,255,255,0.25);">AI AGENT</span>
    </button>

    <!-- LIVE PROGRESS BAR WHEN SCANNING -->
    ${
      this._isScanning
        ? `
      <div class="progress-box">
        <div class="progress-hdr">
          <span style="color: #64b5f6; font-weight: 600;">● ${this._statusMessage || 'Testing project security...'}</span>
          <span>${this._scanPercent}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${Math.max(8, this._scanPercent)}%;"></div>
        </div>
        ${this._scanLogLine ? `<div class="telemetry-line">${this._scanLogLine.slice(0, 95)}</div>` : ''}
      </div>
    `
        : ''
    }
  </div>

  <!-- IN-WEBVIEW MODAL (CLEAN CONSUMER-FRIENDLY AI SELECTOR) -->
  <div class="modal-overlay" id="sidebarModal">
    <div class="modal-card">
      <div class="modal-hdr">
        <strong style="font-size: 13px;">⚙️ Connect AI Assistant</strong>
        <button style="background: none; border: none; color: #aaa; cursor: pointer; font-size: 16px;" onclick="closeModal()">✕</button>
      </div>
      <div style="font-size: 11px; color: var(--muted); margin-bottom: 8px;">
        Choose which AI model powers your deep security testing:
      </div>

      <!-- CHATGPT OAUTH (RECOMMENDED) -->
      <div class="provider-card">
        <div class="provider-hdr">
          <strong style="font-size: 11px;">🌐 ChatGPT Subscription</strong>
          <span style="font-size: 9px; color: #4caf50; font-weight: 700;">LUNA 6 · $0</span>
        </div>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 5px;">
          1-click sign-in in your browser. Runs free on your existing plan.
        </div>
        <button style="width: 100%; background: #10a37f; color: #fff; border: none; padding: 7px; border-radius: 4px; font-size: 11px; font-weight: 700; cursor: pointer;" onclick="startOauth()">
          Sign In with OpenAI (OAuth)
        </button>
      </div>

      <!-- GOOGLE GEMINI -->
      <div class="provider-card">
        <div class="provider-hdr">
          <strong style="font-size: 11px;">✨ Google Gemini</strong>
          <span style="font-size: 9px; color: var(--muted);">gemini-3.7-flash</span>
        </div>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 5px;">
          Free tier API key from aistudio.google.com
        </div>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideGemini" placeholder="Paste Gemini Key..." style="flex: 1; background: var(--bg); border: 1px solid var(--border); color: #fff; padding: 5px 6px; font-size: 10px; border-radius: 3px; outline: none;">
          <button style="background: var(--vscode-button-background); color: #fff; border: none; padding: 5px 8px; border-radius: 3px; font-size: 10px; font-weight: 600; cursor: pointer;" onclick="saveKey('gemini', 'sideGemini')">Save</button>
        </div>
      </div>

      <!-- OPENAI API KEY -->
      <div class="provider-card">
        <div class="provider-hdr">
          <strong style="font-size: 11px;">🤖 OpenAI (API Key)</strong>
          <span style="font-size: 9px; color: var(--muted);">gpt-5.6-luna</span>
        </div>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 5px;">
          Direct API key from platform.openai.com
        </div>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideOpenai" placeholder="Paste OpenAI Key (sk-...)" style="flex: 1; background: var(--bg); border: 1px solid var(--border); color: #fff; padding: 5px 6px; font-size: 10px; border-radius: 3px; outline: none;">
          <button style="background: var(--vscode-button-background); color: #fff; border: none; padding: 5px 8px; border-radius: 3px; font-size: 10px; font-weight: 600; cursor: pointer;" onclick="saveKey('openai', 'sideOpenai')">Save</button>
        </div>
      </div>

      <!-- ANTHROPIC CLAUDE -->
      <div class="provider-card">
        <div class="provider-hdr">
          <strong style="font-size: 11px;">🛡️ Anthropic Claude</strong>
          <span style="font-size: 9px; color: var(--muted);">claude-sonnet-5</span>
        </div>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 5px;">
          Direct API key from console.anthropic.com
        </div>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideClaude" placeholder="Paste Claude Key (sk-ant-...)" style="flex: 1; background: var(--bg); border: 1px solid var(--border); color: #fff; padding: 5px 6px; font-size: 10px; border-radius: 3px; outline: none;">
          <button style="background: var(--vscode-button-background); color: #fff; border: none; padding: 5px 8px; border-radius: 3px; font-size: 10px; font-weight: 600; cursor: pointer;" onclick="saveKey('anthropic', 'sideClaude')">Save</button>
        </div>
      </div>

      <!-- OFFLINE LOCAL MODE -->
      <div class="provider-card">
        <strong style="font-size: 11px;">⚡ Built-in Offline Mode</strong>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 5px;">
          Runs local security analysis without external keys or internet.
        </div>
        <button style="width: 100%; background: var(--vscode-button-secondaryBackground); color: #fff; border: 1px solid var(--border); padding: 6px; border-radius: 4px; font-size: 10px; font-weight: 600; cursor: pointer;" onclick="saveKey('sandbox', '')">
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
      const isConfigured = ${llm.isConfigured};
      if (!isConfigured) {
        openModal();
        return;
      }
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
