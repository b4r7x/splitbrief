import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalReport, ReviewMetrics, ScenarioComparison } from './metrics.js';

export function generateReport(
  report: EvalReport,
  outputDir: string,
): { jsonPath: string; mdPath: string } {
  mkdirSync(outputDir, { recursive: true });
  const ts = report.timestamp.replace(/[:.]/g, '-');
  const jsonPath = join(outputDir, `eval-${ts}.json`);
  const mdPath = join(outputDir, `eval-${ts}.md`);

  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, formatMarkdown(report));

  return { jsonPath, mdPath };
}

export function formatCliSummary(report: EvalReport): string[] {
  const unpriced = !everyPairPriced(report);
  const avgSavingsPercent = report.aggregate.avgCostSavingsPercent;
  const totalSavings = report.aggregate.totalSavingsUSD;
  return [
    `First-pass (baseline): ${report.aggregate.avgBaselineFirstPassRatePercent}%`,
    `First-pass (routed): ${report.aggregate.avgRoutedFirstPassRatePercent}%`,
    `Review yield: ${formatReviewYield(report)}`,
    `Avg quality retention: ${report.aggregate.avgQualityRetentionPercent}%`,
    `Avg cost savings: ${unpriced || avgSavingsPercent === null ? 'unpriced' : `${avgSavingsPercent}%`}`,
    `Total savings: ${unpriced || totalSavings === null ? 'unpriced' : `$${totalSavings.toFixed(4)}`}`,
  ];
}

function everyBaselinePriced(report: EvalReport): boolean {
  return (
    report.scenarios.length > 0 &&
    report.scenarios.every((scenario) => scenario.baseline.cost.pricingAvailable)
  );
}

function everyRoutedPriced(report: EvalReport): boolean {
  return (
    report.scenarios.length > 0 &&
    report.scenarios.every((scenario) => scenario.routed.cost.pricingAvailable)
  );
}

function everyPairPriced(report: EvalReport): boolean {
  return everyBaselinePriced(report) && everyRoutedPriced(report);
}

function formatMarkdown(report: EvalReport): string {
  const baselinePriced = everyBaselinePriced(report);
  const routedPriced = everyRoutedPriced(report);
  const pairsPriced = baselinePriced && routedPriced;
  const lines: string[] = [];
  lines.push(`# Eval Report - ${report.timestamp}`);
  lines.push('');
  lines.push(
    `**Planner:** ${report.plannerModel} | **Baseline implementer:** ${report.baselineImplementerModel} | **Routed implementer:** ${report.routedImplementerModel}`,
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| First-pass (baseline) | ${report.aggregate.avgBaselineFirstPassRatePercent}% |`);
  lines.push(`| First-pass (routed) | ${report.aggregate.avgRoutedFirstPassRatePercent}% |`);
  lines.push(
    `| First-pass Δ (routed − baseline) | ${formatDeltaPercent(
      report.aggregate.avgRoutedFirstPassRatePercent -
        report.aggregate.avgBaselineFirstPassRatePercent,
    )} |`,
  );
  lines.push(`| Review yield | ${formatReviewYield(report)} |`);
  lines.push(`| Scenarios run | ${report.aggregate.scenariosRun} |`);
  lines.push(`| Total retry attempts | ${report.aggregate.totalRetryAttempts} |`);
  lines.push(`| Total escalations | ${report.aggregate.totalEscalations} |`);
  lines.push(`| Avg quality retention | ${report.aggregate.avgQualityRetentionPercent}% |`);
  lines.push(
    `| Scenarios matched quality | ${report.aggregate.scenariosWhereRoutedMatchedBaseline}/${report.aggregate.scenariosRun} |`,
  );
  lines.push(
    `| Avg cost savings | ${formatCostPercent(report.aggregate.avgCostSavingsPercent, pairsPriced)} |`,
  );
  lines.push(
    `| Total baseline cost | ${formatCostUSD(report.aggregate.totalBaselineCostUSD, baselinePriced)} |`,
  );
  lines.push(
    `| Total routed cost | ${formatCostUSD(report.aggregate.totalRoutedCostUSD, routedPriced)} |`,
  );
  lines.push(`| Total savings | ${formatCostUSD(report.aggregate.totalSavingsUSD, pairsPriced)} |`);
  lines.push('');
  lines.push('## Per-scenario results');
  lines.push('');
  lines.push(
    '| Scenario | First-pass (B) | First-pass (R) | Δ | Verdict (B) | Verdict (R) | Quality (B) | Quality (R) | Retention | Baseline $ | Routed $ | Savings |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const scenario of report.scenarios) {
    lines.push(formatScenarioRow(scenario));
  }
  lines.push('');
  return lines.join('\n');
}

function formatScenarioRow(scenario: ScenarioComparison): string {
  const baselineQuality = `${Math.round(scenario.baseline.quality.score * 100)}%`;
  const routedQuality = `${Math.round(scenario.routed.quality.score * 100)}%`;
  const baselineFirstPass = `${Math.round(scenario.baseline.outcome.firstPassRate * 100)}%`;
  const routedFirstPass = `${Math.round(scenario.routed.outcome.firstPassRate * 100)}%`;
  const delta = formatDeltaPercent(scenario.firstPassRateDeltaPercent);
  const baselineCost = scenario.baseline.cost.pricingAvailable
    ? `$${scenario.baselineCostUSD.toFixed(4)}`
    : 'n/a';
  const routedCost = scenario.routed.cost.pricingAvailable
    ? `$${scenario.routedCostUSD.toFixed(4)}`
    : 'n/a';
  const savings =
    scenario.baseline.cost.pricingAvailable && scenario.routed.cost.pricingAvailable
      ? `${scenario.costSavingsPercent}%`
      : 'n/a';
  return `| ${scenario.scenarioName} | ${baselineFirstPass} | ${routedFirstPass} | ${delta} | ${formatVerdict(
    scenario.baseline.review.verdict,
  )} | ${formatVerdict(scenario.routed.review.verdict)} | ${baselineQuality} | ${routedQuality} | ${
    scenario.qualityRetentionPercent
  }% | ${baselineCost} | ${routedCost} | ${savings} |`;
}

function formatReviewYield(report: EvalReport): string {
  const { greenRunsWithFindings, greenRunsCriticalFindings } = report.aggregate;
  return `${greenRunsWithFindings} green run(s) with findings, ${greenRunsCriticalFindings} critical (planner: ${report.plannerModel}, baseline implementer: ${report.baselineImplementerModel}, routed implementer: ${report.routedImplementerModel})`;
}

function formatVerdict(verdict: ReviewMetrics['verdict']): string {
  return verdict ?? 'unknown';
}

function formatCostUSD(value: number | null, priced: boolean): string {
  return priced && value !== null ? `$${value.toFixed(4)}` : 'n/a';
}

function formatCostPercent(value: number | null, priced: boolean): string {
  return priced && value !== null ? `${value}%` : 'n/a';
}

function formatDeltaPercent(delta: number): string {
  const rounded = Math.round(delta * 10) / 10;
  return `${rounded >= 0 ? '+' : ''}${rounded}pp`;
}
