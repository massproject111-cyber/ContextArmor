/**
 * ContextArmor Core Types
 */

export type Ecosystem = 'npm' | 'pypi';

export type RiskLevel = 'SAFE' | 'LOW' | 'WARNING' | 'CRITICAL';

export type RegistryLookupState = 'EXISTS' | 'NOT_FOUND' | 'UNKNOWN';

export interface PackageTarget {
  name: string;
  version?: string;
  ecosystem: Ecosystem;
  isDirect?: boolean;
}

export interface PackageMetadata {
  name: string;
  ecosystem: Ecosystem;
  exists: boolean;
  lookupState: RegistryLookupState;
  firstReleaseDate?: string;
  latestReleaseDate?: string;
  latestVersion?: string;
  stableOlderVersion?: string;
  versionsCount?: number;
  dependentsCount?: number;
  repositoryUrl?: string;
  hasInstallScripts?: boolean;
  weeklyDownloads?: number;
  isUnpublished?: boolean;
  description?: string;
  networkError?: string;
  osvError?: string;
  osvAdvisories?: Array<{
    id: string;
    summary: string;
    details?: string;
    severity?: string;
  }>;
}

export interface RiskSignal {
  name: string;
  score: number; // 0 - 100
  weight: number;
  reason: string;
}

export interface RiskAssessment {
  target: PackageTarget;
  riskScore: number; // 0 - 100
  riskLevel: RiskLevel;
  signals: RiskSignal[];
  blockRecommended: boolean;
  metadata?: PackageMetadata;
  uncheckedReason?: string;
}

export interface InterceptionContext {
  rawCommand: string;
  extractedPackages: PackageTarget[];
  workingDirectory: string;
}
