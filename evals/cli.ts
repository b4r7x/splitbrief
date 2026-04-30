import { resolve } from 'node:path';
import { runEvalSuite } from './runner.js';
import { addEndpointScenario } from './scenarios/add-endpoint.js';
import { addTestScenario } from './scenarios/add-test.js';
import { addValidationScenario } from './scenarios/add-validation.js';
import { fixBugScenario } from './scenarios/fix-bug.js';
import { refactorExtractScenario } from './scenarios/refactor-extract.js';

const ALL_SCENARIOS = [
  addEndpointScenario,
  fixBugScenario,
  addTestScenario,
  refactorExtractScenario,
  addValidationScenario,
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const plannerModel = getArg(args, '--planner-model') ?? 'gpt-4o';
  const baselineModel = getArg(args, '--baseline-model') ?? plannerModel;
  const routedModel = getArg(args, '--routed-model') ?? 'gpt-4o-mini';
  const baseUrl = getArg(args, '--base-url') ?? process.env['DIPTYCH_EVAL_API_BASE'] ?? '';
  const apiKey = getArg(args, '--api-key') ?? process.env['DIPTYCH_EVAL_API_KEY'] ?? '';
  const provider = getArg(args, '--provider') ?? 'openai';
  const scenarioFilter = getArg(args, '--scenario');
  const record = args.includes('--record');
  const replay = args.includes('--replay');

  if (record && replay) {
    console.error('Error: use either --record or --replay, not both');
    process.exit(1);
  }

  if (!apiKey && !replay) {
    console.error('Error: --api-key or DIPTYCH_EVAL_API_KEY required unless --replay is used');
    process.exit(1);
  }

  if (!baseUrl && !replay) {
    console.error('Error: --base-url or DIPTYCH_EVAL_API_BASE required unless --replay is used');
    process.exit(1);
  }

  const scenarios = scenarioFilter
    ? ALL_SCENARIOS.filter((scenario) => scenario.id === scenarioFilter)
    : ALL_SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`No matching scenario: ${scenarioFilter}`);
    console.error(`Available: ${ALL_SCENARIOS.map((scenario) => scenario.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`Eval: ${scenarios.length} scenarios | planner=${plannerModel} | baseline=${baselineModel} | routed=${routedModel}`);
  if (record) console.log('Recording cassettes...');
  if (replay) console.log('Replaying from cassettes...');

  const report = await runEvalSuite({
    scenarios,
    plannerModel,
    baselineImplementerModel: baselineModel,
    routedImplementerModel: routedModel,
    provider,
    baseUrl,
    apiKey,
    cassetteDir: resolve(import.meta.dirname, 'cassettes'),
    outputDir: resolve(import.meta.dirname, 'results'),
    record,
    replay,
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Avg cost savings: ${report.aggregate.avgCostSavingsPercent}%`);
  console.log(`Avg quality retention: ${report.aggregate.avgQualityRetentionPercent}%`);
  console.log(`Total savings: $${report.aggregate.totalSavingsUSD.toFixed(4)}`);
  console.log('='.repeat(60));
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
