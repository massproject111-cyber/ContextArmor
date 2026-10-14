# ContextArmor Engineering Plan (V3)

---

## 1. System State & Verification Architecture

All empirical test outcomes, latency benchmarks, raw evidence hashes, and runtime measurements are dynamically generated into [`STATE.md`](file:///Users/nufoos/dev-projects/ContextArmor/STATE.md) directly from raw execution artifacts in `evidence/raw/` via `scripts/gen-state.sh`.

Refer to [`STATE.md`](file:///Users/nufoos/dev-projects/ContextArmor/STATE.md) for current gate execution data, commit hash citations, and artifact integrity checksums.

---

## 2. Threat Model & Security Architecture

ContextArmor sits on the boundary between AI autonomous agent execution and the developer host operating system.

### Adversary & Failure Vectors
1. **AI Slopsquatting / Hallucination Exploitation**: LLMs frequently invent non-existent package names. Adversaries monitor LLM hallucination dumps and register these package names on npm and PyPI containing credential stealers.
2. **Typosquatting & Impersonation**: Malicious actors register variations of high-adoption packages (e.g., `cross-env` vs `crossenv`, `colorama` vs `colorma`). ContextArmor measures length-scaled Levenshtein distance against known top ecosystems.
3. **Account Hijacking & Compromised Releases**: Legitimate maintainer accounts compromised via stolen tokens or phishing to release trojanized updates (e.g., `chalk@5.6.1` via OSV `MAL-2025-46969`, `durabletask@1.4.2` via OSV `MAL-2026-4174`).
4. **Shell Evasion & Wrapper Bypasses**: Agents attempting to run package managers via `bash -c`, `eval`, `$(...)`, subshells, or piped `xargs`. ContextArmor recursively unwraps commands up to depth limit five.
5. **Direct Source Bypasses**: Agents running `pip install ./local`, `npm i git+https://...`, or tarball URLs bypassing registry scrutiny. ContextArmor dispatches all direct sources to `ASK`.
6. **Agent Self-Tampering**: Autonomous agents modifying client configuration files (`.claude/settings.json`, `.agents/hooks.json`) or tampering with audit logs (`~/.contextarmor/decisions.log`). Intercepted at PreToolUse with exit code two and hardened by client deny rules using `Edit(path)` syntax.

---

## 3. Locked Technical Decisions

1. **Decision 1: Engine Architecture**: Single core engine shared across CLI, PreToolUse hook, and evaluation runner. Client adapters (Claude Code, Cursor, Antigravity) are lightweight protocol adapters.
2. **Decision 2: Zero Production Dependencies**: Single bundled binary `dist/cli.js` executed on stock Node.js with `node:util` `parseArgs`. `package.json` production `"dependencies"` is strictly `{}`.
3. **Decision 3: Fail-Open vs. Fail-Closed Policy**:
   - Fail-open ONLY on timeout (elapsed hook budget exceeded) with visible `ASK` listing unchecked packages.
   - Fail-closed (`BLOCK`) on confirmed OSV `MAL-` records, unverified registry existence, dead name hallucinations, and self-tampering attempts.
4. **Decision 4: Tier Mapping**: Two operational tiers: `BLOCK` (exit code two, tool execution prevented) and `ASK` (confirmation requested with reason, exit zero interactive, downgraded to `BLOCK` exit two in unattended / bypassPermissions mode). Clean installs emit nothing and exit zero.
5. **Decision 5: MAL in Resolved Tree = BLOCK**: Any dependency in a resolved manifest or lockfile matching a known OSV `MAL-` advisory triggers immediate `BLOCK`.
6. **Decision 6: Human Allowlist Pinned name@version**: Human override allowlist (`~/.contextarmor/allowlist.json`) requires exact pinned `name@version` entries, preventing unvetted updates or supply chain drift under allowlisted names.
7. **Decision 7: Init Suggest-Only**: `contextarmor init` does not unilaterally mutate client configuration files; it inspects current configurations and outputs exact suggested configuration snippets for the developer to inspect and apply.
8. **Decision 8: Adapter Failures Dispatch to ASK**: If a client tool call payload cannot be parsed into known command fields, the hook logs `ADAPTER_FAIL` and returns `ASK` with visible warning; it never silently allows unparsed payloads.
9. **Decision 9: Unparsed Install Token Dispatches to ASK**: If a package manager command contains install verbs/tokens (`install`, `add`, `i`) but argument structure or flags cannot be parsed, the hook logs `UNPARSED_INSTALL` and dispatches to `ASK`.
10. **Decision 10: Typosquatting ASK-Only with Adoption Gate**: Levenshtein similarity to top popular packages triggers `ASK` (WARNING tier), not `BLOCK`. Candidates with established adoption (high weekly downloads, age, or dependents) suppress typosquat signals.
11. **Decision 11: 72-Hour Cooldown Rule**: Any newly added or changed dependency vs git HEAD lockfile whose version release date is less than seventy-two hours ago triggers `ASK`. If the exact package version was already recorded in the git HEAD lockfile, cooldown checking is suppressed.
12. **Decision 12: Defense Against Agent Self-Tampering**: Writes targeting `.claude/settings.json`, `.agents/hooks.json`, and `~/.contextarmor/**` via shell commands (`cp`, `tee`, `sed`, `rm`, `git checkout`, `python3`, subshells, or globs) are intercepted with `BLOCK` (exit two).

---

## 4. Phase Plan

### Phase 1: Phase 1 Exit Gate Review
- Scope strictly bounded to Phase 1 validation. Code frozen and tested via `scripts/p1-gate.sh`.
- Stop at P1 exit gate. Do not begin Phases two through six until reviewer signoff.

---

### Phase 2: Static MCP Config Linter
- **Goal**: Validate Model Context Protocol (MCP) server definitions (`claude_desktop_config.json`, `.claude/settings.json`, Cursor MCP configs) against command injection, missing environment variables, and unpinned binary execution.
- **Files**: `src/detectors/mcpLinter/index.ts`, `src/detectors/mcpLinter/rules.ts`, `src/cli/commands/lintMcp.ts`.
- **Acceptance Command & Expected Output**:
  - `node dist/cli.js lint-mcp -p tests/fixtures/mcp_insecure.json` -> reports `HIGH: Unpinned npx execution detected` with exit code one.
  - `node dist/cli.js lint-mcp -p tests/fixtures/mcp_secure.json` -> reports clean with exit code zero.
- **FP Risk**: Low (static structural analysis against concrete security rules).
- **Estimated Effort**: Six hours.
- **Dependencies**: Phase 1 CLI infrastructure.
- **Exit Gate**: Test suite covering malicious vs secure MCP configurations with zero false positives on standard reference configs.

---

### Phase 3: Registry Cache, Fast Path & Offline Mode
- **Goal**: Hermetic local evaluation cache, disk LRU cache management, offline mock registry server for reproducible tests without live network round-trips.
- **Files**: `src/detectors/packageRisk/cacheManager.ts`, `src/detectors/packageRisk/mockRegistry.ts`.
- **Acceptance Command & Expected Output**:
  - `npm test tests/cache.test.ts` -> all tests pass with exit code zero; warm lookup latency remains sub-fifty milliseconds without network requests.
- **FP Risk**: Zero (purely caching and test harness).
- **Estimated Effort**: Eight hours.
- **Dependencies**: Phase 1 RegistryClient and disk cache.
- **Exit Gate**: Complete offline test run with disconnected network interface completing in under five seconds.

---

### Phase 4: Init Command & Automated Integration
- **Goal**: Interactive client setup checker for Claude Code, Cursor, and Antigravity.
- **Files**: `src/cli/commands/init.ts`, `src/cli/commands/doctor.ts`.
- **Acceptance Command & Expected Output**:
  - `node dist/cli.js init --dry-run` -> outputs exact suggested hook JSON for detected installed clients with exit code zero.
- **FP Risk**: Zero (suggest-only, does not alter security decisions).
- **Estimated Effort**: Five hours.
- **Dependencies**: Phase 1 Client Adapters.
- **Exit Gate**: Successful dry-run execution across clean macOS, Linux, and Windows path structures.

---

### Phase 5: Advanced Supply Chain Attack Detectors
- **Goal**: Detection of package install scripts on low-adoption packages, hidden transitive dependencies, and suspicious author account handoffs.
- **Files**: `src/detectors/packageRisk/scriptAuditor.ts`, `src/detectors/packageRisk/authorTracker.ts`.
- **Acceptance Command & Expected Output**:
  - `node dist/cli.js check suspicious-pkg` -> outputs `WARNING: Suspicious install script on unvetted author` with exit code zero.
- **FP Risk**: Medium (mitigated by download volume threshold and maturity gates).
- **Estimated Effort**: Twelve hours.
- **Dependencies**: Phase 1 Risk Engine.
- **Exit Gate**: Evaluation against historical malware samples with high recall and minimal false positives on top popular packages.

---

### Phase 6: Packaging, Distribution & Documentation
- **Goal**: Unpark VS Code extension (`src/extension.ts`, `src/ui/**`), package npm bundle `@contextarmor/cli`, and document release workflows.
- **Files**: `package.json`, `README.md`, `src/extension.ts`.
- **Acceptance Command & Expected Output**:
  - `npm pack --dry-run` -> produces clean tarball under five hundred kilobytes; `npx tsc --project tsconfig.extension.json` -> exit code zero.
- **FP Risk**: Zero.
- **Estimated Effort**: Ten hours.
- **Dependencies**: Phases one through five.
- **Exit Gate**: Clean installation from tarball on a fresh system with zero external npm dependencies.

---

## 5. Parked & Cut Features

1. **Parked: VS Code Extension UI**:
   - Files: `src/extension.ts`, `src/ui/**`.
   - Rationale: Excluded from compilation (`tsconfig.json`) to keep CLI zero-dependency and lightweight. Will be restored in Phase 6 as a separate packaging target.
2. **Cut: Heuristic Zero Dependents Signal**:
   - Replaced by authoritative download metrics and first-release registration age.
3. **Cut: Global Bypass Environment Variables**:
   - `CONTEXTARMOR_DISABLE` and `/tmp/contextarmor_disable` permanently removed from shipping code to eliminate agent tampering paths.

---

## 6. Execution Instructions

Every operational claim in Phase 1 is backed by raw output files captured under `evidence/raw/` by `scripts/p1-gate.sh`. To reproduce:
```bash
./scripts/p1-gate.sh
./scripts/gen-state.sh
```
