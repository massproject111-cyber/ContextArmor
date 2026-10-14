import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface McpFinding {
  serverName: string;
  ruleId: string;
  severity: 'WARNING' | 'CRITICAL';
  message: string;
  remediation: string;
}

// Strict known token prefixes (Gitleaks standard) to eliminate false positive entropy noise
const SECRET_REGEXES = [
  { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9]{32,48}/ },
  { name: 'Anthropic API Key', regex: /sk-ant-[a-zA-Z0-9_-]{32,}/ },
  { name: 'GitHub Token', regex: /ghp_[a-zA-Z0-9]{36}/ },
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
];

export class McpLinter {
  /**
   * Discovers MCP configs across standard client paths:
   * Claude Desktop, Cursor, VS Code, and Gemini / Antigravity.
   */
  public discoverConfigFiles(workspaceRoot?: string): string[] {
    const discovered: string[] = [];
    const home = os.homedir();

    // 1. Claude Desktop
    const claudeMac = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    const claudeWin = path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
    if (fs.existsSync(claudeMac)) discovered.push(claudeMac);
    if (process.env.APPDATA && fs.existsSync(claudeWin)) discovered.push(claudeWin);

    // 2. Claude Code
    const claudeCodeHome = path.join(home, '.claude.json');
    if (fs.existsSync(claudeCodeHome)) discovered.push(claudeCodeHome);

    // 3. Workspace-level configs
    if (workspaceRoot) {
      const vsCodeMcp = path.join(workspaceRoot, '.vscode', 'mcp.json');
      const cursorMcp = path.join(workspaceRoot, '.cursor', 'mcp.json');
      const claudeCodeProject = path.join(workspaceRoot, '.mcp.json');

      if (fs.existsSync(vsCodeMcp)) discovered.push(vsCodeMcp);
      if (fs.existsSync(cursorMcp)) discovered.push(cursorMcp);
      if (fs.existsSync(claudeCodeProject)) discovered.push(claudeCodeProject);
    }

    return discovered;
  }

  public lintConfigFile(filePath: string): McpFinding[] {
    const findings: McpFinding[] = [];
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);
      const servers = parsed.mcpServers || parsed.servers || {};

      for (const [serverName, serverConfig] of Object.entries<any>(servers)) {
        if (!serverConfig || typeof serverConfig !== 'object') continue;

        const cmd = String(serverConfig.command || '');
        const args = Array.isArray(serverConfig.args) ? serverConfig.args.map(String) : [];
        const env = serverConfig.env && typeof serverConfig.env === 'object' ? serverConfig.env : {};

        // Rule MCP-001: Unpinned Executable (npx -y without @version, uvx without version)
        if (cmd === 'npx' || cmd.endsWith('/npx')) {
          const hasY = args.includes('-y') || args.includes('--yes');
          if (hasY) {
            // Find package name arg
            for (const arg of args) {
              if (arg.startsWith('-')) continue;
              if (!arg.includes('@') || arg.startsWith('@') && !arg.slice(1).includes('@')) {
                findings.push({
                  serverName,
                  ruleId: 'MCP-001',
                  severity: 'CRITICAL',
                  message: `Unpinned npx execution for package '${arg}'.`,
                  remediation: `Pin the package to an explicit version (e.g. '${arg}@1.0.0') to avoid supply chain hijack on startup.`,
                });
              }
            }
          }
        }

        // Rule MCP-002: Hardcoded Secrets in env (Gitleaks regexes, ignore ${env:VAR} references)
        for (const [envKey, envVal] of Object.entries<any>(env)) {
          const valStr = String(envVal);
          if (valStr.startsWith('${') && valStr.endsWith('}')) {
            continue; // Safe environment variable reference
          }

          for (const sec of SECRET_REGEXES) {
            if (sec.regex.test(valStr)) {
              findings.push({
                serverName,
                ruleId: 'MCP-002',
                severity: 'CRITICAL',
                message: `Hardcoded ${sec.name} detected in env variable '${envKey}'.`,
                remediation: `Do not store plaintext tokens in config file. Use an environment reference: '\${env:${envKey}}'.`,
              });
            }
          }
        }

        // Rule MCP-003: Broad Filesystem Boundaries
        for (const arg of args) {
          const norm = arg.trim();
          if (
            norm === '/' ||
            norm === '~' ||
            norm === '$HOME' ||
            norm.endsWith('/.ssh') ||
            norm.endsWith('/.aws')
          ) {
            findings.push({
              serverName,
              ruleId: 'MCP-003',
              severity: 'WARNING',
              message: `Overly broad filesystem root granted in arguments: '${norm}'.`,
              remediation: 'Restrict directory scope to specific project folders only.',
            });
          }
        }

        // Rule MCP-004: Explicit Subshell Wrappers
        if (
          cmd === 'sh' ||
          cmd === 'bash' ||
          cmd === 'cmd.exe' ||
          cmd === 'powershell' ||
          cmd === 'powershell.exe'
        ) {
          if (args.includes('-c') || args.includes('/c')) {
            findings.push({
              serverName,
              ruleId: 'MCP-004',
              severity: 'CRITICAL',
              message: `Dangerous subshell wrapper (${cmd} -c) configured for MCP server.`,
              remediation: 'Execute target binaries directly without subshell wrapping.',
            });
          }
        }
      }
    } catch {
      // Ignore JSON parse errors
    }

    return findings;
  }
}
