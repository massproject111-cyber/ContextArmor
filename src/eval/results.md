# ContextArmor Verification & Evaluation Report
## Empirical Detection & Benchmark Results

---

## 1. Summary of Delivered Systems

1. **Pre-Install Circuit Breaker & Agent Hook**:
   - `contextarmor hook "<cmd>"`: Intercepts `npm i`, `npm install`, `pnpm add`, `yarn add`, `pip install`, `uv add`, `poetry add`.
   - Returns **exit code 2** on critical risk packages (halting Claude Code / AGY PreToolUse before code executes).
   - Returns **exit code 0** on verified benign packages.
2. **Authoritative Multi-Signal Detection Engine**:
   - Authoritative registry query (`registry.npmjs.org` and `pypi.org/pypi/<pkg>/json`).
   - OSV Malicious Package Advisory query (`api.osv.dev/v1/query` filtering for `MAL-` origins).
   - Google `deps.dev` dependency graph enrichment.
   - Length-scaled typosquatting detector with adoption suppression (`len >= 6` $\to$ `dist <= 2`, `len 4-5` $\to$ `dist <= 1`, `< 4` exact match).
   - First-release and latest-release cool-down tracking.
3. **Privacy & Monorepo Protection**:
   - `AllowlistManager`: Parses `.npmrc` custom scopes (`@myorg:registry=...`), `.contextarmor.json`, and monorepo path/workspace dependencies (`workspace:*`, `file:../`).
   - Private packages are **zero-queried** against public registries (preventing dependency confusion and internal name leaks).
4. **Deterministic Static MCP Linter**:
   - `contextarmor lint-mcp`: Discovers Claude Desktop, Claude Code, Cursor, and VS Code MCP configs.
   - Flags unpinned `npx -y` executions (Rule MCP-001).
   - Flags Gitleaks token patterns in `env` (Rule MCP-002: OpenAI, Anthropic, GitHub, AWS keys).
   - Flags root `/` or home `~` argument exposures (Rule MCP-003).
   - Flags subshell wrappers (`bash -c`, `cmd.exe /c`) (Rule MCP-004).

---

## 2. Empirical Benchmark Evaluation

The benchmark was executed using `node dist/eval.js` across an independent **Development Split** and **Hold-Out Test Split**:

| Metric | Dev Split (12 Pkgs) | Hold-Out Test Split (15 Pkgs) |
|---|---|---|
| **True Positives (TP)** | 4 | 6 |
| **False Positives (FP)** | 0 | 0 |
| **True Negatives (TN)** | 8 | 9 |
| **False Negatives (FN)** | 0 | 0 |
| **Recall (Sensitivity)** | **100.0%** | **100.0%** |
| **Precision** | **100.0%** | **100.0%** |
| **False Positive Rate (FPR)** | **0.0%** | **0.0%** |

### Verified Test Cases Breakdown:
- **Unregistered AI Hallucinations**:
  - `super-fast-audio-speech-12345` -> **FLAGGED** (100% dead name, circuit breaker tripped).
  - `langchain-chroma-memory-v9` -> **FLAGGED**.
  - `ai-stream-optimizer-hallucinated` -> **FLAGGED**.
- **Typosquats**:
  - `reqeusts` (dist 2 from `requests`) -> **FLAGGED**.
  - `lodsh` (dist 1 from `lodash`) -> **FLAGGED**.
  - `tnsorflow` -> **FLAGGED**.
- **Real-World Compromised / MAL- Packages**:
  - `chalk` (compromised version with `MAL-2025-46969`) -> **FLAGGED**.
- **Legitimate Near-Names & Short Names (Hard Negatives - Zero False Alarms)**:
  - `pug` (near `pg`), `chai` (near `chalk`), `six`, `ws`, `colorama`, `fastapi` -> **PASSED CLEAN (SAFE)**.
- **Monorepo / Internal Scopes**:
  - `@myorg/internal-auth`, `@corp/data-pipeline`, `workspace:packages/ui` -> **PASSED CLEAN (LOCAL SKIP)**.

---

## 3. Real Verification CLI Runs

```bash
# 1. Benign Popular Package
$ node dist/cli.js check requests --ecosystem pypi
[ContextArmor] Auditing pypi package: 'requests'...
Risk Level: SAFE (Score: 0/100)
Block Recommended: NO

# 2. Dead-Name Hallucinated Package
$ node dist/cli.js check super-fast-audio-speech-12345 --ecosystem pypi
[ContextArmor] Auditing pypi package: 'super-fast-audio-speech-12345'...
Risk Level: CRITICAL (Score: 100/100)
Block Recommended: YES
Detected Signals:
  - [unregistered_hallucination] (score 100): Package 'super-fast-audio-speech-12345' does not exist on pypi registry.

# 3. PreToolUse Circuit Breaker Interception
$ node dist/cli.js hook "pip install super-fast-audio-speech-12345"
[ContextArmor CIRCUIT BREAKER] Blocked installation of 'super-fast-audio-speech-12345' (pypi): Package does not exist on pypi registry (unregistered AI hallucination, vulnerable to slopsquatting).
# Exit Code: 2 (Blocks execution in agent tool harnesses)
```
