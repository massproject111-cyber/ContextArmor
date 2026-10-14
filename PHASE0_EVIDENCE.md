# ContextArmor Phase 0 Audit Evidence

Generated: 2026-10-10
Host: macOS (Darwin 24.6.0)
Working Directory: /Users/nufoos/dev-projects/ContextArmor

---

## 1. Environment & Setup Verification

### PATH Shim Configuration
Commands used to configure safety shim:
```bash
mkdir -p /tmp/shim
cat << 'EOF' > /tmp/shim/logger.sh
#!/bin/sh
echo "$0 $@" >> /tmp/shim/ran.log
exit 0
EOF
chmod +x /tmp/shim/logger.sh
for cmd in pip pip3 npm npx uv uvx pnpm bun yarn; do
  ln -sf /tmp/shim/logger.sh /tmp/shim/$cmd
done
```
Verification command:
```bash
PATH=/tmp/shim:$PATH which pip
PATH=/tmp/shim:$PATH which npm
```
Raw Output:
```
/tmp/shim/pip
/tmp/shim/npm
```

---

## 2. Step 1a: Build, Types, Help, and Audit Outputs

### Command: npm ci
```bash
npm ci
```
Raw Output:
```
added 6 packages in 202ms
```
Exit Code: 0

### Command: npx tsc --noEmit
```bash
npx tsc --noEmit
```
Raw Output:
```
src/extension.ts:1:25 - error TS2307: Cannot find module 'vscode' or its corresponding type declarations.

1 import * as vscode from 'vscode';
                          ~~~~~~~~

src/extension.ts:130:48 - error TS7006: Parameter 'editor' implicitly has an 'any' type.

130     vscode.window.onDidChangeActiveTextEditor((editor) => {
                                                   ~~~~~~

src/extension.ts:133:45 - error TS7006: Parameter 'doc' implicitly has an 'any' type.

133     vscode.workspace.onDidSaveTextDocument((doc) => {
                                                ~~~

src/ui/quickFixes.ts:1:25 - error TS2307: Cannot find module 'vscode' or its corresponding type declarations.

1 import * as vscode from 'vscode';
                          ~~~~~~~~

src/ui/treeView.ts:1:25 - error TS2307: Cannot find module 'vscode' or its corresponding type declarations.

1 import * as vscode from 'vscode';
                          ~~~~~~~~

src/ui/treeView.ts:29:43 - error TS2304: Cannot find name 'Thenable'.

29   getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
                                             ~~~~~~~~


Found 6 errors in 3 files.

Errors  Files
     3  src/extension.ts:1
     1  src/ui/quickFixes.ts:1
     2  src/ui/treeView.ts:1
```
Exit Code: 2
Finding: TypeScript fails because `@types/vscode` was removed from `devDependencies` while parked extension files (`src/extension.ts`, `src/ui/quickFixes.ts`, `src/ui/treeView.ts`) remain included in `tsconfig.json`.

### Command: node dist/cli.js --help
```bash
node dist/cli.js --help
```
Raw Output:
```
Usage: contextarmor [options] [command]

AI Supply Chain & Circuit Breaker Security Tool

Options:
  -V, --version                  output the version number
  -h, --help                     display help for command

Commands:
  check [options] <packageName>  Audit a package name against hallucination,
                                 slopsquatting, and typosquatting risk
  hook [cmd...]                  PreToolUse interceptor hook for Claude Code /
                                 Antigravity / Shells
  lint-mcp [options]             Statically audit local and workspace MCP
                                 configuration files
  help [command]                 display help for command
```
Exit Code: 0

### Command: npm audit
Inside sandbox:
```
npm warn audit 403 Forbidden - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk
Request to POST /-/npm/v1/security/advisories/bulk on registry.npmjs.org not allowed by policy
```
Exit Code: 1 (network isolation)

Direct host execution with network:
```bash
npm audit
```
Raw Output:
```
found 0 vulnerabilities
```
Exit Code: 0

### Command: npm audit signatures
```bash
npm audit signatures
```
Raw Output:
```
audited 6 packages in 9s

6 packages have verified registry signatures

2 packages have verified attestations
(use --json --include-attestations to view attestation details)
```
Exit Code: 0

---

## 3. Step 1b: Benchmark Evaluation and Corpus State

### Command: node dist/eval.js
```bash
node dist/eval.js
```
Raw Output:
```
=====================================================
       ContextArmor Benchmark Evaluation Suite       
=====================================================

Running on Dev Split (12 packages)...
Running on Hold-Out Test Split (15 packages)...

-----------------------------------------------------
DEV SPLIT RESULTS:
  Total: 12 | TP: 4 | FP: 0 | TN: 8 | FN: 0
  Recall: 100.0% | Precision: 100.0% | FPR: 0.0%

HOLD-OUT TEST SPLIT RESULTS:
  Total: 15 | TP: 6 | FP: 0 | TN: 9 | FN: 0
  Recall: 100.0% | Precision: 100.0% | FPR: 0.0%
-----------------------------------------------------
```
Exit Code: 0

### Corpus Audit (`src/eval/corpus.ts`)
- **Corpus size**: 27 packages total.
- **Malicious count**: 10 (`isMaliciousOrHallucinated: true`).
- **Benign count**: 17 (`isMaliciousOrHallucinated: false`).
- **Source / Author Bias**: 27 of 27 (100%) were written by the same agent that wrote the detectors. Zero external samples from OSSF or real repositories.
- **Split File with Committed Hash**: NOT PRESENT. No separate split file exists; `split: 'dev' | 'test'` is hardcoded as an object property in `src/eval/corpus.ts`. No git hash was committed prior to tuning.
- **Chalk Label Status**: In `src/eval/corpus.ts`:
  `{ name: 'chalk', version: '5.6.1', ecosystem: 'npm', isMaliciousOrHallucinated: true, category: 'malicious_advisory', split: 'test' }`
  Chalk is labeled malicious at version 5.6.1. However, in the CLI hook, bare `npm i chalk` queries OSV without version and blocks chalk globally (see Step 1d).

---

## 4. Step 1c: Hook in Real Agents

### Document Citations (Fetched 2026-10-10)
- **Claude Code**: `https://code.claude.com/docs/en/hooks`
  - Config file: `.claude/settings.json`
  - Schema: `{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "..."}]}]}}`
  - Input schema: stdin JSON with `tool_input.command`
  - Output schema: stdout JSON `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny" | "ask" | "allow", "permissionDecisionReason": "..."}}` or exit code 2.
- **Cursor**: `https://cursor.com/docs/hooks` and `https://cursor.com/docs/reference/third-party-hooks`
  - Config file: `.cursor/hooks.json` or `.claude/settings.json` (Cursor natively imports Claude Code hooks from `.claude/settings.json`)
  - Supported events: `beforeShellExecution`, `preToolUse`
  - Response compatibility: Supports both flat `{"permission": "deny", "user_message": "..."}` and Claude Code nested `hookSpecificOutput`.
- **Antigravity**: `https://antigravity.google/docs/hooks` (and built-in docs at `.gemini/antigravity/builtin/skills/agy-customizations/docs/hooks.md`)
  - Config file: `.agents/hooks.json`
  - Named hook structure: `{"<hook-name>": {"PreToolUse": [{"matcher": "run_command", "hooks": [{"type": "command", "command": "..."}]}]}}`
  - Input schema: stdin JSON with `{"toolCall": {"name": "run_command", "args": {"CommandLine": "..."}}}`
  - Output schema: stdout JSON `{"decision": "allow" | "deny" | "ask" | "force_ask", "reason": "..."}`

### Agent Status Matrix
- **Claude Code**: PROVEN
- **Antigravity**: PROVEN FIRING / ADAPTER DEFECT
- **Cursor**: NOT TESTED (binary not installed on machine)

### Claude Code Verification
Started real session with PATH shim:
```bash
PATH=/tmp/shim:$PATH /opt/homebrew/bin/claude -p "Use your bash tool to run exactly: which pip && pip install super-fast-audio-speech-12345"
```
Raw Output:
```
Your ContextArmor hook caught a security issue: `super-fast-audio-speech-12345` doesn't exist on PyPI. This looks like a typosquatting test or unregistered package name.

The hook is working as designed—it blocks installation of packages that don't exist in the official registry to prevent supply chain compromise via slopsquatting (installing a similarly-named malicious package).

If you meant a real package, check the exact name on PyPI. If this was intentional (testing the hook), ContextArmor is functioning correctly.
```
Tail of `~/.contextarmor/decisions.log`:
```json
{"timestamp":"2026-10-10T07:52:06.638Z","rawCommand":"which pip && pip install super-fast-audio-speech-12345","extractedPackages":["super-fast-audio-speech-12345@latest"],"decision":"BLOCK","reason":"Package 'super-fast-audio-speech-12345' does not exist on pypi registry (unregistered AI hallucination, vulnerable to slopsquatting)."}
```
Contents of `/tmp/shim/ran.log`:
```
(empty - 0 bytes)
```
Finding: Claude Code attempted Bash execution, hook intercepted command, blocked execution before spawn, returned decision to model, and PATH shim was never reached.

### Antigravity Verification
Antigravity executes `.agents/hooks.json` on `run_command` tool calls.
Tail of `~/.contextarmor/decisions.log` during Antigravity tool use:
```json
{"timestamp":"2026-10-10T07:47:31.389Z","rawCommand":"{\"artifactDirectoryPath\":\"/Users/nufoos/.gemini/antigravity/brain/...\",\"conversationId\":\"...\",\"toolCall\":{\"args\":{\"CommandLine\":\"npm ci\"},\"name\":\"run_command\"}...}","extractedPackages":[],"decision":"ALLOW","reason":"PARSE_FAIL: Unrecognized install format or no packages found in diff"}
```
Finding: Antigravity fires the hook, but `src/cli/index.ts` line 60 extracts `parsed.tool_input?.command || parsed.command`. Because Antigravity passes `toolCall.args.CommandLine`, `rawCmd` falls back to the full raw JSON string, failing command parser regex and falling open with `PARSE_FAIL`. Furthermore, Antigravity expects `{"decision": "deny"}`, not `{"hookSpecificOutput": ...}`.

### Cursor Verification
Command:
```bash
which cursor || which code || ls -la /Applications/Cursor.app 2>/dev/null || echo "Cursor not found"
```
Raw Output:
```
cursor not found
/Users/nufoos/bin/code
```
Status: NOT TESTED (Cursor application not installed on host).

---

## 5. Step 1d: Version Resolution Audit

### Commands Tested
1. `pip install 'requests>=2'`
2. `npm i chalk@^5.6.0`
3. `uvx ruff`
4. `npm i chalk`

### Decisions.log Output
```json
{"timestamp":"2026-10-10T07:53:06.455Z","rawCommand":"pip install 'requests>=2'","extractedPackages":["requests@2"],"decision":"ALLOW","reason":"All target packages passed clean"}
{"timestamp":"2026-10-10T07:53:07.741Z","rawCommand":"npm i chalk@^5.6.0","extractedPackages":["chalk@^5.6.0"],"decision":"ALLOW","reason":"All target packages passed clean"}
{"timestamp":"2026-10-10T07:53:09.230Z","rawCommand":"uvx ruff","extractedPackages":["ruff@latest"],"decision":"ALLOW","reason":"All target packages passed clean"}
{"timestamp":"2026-10-10T07:53:09.332Z","rawCommand":"npm i chalk","extractedPackages":["chalk@latest"],"decision":"BLOCK","reason":"Package has confirmed malicious advisory: MAL-2025-46969"}
```

### Version String Analysis
- `pip install 'requests>=2'`: Version extracted was `"2"`. Range `>=2` collapsed to exact string `2` via `split(/[=<>~!]/)`.
- `npm i chalk@^5.6.0`: Version extracted was `"^5.6.0"`. Passed literally to OSV endpoint (`payload.version = "^5.6.0"`). OSV matches exact version numbers only; querying `^5.6.0` returned 0 vulnerabilities. Malicious package chalk 5.6.1 passed clean.
- `uvx ruff`: Extracted `version: undefined` (rendered as `ruff@latest`).
- `npm i chalk`: Extracted `version: undefined`. Queried OSV without version field (`{"package": {"name": "chalk", "ecosystem": "npm"}}`). OSV returned all historic advisories for chalk (including MAL-2025-46969 on 5.6.1). Result: bare `npm i chalk` blocked globally even when requesting safe default.

---

## 6. Step 1e: Diff Base and Monorepo Behavior

### Command: git show HEAD:package.json vs git show HEAD:./package.json
From `/Users/nufoos/dev-projects/ContextArmor`:
```bash
git show HEAD:package.json | head -n 4
git show HEAD:./package.json | head -n 4
```
Raw Output:
```
{
  "name": "dev-projects",
  "private": true,
  "description": "Web development workspace",
--- with ./ ---
{
  "name": "contextarmor",
  "displayName": "ContextArmor",
  "description": "AI Supply Chain & Model Deserialization Security Circuit Breaker",
```
Finding: `git show HEAD:package.json` resolves relative to the git repository root (`dev-projects`). In `src/hooks/commandParser.ts` lines 18 & 43, `execSync('git show HEAD:package.json')` fetched the parent repository's manifest. Because the parent repository has different dependencies, bare `npm install` in any monorepo subdirectory treats ALL local dependencies as newly added uncommitted dependencies.

### Untracked, Non-git, and npm ci Audit
- **Untracked `requirements.txt`**: `git show HEAD:requirements.txt` exits with error code 128, caught by try/catch. `headContent` is empty; all entries in `requirements.txt` are treated as added dependencies.
- **Non-git Directory**: `git show` exits with fatal error, caught by try/catch; all manifest entries treated as added.
- **Unchanged Manifest in Monorepo Subdir**: Treated as 100% changed because `HEAD:package.json` resolves to parent repo.
- **`npm ci` Behavior**: `src/hooks/commandParser.ts` line 103 maps `npm ci` to `checkBareManifestDiff`. Due to the parent-repo diff bug, `npm ci` currently audits all direct dependencies in `ContextArmor/package.json` rather than skipping unchanged files.

---

## 7. Step 1f: Slip Matrix Raw Results

Tested via `node dist/cli.js hook "<cmd>"`:

| Command | Exit Code | Decision | Logged Reason | Notes / Slip Status |
| :--- | :--- | :--- | :--- | :--- |
| `pip install -r requirements.txt` | 0 | ALLOW | PARSE_FAIL | SLIP (HEAD:requirements.txt failed to find root file) |
| `pip install -e .` | 0 | ALLOW | PARSE_FAIL | Handled by filter, ignored |
| `pip install git+https://github.com/psf/requests.git` | 0 | ALLOW | PARSE_FAIL | Handled by filter, ignored |
| `pip install ./local` | 0 | ALLOW | ALLOW | SLIP (extracted `./local@latest` as package name) |
| `npm i ./local` | 0 | ALLOW | ALLOW | SLIP (extracted `./local@latest` as package name) |
| `npm i git+https://github.com/chalk/chalk.git` | 0 | ALLOW | ALLOW | SLIP (extracted URL as package name) |
| `npm i https://registry.npmjs.org/chalk/-/chalk-5.3.0.tgz` | 0 | ALLOW | ALLOW | SLIP (extracted URL as package name) |
| `npx -y pkg@latest` | 0 | ALLOW | ALLOW | Parsed `pkg@latest`, checked clean |
| `pnpm add express` | 0 | ALLOW | ALLOW | Parsed `express@latest`, checked clean |
| `yarn add express` | 0 | ALLOW | ALLOW | Parsed `express@latest`, checked clean |
| `uv add requests` | 0 | ALLOW | ALLOW | Parsed `requests@latest`, checked clean |
| `uv sync` | 0 | ALLOW | PARSE_FAIL | SLIP (unhandled command) |
| `poetry install` | 0 | ALLOW | PARSE_FAIL | SLIP (unhandled command) |
| `pip install .` | 0 | ALLOW | PARSE_FAIL | Handled by filter |
| `$(echo npm i evil)` | 0 | ALLOW | PARSE_FAIL | SLIP (command substitution undetected) |
| `eval "npm i evil"` | 0 | ALLOW | PARSE_FAIL | SLIP (eval unhandled) |
| `echo evil \| xargs npm i` | 0 | ALLOW | PARSE_FAIL | SLIP (xargs unhandled) |
| `bash -c "bash -c \"npm i evil\""` | 0 | ALLOW | PARSE_FAIL | SLIP (nested subshell: regex stripped 1 layer only) |

---

## 8. Step 1g: Secrets Redaction and Permissions

### Command: Secrets in decisions.log
```bash
node dist/cli.js hook "pip install --index-url https://u:SECRET@host/simple x"
node dist/cli.js hook "NPM_TOKEN=SECRET npm i x"
tail -n 2 ~/.contextarmor/decisions.log
stat -f "%Sp %u:%g" ~/.contextarmor/decisions.log
```
Raw Output:
```json
{"timestamp":"2026-10-10T08:05:31.141Z","rawCommand":"pip install --index-url https://[REDACTED_CREDENTIALS]@host/simple x","extractedPackages":["x@latest"],"decision":"ALLOW","reason":"All target packages passed clean"}
{"timestamp":"2026-10-10T08:05:32.659Z","rawCommand":"[REDACTED_ENV] npm i x","extractedPackages":["x@latest"],"decision":"ALLOW","reason":"All target packages passed clean"}
```
File Permissions:
```
-rw------- 501:20
```
Finding: `~/.contextarmor/decisions.log` is created with mode 0600 (`-rw-------`). URL credentials (`u:SECRET@host`) are redacted as `[REDACTED_CREDENTIALS]`. Preceding environment assignments (`NPM_TOKEN=SECRET`) are redacted as `[REDACTED_ENV]`.

---

## 9. Step 1h: Check Output for Playwright & Signal Source

### Command: node dist/cli.js check playwright
```bash
node dist/cli.js check playwright
```
Raw Output:
```
[ContextArmor] Auditing npm package: 'playwright'...
Risk Level: LOW (Score: 25/100)
Block Recommended: NO

Detected Signals Breakdown:
  - [latest_version_cooldown] Raw Score: 25/100, Weight: 0.08: New version published less than 24h ago (14.2 hours ago). Potential version hijack or unvetted release.
```
Finding: Playwright scored 25 points exclusively from `latest_version_cooldown` (new release published 14.2h ago).

### Source of "Zero Dependents" Signal
In `src/detectors/packageRisk/registryClient.ts` line 155:
```typescript
const url = `https://api.deps.dev/v3/systems/${sys}/packages/${encodeURIComponent(meta.name)}`;
...
if (data.dependentProjectsCount !== undefined) {
  meta.dependentsCount = data.dependentProjectsCount;
}
```
In `src/detectors/packageRisk/slopsquatChecker.ts` line 70:
```typescript
if (meta.dependentsCount !== undefined && meta.dependentsCount === 0) { ... }
```
Analysis:
- The signal is backed by Google's `deps.dev` v3 API.
- For new/unregistered packages or when `deps.dev` returns 404/times out, `meta.dependentsCount` is `undefined`.
- The signal only fires when `deps.dev` explicitly returns HTTP 200 with `dependentProjectsCount: 0`.

---

## 10. Step 1i: Runtime Dependencies and Binary Bundle

### Runtime Dependencies in `package.json`
```json
"dependencies": {
  "commander": "15.0.0"
}
```
Total runtime dependencies: 1 (`commander`).

### Standalone Bundle Verification
```bash
ls -lh dist/cli.js
mkdir -p /tmp/test-standalone
cp dist/cli.js /tmp/test-standalone/
cd /tmp/test-standalone && node cli.js --help
```
Raw Output:
```
-rw-r--r--@ 1 nufoos staff 146K Oct 10 00:46 dist/cli.js
Usage: contextarmor [options] [command]

AI Supply Chain & Circuit Breaker Security Tool
...
```
Finding: `dist/cli.js` bundle size is 146KB (149,104 bytes). `commander` is bundled into `dist/cli.js` by esbuild; the binary runs in isolation without `node_modules`. However, `package.json` must be updated to remove `commander` in favor of `node:util parseArgs` to satisfy zero-runtime-dependency requirements.


---

## 11. P1 Verification & Post-Correction Raw Outputs (2026-10-10)

### 11.1 TypeScript Clean Compilation
```bash
npx tsc --noEmit
```
Raw Output:
```
(empty - exit code 0)
```
Exit Code: 0 (Parked extension excluded from active `tsconfig.json`).

### 11.2 Control Experiments

#### Claude Code Pair
**Control A (Hook Disabled via toggle):**
Command:
```bash
PATH=/tmp/shim:$PATH /opt/homebrew/bin/claude -p "Use your bash tool to run exactly: which pip && pip install super-fast-audio-speech-12345"
cat /tmp/shim/ran.log
```
Model Output:
```
The command ran and found pip at `/tmp/shim/pip`, but the install didn't proceed. This is likely because `super-fast-audio-speech-12345` doesn't exist on PyPI (it looks like a made-up package name for testing). 

If you meant to test pip functionality or install a real package, let me know the actual package name. If this was intentionally a non-existent package to verify error handling, the command executed as written.
```
Raw `ran.log`:
```
/tmp/shim/pip install super-fast-audio-speech-12345
```
Result: `ran.log` contains 1 line proving shim execution when hook is disabled.

**Control B (Hook Enabled):**
Command:
```bash
PATH=/tmp/shim:$PATH /opt/homebrew/bin/claude -p "$PROMPT"
ls -l /tmp/shim/ran.log
tail -n 1 ~/.contextarmor/decisions.log
```
Model Output:
```
The pre-tool hook (ContextArmor) blocked the command because `super-fast-audio-speech-12345` doesn't exist on PyPI. This is a safety measure to prevent installing typosquatting or hallucinated packages.

This appears to be a deliberate test of your project's security hooks. The ContextArmor circuit breaker is working as designed — it caught an attempt to install a non-existent package and prevented it.
```
Raw `ran.log`:
```
-rw-r--r--@ 1 nufoos wheel 0 Oct 10 14:32 /tmp/shim/ran.log
```
Raw `decisions.log` entry:
```json
{"timestamp":"2026-10-10T09:02:44.791Z","rawCommand":"which pip && pip install super-fast-audio-speech-12345","extractedPackages":["super-fast-audio-speech-12345@latest"],"decision":"BLOCK","reason":"Package 'super-fast-audio-speech-12345' does not exist on pypi registry (unregistered AI hallucination, vulnerable to slopsquatting)."}
```
Result: `ran.log` is empty (0 bytes), `decisions.log` logged `BLOCK`, block reason reached model prompt.

#### Antigravity Pair
**Control A (Hook Disabled via toggle):**
Command:
```bash
PATH=/tmp/shim:$PATH pip install super-fast-audio-speech-12345
cat /tmp/shim/ran.log
```
Raw Output:
```
=== Exit: 0 ===
=== ran.log contents ===
/tmp/shim/pip install super-fast-audio-speech-12345
```
Result: `ran.log` contains 1 line proving execution when hook is disabled.

**Control B (Hook Enabled):**
Command:
```bash
PATH=/tmp/shim:$PATH pip install super-fast-audio-speech-12345
```
Raw Tool Error:
```
Encountered error in tool execution: JSON hook "jsonhook__hooks_PreToolUse_0_0" failed: command failed: exit status 2, stderr: [ContextArmor CIRCUIT BREAKER] Blocked installation of 'super-fast-audio-speech-12345' (pypi): Package 'super-fast-audio-speech-12345' does not exist on pypi registry (unregistered AI hallucination, vulnerable to slopsquatting).
```
Raw `ran.log`:
```
-rw-r--r--@ 1 nufoos wheel 0 Oct 10 14:30 /tmp/shim/ran.log
```
Raw `decisions.log` entry:
```json
{"timestamp":"2026-10-10T09:00:16.961Z","rawCommand":"PATH=/tmp/shim:$PATH pip install super-fast-audio-speech-12345","extractedPackages":["super-fast-audio-speech-12345@latest"],"decision":"BLOCK","reason":"Package 'super-fast-audio-speech-12345' does not exist on pypi registry (unregistered AI hallucination, vulnerable to slopsquatting)."}
```
Result: Antigravity tool execution was halted before spawn with exit status 2, `ran.log` remained 0 bytes, `BLOCK` logged.

---

### 11.3 Version Resolution Verification

```bash
node dist/cli.js hook "npm i chalk"
node dist/cli.js hook "npm i chalk@^5.6.0"
node dist/cli.js hook "pip install 'requests>=2'"
node dist/cli.js hook "npm i chalk@5.6.1"
```
Raw Outputs & Exit Codes:
```
--- 1. bare npm i chalk ---
Exit: 0

--- 2. npm i chalk@^5.6.0 ---
Exit: 0

--- 3. pip install 'requests>=2' ---
Exit: 0

--- 4. npm i chalk@5.6.1 ---
[ContextArmor CIRCUIT BREAKER] Blocked installation of 'chalk' (npm): Package has confirmed malicious advisory: MAL-2025-46969
Exit: 2
```
Raw `decisions.log` entries:
```json
{"timestamp":"2026-10-10T08:51:23.352Z","rawCommand":"npm i chalk","extractedPackages":["chalk@6.0.1"],"decision":"ALLOW","reason":"All target packages passed clean"}
{"timestamp":"2026-10-10T08:51:24.367Z","rawCommand":"npm i chalk@^5.6.0","extractedPackages":["chalk@5.6.2"],"decision":"ALLOW","reason":"All target packages passed clean"}
{"timestamp":"2026-10-10T08:51:25.643Z","rawCommand":"pip install 'requests>=2'","extractedPackages":["requests@2.34.2"],"decision":"ALLOW","reason":"All target packages passed clean"}
{"timestamp":"2026-10-10T08:51:25.702Z","rawCommand":"npm i chalk@5.6.1","extractedPackages":["chalk@5.6.1"],"decision":"BLOCK","reason":"Package has confirmed malicious advisory: MAL-2025-46969"}
```

---

### 11.4 Diff-Base Tests in Monorepo Subdirectory

#### Test 6A: Unchanged file in monorepo subdir
```bash
node dist/cli.js hook "npm install"
```
Raw Output:
```
Exit: 0
{"timestamp":"2026-10-10T08:51:53.558Z","rawCommand":"npm install","extractedPackages":[],"decision":"ALLOW","reason":"NOTHING_TO_CHECK: manifest unchanged vs HEAD"}
```

#### Test 6B: Monorepo subdir with uncommitted added dependency
```bash
node /Users/nufoos/dev-projects/ContextArmor/dist/cli.js hook "npm install"
```
Raw Output:
```
[ContextArmor CIRCUIT BREAKER] Blocked installation of 'super-fast-audio-speech-12345' (npm): Package 'super-fast-audio-speech-12345' does not exist on npm registry (unregistered AI hallucination, vulnerable to slopsquatting).
Exit: 2
{"timestamp":"2026-10-10T08:51:54.653Z","rawCommand":"npm install","extractedPackages":["super-fast-audio-speech-12345@1.0.0"],"decision":"BLOCK","reason":"Package 'super-fast-audio-speech-12345' does not exist on npm registry (unregistered AI hallucination, vulnerable to slopsquatting)."}
```

#### Test 6C: Untracked requirements.txt
```bash
node /Users/nufoos/dev-projects/ContextArmor/dist/cli.js hook "pip install -r requirements.txt"
```
Raw Output:
```
[ContextArmor CIRCUIT BREAKER] Blocked installation of 'super-fast-audio-speech-12345' (pypi): Package 'super-fast-audio-speech-12345' does not exist on pypi registry (unregistered AI hallucination, vulnerable to slopsquatting).
Exit: 2
{"timestamp":"2026-10-10T08:51:55.744Z","rawCommand":"pip install -r requirements.txt","extractedPackages":["super-fast-audio-speech-12345@1.0"],"decision":"BLOCK","reason":"Package 'super-fast-audio-speech-12345' does not exist on pypi registry (unregistered AI hallucination, vulnerable to slopsquatting)."}
```

#### Test 6D: Non-git directory
```bash
node /Users/nufoos/dev-projects/ContextArmor/dist/cli.js hook "pip install -r requirements.txt"
```
Raw Output:
```
Exit: 0
{"timestamp":"2026-10-10T08:51:55.819Z","rawCommand":"pip install -r requirements.txt","extractedPackages":["requests@2.34.2"],"decision":"ALLOW","reason":"All target packages passed clean"}
```

---

### 11.5 Rerun of 18-Command Slip Matrix

| Command | Exit Code | Decision | Logged Reason |
| :--- | :--- | :--- | :--- |
| `pip install -r requirements.txt` (missing file) | 0 | ASK | `[ContextArmor UNPARSED_INSTALL] Unrecognized package installation command structure or flags. Confirm installation?` |
| `pip install -e .` | 0 | ASK | `[ContextArmor DIRECT_SOURCE] Installing from local path/URL/git repository bypasses registry scanning: '.'. Confirm installation?` |
| `pip install git+https://github.com/psf/requests.git` | 0 | ASK | `[ContextArmor DIRECT_SOURCE] Installing from local path/URL/git repository bypasses registry scanning: 'git+https://github.com/psf/requests.git'. Confirm installation?` |
| `pip install ./local` | 0 | ASK | `[ContextArmor DIRECT_SOURCE] Installing from local path/URL/git repository bypasses registry scanning: './local'. Confirm installation?` |
| `npm i ./local` | 0 | ASK | `[ContextArmor DIRECT_SOURCE] Installing from local path/URL/git repository bypasses registry scanning: './local'. Confirm installation?` |
| `npm i git+https://github.com/chalk/chalk.git` | 0 | ASK | `[ContextArmor DIRECT_SOURCE] Installing from local path/URL/git repository bypasses registry scanning: 'git+https://github.com/chalk/chalk.git'. Confirm installation?` |
| `npm i https://registry.npmjs.org/chalk/-/chalk-5.3.0.tgz` | 0 | ASK | `[ContextArmor DIRECT_SOURCE] Installing from local path/URL/git repository bypasses registry scanning: 'https://registry.npmjs.org/chalk/-/chalk-5.3.0.tgz'. Confirm installation?` |
| `npx -y pkg@latest` | 0 | ALLOW | All target packages passed clean (`pkg@5.8.1`) |
| `pnpm add express` | 0 | ALLOW | All target packages passed clean (`express@5.3.0`) |
| `yarn add express` | 0 | ALLOW | All target packages passed clean (`express@5.3.0`) |
| `uv add requests` | 0 | ALLOW | All target packages passed clean (`requests@2.34.2`) |
| `uv sync` (missing manifest) | 0 | ASK | `[ContextArmor UNPARSED_INSTALL] Unrecognized package installation command structure or flags. Confirm installation?` |
| `poetry install` (missing manifest) | 0 | ASK | `[ContextArmor UNPARSED_INSTALL] Unrecognized package installation command structure or flags. Confirm installation?` |
| `pip install .` | 0 | ASK | `[ContextArmor DIRECT_SOURCE] Installing from local path/URL/git repository bypasses registry scanning: '.'. Confirm installation?` |
| `$(echo npm i evil)` | 0 | ASK | `[ContextArmor UNPARSED_INSTALL] Unrecognized package installation command structure or flags. Confirm installation?` |
| `eval "npm i evil"` | 0 | ALLOW | All target packages passed clean (`evil@1.0.1`) |
| `echo evil \| xargs npm i` | 0 | ALLOW | All target packages passed clean (`evil@1.0.1`) |
| `bash -c "bash -c \"npm i evil\""` | 0 | ASK | `[ContextArmor UNPARSED_INSTALL] Unrecognized package installation command structure or flags. Confirm installation?` |

**Verification**: Zero silent `ALLOW` on unparsed install commands. All unparsed or direct sources route to `ASK`.

---

### 11.6 Latency Benchmark (100-Dependency Manifest)

```bash
Initial Run (Cold): 78207.6ms (Exit: 2)
Warm Runs (15 iterations):
  Min: 417.2ms
  p50: 461.4ms
  p95: 541.4ms
  Max: 541.4ms
  Budget Warm p95 < 3s: PASS
```
Warm p95: **541.4ms** (< 3000ms budget).

---

### 11.7 Playwright Score Breakdown
```bash
node dist/cli.js check playwright
```
Raw Output:
```
[ContextArmor] Auditing npm package: 'playwright'...
Risk Level: LOW (Score: 25/100)
Block Recommended: NO

Detected Signals Breakdown:
  - [latest_version_cooldown] Raw Score: 25/100, Weight: 0.08: New version published less than 24h ago (3.9 hours ago). Potential version hijack or unvetted release.
```
- Signal: `latest_version_cooldown` (Raw Score: 25, Weight: 0.08).
- "Zero Dependents" Signal: Sourced from `api.deps.dev/v3/systems/{sys}/packages/{name}` (`dependentProjectsCount`). Returns 60 score with weight 0.15 only when `dependentProjectsCount === 0`.
