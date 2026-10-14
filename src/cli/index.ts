import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { handlePreToolUseHook } from '../hooks/preToolUse.js';
import { PackageRiskEngine, classifyDecision } from '../detectors/packageRisk/index.js';
import { McpLinter } from '../mcp/linter.js';
import type { Ecosystem } from '../core/types.js';

function printHelp(): void {
  console.log(`ContextArmor - AI Supply Chain & Circuit Breaker Security Tool

Usage:
  contextarmor <command> [options]

Commands:
  check <packageName> [-e, --ecosystem <npm|pypi>]
      Audit a package name against hallucination, slopsquatting, and typosquatting risk.
  audit [path] [--json]
      Audit all dependencies in a package.json, requirements.txt, or project directory.
  hook [command...]
      PreToolUse interceptor hook for Claude Code / Antigravity / Shells.
      Reads from stdin if no command argument is provided.
  lint-mcp [-p, --path <path>]
      Statically audit local and workspace MCP configuration files.
  doctor [--canary]
      Verify client hook configurations, permissions, and live tamper protection.
  init
      Initialize or verify hook configuration for local coding agents.

Options:
  -h, --help       Show help
  -v, --version    Show version
`);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes('-h') || rawArgs.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  if (rawArgs.includes('-v') || rawArgs.includes('--version')) {
    console.log('0.1.0');
    process.exit(0);
  }

  const subcommand = rawArgs[0];
  const subArgs = rawArgs.slice(1);

  switch (subcommand) {
    case 'check': {
      const { values, positionals } = parseArgs({
        args: subArgs,
        options: {
          ecosystem: { type: 'string', short: 'e', default: 'npm' },
          json: { type: 'boolean', default: false },
          help: { type: 'boolean', short: 'h', default: false },
        },
        allowPositionals: true,
      });

      const rawPackageSpec = positionals[0];
      if (!rawPackageSpec || values.help) {
        console.error('Usage: contextarmor check <packageName> [-e <npm|pypi>] [--json]');
        process.exit(1);
      }

      const eco: Ecosystem = values.ecosystem === 'pypi' ? 'pypi' : 'npm';
      let packageName = rawPackageSpec;
      let version: string | undefined;

      // Parse name@ver or @scope/name@ver
      const lastAt = rawPackageSpec.lastIndexOf('@');
      if (lastAt > 0) {
        packageName = rawPackageSpec.slice(0, lastAt);
        version = rawPackageSpec.slice(lastAt + 1);
      }

      const engine = new PackageRiskEngine();
      if (!values.json) {
        console.log(`[ContextArmor] Auditing ${eco} package: '${packageName}${version ? `@${version}` : ''}'...`);
      }

      const result = await engine.evaluate({ name: packageName, version, ecosystem: eco, isDirect: true });
      const decision = classifyDecision(result);

      let reason = 'Package passed clean';
      if (decision === 'BLOCK') {
        const topReason = result.signals[0]?.reason || 'High risk AI hallucination or malicious package detected';
        reason = `[ContextArmor CIRCUIT BREAKER] Blocked installation of '${packageName}' (${eco}): ${topReason}`;
      } else if (decision === 'ASK') {
        const prioritizedSignal = result.signals.find(s => s.name === 'version_cooldown_72h')
          || [...result.signals].sort((a, b) => (b.score * b.weight) - (a.score * a.weight))[0];
        const topReason = result.uncheckedReason
          ? `[UNCHECKED] ${result.uncheckedReason}`
          : (prioritizedSignal?.reason || 'Package flagged in warning tier');
        reason = `[ContextArmor WARNING] Flagged package: '${packageName}': ${topReason}`;
      }

      if (values.json) {
        console.log(JSON.stringify({
          decision,
          reason,
          signals: result.signals,
        }));
        if (decision === 'BLOCK') {
          process.exit(1);
        }
        process.exit(0);
      }

      console.log(`Decision: ${decision}`);
      console.log(`Risk Level: ${result.riskLevel} (Score: ${result.riskScore}/100)`);
      console.log(`Block Recommended: ${result.blockRecommended ? 'YES' : 'NO'}`);

      if (result.signals.length > 0) {
        console.log('\nDetected Signals Breakdown:');
        for (const sig of result.signals) {
          console.log(`  - [${sig.name}] Raw Score: ${sig.score}/100, Weight: ${sig.weight}: ${sig.reason}`);
        }
      } else {
        console.log('\nNo risk signals detected.');
      }

      if (decision === 'BLOCK') {
        process.exit(1);
      }
      process.exit(0);
      break;
    }

    case 'audit': {
      const { values, positionals } = parseArgs({
        args: subArgs,
        options: {
          json: { type: 'boolean', default: false },
          help: { type: 'boolean', short: 'h', default: false },
        },
        allowPositionals: true,
      });

      let targetPath = positionals[0] || process.cwd();
      if (!path.isAbsolute(targetPath)) {
        targetPath = path.resolve(process.cwd(), targetPath);
      }

      if (!fs.existsSync(targetPath)) {
        console.error(`[ContextArmor] Error: Path not found: '${targetPath}'`);
        process.exit(1);
      }

      const stat = fs.statSync(targetPath);
      let targetFile = targetPath;
      if (stat.isDirectory()) {
        const pkgPath = path.join(targetPath, 'package.json');
        const reqPath = path.join(targetPath, 'requirements.txt');
        if (fs.existsSync(pkgPath)) {
          targetFile = pkgPath;
        } else if (fs.existsSync(reqPath)) {
          targetFile = reqPath;
        } else {
          console.error(`[ContextArmor] No package.json or requirements.txt found in directory: '${targetPath}'`);
          process.exit(1);
        }
      }

      const engine = new PackageRiskEngine();
      const isNpm = targetFile.endsWith('package.json');
      const isPypi = targetFile.endsWith('requirements.txt');

      if (!isNpm && !isPypi) {
        console.error(`[ContextArmor] Unsupported file type: '${targetFile}'. Must be package.json or requirements.txt`);
        process.exit(1);
      }

      const fileContent = fs.readFileSync(targetFile, 'utf8');
      const depsToCheck: Array<{ name: string; version?: string; ecosystem: Ecosystem }> = [];

      if (isNpm) {
        try {
          const parsed = JSON.parse(fileContent);
          const allDeps = {
            ...(parsed.dependencies || {}),
            ...(parsed.devDependencies || {}),
            ...(parsed.peerDependencies || {}),
            ...(parsed.optionalDependencies || {}),
          };
          for (const [name, ver] of Object.entries(allDeps)) {
            depsToCheck.push({
              name,
              version: String(ver).replace(/^[\^~>=< ]+/, ''),
              ecosystem: 'npm',
            });
          }
        } catch {
          console.error(`[ContextArmor] Failed to parse JSON in '${targetFile}'`);
          process.exit(1);
        }
      } else {
        const lines = fileContent.split(/\r?\n/);
        for (const line of lines) {
          const cleaned = line.trim();
          if (!cleaned || cleaned.startsWith('#') || cleaned.startsWith('-')) continue;
          const match = cleaned.match(/^([a-zA-Z0-9_\-\.]+)(?:[=><~!]=*([a-zA-Z0-9_\-\.]+))?/);
          if (match) {
            depsToCheck.push({
              name: match[1],
              version: match[2],
              ecosystem: 'pypi',
            });
          }
        }
      }

      if (!values.json) {
        console.log(`\n[ContextArmor Audit] Scanning ${depsToCheck.length} dependencies in '${targetFile}'...\n`);
      }

      let blockedCount = 0;
      let askCount = 0;
      let allowCount = 0;
      const results: Array<{ spec: string; decision: string; reason: string; riskScore: number }> = [];

      for (const dep of depsToCheck) {
        const evalRes = await engine.evaluate({
          name: dep.name,
          version: dep.version,
          ecosystem: dep.ecosystem,
          isDirect: true,
        });
        const decision = classifyDecision(evalRes);
        const spec = `${dep.name}${dep.version ? `@${dep.version}` : ''}`;

        let reason = 'Package passed clean';
        if (decision === 'BLOCK') {
          blockedCount++;
          reason = evalRes.signals[0]?.reason || 'Malicious advisory or unregistered hallucination';
          if (!values.json) {
            console.log(`  🛑 [BLOCK] ${spec.padEnd(35)} - ${reason}`);
          }
        } else if (decision === 'ASK') {
          askCount++;
          reason = evalRes.signals[0]?.reason || 'Warning flag';
          if (!values.json) {
            console.log(`  ⚠️  [ASK]   ${spec.padEnd(35)} - ${reason}`);
          }
        } else {
          allowCount++;
          if (!values.json) {
            console.log(`  ✅ [ALLOW] ${spec.padEnd(35)} - Clean`);
          }
        }

        results.push({
          spec,
          decision,
          reason,
          riskScore: evalRes.riskScore,
        });
      }

      const overallScore = blockedCount > 0 ? 65 : askCount > 0 ? 82 : 100;

      if (values.json) {
        console.log(JSON.stringify({
          targetFile,
          total: depsToCheck.length,
          blocked: blockedCount,
          ask: askCount,
          allow: allowCount,
          score: overallScore,
          dependencies: results,
        }, null, 2));
      } else {
        console.log(`\n------------------------------------------------------------`);
        console.log(`Audit Summary: ${depsToCheck.length} audited | ${allowCount} clean | ${askCount} warnings | ${blockedCount} blocked`);
        console.log(`Security Score: ${overallScore}/100 (${overallScore === 100 ? 'CLEAN' : overallScore >= 80 ? 'WARNING' : 'CRITICAL'})`);
        console.log(`------------------------------------------------------------\n`);
      }

      if (blockedCount > 0) {
        process.exit(1);
      }
      process.exit(0);
      break;
    }

    case 'hook': {
      let rawInput = subArgs.length > 0 ? subArgs.join(' ') : '';

      // If no positional argument, read from stdin (Claude Code / Antigravity / Cursor PreToolUse JSON payload)
      if (!rawInput && !process.stdin.isTTY) {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(Buffer.from(chunk));
          }
          rawInput = Buffer.concat(chunks).toString('utf8').trim();
        } catch {}
      }

      if (!rawInput) {
        process.exit(0);
      }

      const res = await handlePreToolUseHook(rawInput);
      if (res.stderrMessage) {
        console.error(res.stderrMessage);
      }
      if (res.stdoutPayload) {
        console.log(res.stdoutPayload);
      }
      process.exit(res.exitCode);
      break;
    }

    case 'lint-mcp': {
      const { values } = parseArgs({
        args: subArgs,
        options: {
          path: { type: 'string', short: 'p' },
          help: { type: 'boolean', short: 'h', default: false },
        },
        allowPositionals: true,
      });

      const linter = new McpLinter();
      const targets = values.path ? [values.path] : linter.discoverConfigFiles(process.cwd());

      if (targets.length === 0) {
        console.log('[ContextArmor] No MCP configuration files discovered.');
        process.exit(0);
      }

      let totalFindings = 0;
      for (const file of targets) {
        console.log(`\nAuditing MCP Config: ${file}`);
        const findings = linter.lintConfigFile(file);
        totalFindings += findings.length;

        for (const f of findings) {
          console.log(`  [${f.severity}] [${f.ruleId}] Server '${f.serverName}': ${f.message}`);
          console.log(`     Remediation: ${f.remediation}`);
        }
      }

      if (totalFindings > 0) {
        console.log(`\nTotal MCP Findings: ${totalFindings}`);
      } else {
        console.log('\n[ContextArmor] All discovered MCP server configurations are clean.');
      }
      process.exit(0);
      break;
    }

    case 'doctor': {
      const { values } = parseArgs({
        args: subArgs,
        options: {
          canary: { type: 'boolean', default: false },
          help: { type: 'boolean', short: 'h', default: false },
        },
        allowPositionals: true,
      });

      console.log('[ContextArmor Doctor] Auditing environment and hook configurations...\n');

      const checks: { name: string; status: 'OK' | 'MISSING' | 'WARN'; details: string }[] = [];

      // 1. Claude settings
      const claudeSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
      if (fs.existsSync(claudeSettingsPath)) {
        try {
          const content = fs.readFileSync(claudeSettingsPath, 'utf8');
          const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
          const json = JSON.parse(content);
          const hasHook = json.hooks?.PreToolUse?.some((h: any) =>
            h.matcher === 'Bash' && h.hooks?.some((sub: any) => sub.command?.includes('contextarmor') || sub.command?.includes('dist/cli.js'))
          );
          checks.push({
            name: 'Claude Code Hook (.claude/settings.json)',
            status: hasHook ? 'OK' : 'WARN',
            details: `Wired: ${hasHook ? 'YES' : 'NO'}, Hash: ${hash}`,
          });

          // Check agent deny rules in Claude settings
          const denyList: string[] = json.permissions?.deny || [];
          const hasHookDeny = denyList.some(d => d.includes('.claude/settings.json'));
          const hasAgDeny = denyList.some(d => d.includes('.agents/hooks.json'));
          const hasDecisionsDeny = denyList.some(d => d.includes('.contextarmor'));
          const allProtected = hasHookDeny && hasAgDeny && hasDecisionsDeny;
          checks.push({
            name: 'Agent Deny Rules (Claude Code)',
            status: allProtected ? 'OK' : 'WARN',
            details: `Claude Config: ${hasHookDeny ? 'YES' : 'NO'}, AG Config: ${hasAgDeny ? 'YES' : 'NO'}, Decisions: ${hasDecisionsDeny ? 'YES' : 'NO'}`,
          });
        } catch (e: any) {
          checks.push({ name: 'Claude Code Hook', status: 'WARN', details: `Parse error: ${e.message}` });
        }
      } else {
        checks.push({ name: 'Claude Code Hook (.claude/settings.json)', status: 'MISSING', details: 'File not found' });
      }

      // 2. Antigravity settings
      const agHooksPath = path.join(process.cwd(), '.agents', 'hooks.json');
      if (fs.existsSync(agHooksPath)) {
        try {
          const content = fs.readFileSync(agHooksPath, 'utf8');
          const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
          const json = JSON.parse(content);
          const hasHook = json.hooks?.PreToolUse?.some((h: any) =>
            h.matcher === 'run_command' && (h.command?.includes('contextarmor') || h.hooks?.some((sub: any) => sub.command?.includes('contextarmor') || sub.command?.includes('dist/cli.js')))
          );
          checks.push({
            name: 'Antigravity Hook (.agents/hooks.json)',
            status: hasHook ? 'OK' : 'WARN',
            details: `Wired: ${hasHook ? 'YES' : 'NO'}, Hash: ${hash}`,
          });
        } catch (e: any) {
          checks.push({ name: 'Antigravity Hook', status: 'WARN', details: `Parse error: ${e.message}` });
        }
      } else {
        checks.push({ name: 'Antigravity Hook (.agents/hooks.json)', status: 'MISSING', details: 'File not found' });
      }

      // 3. User decisions directory and log file
      const userDir = path.join(os.homedir(), '.contextarmor');
      if (fs.existsSync(userDir)) {
        const stats = fs.statSync(userDir);
        const isDirSecure = (stats.mode & 0o777) === 0o700;
        checks.push({
          name: 'Decisions Directory (~/.contextarmor)',
          status: isDirSecure ? 'OK' : 'WARN',
          details: `Mode: ${(stats.mode & 0o777).toString(8)} (Recommended: 700)`,
        });

        const logPath = path.join(userDir, 'decisions.log');
        if (fs.existsSync(logPath)) {
          const logStats = fs.statSync(logPath);
          const isLogSecure = (logStats.mode & 0o777) === 0o600;
          checks.push({
            name: 'Decisions Log (~/.contextarmor/decisions.log)',
            status: isLogSecure ? 'OK' : 'WARN',
            details: `Mode: ${(logStats.mode & 0o777).toString(8)} (Recommended: 600)`,
          });
        }
      } else {
        checks.push({ name: 'Decisions Directory (~/.contextarmor)', status: 'OK', details: 'Not yet created (will initialize on first hook run)' });
      }

      for (const c of checks) {
        console.log(`[${c.status}] ${c.name}: ${c.details}`);
      }

      // 4. Live Canary Probes (run if --canary specified or as part of verification)
      if (values.canary) {
        console.log('\n--- Running Live Canary Probes ---');
        let canariesPassed = true;

        // Canary A: Malicious Package Intercept
        try {
          const canaryPayload = JSON.stringify({
            tool_input: {
              command: 'npm i chalk@5.6.1',
            },
          });
          const canaryRes = await handlePreToolUseHook(canaryPayload, 'claude');
          if (canaryRes.decision === 'BLOCK' && canaryRes.exitCode === 2) {
            console.log('[OK] Canary 1 (Malicious Package): Intercepted chalk@5.6.1 with BLOCK (exitCode 2)');
            console.log(`     Reason: ${canaryRes.reason}`);
          } else {
            console.log(`[WARN] Canary 1 FAILED: decision=${canaryRes.decision}, exitCode=${canaryRes.exitCode}`);
            canariesPassed = false;
          }
        } catch (err: any) {
          console.log(`[ERROR] Canary 1 probe error: ${err.message}`);
          canariesPassed = false;
        }

        // Canary B: Protected Path Tamper Intercept (Settings)
        try {
          const tamperPayload = JSON.stringify({
            tool_input: {
              command: 'echo "tamper" >> .claude/settings.json',
            },
          });
          const tamperRes = await handlePreToolUseHook(tamperPayload, 'claude');
          if (tamperRes.decision === 'BLOCK' && tamperRes.exitCode === 2) {
            console.log('[OK] Canary 2 (Config Tamper Attempt): Intercepted write to .claude/settings.json with BLOCK (exitCode 2)');
            console.log(`     Reason: ${tamperRes.reason}`);
          } else {
            console.log(`[WARN] Canary 2 FAILED: decision=${tamperRes.decision}, exitCode=${tamperRes.exitCode}`);
            canariesPassed = false;
          }
        } catch (err: any) {
          console.log(`[ERROR] Canary 2 probe error: ${err.message}`);
          canariesPassed = false;
        }

        // Canary C: Protected Path Tamper Intercept (Decisions Log)
        try {
          const tamperPayload2 = JSON.stringify({
            tool_input: {
              command: 'rm -f ~/.contextarmor/decisions.log',
            },
          });
          const tamperRes2 = await handlePreToolUseHook(tamperPayload2, 'claude');
          if (tamperRes2.decision === 'BLOCK' && tamperRes2.exitCode === 2) {
            console.log('[OK] Canary 3 (Audit Log Deletion): Intercepted deletion of ~/.contextarmor/decisions.log with BLOCK (exitCode 2)');
            console.log(`     Reason: ${tamperRes2.reason}`);
          } else {
            console.log(`[WARN] Canary 3 FAILED: decision=${tamperRes2.decision}, exitCode=${tamperRes2.exitCode}`);
            canariesPassed = false;
          }
        } catch (err: any) {
          console.log(`[ERROR] Canary 3 probe error: ${err.message}`);
          canariesPassed = false;
        }

        if (canariesPassed) {
          console.log('\n[OK] All Live Canary Probes PASSED.');
        } else {
          console.log('\n[WARN] One or more Canary Probes FAILED.');
          process.exit(1);
        }
      }

      console.log('\nDoctor check complete.');
      process.exit(0);
      break;
    }

    case 'init': {
      console.log('[ContextArmor Init] Initializing configuration...');
      const userDir = path.join(os.homedir(), '.contextarmor');
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
        console.log(`Created directory: ${userDir} (mode 700)`);
      }
      console.log('[OK] Initialization complete.');
      process.exit(0);
      break;
    }

    default:
      console.error(`Unknown command: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
