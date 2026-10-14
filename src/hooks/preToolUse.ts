import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PackageRiskEngine, classifyDecision } from '../detectors/packageRisk/index.js';
import { extractPackagesFromCommand } from './commandParser.js';
import { AllowlistManager } from '../core/allowlist.js';
import { parseHookStdin, formatClientResponse, type ClientType } from './clientAdapters.js';

export interface InterceptResult {
  blocked: boolean;
  decision: 'BLOCK' | 'ASK' | 'ALLOW';
  reason?: string;
  exitCode: number;
  stdoutPayload?: string;
  stderrMessage?: string;
}

export function logDecision(rawCommand: string, extractedPkgs: string[], decision: string, reason: string): void {
  try {
    const logDir = path.join(os.homedir(), '.contextarmor');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    }
    const logPath = path.join(logDir, 'decisions.log');

    // Redact URL credentials (https://user:pass@host) and env assignments (API_KEY=xxx)
    const sanitizedCommand = rawCommand
      .replace(/(https?:\/\/)[^:@\s]+:[^@\s]+@/g, '$1[REDACTED_CREDENTIALS]@')
      .replace(/([A-Z_]+(?:KEY|TOKEN|SECRET|PASSWORD)=[^\s]+)/gi, '[REDACTED_ENV]');

    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      rawCommand: sanitizedCommand,
      extractedPackages: extractedPkgs,
      decision,
      reason,
    }) + '\n';
    fs.appendFileSync(logPath, entry, { mode: 0o600 });
    try {
      fs.chmodSync(logPath, 0o600);
    } catch {}
  } catch {}
}

/**
 * Pre-Execution circuit breaker hook.
 * Compatible with Claude Code, Antigravity, Cursor, and CLI wrappers.
 */
export async function handlePreToolUseHook(
  rawInput: string,
  explicitClientType?: ClientType,
  customEngine?: PackageRiskEngine
): Promise<InterceptResult> {
  const parsed = parseHookStdin(rawInput);
  const clientType = explicitClientType || parsed.clientType;

  // If payload was a shell tool call but command was missing / unparseable from known fields
  if (parsed.adapterFailed) {
    const reason = '[ContextArmor ADAPTER_FAIL] Shell tool call received but command could not be extracted from payload';
    logDecision(parsed.rawInput, [], 'ADAPTER_FAIL', reason);
    const clientResp = formatClientResponse(clientType, 'ASK', reason);
    return {
      blocked: false,
      decision: 'ASK',
      reason,
      ...clientResp,
    };
  }

  const rawCmd = parsed.command;
  if (!rawCmd) {
    return {
      blocked: false,
      decision: 'ALLOW',
      exitCode: 0,
    };
  }

  const context = extractPackagesFromCommand(rawCmd, parsed.cwd);

  // 0. Defense Against Self-Tampering: Block writes to protected configuration paths
  if (context.protectedPathWrite) {
    const reason = `[ContextArmor PROTECTED_PATH] Command attempts to modify protected configuration path: '${context.protectedPathWrite}'. Blocked by circuit breaker.`;
    logDecision(rawCmd, [], 'BLOCK', reason);
    const clientResp = formatClientResponse(clientType, 'BLOCK', reason, { permissionMode: parsed.permissionMode });
    return {
      blocked: true,
      decision: 'BLOCK',
      reason,
      ...clientResp,
    };
  }

  // 1. Missing Requirements/Target File -> ASK
  if (context.missingFile) {
    const reason = `[ContextArmor PARSE_FAIL] Requirements file '${context.missingFile}' does not exist on disk. Confirm installation?`;
    logDecision(rawCmd, [], 'ASK', reason);
    const clientResp = formatClientResponse(clientType, 'ASK', reason, { permissionMode: parsed.permissionMode });
    return {
      blocked: false,
      decision: 'ASK',
      reason,
      ...clientResp,
    };
  }

  // 2. Direct Source (local path, URL, git spec, tarball) -> ASK
  if (context.directSource) {
    const reason = `[ContextArmor DIRECT_SOURCE] Installing from local path/URL/git repository bypasses registry scanning: '${context.directSource}'. Confirm installation?`;
    logDecision(rawCmd, [context.directSource], 'ASK', reason);
    const clientResp = formatClientResponse(clientType, 'ASK', reason, { permissionMode: parsed.permissionMode });
    return {
      blocked: false,
      decision: 'ASK',
      reason,
      ...clientResp,
    };
  }

  // 3. Exceeded unwrapping depth limit -> ASK
  if (context.exceededDepth) {
    const reason = '[ContextArmor NESTED_SHELL] Command exceeds subshell/wrapper unwrapping depth limit (depth > 5). Confirm execution?';
    logDecision(rawCmd, [], 'ASK', reason);
    const clientResp = formatClientResponse(clientType, 'ASK', reason, { permissionMode: parsed.permissionMode });
    return {
      blocked: false,
      decision: 'ASK',
      reason,
      ...clientResp,
    };
  }

  // 4. Manifest diff with nothing to check (unchanged manifest / lockfile) -> ALLOW
  if (context.nothingToCheck) {
    logDecision(rawCmd, [], 'ALLOW', 'NOTHING_TO_CHECK: manifest unchanged vs HEAD');
    const clientResp = formatClientResponse(clientType, 'ALLOW', 'NOTHING_TO_CHECK: manifest unchanged vs HEAD', { permissionMode: parsed.permissionMode });
    return {
      blocked: false,
      decision: 'ALLOW',
      ...clientResp,
    };
  }

  // 5. Install token present on package manager with zero targets (e.g. uv add, bare pip install) -> ALLOW
  if (context.installNoTargets) {
    logDecision(rawCmd, [], 'ALLOW', 'INSTALL_NO_TARGETS: No packages targeted in install command');
    const clientResp = formatClientResponse(clientType, 'ALLOW', 'INSTALL_NO_TARGETS: No packages targeted in install command', { permissionMode: parsed.permissionMode });
    return {
      blocked: false,
      decision: 'ALLOW',
      ...clientResp,
    };
  }

  // 6. Install token present on package manager but no packages parsed -> ASK
  if (context.unparsedInstall) {
    const reason = '[ContextArmor UNPARSED_INSTALL] Unrecognized package installation command structure or flags. Confirm installation?';
    logDecision(rawCmd, [], 'ASK', reason);
    const clientResp = formatClientResponse(clientType, 'ASK', reason, { permissionMode: parsed.permissionMode });
    return {
      blocked: false,
      decision: 'ASK',
      reason,
      ...clientResp,
    };
  }

  // 7. Non-package-manager command -> ALLOW
  if (context.notInstallCmd || context.extractedPackages.length === 0) {
    logDecision(rawCmd, [], 'ALLOW', 'NOT_INSTALL_CMD: Non-package-manager command');
    const clientResp = formatClientResponse(clientType, 'ALLOW', 'NOT_INSTALL_CMD: Non-package-manager command', { permissionMode: parsed.permissionMode });
    return {
      blocked: false,
      decision: 'ALLOW',
      ...clientResp,
    };
  }

  // 8. Evaluate extracted packages
  const allowlist = new AllowlistManager(context.workingDirectory);
  if (
    rawCmd.includes('--index-url') && !rawCmd.includes('pypi.org') ||
    rawCmd.includes('--registry') && !rawCmd.includes('registry.npmjs.org')
  ) {
    allowlist.customRegistryConfigured = true;
  }

  const engine = customEngine || new PackageRiskEngine(undefined, allowlist);

  // 20s overall hook execution budget. If elapsed time exceeds 20s, fail-open to ASK
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) =>
    setTimeout(() => resolve({ timedOut: true }), 20000)
  );

  const evaluationPromise = (async () => {
    const results = await engine.evaluateBatch(context.extractedPackages);
    return { timedOut: false as const, results };
  })();

  const outcome = await Promise.race([timeoutPromise, evaluationPromise]);

  if (outcome.timedOut) {
    const unchecked = context.extractedPackages.map(p => p.name).slice(0, 10).join(', ');
    const reason = `[ContextArmor TIMEOUT] Package evaluation exceeded budget. The following packages could not be verified: [${unchecked}${context.extractedPackages.length > 10 ? '...' : ''}]. Confirm installation?`;
    logDecision(rawCmd, context.extractedPackages.map(p => `${p.name}@${p.version || 'latest'}`), 'ASK', reason);
    const clientResp = formatClientResponse(clientType, 'ASK', reason, { permissionMode: parsed.permissionMode });
    return {
      blocked: false,
      decision: 'ASK',
      reason,
      ...clientResp,
    };
  }

  const warnings: { pkgId: string; reason: string }[] = [];
  for (const { target, assessment } of outcome.results) {
    const currentPkgId = `${target.name}@${target.version || 'latest'}`;
    const decision = classifyDecision(assessment);

    // A. BLOCK TIER: exit code 2
    if (decision === 'BLOCK') {
      const topReason = assessment.signals[0]?.reason || 'High risk AI hallucination or malicious package detected';
      const msg = `[ContextArmor CIRCUIT BREAKER] Blocked installation of '${target.name}' (${target.ecosystem}): ${topReason}`;
      logDecision(rawCmd, [currentPkgId], 'BLOCK', topReason);
      const clientResp = formatClientResponse(clientType, 'BLOCK', msg, { permissionMode: parsed.permissionMode });
      return {
        blocked: true,
        decision: 'BLOCK',
        reason: msg,
        ...clientResp,
      };
    }

    // B. Collect WARN / ASK TIER
    if (decision === 'ASK') {
      const prioritizedSignal = assessment.signals.find(s => s.name === 'version_cooldown_72h')
        || [...assessment.signals].sort((a, b) => (b.score * b.weight) - (a.score * a.weight))[0];
      const topReason = assessment.uncheckedReason
        ? `[UNCHECKED] ${assessment.uncheckedReason}`
        : (prioritizedSignal?.reason || 'Package flagged in warning tier');
      warnings.push({ pkgId: currentPkgId, reason: `${target.name}: ${topReason}` });
    }
  }

  if (warnings.length > 0) {
    const combinedReason = warnings.map(w => w.reason).join('; ');
    const msg = `[ContextArmor WARNING] Flagged packages: [${combinedReason}]. Confirm installation?`;
    logDecision(rawCmd, warnings.map(w => w.pkgId), 'ASK', combinedReason);
    const clientResp = formatClientResponse(clientType, 'ASK', msg, { permissionMode: parsed.permissionMode });
    return {
      blocked: false,
      decision: 'ASK',
      reason: msg,
      ...clientResp,
    };
  }

  const resolvedPkgIds = context.extractedPackages.map(p => `${p.name}@${p.version || 'latest'}`);
  logDecision(rawCmd, resolvedPkgIds, 'ALLOW', 'All target packages passed clean');
  const clientResp = formatClientResponse(clientType, 'ALLOW', 'All target packages passed clean', { permissionMode: parsed.permissionMode });
  return {
    blocked: false,
    decision: 'ALLOW',
    ...clientResp,
  };
}
