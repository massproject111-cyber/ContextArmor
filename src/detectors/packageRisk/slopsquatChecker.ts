import type { PackageMetadata, RiskSignal } from '../../core/types.js';

const MS_IN_DAY = 24 * 60 * 60 * 1000;

export function evaluateSlopsquatting(
  meta: PackageMetadata,
  options?: { inHeadLockfile?: boolean }
): RiskSignal[] {
  const signals: RiskSignal[] = [];

  // 1. Dead name hallucination: ONLY HTTP 404 (NOT_FOUND) triggers unregistered_hallucination
  if (meta.lookupState === 'NOT_FOUND') {
    signals.push({
      name: 'unregistered_hallucination',
      score: 100,
      weight: 0.40,
      reason: `Package '${meta.name}' does not exist on ${meta.ecosystem} registry (HTTP 404: unregistered AI hallucination, vulnerable to slopsquatting).`,
    });
    return signals;
  }

  // If lookup failed due to network/server error (UNKNOWN), do not perform age/download scoring
  if (meta.lookupState === 'UNKNOWN') {
    return signals;
  }

  // 2. Known OSV MAL- advisory (highest authoritative priority)
  if (meta.osvAdvisories && meta.osvAdvisories.length > 0) {
    signals.push({
      name: 'osv_malicious_advisory',
      score: 100,
      weight: 0.50,
      reason: `Package has confirmed malicious advisory: ${meta.osvAdvisories.map((a) => a.id).join(', ')}`,
    });
  }

  // 2b. Security quarantine placeholder stub (quarantined by registry security team)
  if (
    (meta.latestVersion && meta.latestVersion.includes('security')) ||
    (meta.description && /security holding package/i.test(meta.description))
  ) {
    signals.push({
      name: 'security_quarantine_stub',
      score: 100,
      weight: 1.0,
      reason: `Package '${meta.name}' is a security holding quarantine placeholder published by the registry security team (version ${meta.latestVersion || 'quarantine'}).`,
    });
  }

  // 2c. Unpublished package check (HTTP 200 with unpublished timestamp and no OSV hit)
  if (meta.isUnpublished) {
    signals.push({
      name: 'unpublished_package',
      score: 50,
      weight: 1.0,
      reason: `Package '${meta.name}' was unpublished by its author from the registry.`,
    });
    return signals;
  }

  const now = Date.now();

  // 3. First release age (newly published)
  if (meta.firstReleaseDate) {
    const firstTime = new Date(meta.firstReleaseDate).getTime();
    const ageDays = (now - firstTime) / MS_IN_DAY;

    if (ageDays < 3) {
      // < 72 hours
      signals.push({
        name: 'recently_registered',
        score: 90,
        weight: 0.25,
        reason: `Package was first published ${ageDays.toFixed(1)} days ago (< 72 hours). High risk of freshly registered hallucination or squat.`,
      });
    } else if (ageDays < 30) {
      signals.push({
        name: 'young_package',
        score: 40,
        weight: 0.15,
        reason: `Package is relatively new (${ageDays.toFixed(0)} days old).`,
      });
    }
  }

  // 4. Latest version release age: 72-hour cooldown rule
  // Suppressed if the exact package version was already recorded in HEAD lockfile.
  if (!options?.inHeadLockfile && meta.latestReleaseDate) {
    const latestTime = new Date(meta.latestReleaseDate).getTime();
    const latestAgeHours = (now - latestTime) / (60 * 60 * 1000);

    if (latestAgeHours < 72) {
      const verStr = meta.latestVersion ? `@${meta.latestVersion}` : '';
      const olderVer = meta.stableOlderVersion;
      const pinCmd = meta.ecosystem === 'npm'
        ? `npm i ${meta.name}@${olderVer || 'pinned-version'}`
        : `pip install ${meta.name}==${olderVer || 'pinned-version'}`;
      const olderInfo = olderVer
        ? `Newest version older than 72h: '${olderVer}'. Suggested pin: '${pinCmd}'.`
        : `No version older than 72h found.`;

      signals.push({
        name: 'version_cooldown_72h',
        score: 50,
        weight: 1.0,
        reason: `Package '${meta.name}${verStr}' was published ${latestAgeHours.toFixed(1)} hours ago (< 72h cooldown). High risk of unvetted fresh release or hijack. ${olderInfo}`,
      });
    }
  }

  // 5. Install script execution (npm preinstall/postinstall)
  // Hardening rule: established packages with high weekly downloads (e.g. esbuild, sharp, puppeteer) are expected to compile binaries.
  // Only flag install scripts if package has low adoption (weekly downloads < 1000) OR is young (< 30d).
  if (meta.hasInstallScripts) {
    const isYoung = meta.firstReleaseDate && ((now - new Date(meta.firstReleaseDate).getTime()) / MS_IN_DAY < 30);
    const hasLowDownloads = meta.weeklyDownloads !== undefined && meta.weeklyDownloads < 1000;

    if (isYoung || hasLowDownloads) {
      signals.push({
        name: 'install_scripts_present',
        score: 75,
        weight: 0.20,
        reason: 'Package executes preinstall/postinstall lifecycle scripts and has low adoption or is newly published.',
      });
    }
  }

  // 6. Unvetted zero adoption: zero weekly downloads on single-version release
  if (meta.weeklyDownloads === 0 && meta.versionsCount !== undefined && meta.versionsCount <= 1) {
    signals.push({
      name: 'unvetted_zero_adoption',
      score: 55,
      weight: 0.35,
      reason: `Package '${meta.name}' has 0 weekly downloads and only a single release. Unvetted adoption risk.`,
    });
  }

  return signals;
}
