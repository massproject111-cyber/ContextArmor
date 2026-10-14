import { RegistryClient } from './registryClient.js';
import { evaluateSlopsquatting } from './slopsquatChecker.js';
import { checkTyposquatting } from './typosquatChecker.js';
import { AllowlistManager } from '../../core/allowlist.js';
import { VersionResolver } from './versionResolver.js';
import type { PackageTarget, RiskAssessment, RiskLevel } from '../../core/types.js';

export type SecurityDecision = 'BLOCK' | 'ASK' | 'ALLOW';

/**
 * Authoritative single decision function mapping a RiskAssessment to BLOCK / ASK / ALLOW.
 * Shared directly across hook interception and evaluation benchmarks.
 * UNKNOWN registry results and OSV errors map directly to ASK (never BLOCK, never silent ALLOW).
 */
export function classifyDecision(assessment: RiskAssessment): SecurityDecision {
  if (assessment.uncheckedReason) {
    return 'ASK';
  }
  if (assessment.blockRecommended || assessment.riskLevel === 'CRITICAL') {
    return 'BLOCK';
  }
  if (assessment.riskLevel === 'WARNING') {
    return 'ASK';
  }
  return 'ALLOW';
}

export class PackageRiskEngine {
  private registryClient: RegistryClient;
  private allowlist: AllowlistManager;
  private versionResolver: VersionResolver;

  constructor(
    registryClient?: RegistryClient,
    allowlist?: AllowlistManager,
    fetchFn?: typeof fetch,
    versionResolver?: VersionResolver
  ) {
    this.registryClient = registryClient || new RegistryClient(undefined, undefined, fetchFn);
    this.allowlist = allowlist || new AllowlistManager();
    this.versionResolver = versionResolver || new VersionResolver(undefined, fetchFn);
  }

  public async evaluate(
    target: PackageTarget,
    options?: { inHeadLockfile?: boolean }
  ): Promise<RiskAssessment> {
    // Resolve concrete version if not already exact pin
    const resolvedVersion = await this.versionResolver.resolve(target.name, target.ecosystem, target.version);
    if (resolvedVersion) {
      target.version = resolvedVersion;
    }

    // 1. Privacy & Monorepo Allowlist Check (for internal scopes and explicit user allowlist)
    if (this.allowlist.isAllowlistedOrPrivate(target.name)) {
      if (!this.allowlist.customRegistryConfigured) {
        return {
          target,
          riskScore: 0,
          riskLevel: 'SAFE',
          signals: [
            {
              name: 'allowlisted_or_private',
              score: 0,
              weight: 1.0,
              reason: `Package '${target.name}' matches internal organization scope or user allowlist.`,
            },
          ],
          blockRecommended: false,
        };
      }
      const meta = await this.registryClient.getMetadata(target.name, target.ecosystem, target.version);
      if (meta.osvAdvisories && meta.osvAdvisories.length > 0) {
        return {
          target,
          riskScore: 100,
          riskLevel: 'CRITICAL',
          signals: [
            {
              name: 'osv_malicious_advisory',
              score: 100,
              weight: 1.0,
              reason: `Custom registry package has confirmed malicious advisory: ${meta.osvAdvisories.map(a => a.id).join(', ')}`,
            },
          ],
          blockRecommended: true,
          metadata: meta,
        };
      }
      return {
        target,
        riskScore: 0,
        riskLevel: 'SAFE',
        signals: [
          {
            name: 'custom_registry_clean',
            score: 0,
            weight: 1.0,
            reason: `Package '${target.name}' hosted on custom registry; clean OSV status.`,
          },
        ],
        blockRecommended: false,
        metadata: meta,
      };
    }

    // 2. Fetch Authoritative Registry & Advisory Metadata
    const meta = await this.registryClient.getMetadata(target.name, target.ecosystem, target.version);

    // 3. Compute Slopsquatting & Vulnerability Signals
    const signals = evaluateSlopsquatting(meta, options);

    // 4. Compute Length-Scaled Typosquatting Signal with Adoption Gate
    const typoSignal = checkTyposquatting(target.name, target.ecosystem, meta);
    if (typoSignal) {
      signals.push(typoSignal);
    }

    // 5. Aggregate Weighted Score
    let totalScore = 0;
    if (signals.length > 0) {
      let weightSum = 0;
      let weightedProduct = 0;
      for (const sig of signals) {
        weightedProduct += sig.score * sig.weight;
        weightSum += sig.weight;
      }
      totalScore = weightSum > 0 ? Math.min(100, Math.round(weightedProduct / weightSum)) : 0;
    }

    let uncheckedReason: string | undefined;
    if (meta.lookupState === 'UNKNOWN') {
      uncheckedReason = `Registry lookup failed for '${target.name}' (${target.ecosystem}): ${meta.networkError || 'Network timeout or server error'}`;
    } else if (meta.osvError) {
      uncheckedReason = `OSV advisory check failed for '${target.name}' (${target.ecosystem}): ${meta.osvError}`;
    }

    // ============================================================================
    // CONTEXTARMOR SCORING & DECISION ESCALATION MATRIX
    // ----------------------------------------------------------------------------
    // | Signal / Condition                              | Criteria                                | Decision |
    // | :---------------------------------------------- | :-------------------------------------- | :------- |
    // | UNCHECKED (Registry/OSV error or timeout)       | lookupState === 'UNKNOWN' or osvError   | ASK      |
    // | NOT_FOUND (HTTP 404 dead name / hallucination)  | lookupState === 'NOT_FOUND'             | BLOCK    |
    // | OSV MAL- advisory                               | osvAdvisories.length > 0                | BLOCK    |
    // | Typosquat + Fresh / Low Adoption                | typoSignal AND (age < 30d or dl < 1000) | BLOCK    |
    // | Typosquat alone (Established package)           | typoSignal alone (age >= 30d, dl >= 1k) | ASK      |
    // | Cooldown 72h                                    | version age < 72h                       | ASK      |
    // | High risk score                                 | totalScore >= 75                        | BLOCK    |
    // | Warning risk score                              | totalScore >= 45                        | ASK      |
    // | Clean / Low risk                                | default clean package                   | ALLOW    |
    // ----------------------------------------------------------------------------
    // Invariant: NOT_FOUND (HTTP 404) = BLOCK always. Other signals can only escalate,
    // never lower. OSV MAL- hit = BLOCK always. Typosquat alone = ASK.
    // Typosquat AND (first release < 30d OR weekly downloads < 1000) = BLOCK.
    // ============================================================================
    let riskLevel: RiskLevel = 'SAFE';
    let blockRecommended = false;

    if (uncheckedReason) {
      riskLevel = 'WARNING';
      blockRecommended = false;
    } else if (meta.lookupState === 'NOT_FOUND') {
      riskLevel = 'CRITICAL';
      blockRecommended = true;
    } else if (meta.osvAdvisories && meta.osvAdvisories.length > 0) {
      riskLevel = 'CRITICAL';
      blockRecommended = true;
    } else if (meta.isUnpublished || signals.some(s => s.name === 'security_quarantine_stub')) {
      riskLevel = 'WARNING';
      blockRecommended = false;
    } else if (typoSignal) {
      const MS_IN_DAY = 24 * 60 * 60 * 1000;
      const ageDays = meta.firstReleaseDate
        ? (Date.now() - new Date(meta.firstReleaseDate).getTime()) / MS_IN_DAY
        : 0;
      const isYoung = ageDays < 30;
      const hasLowDownloads = meta.weeklyDownloads !== undefined
        ? meta.weeklyDownloads < 1000
        : (meta.ecosystem === 'npm');

      if (isYoung || (hasLowDownloads && ageDays < 90)) {
        riskLevel = 'CRITICAL';
        blockRecommended = true;
      } else {
        riskLevel = 'WARNING';
        blockRecommended = false;
      }
    } else if (totalScore >= 75) {
      riskLevel = 'CRITICAL';
      blockRecommended = true;
    } else if (totalScore >= 45) {
      riskLevel = 'WARNING';
    } else if (totalScore > 0) {
      riskLevel = 'LOW';
    }

    return {
      target,
      riskScore: totalScore,
      riskLevel,
      signals,
      blockRecommended,
      metadata: meta,
      uncheckedReason,
    };
  }

  /**
   * Fast batch evaluation: resolves versions, bulk-queries npm downloads,
   * performs a single OSV /v1/querybatch call, and fetches packuments with bounded concurrency.
   */
  public async evaluateBatch(
    targets: PackageTarget[],
    optionsMap?: Map<string, { inHeadLockfile?: boolean }>
  ): Promise<{ target: PackageTarget; assessment: RiskAssessment }[]> {
    const results: { target: PackageTarget; assessment: RiskAssessment }[] = [];
    if (targets.length === 0) return results;

    // 1. Resolve concrete versions in parallel
    await Promise.all(
      targets.map(async (t) => {
        const resolved = await this.versionResolver.resolve(t.name, t.ecosystem, t.version);
        if (resolved) {
          t.version = resolved;
        }
      })
    );

    // 2. Separate allowlisted / internal packages
    const nonAllowlisted: PackageTarget[] = [];
    for (const target of targets) {
      if (this.allowlist.isAllowlistedOrPrivate(target.name) && !this.allowlist.customRegistryConfigured) {
        results.push({
          target,
          assessment: {
            target,
            riskScore: 0,
            riskLevel: 'SAFE',
            signals: [
              {
                name: 'allowlisted_or_private',
                score: 0,
                weight: 1.0,
                reason: `Package '${target.name}' matches internal organization scope or user allowlist.`,
              },
            ],
            blockRecommended: false,
          },
        });
      } else {
        nonAllowlisted.push(target);
      }
    }

    if (nonAllowlisted.length === 0) return results;

    // 3. Check Disk Cache first for each target
    const targetMetas: { target: PackageTarget; meta: any }[] = [];
    const uncachedTargets: PackageTarget[] = [];

    for (const target of nonAllowlisted) {
      const cached = this.registryClient.getCachedMetadata(target.name, target.ecosystem, target.version);
      if (cached) {
        targetMetas.push({ target, meta: cached });
      } else {
        uncachedTargets.push(target);
      }
    }

    if (uncachedTargets.length > 0) {
      // Fetch packument metadata with bounded concurrency (25 concurrent)
      const concurrency = 25;
      const newlyFetched: { target: PackageTarget; meta: any }[] = [];
      for (let i = 0; i < uncachedTargets.length; i += concurrency) {
        const chunk = uncachedTargets.slice(i, i + concurrency);
        const chunkMetas = await Promise.all(
          chunk.map(async (target) => {
            const meta = await this.registryClient.getMetadata(
              target.name,
              target.ecosystem,
              target.version,
              { skipEnrichment: true }
            );
            return { target, meta };
          })
        );
        newlyFetched.push(...chunkMetas);
      }

      // Bulk enrich npm downloads for uncached npm targets
      const npmMetas = newlyFetched.map(tm => tm.meta).filter(m => m.ecosystem === 'npm');
      await this.registryClient.enrichBulkNpmDownloads(npmMetas);

      // Bulk query OSV in single querybatch request
      const osvItems = newlyFetched.map(tm => ({
        name: tm.target.name,
        ecosystem: tm.target.ecosystem,
        version: tm.target.version,
        meta: tm.meta,
      }));
      await this.registryClient.batchQueryOsv(osvItems);

      // Save each newly-enriched meta to disk cache for instantaneous warm runs
      for (const { target, meta } of newlyFetched) {
        if (meta.lookupState !== 'UNKNOWN' && !meta.osvError) {
          this.registryClient.cacheMetadata(meta, target.version);
        }
        targetMetas.push({ target, meta });
      }
    }

    // 4. Score each package
    for (const { target, meta } of targetMetas) {
      const options = optionsMap?.get(target.name);
      const signals = evaluateSlopsquatting(meta, options);
      const typoSignal = checkTyposquatting(target.name, target.ecosystem, meta);
      if (typoSignal) {
        signals.push(typoSignal);
      }

      let totalScore = 0;
      if (signals.length > 0) {
        let weightSum = 0;
        let weightedProduct = 0;
        for (const sig of signals) {
          weightedProduct += sig.score * sig.weight;
          weightSum += sig.weight;
        }
        totalScore = weightSum > 0 ? Math.min(100, Math.round(weightedProduct / weightSum)) : 0;
      }

      let uncheckedReason: string | undefined;
      if (meta.lookupState === 'UNKNOWN') {
        uncheckedReason = `Registry lookup failed for '${target.name}' (${target.ecosystem}): ${meta.networkError || 'Network timeout or server error'}`;
      } else if (meta.osvError) {
        uncheckedReason = `OSV advisory check failed for '${target.name}' (${target.ecosystem}): ${meta.osvError}`;
      }

      let riskLevel: RiskLevel = 'SAFE';
      let blockRecommended = false;

      if (uncheckedReason) {
        riskLevel = 'WARNING';
        blockRecommended = false;
      } else if (meta.lookupState === 'NOT_FOUND') {
        riskLevel = 'CRITICAL';
        blockRecommended = true;
      } else if (meta.osvAdvisories && meta.osvAdvisories.length > 0) {
        riskLevel = 'CRITICAL';
        blockRecommended = true;
      } else if (meta.isUnpublished || signals.some(s => s.name === 'security_quarantine_stub')) {
        riskLevel = 'WARNING';
        blockRecommended = false;
      } else if (typoSignal) {
        const MS_IN_DAY = 24 * 60 * 60 * 1000;
        const ageDays = meta.firstReleaseDate
          ? (Date.now() - new Date(meta.firstReleaseDate).getTime()) / MS_IN_DAY
          : 0;
        const isYoung = ageDays < 30;
        const hasLowDownloads = meta.weeklyDownloads !== undefined
          ? meta.weeklyDownloads < 1000
          : (meta.ecosystem === 'npm');

        if (isYoung || (hasLowDownloads && ageDays < 90)) {
          riskLevel = 'CRITICAL';
          blockRecommended = true;
        } else {
          riskLevel = 'WARNING';
          blockRecommended = false;
        }
      } else if (totalScore >= 75) {
        riskLevel = 'CRITICAL';
        blockRecommended = true;
      } else if (totalScore >= 45) {
        riskLevel = 'WARNING';
      } else if (totalScore > 0) {
        riskLevel = 'LOW';
      }

      results.push({
        target,
        assessment: {
          target,
          riskScore: totalScore,
          riskLevel,
          signals,
          blockRecommended,
          metadata: meta,
          uncheckedReason,
        },
      });
    }

    return results;
  }
}
