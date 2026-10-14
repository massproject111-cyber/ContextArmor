import { PackageRiskEngine, classifyDecision } from '../detectors/packageRisk/index.js';
import { AllowlistManager } from '../core/allowlist.js';
import { EVAL_CORPUS } from './corpus.js';

async function diagnose() {
  const allowlist = new AllowlistManager();
  allowlist.addScope('@myorg');
  allowlist.addScope('@corp');
  const engine = new PackageRiskEngine(undefined, allowlist);

  console.log('--- DIAGNOSING EVAL PREDICTIONS ---');
  for (const item of EVAL_CORPUS) {
    const res = await engine.evaluate({ name: item.name, version: item.version, ecosystem: item.ecosystem });
    const decision = classifyDecision(res);
    if (!item.isMaliciousOrHallucinated && decision === 'BLOCK') {
      console.log(`[FALSE POSITIVE BLOCK] ${item.split} -> ${item.name} (${item.ecosystem}): Score=${res.riskScore}, Level=${res.riskLevel}`);
      for (const sig of res.signals) {
        console.log(`   Signal: ${sig.name} (${sig.score}) - ${sig.reason}`);
      }
    } else if (!item.isMaliciousOrHallucinated && decision === 'ASK') {
      console.log(`[BENIGN WARNING / ASK] ${item.split} -> ${item.name} (${item.ecosystem}): Score=${res.riskScore}, Level=${res.riskLevel}`);
      for (const sig of res.signals) {
        console.log(`   Signal: ${sig.name} (${sig.score}) - ${sig.reason}`);
      }
    }
  }
}

diagnose().catch(console.error);
