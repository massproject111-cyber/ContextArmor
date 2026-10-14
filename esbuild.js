import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

async function main() {
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    sourcemap: true,
    logLevel: 'info',
  };

  // Build CLI tool
  await esbuild.build({
    ...common,
    entryPoints: ['src/cli/index.ts'],
    outfile: 'dist/cli.js',
    banner: { js: '#!/usr/bin/env node\n' },
  });

  // Build Evaluation Suite
  await esbuild.build({
    ...common,
    entryPoints: ['src/eval/runBenchmark.ts'],
    outfile: 'dist/eval.js',
  });

  // Build Diagnostic tool
  await esbuild.build({
    ...common,
    entryPoints: ['src/eval/diagnose.ts'],
    outfile: 'dist/diagnose.js',
  });

  // Build Fault Injection tests
  await esbuild.build({
    ...common,
    entryPoints: ['tests/faultInjection.ts'],
    outfile: 'dist/faultInjection.js',
  });

  // Build Outage Latency test
  await esbuild.build({
    ...common,
    entryPoints: ['tests/outageLatency.ts'],
    outfile: 'dist/outageLatency.js',
  });

  // Build VS Code Extension
  await esbuild.build({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
  });

  // Build Extension Diagnostics Unit Test
  await esbuild.build({
    ...common,
    entryPoints: ['tests/extensionDiagnostics.test.ts'],
    outfile: 'dist/extensionDiagnostics.test.js',
  });

  console.log('Build completed successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
