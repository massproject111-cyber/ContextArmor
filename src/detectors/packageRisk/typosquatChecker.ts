import { TOP_PYPI_PACKAGES, TOP_NPM_PACKAGES } from './topPackages.js';
import type { Ecosystem, RiskSignal } from '../../core/types.js';

function levenshtein(a: string, b: string): number {
  const an = a.length;
  const bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix: number[][] = [];
  for (let i = 0; i <= bn; ++i) matrix[i] = [i];
  for (let i = 0; i <= an; ++i) matrix[0][i] = i;

  for (let i = 1; i <= bn; ++i) {
    for (let j = 1; j <= an; ++j) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1) // insertion / deletion
        );
      }
    }
  }
  return matrix[bn][an];
}

export function checkTyposquatting(
  candidate: string,
  ecosystem: Ecosystem,
  meta?: { weeklyDownloads?: number; firstReleaseDate?: string; dependentsCount?: number; exists?: boolean }
): RiskSignal | null {
  const norm = candidate.toLowerCase();
  const topSet = ecosystem === 'npm' ? TOP_NPM_PACKAGES : TOP_PYPI_PACKAGES;

  // Exact match to top package is obviously not a typosquat
  if (topSet.has(norm)) {
    return null;
  }

  const len = norm.length;
  // Guardrail: short names (<4 chars) are completely skipped for fuzzy Levenshtein
  if (len < 4) {
    return null;
  }

  // Length scaled threshold:
  // len 4-5 => dist <= 1
  // len >= 6 => dist <= 2
  const maxAllowedDist = len >= 6 ? 2 : 1;

  for (const popular of topSet) {
    // Skip if length diff is greater than allowed distance
    if (Math.abs(len - popular.length) > maxAllowedDist) {
      continue;
    }

    const dist = levenshtein(norm, popular);
    if (dist > 0 && dist <= maxAllowedDist) {
      return {
        name: 'typosquat_similarity',
        score: 60,
        weight: 1.0,
        reason: `Package name '${candidate}' is edit distance ${dist} from popular package '${popular}' (possible typosquat). Confirm installation?`,
      };
    }
  }

  return null;
}
