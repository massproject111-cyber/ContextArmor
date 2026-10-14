import type { InterceptionContext } from '../core/types.js';

export type ClientType = 'claude' | 'antigravity' | 'cursor' | 'cli';

export interface ParsedHookInput {
  clientType: ClientType;
  command?: string;
  cwd?: string;
  permissionMode?: string;
  isShellToolCall: boolean;
  adapterFailed: boolean;
  rawInput: string;
}

export interface ClientResponsePayload {
  exitCode: number;
  stdoutPayload?: string;
  stderrMessage?: string;
}

/**
 * Normalizes stdin JSON from Claude Code, Antigravity, Cursor, or raw CLI invocations.
 * Field citations:
 * - Claude Code: 'tool_input.command', 'tool_input.cwd'
 *   Source: https://code.claude.com/docs/en/hooks
 * - Antigravity: 'toolCall.args.CommandLine', 'toolCall.args.Cwd', 'workspacePaths'
 *   Source: https://antigravity.google/docs/hooks
 * - Cursor: 'command', 'cwd', 'sandbox' (beforeShellExecution)
 *   Source: https://cursor.com/docs/hooks
 */
export function parseHookStdin(inputStr: string): ParsedHookInput {
  const trimmed = inputStr.trim();
  if (!trimmed) {
    return {
      clientType: 'cli',
      command: undefined,
      cwd: process.cwd(),
      isShellToolCall: false,
      adapterFailed: false,
      rawInput: inputStr,
    };
  }

  try {
    const json = JSON.parse(trimmed);

    // 1. Antigravity: toolCall.name === 'run_command'
    if (json.toolCall && typeof json.toolCall === 'object') {
      const isShell = json.toolCall.name === 'run_command';
      const cmd = json.toolCall.args?.CommandLine;
      const cwd = json.toolCall.args?.Cwd || (Array.isArray(json.workspacePaths) ? json.workspacePaths[0] : undefined) || process.cwd();

      if (isShell && (!cmd || typeof cmd !== 'string')) {
        return {
          clientType: 'antigravity',
          command: undefined,
          cwd,
          isShellToolCall: true,
          adapterFailed: true,
          rawInput: inputStr,
        };
      }

      return {
        clientType: 'antigravity',
        command: typeof cmd === 'string' ? cmd : undefined,
        cwd,
        isShellToolCall: isShell,
        adapterFailed: false,
        rawInput: inputStr,
      };
    }

    // 2. Claude Code: tool_input.command, permission_mode
    if (json.tool_input && typeof json.tool_input === 'object') {
      const cmd = json.tool_input.command;
      const cwd = json.tool_input.cwd || process.cwd();
      const permissionMode = typeof json.permission_mode === 'string' ? json.permission_mode : undefined;

      if (!cmd || typeof cmd !== 'string') {
        return {
          clientType: 'claude',
          command: undefined,
          cwd,
          permissionMode,
          isShellToolCall: true,
          adapterFailed: true,
          rawInput: inputStr,
        };
      }

      return {
        clientType: 'claude',
        command: cmd,
        cwd,
        permissionMode,
        isShellToolCall: true,
        adapterFailed: false,
        rawInput: inputStr,
      };
    }

    // 3. Cursor: command + cwd/sandbox (beforeShellExecution)
    if (json.command !== undefined && (json.sandbox !== undefined || json.cwd !== undefined)) {
      const cmd = json.command;
      const cwd = json.cwd || process.cwd();

      if (typeof cmd !== 'string' || !cmd.trim()) {
        return {
          clientType: 'cursor',
          command: undefined,
          cwd,
          isShellToolCall: true,
          adapterFailed: true,
          rawInput: inputStr,
        };
      }

      return {
        clientType: 'cursor',
        command: cmd,
        cwd,
        isShellToolCall: true,
        adapterFailed: false,
        rawInput: inputStr,
      };
    }

    // Fallback: check if command is top-level property
    if (typeof json.command === 'string' && json.command.trim()) {
      return {
        clientType: 'claude',
        command: json.command,
        cwd: json.cwd || process.cwd(),
        isShellToolCall: true,
        adapterFailed: false,
        rawInput: inputStr,
      };
    }

    // Unrecognized JSON structure on what might be a tool use
    return {
      clientType: 'cli',
      command: undefined,
      cwd: process.cwd(),
      isShellToolCall: false,
      adapterFailed: false,
      rawInput: inputStr,
    };
  } catch {
    // Non-JSON input: treat as plain shell command line
    return {
      clientType: 'cli',
      command: trimmed,
      cwd: process.cwd(),
      isShellToolCall: true,
      adapterFailed: false,
      rawInput: inputStr,
    };
  }
}

/**
 * Formats decision into client-specific response JSON and exit code.
 */
export function formatClientResponse(
  clientType: ClientType,
  decision: 'BLOCK' | 'ASK' | 'ALLOW',
  reason: string,
  options?: { permissionMode?: string }
): ClientResponsePayload {
  const isBypass = options?.permissionMode === 'bypassPermissions';
  const isUnattended = isBypass || process.env.CONTEXTARMOR_UNATTENDED === '1' || process.env.CI === 'true';
  const effectiveDecision = (decision === 'ASK' && isUnattended) ? 'BLOCK' : decision;
  const effectiveReason = (decision === 'ASK' && isUnattended)
    ? `[ContextArmor UNATTENDED POLICY] ${reason} (denied: unattended policy)`
    : reason;

  switch (clientType) {
    case 'antigravity': {
      if (effectiveDecision === 'BLOCK') {
        return {
          exitCode: 2,
          stdoutPayload: JSON.stringify({ decision: 'deny', reason: effectiveReason }),
          stderrMessage: effectiveReason,
        };
      }
      if (effectiveDecision === 'ASK') {
        return {
          exitCode: 0,
          stdoutPayload: JSON.stringify({ decision: 'ask', reason: effectiveReason }),
        };
      }
      return {
        exitCode: 0,
      };
    }

    case 'claude': {
      if (effectiveDecision === 'BLOCK') {
        return {
          exitCode: 2,
          stdoutPayload: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: effectiveReason,
            },
          }),
          stderrMessage: effectiveReason,
        };
      }
      if (effectiveDecision === 'ASK') {
        return {
          exitCode: 0,
          stdoutPayload: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: effectiveReason,
            },
          }),
        };
      }
      return {
        exitCode: 0,
      };
    }

    case 'cursor': {
      if (effectiveDecision === 'BLOCK') {
        return {
          exitCode: 2,
          stdoutPayload: JSON.stringify({
            permission: 'deny',
            user_message: effectiveReason,
            agent_message: effectiveReason,
          }),
          stderrMessage: effectiveReason,
        };
      }
      if (effectiveDecision === 'ASK') {
        return {
          exitCode: 0,
          stdoutPayload: JSON.stringify({
            permission: 'ask',
            user_message: effectiveReason,
            agent_message: effectiveReason,
          }),
        };
      }
      return {
        exitCode: 0,
      };
    }

    case 'cli':
    default: {
      if (effectiveDecision === 'BLOCK') {
        return {
          exitCode: 2,
          stderrMessage: effectiveReason,
        };
      }
      if (effectiveDecision === 'ASK') {
        return {
          exitCode: 0,
          stderrMessage: `[ContextArmor WARNING] ${effectiveReason}`,
        };
      }
      return {
        exitCode: 0,
      };
    }
  }
}
