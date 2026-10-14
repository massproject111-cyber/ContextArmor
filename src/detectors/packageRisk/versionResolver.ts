import { execSync } from 'node:child_process';
import { DiskCache } from '../../core/cache.js';
import type { Ecosystem } from '../../core/types.js';

/**
 * Resolves a package specification (bare name, tag, or semver range)
 * to an exact, concrete version string before OSV is queried.
 */
export class VersionResolver {
  private cache: DiskCache;
  private fetchFn: typeof fetch;

  constructor(cache?: DiskCache, fetchFn?: typeof fetch) {
    this.cache = cache || new DiskCache(0, 15);
    this.fetchFn = fetchFn || globalThis.fetch;
  }

  /**
   * Resolves an npm package specification to an exact version.
   */
  async resolveNpm(name: string, spec?: string): Promise<string | undefined> {
    const cleanSpec = spec?.trim();

    // 1. If spec is already an exact pinned version (no range operators and not 'latest')
    if (cleanSpec && !/[~^><=*x]/.test(cleanSpec) && cleanSpec !== 'latest') {
      return cleanSpec;
    }

    const cacheKey = `npm_version:${name}:${cleanSpec || 'latest'}`;
    const cached = this.cache.get<string>(cacheKey);
    if (cached) {
      return cached;
    }

    // 2. Fetch packument using lightweight abbreviated JSON accept header
    try {
      const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
      const res = await this.fetchFn(url, {
        headers: { Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
        signal: AbortSignal.timeout(3000),
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        const distTags = data['dist-tags'] || {};
        if (distTags.latest && (cleanSpec === '*' || cleanSpec === 'latest' || !cleanSpec)) {
          this.cache.set(cacheKey, distTags.latest);
          return distTags.latest;
        }

        const versions = Object.keys(data.versions || {});
        if (versions.length > 0) {
          if (cleanSpec && versions.includes(cleanSpec)) {
            this.cache.set(cacheKey, cleanSpec);
            return cleanSpec;
          }
        }
      }
    } catch {
      // Fallback
    }

    return undefined;
  }

  /**
   * Resolves a PyPI package specification to an exact version.
   */
  async resolvePypi(name: string, spec?: string): Promise<string | undefined> {
    const cleanSpec = spec?.trim().replace(/^==/, '');

    // 1. If spec is already exact pinned version
    if (cleanSpec && !/[~^><=*]/.test(cleanSpec) && cleanSpec !== 'latest') {
      return cleanSpec;
    }

    const cacheKey = `pypi_version:${name}:${cleanSpec || 'latest'}`;
    const cached = this.cache.get<string>(cacheKey);
    if (cached) {
      return cached;
    }

    // 2. Query PyPI JSON API
    try {
      const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = (await res.json()) as any;
        const latestVer = data.info?.version;
        if (typeof latestVer === 'string' && latestVer) {
          this.cache.set(cacheKey, latestVer);
          return latestVer;
        }
      }
    } catch {
      // Non-fatal
    }

    return undefined;
  }

  /**
   * General resolver dispatcher for ecosystem.
   */
  async resolve(name: string, ecosystem: Ecosystem, spec?: string): Promise<string | undefined> {
    if (ecosystem === 'npm') {
      return this.resolveNpm(name, spec);
    }
    return this.resolvePypi(name, spec);
  }
}
