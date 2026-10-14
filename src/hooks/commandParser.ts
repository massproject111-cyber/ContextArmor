import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { PackageTarget } from '../core/types.js';

export interface CommandParseResult {
  rawCommand: string;
  extractedPackages: PackageTarget[];
  workingDirectory: string;
  directSource?: string;
  missingFile?: string;
  protectedPathWrite?: string;
  unparsedInstall?: boolean;
  exceededDepth?: boolean;
  nothingToCheck?: boolean;
  notInstallCmd?: boolean;
  installNoTargets?: boolean;
  adapterFailed?: boolean;
}

/**
 * Searches upward from startDir for the nearest manifest file.
 */
function findNearestFile(startDir: string, filename: string): string | undefined {
  let curr = path.resolve(startDir);
  while (true) {
    const candidate = path.join(curr, filename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return undefined;
}

/**
 * Checks for manifest additions when a bare install is run ('npm install' / 'pip install' / 'uv sync')
 * by diffing against git HEAD:./<filename>.
 */
function checkBareManifestDiff(
  workingDir: string,
  ecosystem: 'npm' | 'pypi',
  specificFile?: string
): { packages: PackageTarget[]; nothingToCheck: boolean; directSource?: string } {
  const pkgs: PackageTarget[] = [];
  let directSource: string | undefined;
  try {
    if (ecosystem === 'npm') {
      const manifestPath = findNearestFile(workingDir, specificFile || 'package.json');
      if (manifestPath && fs.existsSync(manifestPath)) {
        const manifestDir = path.dirname(manifestPath);
        const filename = path.basename(manifestPath);
        let headContent = '';
        let hasGitHead = false;
        try {
          headContent = execSync(`git show HEAD:./${filename}`, {
            cwd: manifestDir,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          hasGitHead = true;
        } catch {
          // Untracked or non-git dir
          hasGitHead = false;
        }

        const currentJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const currentDeps = { ...(currentJson.dependencies || {}), ...(currentJson.devDependencies || {}) };

        let headDeps: Record<string, string> = {};
        if (hasGitHead && headContent) {
          try {
            const parsedHead = JSON.parse(headContent);
            headDeps = { ...(parsedHead.dependencies || {}), ...(parsedHead.devDependencies || {}) };
          } catch {}
        }

        let directSource: string | undefined;
        for (const [dep, rawVer] of Object.entries(currentDeps)) {
          const verStr = String(rawVer).trim();
          if (!hasGitHead || !headDeps[dep] || headDeps[dep] !== verStr) {
            // 1. Alias specs: npm:real@ver, npm:@scope/pkg@ver, npm:real
            if (verStr.startsWith('npm:')) {
              const target = verStr.slice(4).trim();
              let realName = target;
              let realVer: string | undefined;
              const atIdx = target.lastIndexOf('@');
              if (atIdx > 0) {
                realName = target.slice(0, atIdx);
                realVer = target.slice(atIdx + 1);
              }
              // Resolve alias to real package; never look up alias name
              pkgs.push({ name: realName, version: realVer, ecosystem: 'npm', isDirect: true });
              continue;
            }

            // 2. Workspace protocol: workspace:, workspace:*, workspace:^1.0.0
            if (verStr.startsWith('workspace:')) {
              // Local workspace within monorepo, skip external registry lookup
              continue;
            }

            // 3. Direct source protocols: file:, link:, github:, git+, http:, https:
            if (
              verStr.startsWith('file:') ||
              verStr.startsWith('link:') ||
              verStr.startsWith('github:') ||
              verStr.startsWith('git+') ||
              verStr.startsWith('git://') ||
              verStr.startsWith('http://') ||
              verStr.startsWith('https://') ||
              isDirectSource(verStr)
            ) {
              directSource = `${dep} (${verStr})`;
              continue;
            }

            // Regular registry dependency
            pkgs.push({ name: dep, version: verStr, ecosystem: 'npm', isDirect: true });
          }
        }

        // Check lockfile diff if manifest itself has no changes (e.g., dependency version bumped in package-lock.json)
        if (hasGitHead && pkgs.length === 0) {
          const lockCandidates = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
          for (const lockfile of lockCandidates) {
            const lockPath = path.join(manifestDir, lockfile);
            if (fs.existsSync(lockPath)) {
              try {
                const lockDiff = execSync(`git diff HEAD -- ${lockfile}`, {
                  cwd: manifestDir,
                  encoding: 'utf8',
                  stdio: ['pipe', 'pipe', 'ignore'],
                });
                if (lockDiff) {
                  // Extract added version lines or package blocks
                  // For package-lock.json v2/v3: "node_modules/pkg": { "version": "x.y.z" }
                  if (lockfile === 'package-lock.json') {
                    const currentLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
                    let headLock: any = {};
                    try {
                      headLock = JSON.parse(execSync(`git show HEAD:./${lockfile}`, {
                        cwd: manifestDir,
                        encoding: 'utf8',
                        stdio: ['pipe', 'pipe', 'ignore'],
                      }));
                    } catch {}

                    const currPackages = currentLock.packages || {};
                    const headPackages = headLock.packages || {};
                    for (const [key, pkgInfo] of Object.entries(currPackages) as [string, any][]) {
                      if (key.startsWith('node_modules/')) {
                        const parts = key.split('node_modules/');
                        const pkgName = parts[parts.length - 1];
                        const currVer = pkgInfo?.version;
                        const headVer = headPackages[key]?.version;
                        if (pkgName && (!headVer || headVer !== currVer)) {
                          pkgs.push({ name: pkgName, version: currVer, ecosystem: 'npm', isDirect: false });
                        }
                      }
                    }
                  } else {
                    // For yarn.lock or pnpm-lock.yaml, inspect added lines with +
                    const addedLines = lockDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
                    let currentYarnPkg = '';
                    for (const line of addedLines) {
                      // pnpm-lock.yaml: /chalk@5.6.1: or chalk@5.6.1:
                      const pnpmMatch = line.match(/^\+\s*(?:\/)?(?:@([a-zA-Z0-9_\-\.\/]+)\/)?([a-zA-Z0-9_\-\.]+)@([0-9a-zA-Z_\-\.\+]+):/);
                      if (pnpmMatch) {
                        const name = pnpmMatch[1] ? `@${pnpmMatch[1]}/${pnpmMatch[2]}` : pnpmMatch[2];
                        const version = pnpmMatch[3];
                        if (name && !pkgs.some(p => p.name === name)) {
                          pkgs.push({ name, version, ecosystem: 'npm', isDirect: false });
                        }
                      }

                      // yarn.lock header: chalk@^5.0.0, chalk@5.6.1:
                      const yarnHeader = line.match(/^\+\s*["']?([@a-zA-Z0-9_\-\/]+)@[^:]+:/);
                      if (yarnHeader) {
                        currentYarnPkg = yarnHeader[1];
                      }
                      const yarnVer = line.match(/^\+\s*version\s+["']([^"']+)["']/);
                      if (yarnVer && currentYarnPkg) {
                        const ver = yarnVer[1];
                        const existing = pkgs.find(p => p.name === currentYarnPkg);
                        if (existing) {
                          existing.version = ver;
                        } else {
                          pkgs.push({ name: currentYarnPkg, version: ver, ecosystem: 'npm', isDirect: false });
                        }
                      }

                      const simpleMatch = line.match(/^\+\s*(?:["']?([@a-zA-Z0-9_\-\/]+)@|([a-zA-Z0-9_\-\/]+):)/);
                      if (simpleMatch) {
                        const name = simpleMatch[1] || simpleMatch[2];
                        if (name && !pkgs.some(p => p.name === name)) {
                          pkgs.push({ name, ecosystem: 'npm', isDirect: false });
                        }
                      }
                    }
                  }
                }
              } catch {}
              break;
            }
          }
        }

        if (directSource && pkgs.length === 0) {
          return { packages: [], nothingToCheck: false, directSource };
        }
        if (hasGitHead && pkgs.length === 0) {
          return { packages: [], nothingToCheck: true };
        }
      }
    } else if (ecosystem === 'pypi') {
      const targetFilename = specificFile || 'requirements.txt';
      const reqPath = findNearestFile(workingDir, targetFilename);
      if (reqPath && fs.existsSync(reqPath)) {
        const manifestDir = path.dirname(reqPath);
        const filename = path.basename(reqPath);
        let headContent = '';
        let hasGitHead = false;
        try {
          headContent = execSync(`git show HEAD:./${filename}`, {
            cwd: manifestDir,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          hasGitHead = true;
        } catch {
          hasGitHead = false;
        }

        const currentLines = fs.readFileSync(reqPath, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        const headLines = new Set(
          hasGitHead ? headContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')) : []
        );

        for (const line of currentLines) {
          if (!hasGitHead || !headLines.has(line)) {
            const parts = line.split(/[=<>~!]/);
            const name = parts[0].trim();
            const version = parts.length > 1 ? parts[parts.length - 1].trim() : undefined;
            if (name) {
              pkgs.push({ name, version, ecosystem: 'pypi', isDirect: true });
            }
          }
        }

        // Check poetry.lock or uv.lock if requirements/pyproject has no additions
        if (hasGitHead && pkgs.length === 0) {
          const lockCandidates = ['poetry.lock', 'uv.lock'];
          for (const lockfile of lockCandidates) {
            const lockPath = path.join(manifestDir, lockfile);
            if (fs.existsSync(lockPath)) {
              try {
                const lockDiff = execSync(`git diff HEAD -- ${lockfile}`, {
                  cwd: manifestDir,
                  encoding: 'utf8',
                  stdio: ['pipe', 'pipe', 'ignore'],
                });
                if (lockDiff) {
                  const addedLines = lockDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
                  let currentPyPkg = '';
                  for (const line of addedLines) {
                    const nameMatch = line.match(/^\+\s*name\s*=\s*["']([^"']+)["']/);
                    if (nameMatch) {
                      currentPyPkg = nameMatch[1];
                    }
                    const verMatch = line.match(/^\+\s*version\s*=\s*["']([^"']+)["']/);
                    if (verMatch && currentPyPkg) {
                      const ver = verMatch[1];
                      const existing = pkgs.find(p => p.name === currentPyPkg);
                      if (existing) {
                        existing.version = ver;
                      } else {
                        pkgs.push({ name: currentPyPkg, version: ver, ecosystem: 'pypi', isDirect: false });
                      }
                      currentPyPkg = '';
                    } else if (nameMatch && !pkgs.some(p => p.name === currentPyPkg)) {
                      pkgs.push({ name: currentPyPkg, ecosystem: 'pypi', isDirect: false });
                    }
                  }
                }
              } catch {}
              break;
            }
          }
        }

        if (hasGitHead && pkgs.length === 0) {
          return { packages: [], nothingToCheck: true };
        }
      }
    }
  } catch {
    // Fail open on unexpected diff error
  }
  return { packages: pkgs, nothingToCheck: false, directSource };
}

/**
 * Recursively unwraps subshell wrappers, eval, command substitutions, pipes to xargs,
 * and command chaining up to depth limit 5.
 */
export function recursiveUnwrapCommand(cmd: string, depth = 0): { command: string; exceededDepth: boolean } {
  if (depth > 5) {
    return { command: cmd, exceededDepth: true };
  }

  let cleaned = cmd.trim();

  // 1. Unwrap command substitution: $(...) or `...`
  const subMatch = cleaned.match(/^\$\((.+)\)$/) || cleaned.match(/^`(.+)`$/);
  if (subMatch && subMatch[1]) {
    return recursiveUnwrapCommand(subMatch[1].trim(), depth + 1);
  }

  // 2. Unwrap subshell wrappers: bash -c "...", sh -c '...', zsh -c "..."
  const subshellMatch = cleaned.match(/^(?:bash|sh|zsh)\s+-c\s+["'](.+)["']$/s) ||
                        cleaned.match(/^(?:bash|sh|zsh)\s+-c\s+(?:\\+["'])(.+)(?:\\+["'])$/s);
  if (subshellMatch && subshellMatch[1]) {
    let inner = subshellMatch[1].trim();
    inner = inner.replace(/\\(["'\\])/g, '$1');
    return recursiveUnwrapCommand(inner, depth + 1);
  }

  // 3. Unwrap eval: eval "..." or eval '...'
  const evalMatch = cleaned.match(/^eval\s+["'](.+)["']$/s) || cleaned.match(/^eval\s+(.+)$/s);
  if (evalMatch && evalMatch[1]) {
    return recursiveUnwrapCommand(evalMatch[1].trim(), depth + 1);
  }

  // 4. Unwrap xargs: e.g. echo evil | xargs npm i -> npm i evil
  if (cleaned.includes('|') && cleaned.includes('xargs')) {
    const pipeParts = cleaned.split('|').map(p => p.trim());
    const xargsPart = pipeParts.find(p => p.startsWith('xargs'));
    const producerPart = pipeParts[0];
    if (xargsPart && producerPart) {
      const targetCmd = xargsPart.replace(/^xargs\s+/, '').trim();
      let inputArg = '';
      const echoMatch = producerPart.match(/^echo\s+["']?([^"']+)["']?$/);
      if (echoMatch && echoMatch[1]) {
        inputArg = echoMatch[1].trim();
      }
      return recursiveUnwrapCommand(`${targetCmd} ${inputArg}`.trim(), depth + 1);
    }
  }

  // 5. Handle chaining: e.g. cd x && npm i ...
  if (cleaned.includes('&&')) {
    const parts = cleaned.split('&&');
    return recursiveUnwrapCommand(parts[parts.length - 1].trim(), depth + 1);
  }
  if (cleaned.includes(';')) {
    const parts = cleaned.split(';');
    return recursiveUnwrapCommand(parts[parts.length - 1].trim(), depth + 1);
  }

  // 6. Strip leading sudo
  if (cleaned.startsWith('sudo ')) {
    return recursiveUnwrapCommand(cleaned.slice(5).trim(), depth + 1);
  }

  // 7. Strip leading env assignments: env FOO=bar npm i ... or FOO=bar npm i ...
  const envMatch = cleaned.match(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+(.+)$/);
  if (envMatch && envMatch[1]) {
    return recursiveUnwrapCommand(envMatch[1].trim(), depth + 1);
  }

  return { command: cleaned, exceededDepth: false };
}

/**
 * Checks if a token represents a direct source (local path, URL, git spec, tarball).
 */
export function isDirectSource(token: string): boolean {
  const t = token.trim();
  const baseToken = t.replace(/\[[^\]]+\]$/, '');
  if (baseToken === '.' || baseToken === '..' || baseToken.startsWith('./') || baseToken.startsWith('../') || baseToken.startsWith('/') || baseToken.startsWith('file:')) {
    return true;
  }
  if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('git+') || t.startsWith('git://') || t.startsWith('ssh://')) {
    return true;
  }
  if (t.endsWith('.tgz') || t.endsWith('.tar.gz') || t.endsWith('.whl')) {
    return true;
  }
  return false;
}

/**
 * Checks if a command contains an install token.
 */
export function hasInstallToken(cmd: string): boolean {
  return /\b(install|i|add|ci|sync)\b/.test(cmd);
}

export function checkProtectedPathWrite(cmd: string): string | undefined {
  const c = cmd.trim();

  // Pattern matching protected targets:
  // 1. Literal path: .claude/settings.json, .agents/hooks.json, ~/.contextarmor, .contextarmor
  // 2. Glob variants: .cla*/set*, .agents/hook*, .contex*
  // 3. Subdirectory context: cd .claude && ... settings.json
  const hasProtectedTarget =
    /(\.claude\/settings\.json|\.agents\/hooks\.json|~?\.contextarmor)/.test(c) ||
    /(\.cla[^\s/]*\/set[^\s/]*|\.agent[^\s/]*\/hook[^\s/]*)/.test(c) ||
    /(?:cd\s+[^\s&;]*\.claude\b.*(?:settings\.json|set[^\s/]*))/s.test(c) ||
    /(?:settings\.json|hooks\.json|decisions\.log)/.test(c);

  if (!hasProtectedTarget) return undefined;

  // Positive allowlist: purely read-only commands targeting protected paths
  // E.g. cat, head, tail, grep, ls, stat, git diff, git show, git log
  const isReadOnly =
    /^(?:cat|head|tail|grep|ls|stat|less|more|view)\s+/.test(c) ||
    /^git\s+(?:diff|show|log|status)\b/.test(c);

  if (isReadOnly && !c.includes('>') && !c.includes('|') && !c.includes('&&')) {
    return undefined;
  }

  // Check 1: Redirection into protected file (> or >>)
  if (/>+\s*[^\s|&;]*(\.claude|\.agents|\.contextarmor|settings\.json|hooks\.json|decisions\.log|set[^\s/]*)/.test(c)) {
    return '.claude/settings.json';
  }

  // Check 2: Modifying commands: rm, mv, cp, sed, tee, touch, truncate, unlink, chmod, chown
  if (/\b(rm|mv|cp|sed|tee|touch|truncate|unlink|chmod|chown)\b/.test(c)) {
    return '.claude/settings.json';
  }

  // Check 3: Git overwrite commands: git checkout, git restore, git reset
  if (/^git\s+(?:checkout|restore|reset|clean)\b/.test(c)) {
    return '.claude/settings.json';
  }

  // Check 4: Script engines modifying files: python, python3, node, bash, sh, perl, ruby
  if (/\b(?:python3?|node|perl|ruby|bash|sh)\b.*(?:open|write|unlink|remove|writeFile|writeFileSync)/.test(c)) {
    return '.claude/settings.json';
  }

  // Check 5: cd .claude && ... settings.json with append/write
  if (/(?:cd\s+[^\s&;]*\.claude\b.*(?:>|rm|mv|cp|tee|sed|touch))/s.test(c)) {
    return '.claude/settings.json';
  }

  return undefined;
}

/**
 * Robust shell command parser.
 */
export function extractPackagesFromCommand(
  commandStr: string,
  cwd: string = process.cwd()
): CommandParseResult {
  const unwrapped = recursiveUnwrapCommand(commandStr);
  if (unwrapped.exceededDepth) {
    return {
      rawCommand: commandStr,
      extractedPackages: [],
      workingDirectory: cwd,
      exceededDepth: true,
    };
  }

  const cleaned = unwrapped.command;
  const pkgs: PackageTarget[] = [];

  // 0. Defense Against Self-Tampering: Check for writes to protected configuration paths
  const protWrite = checkProtectedPathWrite(commandStr) || checkProtectedPathWrite(cleaned);
  if (protWrite) {
    return {
      rawCommand: commandStr,
      extractedPackages: [],
      workingDirectory: cwd,
      protectedPathWrite: protWrite,
    };
  }

  // 1. Bare npm ecosystem install (npm install / npm ci / pnpm install / yarn install / bun install)
  if (/^npm\s+(?:install|i|ci)$/.test(cleaned) || /^pnpm\s+(?:install|i)$/.test(cleaned) || /^yarn(?:\s+install)?$/.test(cleaned) || /^bun\s+install$/.test(cleaned)) {
    const diff = checkBareManifestDiff(cwd, 'npm');
    if (diff.directSource) {
      return {
        rawCommand: commandStr,
        extractedPackages: [],
        workingDirectory: cwd,
        directSource: diff.directSource,
      };
    }
    return {
      rawCommand: commandStr,
      extractedPackages: diff.packages,
      workingDirectory: cwd,
      nothingToCheck: diff.packages.length === 0,
    };
  }

  // 2. Bare PyPI install: pip install -r requirements.txt / -c
  if (/^pip3?\s+install\s+(?:-r|-c)\s+([^\s]+)$/.test(cleaned) || /^uv\s+pip\s+install\s+(?:-r|-c)\s+([^\s]+)$/.test(cleaned)) {
    const match = cleaned.match(/\s+(?:-r|-c)\s+([^\s]+)/);
    const filename = match ? match[1] : 'requirements.txt';
    const filePath = path.resolve(cwd, filename);
    if (!fs.existsSync(filePath)) {
      return {
        rawCommand: commandStr,
        extractedPackages: [],
        workingDirectory: cwd,
        missingFile: filename,
      };
    }
    const diff = checkBareManifestDiff(cwd, 'pypi', filename);
    return {
      rawCommand: commandStr,
      extractedPackages: diff.packages,
      workingDirectory: cwd,
      nothingToCheck: diff.packages.length === 0,
    };
  }

  // Bare uv sync / poetry install with dedicated lockfile inspection
  if (/^uv\s+sync$/.test(cleaned) || /^poetry\s+install$/.test(cleaned)) {
    const isUv = cleaned.startsWith('uv');
    const lockfile = isUv ? 'uv.lock' : 'poetry.lock';
    const lockPath = findNearestFile(cwd, lockfile);
    if (lockPath && fs.existsSync(lockPath)) {
      const lockDir = path.dirname(lockPath);
      let lockDiff = '';
      try {
        lockDiff = execSync(`git diff HEAD -- ${lockfile}`, {
          cwd: lockDir,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch {}
      if (lockDiff) {
        const addedLines = lockDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
        let currentPyPkg = '';
        for (const line of addedLines) {
          const nameMatch = line.match(/^\+\s*name\s*=\s*["']([^"']+)["']/);
          if (nameMatch) currentPyPkg = nameMatch[1];
          const verMatch = line.match(/^\+\s*version\s*=\s*["']([^"']+)["']/);
          if (verMatch && currentPyPkg) {
            const ver = verMatch[1];
            pkgs.push({ name: currentPyPkg, version: ver, ecosystem: 'pypi', isDirect: false });
            currentPyPkg = '';
          }
        }
        if (pkgs.length > 0) {
          return { rawCommand: commandStr, extractedPackages: pkgs, workingDirectory: cwd };
        }
      }
      return { rawCommand: commandStr, extractedPackages: [], workingDirectory: cwd, nothingToCheck: true };
    }
    const diff = checkBareManifestDiff(cwd, 'pypi', 'pyproject.toml');
    return {
      rawCommand: commandStr,
      extractedPackages: diff.packages,
      workingDirectory: cwd,
      nothingToCheck: diff.packages.length === 0,
    };
  }

  // Install command with zero targets
  if (/^uv\s+add$/.test(cleaned) || /^pip3?\s+install$/.test(cleaned)) {
    return {
      rawCommand: commandStr,
      extractedPackages: [],
      workingDirectory: cwd,
      installNoTargets: true,
    };
  }

  // 3. npm runner tools: npx, bunx, pnpm dlx, yarn dlx
  const npmRunnerMatch = cleaned.match(/^(?:npx(?:\s+(?:-y|--yes))?|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(.+)$/);
  if (npmRunnerMatch && npmRunnerMatch[1]) {
    const tokens = npmRunnerMatch[1].split(/\s+/);
    for (const tok of tokens) {
      if (!tok.startsWith('-')) {
        if (isDirectSource(tok)) {
          return { rawCommand: commandStr, extractedPackages: [], workingDirectory: cwd, directSource: tok };
        }
        let pkgName = tok;
        let version: string | undefined;
        const atIdx = tok.lastIndexOf('@');
        if (atIdx > 0) {
          pkgName = tok.slice(0, atIdx);
          version = tok.slice(atIdx + 1);
        }
        pkgs.push({ name: pkgName, version, ecosystem: 'npm', isDirect: true });
        break;
      }
    }
    return { rawCommand: commandStr, extractedPackages: pkgs, workingDirectory: cwd };
  }

  // 4. PyPI runner / tool install: uvx, uv tool install, pipx install
  const pypiRunnerMatch = cleaned.match(/^(?:uvx|uv\s+tool\s+install|pipx\s+install)\s+(.+)$/);
  if (pypiRunnerMatch && pypiRunnerMatch[1]) {
    const tokens = pypiRunnerMatch[1].split(/\s+/);
    for (const tok of tokens) {
      if (!tok.startsWith('-')) {
        if (isDirectSource(tok)) {
          return { rawCommand: commandStr, extractedPackages: [], workingDirectory: cwd, directSource: tok };
        }
        let pkgName = tok;
        let version: string | undefined;
        const atIdx = tok.lastIndexOf('@');
        if (atIdx > 0) {
          pkgName = tok.slice(0, atIdx);
          version = tok.slice(atIdx + 1);
        } else {
          const parts = tok.split(/[=<>~!]/);
          pkgName = parts[0].trim();
          if (parts.length > 1) version = parts[parts.length - 1].trim();
        }
        pkgs.push({ name: pkgName, version, ecosystem: 'pypi', isDirect: true });
        break;
      }
    }
    return { rawCommand: commandStr, extractedPackages: pkgs, workingDirectory: cwd };
  }

  // 5. npm package managers: npm, pnpm, yarn, bun add/install
  const npmAddMatch = cleaned.match(/^(?:npm\s+(?:i|install|add)|pnpm\s+add|yarn\s+add|bun\s+add)\s+(.+)$/);
  if (npmAddMatch && npmAddMatch[1]) {
    const tokens = npmAddMatch[1].split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i].trim();
      if (!tok || tok.startsWith('-')) {
        if (tok === '--registry' && i + 1 < tokens.length) i++;
        continue;
      }
      if (isDirectSource(tok)) {
        return { rawCommand: commandStr, extractedPackages: [], workingDirectory: cwd, directSource: tok };
      }
      if (tok.includes('@npm:')) {
        const npmIdx = tok.indexOf('@npm:');
        const target = tok.slice(npmIdx + 5);
        let realPkg = target;
        let version: string | undefined;
        const atIdx = target.lastIndexOf('@');
        if (atIdx > 0) {
          realPkg = target.slice(0, atIdx);
          version = target.slice(atIdx + 1);
        }
        pkgs.push({ name: realPkg, version, ecosystem: 'npm', isDirect: true });
        continue;
      }
      let pkgName = tok;
      let version: string | undefined;
      const atIdx = tok.lastIndexOf('@');
      if (atIdx > 0) {
        pkgName = tok.slice(0, atIdx);
        version = tok.slice(atIdx + 1);
      }
      pkgs.push({ name: pkgName, version, ecosystem: 'npm', isDirect: true });
    }
    if (pkgs.length > 0) {
      return { rawCommand: commandStr, extractedPackages: pkgs, workingDirectory: cwd };
    }
  }

  // 6. PyPI package managers: pip, pip3, python -m pip, uv pip install, uv add, poetry add
  const pipMatch = cleaned.match(/^(?:pip3?\s+install|python(?:\d(?:\.\d+)?)?\s+-m\s+pip\s+install|uv\s+(?:pip\s+install|add)|poetry\s+add)\s+(.+)$/);
  if (pipMatch && pipMatch[1]) {
    const tokens = pipMatch[1].split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      let tok = tokens[i].trim();
      tok = tok.replace(/^['"]|['"]$/g, '');

      if (!tok || tok.startsWith('-')) {
        if ((tok === '--index-url' || tok === '--extra-index-url' || tok === '-r' || tok === '-c') && i + 1 < tokens.length) {
          i++;
        }
        continue;
      }

      if (isDirectSource(tok)) {
        return { rawCommand: commandStr, extractedPackages: [], workingDirectory: cwd, directSource: tok };
      }

      const parts = tok.split(/[=<>~!]/);
      const pkgName = parts[0].trim();
      const version = parts.length > 1 ? tok.slice(pkgName.length).trim() : undefined;
      pkgs.push({ name: pkgName, version, ecosystem: 'pypi', isDirect: true });
    }
    if (pkgs.length > 0) {
      return { rawCommand: commandStr, extractedPackages: pkgs, workingDirectory: cwd };
    }
  }

  // 7. Check if command is an install command that slipped extraction
  if (hasInstallToken(cleaned) && /(npm|pnpm|yarn|bun|pip|pip3|uv|poetry)/.test(cleaned)) {
    return {
      rawCommand: commandStr,
      extractedPackages: [],
      workingDirectory: cwd,
      unparsedInstall: true,
    };
  }

  return { rawCommand: commandStr, extractedPackages: [], workingDirectory: cwd, notInstallCmd: true };
}
