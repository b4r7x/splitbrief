import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalReport, ScenarioComparison } from './metrics.js';

export function generateReport(report: EvalReport, outputDir: string): { jsonPath: string; mdPath: string } {
  mkdirSync(outputDir, { recursive: true });
  const ts = report.timestamp.replace(/[:.]/g, '-');
  const jsonPath = join(outputDir, `eval-${ts}.json`);
  const mdPath = join(outputDir, `eval-${ts}.md`);

  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, formatMarkdown(report));

  return { jsonPath, mdPath };
}

function formatMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Eval Report - ${report.timestamp}`);
  lines.push('');
  lines.push(`**Planner:** ${report.plannerModel} | **Baseline implementer:** ${report.baselineImplementerModel} | **Routed implementer:** ${report.routedImplementerModel}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Scenarios run | ${report.aggregate.scenariosRun} |`);
  lines.push(`| Avg cost savings | ${report.aggregate.avgCostSavingsPercent}% |`);
  lines.push(`| Avg quality retention | ${report.aggregate.avgQualityRetentionPercent}% |`);
  lines.push(`| Total baseline cost | $${report.aggregate.totalBaselineCostUSD.toFixed(4)} |`);
  lines.push(`| Total routed cost | $${report.aggregate.totalRoutedCostUSD.toFixed(4)} |`);
  lines.push(`| Total savings | $${report.aggregate.totalSavingsUSD.toFixed(4)} |`);
  lines.push(`| Scenarios matched quality | ${report.aggregate.scenariosWhereRoutedMatchedBaseline}/${report.aggregate.scenariosRun} |`);
  lines.push('');
  lines.push('## Per-scenario results');
  lines.push('');
  lines.push('| Scenario | Baseline $ | Routed $ | Savings | Quality (B) | Quality (R) | Retention |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const scenario of report.scenarios) {
    lines.push(formatScenarioRow(scenario));
  }
  lines.push('');
  return lines.join('\n');
}

function formatScenarioRow(scenario: ScenarioComparison): string {
  const baselineQuality = `${Math.round(scenario.baseline.quality.score * 100)}%`;
  const routedQuality = `${Math.round(scenario.routed.quality.score * 100)}%`;
  return `| ${scenario.scenarioName} | $${scenario.baselineCostUSD.toFixed(4)} | $${scenario.routedCostUSD.toFixed(4)} | ${scenario.costSavingsPercent}% | ${baselineQuality} | ${routedQuality} | ${scenario.qualityRetentionPercent}% |`;
}
