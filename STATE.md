## 1. Verified System State (Phase 1 Gate Output)

- **Verification Timestamp**: 2026-10-11T04:09:49Z
- **Git Commit**: `afad96cb04a0d41f92460601b0c3fbddbfbcb95e`
- **CLI Binary (`dist/cli.js`) SHA256**: `514409a9002c03e1db56ca310c6cb9b3b6618cdde5efa7b5f299bb21b011a342`
- **Repository Working Tree**: Clean (`git status --porcelain` empty)

### Test 1: Typecheck & Build Integrity
- `npx tsc --noEmit`: Exit Code 0
- `node esbuild.js`: Exit Code 0
- `jq .dependencies package.json`: `{}` (Zero production runtime dependencies)
- *Evidence File*: [`evidence/raw/01_typecheck.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/01_typecheck.txt)

### Test 2: Hook Unit Tests (Payload Shapes)
- **Claude Code Payload**: Allow (exit 0, empty stdout), Ask (`permissionDecision: ask`, exit 0), Block (`permissionDecision: deny`, exit 2)
- **Antigravity Payload**: Allow (exit 0, empty stdout), Ask (`decision: ask`, exit 0), Block (`decision: deny`, exit 2)
- **Cursor Payload**: Allow (exit 0, empty stdout), Ask (`permission: ask`, exit 0), Block (`permission: deny`, exit 2)
- *Evidence File*: [`evidence/raw/02_hook_unit_tests_payload_shapes.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/02_hook_unit_tests_payload_shapes.txt)

### Test 2b: Typosquatting Adoption Gate Verification
- **Clean Popular Packages**: `globby`, `glob`, `got`, `ms`, `nanoid`, `chai`, `pug`, `ws`, `six` evaluated clean (SAFE, Score 0/100, Block: NO)
- **Typosquats Dispatched to ASK**: `reqeusts` (pypi), `lodsh` (npm), `tnsorflow` (pypi) flagged with WARNING tier (Block: NO -> ASK)
- *Evidence File*: [`evidence/raw/02b_typosquat_and_adoption_tests.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/02b_typosquat_and_adoption_tests.txt)

### Test 3: 19-Command Slip Matrix & Log Accountability
- **Commands Tested**: 19 / 19
- **Unlogged Calls (`NO_LOG_LINE`)**: 0 (Zero unlogged calls permitted)
- **Evasion unwrapping**: Subshell wrappers, `eval`, `xargs`, command substitutions unwrapped recursively
- **Depth limit**: 6-deep nested subshell caught and dispatched to `ASK`
- *Evidence File*: [`evidence/raw/03_slip_matrix.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/03_slip_matrix.txt)

### Test 4: Lockfile Diff & OSV Vulnerability Intercept
- **Lockfile Formats Tested (6/6)**: `package-lock.json` (nested), `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `poetry.lock`, `requirements.txt`
- **npm Malicious Intercept**: `chalk@5.6.1` blocked via OSV `MAL-2025-46969` (exit code 2)
- **PyPI Malicious Intercept**: `durabletask@1.4.2` blocked via OSV `MAL-2026-4174` (exit code 2)
- *Evidence File*: [`evidence/raw/04_lockfile_diff.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/04_lockfile_diff.txt)

### Test 5: 72-Hour Cooldown Rule Verification
- **Case 1 (Fresh popular version < 72h)**: `express` published < 72h ago intercepted with `ASK`
- **Case 2 (Same version in HEAD lockfile)**: Suppressed by git HEAD lockfile presence -> clean `ALLOW`
- **Case 3 (Pinned old version > 72h)**: `chalk@4.1.2` released > 72h ago -> clean `ALLOW`
- *Evidence File*: [`evidence/raw/05_cooldown_rules.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/05_cooldown_rules.txt)

### Test 6: Latency Benchmarks & Warm Cache Reconciliation
- **Cold 100-Dependency Run (npm)**: 5426ms (0 deny)
- **Cold 100-Dependency Run (PyPI)**: 4055ms (0 deny)
- **Cold 3-Dependency Run**: 2094ms,
- **Warm 50-Run Benchmark (3-Dep Manifest)**:
  - **Min**: 61ms
  - **Max**: 72ms
  - **Avg**: 63.1ms
  - **p50**: 63ms
  - **p95**: 66ms
- **Warm Cache Reconciliation**: Prior 432ms average occurred because `evaluateBatch` bypassed disk cache writes due to `skipEnrichment: true` and lacked an upfront disk cache check. Fixed by reading disk cache before issuing network calls and persisting enriched metadata to disk cache. Warm runs now execute without network round-trips.
- *Evidence File*: [`evidence/raw/06_latency_benchmarks.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/06_latency_benchmarks.txt)

### Test 7: Diagnostics, Doctor & Canary
- **Playwright Diagnostic**: Evaluated clean (Score 25/100, LOW risk; points for install scripts on popular package; not blocked)
- **Doctor Canary 1 (Malicious Package)**: Intercepted `chalk@5.6.1` with `BLOCK` (exit 2)
- **Doctor Canary 2 (Config Tamper Attempt)**: Intercepted write to `.claude/settings.json` with `BLOCK` (exit 2)
- **Doctor Canary 3 (Audit Log Deletion)**: Intercepted deletion of `~/.contextarmor/decisions.log` with `BLOCK` (exit 2)
- **Zero Bypass Toggles in Codebase**: `grep` confirmed 0 occurrences of `CONTEXTARMOR_DISABLE` and `contextarmor_disable` in `src/`
- **Agent Deny Rules Protected**: Configured with `Edit(path)` syntax in `.claude/settings.json` and `.agents/hooks.json`
- *Evidence File*: [`evidence/raw/07_diagnostics_and_doctor.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/07_diagnostics_and_doctor.txt)

### Test 7b: Self-Protection Tamper Interception Suite
- **Negative Tamper Attempts (8/8 Intercepted)**: Commands writing to `.claude/settings.json`, `.agents/hooks.json`, and `~/.contextarmor/**` via `cp`, `python3 -c`, `sed -i`, `tee`, `cd .claude && echo >> settings.json`, `git checkout --`, `rm decisions.log`, or globs intercepted with BLOCK (exit code 2)
- **Positive Inspection Commands (3/3 Allowed)**: `cat`, `ls -la`, and `git diff` cleanly allowed (exit code 0)
- *Evidence File*: [`evidence/raw/07b_self_protection.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/07b_self_protection.txt)

### Test 8: Client Control Pairs with Safety Shim
- **Safety Shim Verification**: `PATH="/tmp/shim:$PATH"` shims `npm` and `pip` to log directly to `/tmp/shim/ran.log`
- **Claude Code Control A (Hook Disabled)**: Shim records execution line in `/tmp/shim/ran.log`
- **Claude Code Control B (Hook Wired)**: Intercepted with `BLOCK` (exit 2); `/tmp/shim/ran.log` remains empty; `decisions.log` records BLOCK
- **Live Real Claude CLI (`claude -p`) Run**: Transcript captures model receiving circuit breaker block for `chalk@5.6.1` and explaining reasons to user
- **Interactive Claude Session (tmux)**: Labelled `NOT RUN (human interactive session; automated runner captures non-interactive -p and --dangerously-skip-permissions)`
- **Antigravity Control A (Hook Disabled)**: Shim records execution in `/tmp/shim/ran.log`
- **Antigravity Control B (Hook Wired)**: Intercepted with `BLOCK` / `ASK`; `/tmp/shim/ran.log` remains empty
- *Evidence File*: [`evidence/raw/08_client_control_pairs.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/08_client_control_pairs.txt)

### Test 9: ASK Behavior & Unattended Policy Matrix
- **Interactive / Attended Mode**: Claude Code emits `ask` (exit 0), Antigravity emits `ask` (exit 0), Cursor emits `ask` (exit 0)
- **Claude Code `bypassPermissions`**: Payload `permission_mode: bypassPermissions` maps `ASK` to `deny` (exit 2)
- **Unattended Mode (`CONTEXTARMOR_UNATTENDED=1`)**: Claude Code, Antigravity, and Cursor map `ASK` to `deny` (exit 2)
- *Evidence File*: [`evidence/raw/09_ask_and_unattended_policy.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/09_ask_and_unattended_policy.txt)

### Test 10: Benchmark Evaluation Suite (FPR and Recall Integrity)
- **Overall Corpus**:   block_FPR: 0.0% (0/62) [3/n upper bound: 4.84%] | alert_FPR: 8.1% (5/62)
- **Single Decision Function**: Hook and Eval share `classifyDecision` from `src/detectors/packageRisk/index.ts` (zero private thresholds in `src/eval/`)
- *Evidence File*: [`evidence/raw/10_eval.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/10_eval.txt)

### Test 11: Fault Injection Suite (Network Timeouts, 429/503, OSV Failure)
- **Case (a) Registry Timeout**: `npm i express`, `npm i nope-xyz-9`, `npm i chalk@5.6.1` -> all dispatched to `ASK` with `[UNCHECKED]` warning (exit 0, none BLOCK, none ALLOW)
- **Case (b) OSV Service Down**: `npm i chalk@5.6.1` -> dispatched to `ASK` with `[UNCHECKED] OSV advisory check failed` warning
- **Case (c) Registry 429 and 503**: Dispatched to `ASK` with `[UNCHECKED]` warning
- **Case (d) Real HTTP 404 (Network Up)**: `npm i nope-xyz-9` -> `BLOCK` on confirmed unregistered hallucination (exit 2)
- *Evidence File*: [`evidence/raw/11_fault_injection.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/11_fault_injection.txt)

### Test 12: Outage Latency Verification (20s Hard Ceiling)
- **Black-Hole Outage Condition**: Injected non-resolving fetch in test code capped at 20s budget
- **Measured Hook Duration**: 20005 ms (Capped at 20s overall budget)
- **Fail-Open Policy**: Dispatched to `ASK` (exit code 0) explicitly listing unchecked packages: `[ContextArmor TIMEOUT] Package evaluation exceeded budget. The following packages could not be verified: [express]. Confirm installation?`
- *Evidence File*: [`evidence/raw/12_outage_latency.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/12_outage_latency.txt)

### Evidence Files SHA256 Verification Table

| File | SHA256 Hash |
| :--- | :--- |
| [`00_header.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/00_header.txt) | `44ccc91c50bfeccd634c9c82dba71c63ba483ce4895648f6a5dc355c7a8b90fd` |
| [`01_typecheck.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/01_typecheck.txt) | `6d34e95f36a64915b557270da4e525402e7d94aae8bea6cd6e79de9d7a99e83b` |
| [`02_hook_unit_tests_payload_shapes.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/02_hook_unit_tests_payload_shapes.txt) | `62a46979e2545490c3ab4a2a2b224796a057ec38e0e735dfd486116dafc53ab0` |
| [`02b_typosquat_and_adoption_tests.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/02b_typosquat_and_adoption_tests.txt) | `4fbc5a29bc4700a2ce7becdc9bc8fd7fc16958dd97ac7e993d42bf20edeea651` |
| [`03_slip_matrix.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/03_slip_matrix.txt) | `fd467916f6cb44008dca70769f58312d66673202abb5b23d88dfe070e39c696a` |
| [`04_lockfile_diff.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/04_lockfile_diff.txt) | `417220ca5103cbec69e21cda40f247ec4ab24aedd7c20b985285e31ddc9c0959` |
| [`05_cooldown_rules.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/05_cooldown_rules.txt) | `5ecd9b0ffe53da1398921d700f3c555739512820e7eeb784b31895b0bb463756` |
| [`06_latency_benchmarks.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/06_latency_benchmarks.txt) | `41daecfc0b10be20b628c8292e9ecd07246cc90ae547d1a69204b29caccee8ac` |
| [`07_diagnostics_and_doctor.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/07_diagnostics_and_doctor.txt) | `40429df9e25877d90b23e9c368e1ba50b4d501388f364a34c7d075f810ebd158` |
| [`07b_self_protection.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/07b_self_protection.txt) | `f7ed9d274112adea3247a9313da28b59d1df0c2b51ecd930232ea491a360846b` |
| [`08_client_control_pairs.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/08_client_control_pairs.txt) | `ae4ec50817972c744e737110a02e71cb0339cda8c5bc2c327583c1bffe779b1d` |
| [`09_ask_and_unattended_policy.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/09_ask_and_unattended_policy.txt) | `f802008cb92cc6e36d2f1cdbac7f4d46630ce14dc5462d4a2e4d4092b47a31b7` |
| [`10_eval.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/10_eval.txt) | `c34d53feec2fdc06591e88db5139fc012043c51060e694533c8a4577a5ad14bd` |
| [`11_fault_injection.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/11_fault_injection.txt) | `f01ee4ef822401005e6634c15e9068c2addec0a8adecbc057f4f29b702b19bf8` |
| [`12_outage_latency.txt`](file:///Users/nufoos/dev-projects/ContextArmor/evidence/raw/12_outage_latency.txt) | `e9f93e6bfb00f200d375c351434a26d6aab20edd9a2e0639f6c3a65e8cd0badd` |
