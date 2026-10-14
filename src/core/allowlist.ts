import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AllowlistConfig {
  scopedPrefixes: string[];
  explicitPackages: string[];
  ignoreWorkspaces: boolean;
}

/**
 * Parses .npmrc, pip.conf, and project files to establish private registries,
 * internal organization scopes, and explicitly trusted packages.
 */
export class AllowlistManager {
  private scopedPrefixes: Set<string> = new Set();
  private explicitPackages: Set<string> = new Set();
  public customRegistryConfigured = false;

  constructor(workspaceRoot?: string) {
    if (workspaceRoot) {
      this.loadWorkspaceConfigs(workspaceRoot);
    }
  }

  public addScope(scope: string): void {
    const normalized = scope.startsWith('@') ? scope : `@${scope}`;
    this.scopedPrefixes.add(normalized.endsWith('/') ? normalized : `${normalized}/`);
  }

  public addPackage(pkgName: string): void {
    this.explicitPackages.add(pkgName.toLowerCase());
  }

  /**
   * Evaluates whether a package is strictly private / internal and should NEVER
   * be queried against public registries (preventing dependency confusion / data leaks).
   */
  public isAllowlistedOrPrivate(pkgName: string): boolean {
    const lower = pkgName.toLowerCase();

    // 0. If whole project points to a custom internal registry, never query public
    if (this.customRegistryConfigured) {
      return true;
    }

    // 1. Explicit user allowlist
    if (this.explicitPackages.has(lower)) {
      return true;
    }

    // 2. Scoped private package (e.g. @mycompany/pkg)
    for (const scope of this.scopedPrefixes) {
      if (lower.startsWith(scope.toLowerCase())) {
        return true;
      }
    }

    // 3. Local filesystem paths or git targets
    if (
      lower.startsWith('file:') ||
      lower.startsWith('link:') ||
      lower.startsWith('workspace:') ||
      lower.startsWith('git+') ||
      lower.startsWith('http://') ||
      lower.startsWith('https://') ||
      lower.startsWith('.') ||
      lower.startsWith('/')
    ) {
      return true;
    }

    return false;
  }

  private loadWorkspaceConfigs(workspaceRoot: string): void {
    // 1. Check .npmrc for custom scopes and registry overrides
    const npmrcPath = path.join(workspaceRoot, '.npmrc');
    if (fs.existsSync(npmrcPath)) {
      try {
        const content = fs.readFileSync(npmrcPath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          // e.g., @myorg:registry=https://...
          const match = trimmed.match(/^@([a-zA-Z0-9-_]+):registry/);
          if (match && match[1]) {
            this.addScope(`@${match[1]}`);
          }
          // e.g., registry=https://internal-npm.corp.com
          if (trimmed.startsWith('registry=') && !trimmed.includes('registry.npmjs.org')) {
            // Entire default registry is private/internal
            this.customRegistryConfigured = true;
          }
        }
      } catch {
        // ignore read errors
      }
    }

    // 2. Check pip.conf / pyproject.toml for custom private index-url
    const pipConfPath = path.join(workspaceRoot, 'pip.conf');
    if (fs.existsSync(pipConfPath)) {
      try {
        const content = fs.readFileSync(pipConfPath, 'utf8');
        if (content.includes('index-url') && !content.includes('pypi.org') && !content.includes('pypi.python.org')) {
          this.customRegistryConfigured = true;
        }
      } catch {}
    }

    // 3. Check contextarmor.allowlist.json if present
    const allowlistPath = path.join(workspaceRoot, '.contextarmor.json');
    if (fs.existsSync(allowlistPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
        if (Array.isArray(raw.allowlist)) {
          for (const item of raw.allowlist) {
            this.addPackage(item);
          }
        }
        if (Array.isArray(raw.scopes)) {
          for (const scope of raw.scopes) {
            this.addScope(scope);
          }
        }
      } catch {
        // ignore json parse errors
      }
    }
  }
}
