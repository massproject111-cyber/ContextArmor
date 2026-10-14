import { DiskCache } from '../../core/cache.js';
import type { Ecosystem, PackageMetadata } from '../../core/types.js';

export class RegistryClient {
  private cache: DiskCache;
  private osvCache: DiskCache;
  private fetchFn: typeof fetch;

  constructor(cache?: DiskCache, osvCache?: DiskCache, fetchFn?: typeof fetch) {
    // Packument, metadata, and OSV caches have strict 15-minute TTL per specification
    this.cache = cache || new DiskCache(0, 15);
    this.osvCache = osvCache || new DiskCache(0, 15);
    this.fetchFn = fetchFn || globalThis.fetch;
  }

  public getCachedMetadata(name: string, ecosystem: Ecosystem, version?: string): PackageMetadata | null {
    const cacheKey = `meta:${ecosystem}:${name.toLowerCase()}${version ? `:${version}` : ''}`;
    return this.cache.get<PackageMetadata>(cacheKey);
  }

  public cacheMetadata(meta: PackageMetadata, version?: string): void {
    if (meta.lookupState === 'UNKNOWN' || meta.osvError) {
      return;
    }
    const cacheKey = `meta:${meta.ecosystem}:${meta.name.toLowerCase()}${version ? `:${version}` : ''}`;
    this.cache.set(cacheKey, meta);
  }

  /**
   * Fetches metadata directly from authoritative registries (npm or PyPI).
   */
  public async getMetadata(
    name: string,
    ecosystem: Ecosystem,
    version?: string,
    options?: { skipEnrichment?: boolean }
  ): Promise<PackageMetadata> {
    const cacheKey = `meta:${ecosystem}:${name.toLowerCase()}${version ? `:${version}` : ''}`;
    const cached = this.cache.get<PackageMetadata>(cacheKey);
    if (cached) {
      return cached;
    }

    let meta: PackageMetadata;
    if (ecosystem === 'npm') {
      meta = await this.fetchNpmMetadata(name, version);
    } else {
      meta = await this.fetchPyPiMetadata(name, version);
    }

    if (!options?.skipEnrichment) {
      // Enrich with OSV and npm downloads in parallel
      await Promise.allSettled([
        this.enrichFromOsv(meta, version),
        this.enrichNpmDownloads(meta),
      ]);
      // Only cache valid EXISTS and NOT_FOUND results, don't cache temporary UNKNOWN errors
      if (meta.lookupState !== 'UNKNOWN') {
        this.cache.set(cacheKey, meta);
      }
    }

    return meta;
  }

  private async enrichNpmDownloads(meta: PackageMetadata): Promise<void> {
    if (!meta.exists || meta.ecosystem !== 'npm') return;
    const url = `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(meta.name)}`;
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as any;
        if (typeof data.downloads === 'number') {
          meta.weeklyDownloads = data.downloads;
        }
      }
    } catch {}
  }

  private async fetchNpmMetadata(name: string, targetVersion?: string): Promise<PackageMetadata> {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    let lastError: string | undefined;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (res.status === 404) {
          return { name, ecosystem: 'npm', exists: false, lookupState: 'NOT_FOUND' };
        }
        if (!res.ok) {
          lastError = `HTTP ${res.status} ${res.statusText}`;
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 100));
            continue;
          }
          return {
            name,
            ecosystem: 'npm',
            exists: false,
            lookupState: 'UNKNOWN',
            networkError: lastError,
          };
        }

        const data = await res.json() as any;
        const versionsCount = Object.keys(data.versions || {}).length;
        if (data.time?.unpublished || versionsCount === 0) {
          const unpubTime = typeof data.time?.unpublished === 'string'
            ? data.time.unpublished
            : data.time?.unpublished?.time || data.time?.modified;
          return {
            name,
            ecosystem: 'npm',
            exists: false,
            lookupState: 'EXISTS',
            isUnpublished: true,
            versionsCount: 0,
            firstReleaseDate: data.time?.created,
            latestReleaseDate: unpubTime,
            description: data.description,
          };
        }

        const times = data.time || {};
        const firstReleaseDate = times.created;
        const latestVersionKey = data['dist-tags']?.latest;
        const targetVer = targetVersion || latestVersionKey;

        let latestReleaseDate = (targetVer && times[targetVer]) ? times[targetVer] : undefined;
        if (!latestReleaseDate && latestVersionKey && times[latestVersionKey]) {
          latestReleaseDate = times[latestVersionKey];
        }
        if (!latestReleaseDate) {
          latestReleaseDate = times.modified;
        }

        let hasInstallScripts = false;
        const checkVer = targetVer || latestVersionKey;
        if (checkVer && data.versions?.[checkVer]) {
          const pkgJson = data.versions[checkVer];
          const scripts = pkgJson.scripts || {};
          hasInstallScripts = Boolean(scripts.preinstall || scripts.install || scripts.postinstall);
        }

        const repoUrl = typeof data.repository === 'string'
          ? data.repository
          : data.repository?.url;

        // Find newest version published >= 72 hours ago for cooldown pin suggestion
        const now = Date.now();
        const MS_IN_HOUR = 60 * 60 * 1000;
        let stableOlderVersion: string | undefined;
        const sortedNpmVersions = Object.entries(times)
          .filter(([k, v]) => k !== 'created' && k !== 'modified' && typeof v === 'string')
          .sort((a, b) => new Date(b[1] as string).getTime() - new Date(a[1] as string).getTime());

        for (const [ver, timeStr] of sortedNpmVersions) {
          const ageHours = (now - new Date(timeStr as string).getTime()) / MS_IN_HOUR;
          if (ageHours >= 72) {
            stableOlderVersion = ver;
            break;
          }
        }

        return {
          name,
          ecosystem: 'npm',
          exists: true,
          lookupState: 'EXISTS',
          firstReleaseDate,
          latestReleaseDate,
          latestVersion: checkVer,
          stableOlderVersion,
          versionsCount,
          hasInstallScripts,
          repositoryUrl: repoUrl,
          description: data.description,
        };
      } catch (err: any) {
        lastError = err?.message || 'Network request failed';
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
        return {
          name,
          ecosystem: 'npm',
          exists: false,
          lookupState: 'UNKNOWN',
          networkError: lastError,
        };
      }
    }

    return {
      name,
      ecosystem: 'npm',
      exists: false,
      lookupState: 'UNKNOWN',
      networkError: lastError || 'Max retries exceeded',
    };
  }

  private async fetchPyPiMetadata(name: string, targetVersion?: string): Promise<PackageMetadata> {
    const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    let lastError: string | undefined;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
        if (res.status === 404) {
          return { name, ecosystem: 'pypi', exists: false, lookupState: 'NOT_FOUND' };
        }
        if (!res.ok) {
          lastError = `HTTP ${res.status} ${res.statusText}`;
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 100));
            continue;
          }
          return {
            name,
            ecosystem: 'pypi',
            exists: false,
            lookupState: 'UNKNOWN',
            networkError: lastError,
          };
        }

        const data = await res.json() as any;
        const releases = data.releases || {};
        const releaseKeys = Object.keys(releases);
        const versionsCount = releaseKeys.length;

        let firstDate: string | undefined;
        let latestDate: string | undefined;

        if (targetVersion && releases[targetVersion] && releases[targetVersion].length > 0) {
          for (const file of releases[targetVersion]) {
            if (file.upload_time_iso_8601) {
              latestDate = file.upload_time_iso_8601;
              break;
            }
          }
        }

        const allUploadTimes: string[] = [];
        for (const k of releaseKeys) {
          for (const file of releases[k] || []) {
            if (file.upload_time_iso_8601) {
              allUploadTimes.push(file.upload_time_iso_8601);
            }
          }
        }

        if (allUploadTimes.length > 0) {
          allUploadTimes.sort();
          firstDate = allUploadTimes[0];
          if (!latestDate) {
            latestDate = allUploadTimes[allUploadTimes.length - 1];
          }
        }

        const info = data.info || {};
        const repoUrl = info.project_urls?.Source || info.project_urls?.Repository || info.home_page;

        // Find newest version published >= 72 hours ago for cooldown pin suggestion
        const now = Date.now();
        const MS_IN_HOUR = 60 * 60 * 1000;
        let stableOlderVersion: string | undefined;
        const versionDates: Array<{ ver: string; date: number }> = [];

        for (const [ver, files] of Object.entries(releases)) {
          if (Array.isArray(files) && files.length > 0 && (files[0] as any).upload_time_iso_8601) {
            versionDates.push({
              ver,
              date: new Date((files[0] as any).upload_time_iso_8601).getTime(),
            });
          }
        }
        versionDates.sort((a, b) => b.date - a.date);

        for (const item of versionDates) {
          const ageHours = (now - item.date) / MS_IN_HOUR;
          if (ageHours >= 72) {
            stableOlderVersion = item.ver;
            break;
          }
        }

        const checkVer = targetVersion || info.version;

        return {
          name,
          ecosystem: 'pypi',
          exists: true,
          lookupState: 'EXISTS',
          firstReleaseDate: firstDate,
          latestReleaseDate: latestDate,
          latestVersion: checkVer,
          stableOlderVersion,
          versionsCount,
          repositoryUrl: repoUrl,
        };
      } catch (err: any) {
        lastError = err?.message || 'Network request failed';
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
        return {
          name,
          ecosystem: 'pypi',
          exists: false,
          lookupState: 'UNKNOWN',
          networkError: lastError,
        };
      }
    }

    return {
      name,
      ecosystem: 'pypi',
      exists: false,
      lookupState: 'UNKNOWN',
      networkError: lastError || 'Max retries exceeded',
    };
  }

  /**
   * Bulk queries npm downloads in a single endpoint call (up to 100 packages per request).
   */
  public async enrichBulkNpmDownloads(metas: PackageMetadata[]): Promise<void> {
    const npmMetas = metas.filter(m => m.exists && m.ecosystem === 'npm');
    if (npmMetas.length === 0) return;

    const chunkSize = 100;
    for (let i = 0; i < npmMetas.length; i += chunkSize) {
      const chunk = npmMetas.slice(i, i + chunkSize);
      const pkgList = chunk.map(m => m.name).join(',');
      const url = `https://api.npmjs.org/downloads/point/last-week/${pkgList}`;
      try {
        const res = await this.fetchFn(url, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const data = await res.json() as any;
          for (const meta of chunk) {
            const entry = data[meta.name] || (data.package === meta.name ? data : undefined);
            if (entry && typeof entry.downloads === 'number') {
              meta.weeklyDownloads = entry.downloads;
            }
          }
        }
      } catch {}
    }
  }

  /**
   * Bulk queries OSV using a single POST /v1/querybatch endpoint.
   * Caches individual package results in osvCache with 15-minute TTL.
   */
  public async batchQueryOsv(targets: { name: string; ecosystem: Ecosystem; version?: string; meta: PackageMetadata }[]): Promise<void> {
    const validTargets: { name: string; ecosystem: Ecosystem; version: string; meta: PackageMetadata }[] = [];

    for (const t of targets) {
      const isUnresolvable = !t.meta.exists || t.meta.isUnpublished || t.meta.lookupState !== 'EXISTS';
      const resolvedVer = (t.version && t.version !== 'latest' && !/[~^><=*]/.test(t.version))
        ? t.version
        : t.meta.latestVersion;

      if (resolvedVer && !isUnresolvable) {
        validTargets.push({
          name: t.name,
          ecosystem: t.ecosystem,
          version: resolvedVer,
          meta: t.meta,
        });
      } else if (!isUnresolvable) {
        // Unresolved version on a registered package -> set meta.osvError = "version unresolved; OSV unchecked" (ASK)
        t.meta.osvError = 'version unresolved; OSV unchecked';
      }
    }

    if (validTargets.length === 0) return;

    const uncachedTargets: typeof validTargets = [];
    for (const t of validTargets) {
      const cacheKey = `osv:${t.ecosystem}:${t.name.toLowerCase()}:${t.version}`;
      const cached = this.osvCache.get<any[]>(cacheKey);
      if (cached) {
        if (cached.length > 0) {
          t.meta.osvAdvisories = cached;
        }
      } else {
        uncachedTargets.push(t);
      }
    }

    if (uncachedTargets.length === 0) return;

    const url = 'https://api.osv.dev/v1/querybatch';
    const queries = uncachedTargets.map(t => ({
      package: {
        name: t.name,
        ecosystem: t.ecosystem === 'npm' ? 'npm' : 'PyPI',
      },
      version: t.version,
    }));

    let lastError: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queries }),
          signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
          lastError = `HTTP ${res.status} ${res.statusText}`;
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 100));
            continue;
          }
          for (const t of uncachedTargets) {
            t.meta.osvError = `OSV service returned ${lastError}`;
          }
          return;
        }

        const data = await res.json() as any;
        const results = data.results || [];
        for (let i = 0; i < uncachedTargets.length; i++) {
          const t = uncachedTargets[i];
          const r = results[i];
          const cacheKey = `osv:${t.ecosystem}:${t.name.toLowerCase()}:${t.version}`;
          let advisories: any[] = [];
          if (r && Array.isArray(r.vulns)) {
            const malEntries = r.vulns.filter((v: any) =>
              typeof v.id === 'string' && (v.id.startsWith('MAL-') || v.id.startsWith('OSV-MAL-'))
            );
            if (malEntries.length > 0) {
              advisories = malEntries.map((v: any) => ({
                id: v.id,
                summary: v.summary || 'Confirmed malicious package advisory',
                details: v.details,
              }));
              t.meta.osvAdvisories = advisories;
            }
          }
          this.osvCache.set(cacheKey, advisories);
        }
        return;
      } catch (err: any) {
        lastError = err?.message || 'OSV batch query failed';
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
        for (const t of uncachedTargets) {
          t.meta.osvError = lastError;
        }
        return;
      }
    }
  }

  private async enrichFromOsv(meta: PackageMetadata, version?: string): Promise<void> {
    const isUnresolvable = !meta.exists || meta.isUnpublished || meta.lookupState !== 'EXISTS';
    const resolvedVer = (version && version !== 'latest' && !/[~^><=*]/.test(version))
      ? version
      : meta.latestVersion;

    // Package-level OSV query only for unpublished/unresolvable packages, never when a version resolved.
    let verKey: string | undefined;
    if (resolvedVer && !isUnresolvable) {
      verKey = resolvedVer;
    } else if (isUnresolvable) {
      verKey = 'pkg';
    } else {
      // Unresolved version on a registered package -> set meta.osvError = "version unresolved; OSV unchecked" (ASK)
      meta.osvError = 'version unresolved; OSV unchecked';
      return;
    }

    const cacheKey = `osv:${meta.ecosystem}:${meta.name.toLowerCase()}:${verKey}`;
    const cached = this.osvCache.get<any[]>(cacheKey);
    if (cached) {
      if (cached.length > 0) {
        meta.osvAdvisories = cached;
      }
      return;
    }

    const url = 'https://api.osv.dev/v1/query';
    const ecosystem = meta.ecosystem === 'npm' ? 'npm' : 'PyPI';
    const payload: any = {
      package: {
        name: meta.name,
        ecosystem,
      },
    };
    if (verKey !== 'pkg') {
      payload.version = verKey;
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(3000),
        });

        if (!res.ok) {
          lastError = `HTTP ${res.status} ${res.statusText}`;
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 100));
            continue;
          }
          meta.osvError = `OSV service returned ${lastError}`;
          return;
        }

        const data = await res.json() as any;
        let advisories: any[] = [];
        if (Array.isArray(data.vulns)) {
          const malEntries = data.vulns.filter((v: any) =>
            typeof v.id === 'string' && (v.id.startsWith('MAL-') || v.id.startsWith('OSV-MAL-'))
          );
          if (malEntries.length > 0) {
            advisories = malEntries.map((v: any) => ({
              id: v.id,
              summary: v.summary || 'Confirmed malicious package advisory',
              details: v.details,
            }));
            meta.osvAdvisories = advisories;
          }
        }
        this.osvCache.set(cacheKey, advisories);
        return;
      } catch (err: any) {
        lastError = err?.message || 'OSV query failed';
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
        meta.osvError = lastError;
        return;
      }
    }
  }
}
