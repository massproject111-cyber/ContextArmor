# ContextArmor

Deterministic AI Supply Chain Defense & Pre-Execution Circuit Breaker for AI Coding Agents.

ContextArmor intercepts package installation commands and manifest modifications initiated by autonomous coding agents (Claude Code, Google Antigravity, Cursor) before shell execution, blocking unregistered AI hallucinations, slopsquatting, typosquats, and poisoned supply-chain packages.

---

## 1. What It Blocks (CRITICAL Tier / Exit Code 2)

ContextArmor triggers an immediate **BLOCK** (`exit 2`, circuit breaker message returned to model) under the following conditions:

1. **Unregistered AI Hallucinations / Slopsquats (`lookupState === 'NOT_FOUND'`)**:
   - Any package returning HTTP 404 from the authoritative registry (`registry.npmjs.org` or `pypi.org`).
   - Prevents AI hallucinations from being squatted by malicious actors after generation.
2. **Confirmed Malicious Packages (OSV `MAL-` Hits)**:
   - Any package version with active Open Source Vulnerability advisories with IDs matching `MAL-*` or `OSV-MAL-*` (e.g., `MAL-2025-46969` for `chalk@5.6.1`).
3. **Typosquats with Low Adoption or Fresh Publication**:
   - Package name within edit distance 1–2 of a top ecosystem package AND either:
     - First release published $< 30$ days ago, OR
     - Weekly downloads $< 1000$.
4. **Suspicious Lifecycle Install Scripts**:
   - Packages executing `preinstall`/`postinstall` hooks that are young ($< 30$d) or have low weekly downloads ($< 1000$).
   - Note: Established packages with high adoption (e.g., `esbuild`, `sharp`, `puppeteer`) are permitted.
5. **Direct Configuration & Audit Log Tampering**:
   - Commands attempting to modify `.claude/settings.json`, `.agents/hooks.json`, or delete `~/.contextarmor/decisions.log` are intercepted and blocked.
6. **Unattended Mode Escalations**:
   - When running in unattended mode (`permission_mode: bypassPermissions` or `CONTEXTARMOR_UNATTENDED=1`), any condition that would prompt with `ASK` is escalated to `deny` (`exit 2`).

---

## 2. What Prompts for Confirmation (WARNING / ASK Tier / Exit Code 0)

In interactive / attended mode, ContextArmor dispatches to **ASK** (`permissionDecision: ask`, exit code 0) so the developer can make an informed decision:

1. **72-Hour Version Cooldown Rule**:
   - Any newly added or updated package version published $< 72$ hours ago.
   - **Suppression**: Cleanly allowed without prompt if the exact `name@version` is already recorded in the git `HEAD` lockfile.
   - **Guidance**: Reports package version and age, newest version older than 72h, and suggested pin command (e.g., `npm i pkg@1.0.0` or `pip install pkg==1.0.0`).
2. **Typosquat Similarity on Established Packages**:
   - Packages close in edit distance ($\le 2$) to a popular package that have verified high adoption ($\ge 1000$ weekly downloads and $> 30$ days age, such as `globs`, `chalker`, `colorsys`, `clack`, `rimraf2`).
3. **Direct Local, Git, and Archive Sources**:
   - Relative paths (`./local`, `../dep`), absolute paths (`/abs/path`), `git+https://` repositories, or `.tar.gz` URLs.
4. **Registry Network Degradation or Service Outages**:
   - HTTP 429 (rate limit), 500/503 (server error), connection timeouts, or DNS failures after 1 retry. Lists unchecked packages explicitly.
5. **Deeply Nested Shell Wrappers**:
   - Subshell / evaluation nesting exceeding depth limit ($> 5$ wrappers deep).
6. **Unrecognized Package Manager Commands**:
   - Syntax or flags that cannot be unambiguously parsed.

---

## 3. What It Cannot See (Blind Spots & Limitations)

ContextArmor operates as a pre-tool-use command inspector. It does not replace an OS-level sandbox or network proxy:

1. **Shell Script Files**:
   - Commands like `bash script.sh`, `sh install.sh`, or `./deploy.sh` where package installation commands are buried inside external files.
2. **Piping Web Downloads to Shell**:
   - Commands like `curl -sSL https://... | sh` or `wget -qO- https://... | bash`.
3. **Inline Interpreter Execution**:
   - Commands executing package managers via Python or Node runtimes:
     - `python -c "import pip; pip.main(['install', '...'])"`
     - `python3 -c "import os; os.system('npm i ...')"`
4. **Absolute Binary Invocations**:
   - Bypassing PATH wrappers using absolute binary paths (e.g., `/usr/local/bin/npm install ...`) if client hooks do not route them.
5. **Transitive Dependencies**:
   - ContextArmor inspects direct targets in the command line or manifest diff. Dependencies pulled in transitively by a legitimate package require lockfile diffing or proxy firewall inspection.
6. **Hallucinated Names Pre-Registered with Fake Metadata**:
   - If an attacker anticipated an AI hallucination and published the package $> 30$ days ago with fabricated download numbers, it cannot be distinguished from a benign mid-tail package by metadata alone.

---

## 4. Fail-Open Policy

To prevent development deadlocks during third-party infrastructure outages:

- **20-Second Hard Timeout Budget**:
  - The overall hook execution has a strict 20,000 ms ceiling.
  - If registries or APIs hang, ContextArmor aborts and fails open to `ASK` (in interactive mode) or `deny` (in unattended mode), explicitly listing all unchecked packages.
- **Fail-Open on Non-Install Commands**:
  - Non-package-manager commands (`git`, `cargo`, `docker`, build tools) exit 0 cleanly with empty output.
- **Fail-Closed on Definite Threats**:
  - Confirmed 404s and confirmed OSV `MAL-` records always fail closed (`BLOCK`).

---

## 5. Client Hook Support Matrix

| Client / Agent | Hook Mechanism | Official Documentation | Status |
| :--- | :--- | :--- | :--- |
| **Claude Code** (Anthropic) | `.claude/settings.json` `hooks.PreToolUse` matching `Bash` | [Claude Code Hooks Docs](https://code.claude.com/docs/en/hooks) | Supported & Verified |
| **Google Antigravity** | `.agents/hooks.json` `hooks.PreToolUse` matching `run_command` | [Google Antigravity Documentation](https://antigravity.google/docs/hooks) | Supported & Verified |
| **Cursor** | `.cursor/rules` / beforeShellExecution hook | [Cursor Documentation](https://cursor.com/docs/hooks) | Supported Schema |

### Hook Configuration Examples

#### Claude Code (`.claude/settings.json`)
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "command": "node /path/to/dist/cli.js hook"
      }
    ]
  }
}
```

#### Antigravity (`.agents/hooks.json`)
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_command",
        "command": "node /path/to/dist/cli.js hook"
      }
    ]
  }
}
```

---

## 6. Threat Model & Agent-Writable Boundaries

### 6.1 Attack Surface
Coding agents with tool capabilities (`replace_file_content`, `write_to_file`, bash commands) have filesystem access within their workspace and user environment. This presents specific risks:
- **Hook Disarming**: Agent editing `.claude/settings.json` or `.agents/hooks.json` to remove the security hook.
- **Cache Poisoning**: Agent writing directly to `~/.contextarmor/cache` to fabricate clean metadata.
- **Log Destruction**: Agent deleting `~/.contextarmor/decisions.log` to erase audit trails.

### 6.2 Recommended Agent Deny Rules
To defend against agent self-modification, client-level deny rules must be enforced:

```json
{
  "permissions": {
    "deny": [
      "Edit:.claude/settings.json",
      "Edit:.agents/hooks.json",
      "Edit:~/.contextarmor/*",
      "Write:~/.contextarmor/*"
    ]
  }
}
```

> **Boundary Notice**: Deny rules cover project files and specified security configuration paths only. ContextArmor cannot prevent an agent from invoking arbitrary OS syscalls if the client runtime grants unconfined shell access.

---

## 7. Diagnostics & Environment Verification

Run `contextarmor doctor` to verify hook configurations and file permissions:
```console
$ node dist/cli.js doctor
[ContextArmor Doctor] Auditing environment and hook configurations...

[OK] Claude Code Hook (.claude/settings.json): Wired: YES, Hash: bd29298e76f80869
[OK] Antigravity Hook (.agents/hooks.json): Wired: YES, Hash: ea75830056a220c6
[OK] Decisions Directory (~/.contextarmor): Mode: 700 (Recommended: 700)

Doctor check complete.
```

---

## 8. Prospective Package Collector & Cron Setup

ContextArmor includes an automated prospective metadata collector (`scripts/collect-prospective.mjs`) to monitor newly registered packages in real-time across both npm and PyPI:
- **npm feed**: Polls `replicate.npmjs.com/_changes`
- **PyPI feed**: Polls `pypi.org/rss/packages.xml`
- **Metadata snapshot**: Captures initial package metadata at first sight into `data/prospective/YYYY-MM-DD.json`.

### Periodic Polling via Cron (Manual Setup Only)

To run the collector on an automated recurring schedule without manual intervention, configure a user crontab entry:

```bash
# Edit crontab
crontab -e
```

Add the following schedule (e.g. running once every hour):

```cron
# Poll npm and PyPI new package feeds every hour at minute 0
0 * * * * cd /Users/nufoos/dev-projects/ContextArmor && node scripts/collect-prospective.mjs >> /tmp/contextarmor-prospective.log 2>&1
```

> **Notice**: Do not install this cron job automatically in automated agent environments. Configure only on dedicated ingestion hosts with explicit operator authorization.
---
---

## 9. Evaluation Results & Benchmark Metrics

All metrics below are generated directly from machine-recorded evaluation runs stored in `data/eval/holdout_result.json` and `data/eval/holdout_noosv_result.json`.

> [!WARNING]
> **Holdout Dataset Usage Notice**: The holdout split was used twice, detector changed between, corpus v2 filter applied after first look.

### 9.1 Holdout Benchmark Summary (Offline Pinned Clock)

| Metric | Holdout Run 1 (OSV On)<br>hash: `97ccd64f6562...`<br>($n=1537$) | Holdout Second Look (`--no-osv` Heuristics Only)<br>hash: `87b441e55fed...`<br>($n=1533$) |
| :--- | :--- | :--- |
| **Total Evaluated Packages ($n$)** | 1537 | 1533 |
| **Benign Samples ($n_{benign}$)** | 1024 | 1020 |
| **Malicious Samples ($n_{mal}$)** | 513 | 513 |
| **Block FPR (False Blocks on Benign)** | **0.5%** (5/1024) | **0.1%** (1/1020) |
| **Block FPR Wilson 95% CI** | `[0.21%, 1.14%]` | `[0.02%, 0.55%]` |
| **Alert FPR (Block + Ask on Benign)** | **8.0%** (82/1024) | **7.6%** (78/1020) |
| **Alert FPR Wilson 95% CI** | `[6.50%, 9.83%]` | `[6.17%, 9.44%]` |
| **Block Recall (Automatic Denial)** | **100.0%** (513/513) | **48.9%** (251/513) |
| **Alert Recall (Total Interceptions)** | **100.0%** (513/513) | **99.6%** (511/513) |
| **Alert Precision** | **86.2%** | **86.8%** |

### 9.2 Ecosystem Breakdown (Second Look: `--no-osv`, hash: `87b441e55fed...`)

- **npm Split ($n=763$, Benign: 503, Malicious: 260)**:
  - `block_FPR`: **0.0%** (0/503) [Wilson 95% CI: `[0.00%, 0.76%]`]
  - `alert_FPR`: **9.1%** (46/503) [Wilson 95% CI: `[6.93%, 11.98%]`]
  - `alert_Recall`: **100.0%** (260/260) [Wilson 95% CI: `[98.54%, 100.00%]`]
  - **Subcategories**: `dead_name`: 0, `security_stub`: 155 (100% ASK), `unpublished`: 27 (100% ASK), `non_stub_live`: 78 (100% ASK, 78/78).
  - *Heuristic Decision Policy*: npm heuristics dispatch to **ASK, never BLOCK**.

- **PyPI Split ($n=770$, Benign: 517, Malicious: 253)**:
  - `block_FPR`: **0.2%** (1/517) [Wilson 95% CI: `[0.03%, 1.09%]`] (Single 404 name: `aaaaaaaaa`)
  - `alert_FPR`: **6.2%** (32/517) [Wilson 95% CI: `[4.42%, 8.61%]`]
  - `alert_Recall`: **99.2%** (251/253) [Wilson 95% CI: `[97.16%, 99.78%]`]
  - **Subcategories**: `dead_name`: 251 (100% BLOCK, 251/251), `non_stub_live`: 2 (0/2, 2 FN).
  - *Data Limitation*: **PyPI has no download signal** in its public JSON metadata API.

- **Headline Heuristic Recall on Live Malicious (`non_stub_live` across ecosystems, $n=80$)**:
  - **78 / 80 (97.5%)** intercepted via adoption, lifecycle, and slopsquat heuristics without OSV advisory feeds.

---

### 9.3 Methodological Caveats & Limitations

When interpreting benchmark figures, the following operational and methodological constraints must be recognized:

1. **OSV-On Recall Measures Advisory Database Lookups, Not Heuristics**:
   - The 100.0% recall in the standard configuration reflects exact-match advisory lookups against the OSV malicious package database (`MAL-*`). In real-world zero-day attack scenarios where an attacker publishes a novel poisoned dependency, no public advisory exists yet.
2. **Corpus Nature & Threat Competency**:
   - The live-malicious sample in the dataset is mostly zero-download single-version spam harvested from past mass-campaign takedowns. Recall on competent squats with fabricated download counts, multiple release versions, or established history is unknown.
3. **Ecosystem Asymmetries**:
   - **PyPI has no download signal**: Download metrics are absent from PyPI's official JSON API, preventing download-threshold heuristics from evaluating Python dependencies without third-party BigQuery queries.
   - **npm heuristics ASK, never BLOCK**: With OSV stripped, npm heuristic alerts dispatch to `ASK`, never `BLOCK`. Unattended blocking relies on unattended mode escalating `ASK` to `deny`.
4. **Quarantine Stubs Are Post-Incident Artifacts, Not Attack-Time Signals**:
   - npm packages in the malicious dataset that resolve to `0.0.1-security` stubs (dist-tags.latest includes "security" OR a version key includes "security") or `isUnpublished: true` reflect administrative actions taken by npm registry security after an attack was discovered. At the moment of compromise, the attacker's actual payload version was live. The `non_stub_live` metric isolates active, live packages where no security stub was planted.
5. **Alert FPR and Bare-Latest Dependency Lookups**:
   - The ~7.6% - 8.0% alert FPR reflects benchmark queries executed against unpinned package names (equivalent to `npm i <pkg>` or `pip install <pkg>`). This triggers 72-hour version cooldown checks and unvetted adoption scrutiny on whatever latest release was published.
   - *Lockfile suppression status*: The claim that lockfile suppression reduces alert FPR in developer workflows remains untested on this corpus, as all benchmark evaluations query unpinned bare-latest requests.

---

## 10. VS Code Extension & Desktop UI

ContextArmor includes an official VS Code extension providing real-time, in-editor protection for AI-assisted development and manual dependency changes.

### Key Capabilities
1. **Activity Bar Threat Radar**:
   - Resides directly in the left Activity Bar under the ContextArmor Shield (🛡️).
   - Displays real-time **Security Score** (0–100, color-coded Clean/Warning/Critical).
   - Interactive threat cards displaying target package, severity badge (`[BLOCK]` / `[ASK]`), and rationale.
2. **1-Click Remediations**:
   - `💡 Add weights_only=True`: Automatically patches unsafe `torch.load(...)` calls in Python code to safe deserialization.
   - `💡 Pin to <version>`: Pins 72h-cooldown warnings to the newest verified version older than 72 hours.
   - `🗑️ Remove Line`: Removes malicious or hallucinated dependency lines directly from your manifest.
3. **In-Editor Diagnostics & Quick Fixes**:
   - Red squiggly lines on confirmed malware and 404 hallucinations in `package.json` and `requirements.txt`.
   - Yellow warning squigglies on unsafe pickle/model deserialization in Python files.
   - Standard VS Code Quick Fix lightbulb (<kbd>Cmd</kbd> + <kbd>.</kbd> or <kbd>Ctrl</kbd> + <kbd>.</kbd>).
4. **Standalone Security Dashboard**:
   - Run `ContextArmor: Open Security Dashboard` from the Command Palette (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) or click the status bar item.
   - Full-page security audit overview, SVG risk gauge, and active threat table.

### Installation from VSIX
```bash
# Package the extension
npm run build
npx vsce package --no-dependencies --allow-missing-repository --skip-license

# Install into VS Code
code --install-extension contextarmor-0.1.0.vsix
```

---

## 11. Project Audit CLI (`contextarmor audit`)

Scan an entire project or manifest file in one command:

```bash
# Audit a project directory
node dist/cli.js audit ./my-project

# Audit a specific package.json or requirements.txt
node dist/cli.js audit ./package.json

# Output machine-readable JSON
node dist/cli.js audit ./package.json --json
```

