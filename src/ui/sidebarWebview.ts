import * as vscode from 'vscode';
import type { ThreatItem } from './treeView.js';
import { getLlmConfig, setProviderKey } from '../integrations/strix.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsArg(str: string): string {
  return encodeURIComponent(str).replace(/'/g, '%27');
}

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
        case 'runDeepPentest':
        case 'runStrix': {
          vscode.commands.executeCommand('contextarmor.runDeepPentest');
          break;
        }
        case 'configureLlm': {
          vscode.commands.executeCommand('contextarmor.configureLlm');
          break;
        }
        case 'startOauthLogin': {
          const term = vscode.window.createTerminal('ContextArmor ChatGPT OAuth Login');
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
        case 'openUrl': {
          if (data.url) {
            vscode.env.openExternal(vscode.Uri.parse(data.url));
          }
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
            try {
              const uri = vscode.Uri.file(data.file);
              const doc = await vscode.workspace.openTextDocument(uri);
              if (data.line < doc.lineCount) {
                const edit = new vscode.WorkspaceEdit();
                const lineRange = doc.lineAt(data.line).rangeIncludingLineBreak;
                edit.delete(uri, lineRange);
                await vscode.workspace.applyEdit(edit);
                await doc.save();
                vscode.commands.executeCommand('contextarmor.auditWorkspace');
              }
            } catch {}
          }
          break;
        }
        case 'pinDep': {
          if (data.file && data.line !== undefined && data.pin) {
            try {
              const uri = vscode.Uri.file(data.file);
              const doc = await vscode.workspace.openTextDocument(uri);
              if (data.line < doc.lineCount) {
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
            } catch {}
          }
          break;
        }
        case 'fixTorch': {
          if (data.file && data.line !== undefined) {
            try {
              const uri = vscode.Uri.file(data.file);
              const doc = await vscode.workspace.openTextDocument(uri);
              if (data.line < doc.lineCount) {
                const edit = new vscode.WorkspaceEdit();
                const line = doc.lineAt(data.line);
                const updated = line.text.replace(/torch\.load\(([^)]+)\)/, 'torch.load($1, weights_only=True)');
                edit.replace(uri, line.range, updated);
                await vscode.workspace.applyEdit(edit);
                await doc.save();
                vscode.commands.executeCommand('contextarmor.auditWorkspace');
              }
            } catch {}
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

    let statusTitle = 'PROJECT VERIFIED SECURE';
    let statusColor = '#05ffa1';
    let statusDesc = 'All dependencies and code files are verified safe.';
    let statusBadge = 'SECURE';

    if (criticalCount > 0) {
      statusTitle = `${criticalCount} THREAT${criticalCount > 1 ? 'S' : ''} DETECTED`;
      statusColor = '#ff003c';
      statusDesc = 'Critical exploits or malicious packages detected.';
      statusBadge = 'CRITICAL';
    } else if (warningCount > 0) {
      statusTitle = `${warningCount} ITEM${warningCount > 1 ? 'S' : ''} TO AUDIT`;
      statusColor = '#fcee0a';
      statusDesc = 'Unverified or newly published packages detected.';
      statusBadge = 'REVIEW';
    }

    const llm = getLlmConfig();
    let activeProviderName = 'Not Connected';
    if (llm.isConfigured) {
      if (llm.provider === 'ChatGPT (OAuth)') activeProviderName = 'ChatGPT';
      else if (llm.provider === 'Google Gemini') activeProviderName = 'Google Gemini';
      else if (llm.provider === 'Anthropic Claude') activeProviderName = 'Anthropic Claude';
      else if (llm.provider === 'OpenAI') activeProviderName = 'OpenAI';
      else if (llm.provider === 'Built-in Sandbox') activeProviderName = 'Offline Mode';
      else activeProviderName = llm.provider || 'Connected';
    }

    let contentHtml = '';

    if (totalIssues === 0) {
      contentHtml = `
        <div class="empty-state">
          <div style="font-family: var(--font-header); font-weight: 800; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--neon-green);">ALL CLEAR</div>
          <div style="font-size: 11px; color: var(--muted); margin-top: 4px; line-height: 1.4;">
            No malicious dependencies, hallucinations, or code vulnerabilities detected.
          </div>
        </div>
      `;
    } else {
      contentHtml = this._threats
        .map((t) => {
          const isCrit = t.severity === 'CRITICAL';
          const pinMatch =
            t.desc.match(/Suggested pin:\s*['"`](?:npm\s+i\s+[^@]+@|pip\s+install\s+[^=]+=+|uv\s+add\s+[^=]+=*)([^'"`\s]+)['"`]/i) ||
            t.desc.match(/Newest version older than 72h:\s*['"`]([^'"`]+)['"`]/i);
          const pin = pinMatch ? pinMatch[1] : undefined;

          let categoryLabel = 'Package';
          if (t.title.includes('Pentest') || t.desc.includes('pentest')) categoryLabel = 'Finding';
          else if (t.title.startsWith('[MCP')) categoryLabel = 'MCP';
          else if (t.title.includes('torch.load') || t.file?.endsWith('.py')) categoryLabel = 'Python';

          // Safe removal is ONLY for malicious / hallucinated packages in manifests
          const isManifest = !!(t.file?.endsWith('package.json') || t.file?.endsWith('requirements.txt'));
          const isMaliciousPackage = isManifest && (t.severity === 'CRITICAL' || t.desc.toLowerCase().includes('hallucinat') || t.desc.toLowerCase().includes('not found on npm') || t.desc.toLowerCase().includes('not found on pypi'));
          const showRemove = isMaliciousPackage && t.file && t.line !== undefined;

          // Insecure torch.load fix
          const isTorchFix = !!(t.file?.endsWith('.py') && (t.title.includes('torch.load') || t.desc.includes('weights_only')));

          // Make description simple and readable for non-experts
          let humanDesc = t.desc
            .replace(/Suggested pin:\s*['"`][^'"`]+['"`]/i, '')
            .replace(/Package is younger than 72h\./i, 'Published less than 72 hours ago. Unverified packages can be risky.')
            .replace(/Blocked by ContextArmor circuit breaker\./i, 'Blocked to prevent potential malware execution.')
            .trim();

          const safeTitle = escapeHtml(t.title);
          const safeDesc = escapeHtml(humanDesc);
          const safeFileArg = escapeJsArg(t.file || '');
          const safePinArg = escapeJsArg(pin || '');

          return `
            <div class="threat-card" style="border-left: 3px solid ${isCrit ? 'var(--neon-pink)' : 'var(--neon-yellow)'};">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; gap: 4px;">
                <span style="font-weight: 700; font-size: 11.5px; font-family: var(--font-mono); word-break: break-all; color: var(--text);">${safeTitle}</span>
                <div style="display: flex; gap: 4px; flex-shrink: 0;">
                  <span style="background: rgba(0, 240, 255, 0.08); color: var(--neon-cyan); border: 1px solid rgba(0, 240, 255, 0.25); padding: 1px 5px; font-size: 8.5px; font-weight: 800; font-family: var(--font-header); text-transform: uppercase; letter-spacing: 0.08em; clip-path: polygon(0 0, calc(100% - 3px) 0, 100% 3px, 100% 100%, 3px 100%, 0 calc(100% - 3px));">
                    ${categoryLabel}
                  </span>
                  <span style="background: ${isCrit ? 'var(--crit-bg)' : 'var(--warn-bg)'}; color: ${isCrit ? 'var(--crit-text)' : 'var(--warn-text)'}; border: 1px solid ${isCrit ? 'var(--crit-border)' : 'var(--warn-border)'}; padding: 1px 5px; font-weight: 800; font-size: 8.5px; font-family: var(--font-header); text-transform: uppercase; letter-spacing: 0.08em; clip-path: polygon(0 0, calc(100% - 3px) 0, 100% 3px, 100% 100%, 3px 100%, 0 calc(100% - 3px));">
                    ${isCrit ? 'CRITICAL' : 'REVIEW'}
                  </span>
                </div>
              </div>
              <div style="font-size: 11px; color: var(--text-dim); margin-bottom: 8px; line-height: 1.4;">
                ${safeDesc}
              </div>
              <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                ${
                  pin
                    ? `<button class="action-mini btn-fix" onclick="pin('${safeFileArg}', ${t.line}, '${safePinArg}')">Auto-Fix to ${escapeHtml(pin)}</button>`
                    : ''
                }
                ${
                  isTorchFix && t.file && t.line !== undefined
                    ? `<button class="action-mini btn-fix" onclick="fixTorch('${safeFileArg}', ${t.line})">Add weights_only=True</button>`
                    : ''
                }
                ${
                  showRemove
                    ? `<button class="action-mini btn-del" onclick="remove('${safeFileArg}', ${t.line})">Purge Package</button>`
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
      width: 5px;
      height: 5px;
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
      background: var(--cyber-card-bg);
      border: 1px solid var(--border);
      border-left: 3px solid ${statusColor};
      padding: 12px 14px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .hero-banner:hover {
      border-color: ${statusColor};
    }
    .hero-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .hero-title {
      font-family: var(--font-header);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: ${statusColor};
    }
    .hero-desc {
      font-size: 10.5px;
      color: var(--muted);
      margin-top: 2px;
    }
    .hero-badge {
      font-family: var(--font-header);
      font-size: 8.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 2px 6px;
      background: ${statusColor}18;
      color: ${statusColor};
      border: 1px solid ${statusColor}44;
      clip-path: polygon(0 0, calc(100% - 3px) 0, 100% 3px, 100% 100%, 3px 100%, 0 calc(100% - 3px));
    }

    /* QUICK SECURITY CHECK BUTTON */
    .btn-quick-scan {
      width: 100%;
      background: #121824;
      color: #00f0ff;
      border: 1px solid rgba(0, 240, 255, 0.45);
      padding: 9px 12px;
      margin-bottom: 6px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
      box-sizing: border-box;
      clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
    }
    .btn-quick-scan:hover {
      background: rgba(0, 240, 255, 0.15);
      color: #ffffff;
      border-color: #00f0ff;
      transform: translateY(-1px);
    }
    .btn-quick-scan:active {
      transform: translateY(1px);
    }
    .btn-quick-scan:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .btn-content {
      display: flex;
      align-items: center;
      gap: 10px;
      text-align: left;
    }
    .btn-title {
      font-family: var(--font-header);
      font-size: 10.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .btn-desc {
      font-size: 9.5px;
      color: var(--text-dim);
      margin-top: 2px;
      font-family: var(--font-ui);
    }

    /* UTILITY NAVIGATION ROW */
    .util-row {
      display: flex;
      gap: 6px;
      margin-bottom: 14px;
    }
    .btn-util {
      flex: 1;
      background: rgba(0, 240, 255, 0.05);
      color: var(--neon-cyan);
      border: 1px solid rgba(0, 240, 255, 0.3);
      padding: 6px;
      font-size: 10.5px;
      cursor: pointer;
      text-align: center;
      font-family: var(--font-header);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      clip-path: polygon(0 0, calc(100% - 5px) 0, 100% 5px, 100% 100%, 5px 100%, 0 calc(100% - 5px));
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .btn-util:hover {
      background: rgba(0, 240, 255, 0.15);
      border-color: var(--neon-cyan);
      transform: translateY(-1px);
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
      font-family: var(--font-header);
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0.1em;
      margin-bottom: 8px;
    }
    .threat-card {
      background: var(--cyber-card-bg);
      border: 1px solid var(--border);
      padding: 10px;
      margin-bottom: 8px;
      transition: border-color 0.15s ease;
    }
    .threat-card:hover {
      border-color: rgba(0, 240, 255, 0.35);
    }
    .action-mini {
      padding: 4px 8px;
      font-size: 9.5px;
      font-weight: 700;
      font-family: var(--font-header);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;
      border: none;
      clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .action-mini:hover {
      opacity: 0.85;
    }
    .btn-fix {
      background: rgba(0, 240, 255, 0.12);
      color: var(--neon-cyan);
      border: 1px solid rgba(0, 240, 255, 0.4);
    }
    .btn-del {
      background: rgba(255, 0, 60, 0.15);
      color: #ff3366;
      border: 1px solid rgba(255, 0, 60, 0.45);
    }

    /* EMPTY SAFE STATE */
    .empty-state {
      padding: 22px 14px;
      text-align: center;
      border: 1px dashed rgba(5, 255, 161, 0.3);
      background: rgba(5, 255, 161, 0.04);
    }

    /* =========================================================
       SECURITY AUDIT ANCHORED AT BOTTOM
       ========================================================= */
    .deep-station {
      background: var(--cyber-card-bg);
      border: 1px solid var(--border);
      border-top: 2px solid var(--neon-cyan);
      padding: 12px;
      margin-top: auto;
    }
    .station-badge {
      background: rgba(0, 240, 255, 0.1);
      color: var(--neon-cyan);
      border: 1px solid rgba(0, 240, 255, 0.35);
      font-family: var(--font-header);
      font-size: 8.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      padding: 2px 6px;
      display: inline-block;
      margin-bottom: 5px;
    }
    .station-title {
      font-family: var(--font-header);
      font-size: 11.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text);
    }
    .station-desc {
      font-size: 10.5px;
      color: var(--text-dim);
      margin-top: 3px;
      line-height: 1.35;
      margin-bottom: 10px;
    }

    /* ENGINE CHIP */
    .ai-chip {
      background: #090c13;
      border: 1px solid var(--border);
      padding: 7px 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      font-size: 11px;
      margin-bottom: 10px;
      clip-path: polygon(0 0, calc(100% - 5px) 0, 100% 5px, 100% 100%, 5px 100%, 0 calc(100% - 5px));
      transition: border-color 0.15s ease;
    }
    .ai-chip:hover {
      border-color: var(--neon-cyan);
    }
    .ai-chip-left {
      display: flex;
      align-items: center;
      gap: 7px;
    }

    /* MAIN RUN DEEP TEST BUTTON */
    .btn-deep-run {
      width: 100%;
      background: rgba(0, 240, 255, 0.08);
      color: var(--neon-cyan);
      border: 1px solid rgba(0, 240, 255, 0.4);
      padding: 9px 12px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.15s ease, border-color 0.15s ease;
      box-sizing: border-box;
      clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px));
    }
    .btn-deep-run:hover {
      background: rgba(0, 240, 255, 0.18);
      border-color: var(--neon-cyan);
      transform: translateY(-1px);
    }
    .btn-deep-run:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }

    /* LIVE PROGRESS INDICATOR */
    .progress-box {
      background: #06080d;
      border: 1px solid var(--border);
      padding: 10px;
      margin-top: 10px;
    }
    .progress-hdr {
      display: flex;
      justify-content: space-between;
      font-family: var(--font-header);
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }
    .progress-track {
      background: #111622;
      height: 5px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      background: linear-gradient(90deg, var(--neon-cyan), var(--neon-green));
      height: 100%;
      transition: width 0.3s ease;
    }
    .telemetry-line {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--neon-cyan);
      margin-top: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* =========================================================
       IN-WEBVIEW MODAL DIALOG
       ========================================================= */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(3, 4, 7, 0.88);
      display: none;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 12px;
      z-index: 9999;
      box-sizing: border-box;
    }
    .modal-card {
      background: #0a0d15;
      border: 1px solid rgba(0, 240, 255, 0.4);
      padding: 14px;
      width: 100%;
      box-sizing: border-box;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.85);
    }
    .modal-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 6px;
    }
    .provider-card {
      border: 1px solid var(--border);
      padding: 9px 10px;
      margin-top: 8px;
      background: rgba(0, 240, 255, 0.02);
      border-left: 2px solid rgba(0, 240, 255, 0.3);
      transition: all 0.15s;
    }
    .provider-card:hover {
      border-color: rgba(0, 240, 255, 0.5);
      background: rgba(0, 240, 255, 0.04);
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
        <div>
          <div class="btn-title">Quick Security Check</div>
          <div class="btn-desc">Instant 1-second check of packages & code</div>
        </div>
      </div>
    </button>

    <!-- NAVIGATION UTILITY BUTTONS -->
    <div class="util-row">
      <button class="btn-util" onclick="openDashboard()" title="Open comprehensive visual Security Dashboard">
        Full Dashboard
      </button>
      <button class="btn-util" onclick="runDoctor()" title="Inspect system health & security status">
        System Health
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

  <!-- BOTTOM SECTION: SECURITY AUDIT -->
  <div class="deep-station">
    <span class="station-badge">SECURITY AUDIT</span>
    <div class="station-title">Security Simulation</div>
    <div class="station-desc">
      Simulates attack patterns in a sandbox to verify your code won't get exploited.
    </div>

    <!-- ENGINE CONNECTION CHIP -->
    <div class="ai-chip" onclick="openModal()" title="Click to connect or switch engine">
      <div class="ai-chip-left">
        <span style="font-size: 11px; font-weight: 600;">Engine:</span>
        <span style="font-size: 11px; color: var(--text); font-weight: 600;">
          ${activeProviderName}
        </span>
      </div>
      <span style="font-size: 10px; color: var(--muted);">${llm.isConfigured ? 'Change' : 'Connect'}</span>
    </div>

    <!-- MAIN START AUDIT BUTTON -->
    <button class="btn-deep-run" ${this._isScanning ? 'disabled' : ''} onclick="runPentest()" title="Run automated security audit">
      <div class="btn-content">
        <div>
          <div class="btn-title">Run Security Audit</div>
          <div class="btn-desc">Sandbox verification of vulnerabilities</div>
        </div>
      </div>
    </button>

    <!-- LIVE PROGRESS BAR WHEN SCANNING -->
    ${
      this._isScanning
        ? `
      <div class="progress-box">
        <div class="progress-hdr">
          <span style="color: var(--text); font-weight: 600;">${this._statusMessage || 'Testing project security...'}</span>
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

  <!-- IN-WEBVIEW MODAL DIALOG -->
  <div class="modal-overlay" id="sidebarModal">
    <div class="modal-card">
      <div class="modal-hdr">
        <strong style="font-family: var(--font-header); font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em;">Configure Security Engine</strong>
        <button style="background: none; border: none; color: #aaa; cursor: pointer; font-size: 16px;" onclick="closeModal()">✕</button>
      </div>
      <div style="font-size: 11px; color: var(--muted); margin-bottom: 8px;">
        Choose which engine or model powers security testing:
      </div>

      <!-- CHATGPT OAUTH -->
      <div class="provider-card">
        <div class="provider-hdr">
          <strong style="font-family: var(--font-header); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;">ChatGPT Subscription</strong>
          <span style="font-size: 9px; color: var(--muted); font-weight: 600;">Plus / Pro Required</span>
        </div>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 5px;">
          1-click sign-in. Requires ChatGPT Plus or Pro. Free accounts do not support agent streaming (HTTP 429).
        </div>
        <button style="width: 100%; background: #10a37f; color: #fff; border: 1px solid #10a37f; padding: 7px; font-size: 11px; font-weight: 700; cursor: pointer; font-family: var(--font-header); text-transform: uppercase; letter-spacing: 0.05em; clip-path: polygon(0 0, calc(100% - 5px) 0, 100% 5px, 100% 100%, 5px 100%, 0 calc(100% - 5px));" onclick="startOauth()">
          Sign In with OpenAI (OAuth)
        </button>
      </div>

      <!-- GOOGLE GEMINI -->
      <div class="provider-card">
        <div class="provider-hdr">
          <strong style="font-family: var(--font-header); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;">Google Gemini (Recommended)</strong>
          <span style="font-size: 9px; color: var(--neon-cyan); font-weight: 600;">100% Free · High Limits</span>
        </div>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 5px;">
          Free tier with any Google account. No credit card required. Works without usage limits.
        </div>
        <button style="width: 100%; background: rgba(0, 240, 255, 0.1); border: 1px solid rgba(0, 240, 255, 0.35); color: var(--neon-cyan); padding: 5px; font-size: 10px; font-weight: 700; font-family: var(--font-header); text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; margin-bottom: 6px; clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));" onclick="openExternal('https://aistudio.google.com/app/apikey')">
          1-Click: Open Google AI Studio (Copy Free Key)
        </button>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideGemini" placeholder="Paste Gemini Key (AIza...)" style="flex: 1; background: #040508; border: 1px solid var(--border); color: var(--neon-cyan); font-family: var(--font-mono); padding: 5px 6px; font-size: 10px; outline: none;">
          <button style="background: #121824; color: var(--neon-cyan); border: 1px solid rgba(0, 240, 255, 0.45); padding: 5px 10px; font-size: 10px; font-weight: 800; font-family: var(--font-header); text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));" onclick="saveKey('gemini', 'sideGemini')">Save</button>
        </div>
      </div>

      <!-- OPENAI API KEY -->
      <div class="provider-card">
        <div class="provider-hdr">
          <strong style="font-family: var(--font-header); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;">OpenAI (API Key)</strong>
          <span style="font-size: 9px; color: var(--muted);">GPT-4o</span>
        </div>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 5px;">
          Direct API key from platform.openai.com
        </div>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideOpenai" placeholder="Paste OpenAI Key (sk-...)" style="flex: 1; background: #040508; border: 1px solid var(--border); color: var(--neon-cyan); font-family: var(--font-mono); padding: 5px 6px; font-size: 10px; outline: none;">
          <button style="background: #121824; color: var(--neon-cyan); border: 1px solid rgba(0, 240, 255, 0.45); padding: 5px 10px; font-size: 10px; font-weight: 800; font-family: var(--font-header); text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));" onclick="saveKey('openai', 'sideOpenai')">Save</button>
        </div>
      </div>

      <!-- ANTHROPIC CLAUDE -->
      <div class="provider-card">
        <div class="provider-hdr">
          <strong style="font-family: var(--font-header); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;">Anthropic Claude</strong>
          <span style="font-size: 9px; color: var(--muted);">Claude 3.5 Sonnet</span>
        </div>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 5px;">
          Anthropic does not offer consumer web OAuth for third-party CLIs. Requires an API key.
        </div>
        <button style="width: 100%; background: rgba(0, 240, 255, 0.1); border: 1px solid rgba(0, 240, 255, 0.35); color: var(--neon-cyan); padding: 5px; font-size: 10px; font-weight: 700; font-family: var(--font-header); text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; margin-bottom: 6px; clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));" onclick="openExternal('https://console.anthropic.com/settings/keys')">
          1-Click: Open Anthropic Console (Copy Key)
        </button>
        <div style="display: flex; gap: 4px;">
          <input type="password" id="sideClaude" placeholder="Paste Claude Key (sk-ant-...)" style="flex: 1; background: #040508; border: 1px solid var(--border); color: var(--neon-cyan); font-family: var(--font-mono); padding: 5px 6px; font-size: 10px; outline: none;">
          <button style="background: #121824; color: var(--neon-cyan); border: 1px solid rgba(0, 240, 255, 0.45); padding: 5px 10px; font-size: 10px; font-weight: 800; font-family: var(--font-header); text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));" onclick="saveKey('anthropic', 'sideClaude')">Save</button>
        </div>
      </div>

      <!-- OFFLINE LOCAL MODE -->
      <div class="provider-card">
        <strong style="font-family: var(--font-header); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;">Offline Security Engine</strong>
        <div style="font-size: 10px; color: var(--muted); margin-bottom: 5px;">
          Runs local security analysis without external keys or internet.
        </div>
        <button style="width: 100%; background: rgba(0, 240, 255, 0.06); color: var(--neon-cyan); border: 1px solid rgba(0, 240, 255, 0.3); padding: 6px; font-size: 10px; font-weight: 700; font-family: var(--font-header); text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));" onclick="saveKey('sandbox', '')">
          Select Offline Analysis
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
      vscode.postMessage({ command: 'runDeepPentest' });
    }
    function openModal() {
      document.getElementById('sidebarModal').style.display = 'flex';
    }
    function closeModal() {
      document.getElementById('sidebarModal').style.display = 'none';
    }
    function openExternal(url) {
      vscode.postMessage({ command: 'openUrl', url: url });
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
    function remove(encFile, line) {
      const file = decodeURIComponent(encFile);
      vscode.postMessage({ command: 'removeDep', file, line });
    }
    function pin(encFile, line, encPin) {
      const file = decodeURIComponent(encFile);
      const pin = decodeURIComponent(encPin);
      vscode.postMessage({ command: 'pinDep', file, line, pin });
    }
    function fixTorch(encFile, line) {
      const file = decodeURIComponent(encFile);
      vscode.postMessage({ command: 'fixTorch', file, line });
    }
  </script>
</body>
</html>`;
  }
}
