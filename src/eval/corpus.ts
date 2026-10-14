import type { Ecosystem } from '../core/types.js';

export interface EvalCase {
  name: string;
  version?: string;
  ecosystem: Ecosystem;
  isMaliciousOrHallucinated: boolean;
  category:
    | 'hallucination'
    | 'malicious_advisory'
    | 'typosquat'
    | 'popular_control'
    | 'legit_longtail'
    | 'private_monorepo'
    | 'midtail_control'
    | 'binary_build_control'
    | 'near_top_control';
  split: 'dev' | 'test'; // 50/50 train-tune vs hold-out test split
}

export const EVAL_CORPUS: EvalCase[] = [
  // --- Malicious / Hallucinated / Squatted Cases ---
  { name: 'super-fast-audio-speech-12345', ecosystem: 'pypi', isMaliciousOrHallucinated: true, category: 'hallucination', split: 'dev' },
  { name: 'langchain-chroma-memory-v9', ecosystem: 'pypi', isMaliciousOrHallucinated: true, category: 'hallucination', split: 'test' },
  { name: 'ai-stream-optimizer-hallucinated', ecosystem: 'npm', isMaliciousOrHallucinated: true, category: 'hallucination', split: 'dev' },
  { name: 'huggingface-cli-utils-fake', ecosystem: 'pypi', isMaliciousOrHallucinated: true, category: 'hallucination', split: 'test' },
  { name: 'react-copilot-engine-xyz', ecosystem: 'npm', isMaliciousOrHallucinated: true, category: 'hallucination', split: 'test' },
  { name: 'chalk', version: '5.6.1', ecosystem: 'npm', isMaliciousOrHallucinated: true, category: 'malicious_advisory', split: 'test' }, // Malicious specifically at version 5.6.1 (MAL-2025-46969)
  { name: 'reqeusts', ecosystem: 'pypi', isMaliciousOrHallucinated: true, category: 'typosquat', split: 'dev' },
  { name: 'lodsh', ecosystem: 'npm', isMaliciousOrHallucinated: true, category: 'typosquat', split: 'dev' },
  { name: 'tnsorflow', ecosystem: 'pypi', isMaliciousOrHallucinated: true, category: 'typosquat', split: 'test' },
  { name: 'expres-generator', ecosystem: 'npm', isMaliciousOrHallucinated: true, category: 'typosquat', split: 'test' },

  // --- Benign Popular Controls (Pinned to versions >14d old) ---
  { name: 'requests', version: '2.31.0', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'popular_control', split: 'dev' },
  { name: 'numpy', version: '1.26.4', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'popular_control', split: 'test' },
  { name: 'urllib3', version: '2.2.1', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'popular_control', split: 'dev' },
  { name: 'flask', version: '3.0.3', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'popular_control', split: 'test' },
  { name: 'express', version: '4.19.2', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'popular_control', split: 'dev' },
  { name: 'lodash', version: '4.17.21', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'popular_control', split: 'test' },
  { name: 'react', version: '18.3.1', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'popular_control', split: 'dev' },
  { name: 'commander', version: '12.0.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'popular_control', split: 'test' },

  // --- Benign Legit Long-Tail / Near-Name Controls (Hard Negatives, Pinned >14d) ---
  { name: 'pug', version: '3.0.2', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'legit_longtail', split: 'dev' }, // near 'pg'
  { name: 'chai', version: '4.4.1', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'legit_longtail', split: 'test' }, // near 'chalk'
  { name: 'six', version: '1.16.0', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'legit_longtail', split: 'dev' }, // short name
  { name: 'ws', version: '8.16.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'legit_longtail', split: 'dev' }, // short name
  { name: 'colorama', version: '0.4.6', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'legit_longtail', split: 'test' },
  { name: 'fastapi', version: '0.110.0', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'legit_longtail', split: 'test' },

  // --- Benign Mid-Tail Controls 1 (Real npm/PyPI >1k weekly downloads, Pinned >14d) ---
  { name: 'ora', version: '8.0.1', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'kleur', version: '4.1.5', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'colorette', version: '2.0.20', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'mime-types', version: '2.1.35', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'is-glob', version: '4.0.3', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'flit-core', version: '3.9.0', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'pyasn1', version: '0.5.1', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'iniconfig', version: '2.0.0', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'zipp', version: '3.17.0', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'pathspec', version: '0.12.1', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },

  { name: 'picocolors', version: '1.0.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'statuses', version: '2.0.1', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'bytes', version: '3.1.2', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'supports-color', version: '9.4.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'strip-ansi', version: '7.1.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'filelock', version: '3.13.1', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'platformdirs', version: '4.2.0', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'cachetools', version: '5.3.3', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'tomli', version: '2.0.1', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'distlib', version: '0.3.8', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },

  // --- Binary / Install Script Controls (Required: esbuild, sharp, puppeteer, husky, playwright) ---
  { name: 'esbuild', version: '0.20.2', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'binary_build_control', split: 'dev' },
  { name: 'sharp', version: '0.33.2', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'binary_build_control', split: 'test' },
  { name: 'puppeteer', version: '22.4.1', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'binary_build_control', split: 'dev' },
  { name: 'husky', version: '9.0.11', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'binary_build_control', split: 'test' },
  { name: 'playwright', version: '1.42.1', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'binary_build_control', split: 'dev' },

  // --- 20 Benign Mid-Tail Controls (1k-100k Weekly Downloads, Pinned >14d, >=5 within edit distance 2 of top package) ---
  // Within distance 2 of a top package:
  { name: 'globs', version: '0.1.4', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'near_top_control', split: 'dev' }, // dist 1 to glob
  { name: 'chalker', version: '1.2.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'near_top_control', split: 'test' }, // dist 2 to chalk
  { name: 'colorsys', version: '1.0.22', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'near_top_control', split: 'dev' }, // dist 2 to colors
  { name: 'rimraf2', version: '0.1.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'near_top_control', split: 'test' }, // dist 1 to rimraf
  { name: 'rot', version: '0.1.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'near_top_control', split: 'dev' }, // dist 1 to got
  { name: 'clack', version: '1.2.0', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'near_top_control', split: 'test' }, // dist 1 to click

  // Additional 1k-100k weekly download real packages:
  { name: 'chai-spies', version: '1.0.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'mocha-clean', version: '0.4.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'dotenv-yaml', version: '0.1.4', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'cross-port-killer', version: '1.4.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'yaml-front-matter', version: '4.1.1', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'archiver-zip-encryptable', version: '1.0.10', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'markdown-it-toc-done-right', version: '4.2.0', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'click-repl', version: '0.3.0', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'requests-cache', version: '1.1.1', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'flask-jwt-extended', version: '4.6.0', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'pyyaml-env-tag', version: '0.1', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'types-six', version: '1.16.21.9', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },
  { name: 'pydantic-settings', version: '2.2.1', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'dev' },
  { name: 'pytest-mock', version: '3.12.0', ecosystem: 'pypi', isMaliciousOrHallucinated: false, category: 'midtail_control', split: 'test' },

  // --- Private Monorepo Fixtures ---
  { name: '@myorg/internal-auth', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'private_monorepo', split: 'dev' },
  { name: '@corp/data-pipeline', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'private_monorepo', split: 'test' },
  { name: 'workspace:packages/ui', ecosystem: 'npm', isMaliciousOrHallucinated: false, category: 'private_monorepo', split: 'test' },
];
