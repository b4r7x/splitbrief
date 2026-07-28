import { isAbsolute } from 'node:path';
import { formatCost, formatPercent } from '../../core/formatting.js';
import { formatToolModel } from '../../core/model-display.js';
import { costKnownFlags, type CostBreakdown } from '../../core/schemas/summary.js';
import { formatTime } from '../../utils/format-time.js';
import { redactSecrets } from '../../utils/redact.js';
import { REPORT_CSS } from './report-styles.js';
import type { BriefQualityExport, DriftExport, EvidenceExport, ExportData } from './types.js';
import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';

export function renderSessionHtml(data: ExportData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SPLITBRIEF_IDENTITY.displayName} — ${escapeHtml(redactSecrets(data.feature))}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main>
${renderHeader(data)}
${renderHeroSavings(data)}
${renderMetadata(data)}
${renderTaskSummary(data)}
${data.evidence ? renderEvidence(data.evidence) : ''}
${data.drift ? renderScoredResult('Drift', data.drift) : ''}
${data.briefQuality ? renderScoredResult('Brief quality', data.briefQuality) : ''}
${renderPhaseTiming(data)}
${renderFooter(data)}
</main>
</body>
</html>`;
}

function renderHeader(data: ExportData): string {
  const completionLabel =
    data.isComplete && data.completedAt
      ? `Completed ${escapeHtml(formatDateTime(data.completedAt))}`
      : 'In progress';
  return `<header class="report-header">
<div class="logo">${SPLITBRIEF_IDENTITY.displayName} ${data.isComplete ? 'complete' : 'in progress'}</div>
<h1>${escapeHtml(redactSecrets(data.feature))}</h1>
<p class="muted">${completionLabel} · session ${escapeHtml(data.sessionId)}</p>
</header>`;
}

function renderHeroSavings(data: ExportData): string {
  const costBreakdown = data.summary.costBreakdown;
  if (!costBreakdown) return '';
  if (costBreakdown.hasSavingsEstimate === false) return '';

  if (costBreakdown.savingsAmount <= 0) {
    return `<section class="report-section">
<p class="muted">No savings this run (split routing cost equal or higher)</p>
</section>`;
  }

  const actual = formatActualCost(costBreakdown);
  const baseline = formatCost(costBreakdown.hypotheticalCost);
  const percentage = formatPercent(costBreakdown.savingsPercentage);
  const localRate = formatPercent(costBreakdown.localCompletionRate * 100);

  return `<section class="report-section">
<p class="hero">${actual} actual vs ${baseline} all-planner — ${percentage} saved</p>
<p class="hero-subtext">Saved ${formatCost(costBreakdown.savingsAmount)} by routing ${localRate} of tasks to cheap implementer</p>
</section>`;
}

function renderMetadata(data: ExportData): string {
  const summary = data.summary;
  return `<section class="report-section">
<h2>Metadata</h2>
<table>
<tbody>
${renderTableRow('Planner', formatToolModel(summary.plannerTool, summary.plannerModel) || 'n/a')}
${renderTableRow('Implementer', formatToolModel(summary.implementerTool, summary.implementerModel) || 'n/a')}
${renderTableRow('Mode', summary.mode ?? 'n/a')}
${renderTableRow('Total time', formatTime(summary.totalTime))}
</tbody>
</table>
</section>`;
}

function renderTaskSummary(data: ExportData): string {
  const summary = data.summary;
  return `<section class="report-section">
<h2>Task summary</h2>
<p>${summary.totalTasks} tasks: ${summary.completedByLocal} completed locally, ${summary.escalatedToPlanner} escalated, ${summary.failed} failed, ${summary.skipped} skipped</p>
<p>
<span class="badge success">${summary.completedByLocal} local</span>
<span class="badge warning">${summary.escalatedToPlanner} escalated</span>
<span class="badge danger">${summary.failed} failed</span>
<span class="badge muted">${summary.skipped} skipped</span>
</p>
</section>`;
}

function renderEvidence(evidence: EvidenceExport): string {
  return `<section class="report-section">
<h2>Evidence</h2>
<p><span class="success">${evidence.tasksWithValidationEvidence}/${evidence.totalTasks}</span> tasks with validation evidence.</p>
<p class="muted">See ${renderEvidenceLink(evidence.href)} for the full ledger. ${evidence.escalatedTasks} escalated · ${evidence.failedTasks} failed.</p>
</section>`;
}

function renderEvidenceLink(href: string): string {
  if (isAbsolute(href)) return `the ledger at <code>${escapeHtml(href)}</code>`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`;
}

function renderScoredResult(title: string, result: DriftExport | BriefQualityExport): string {
  return `<section class="report-section">
<h2>${title}</h2>
<p><span class="score ${getResultTone(result)}">${result.score.toFixed(2)}</span>${result.passed ? 'Passed' : 'Failed'}</p>
<p class="muted">${result.errorCount} errors · ${result.warningCount} warnings</p>
</section>`;
}

function renderPhaseTiming(data: ExportData): string {
  const entries = Object.entries(data.summary.phaseTimings ?? {});
  if (entries.length === 0) return '';

  const total = entries.reduce((sum, [, duration]) => sum + Math.max(0, duration), 0);
  const widths = normalizePhaseWidths(
    entries.map(([, duration]) => duration),
    total,
  );
  const rows = entries
    .map(([phase, duration], i) => renderPhaseRow(phase, duration, widths[i] ?? 0))
    .join('\n');

  return `<section class="report-section">
<h2>Phase timing</h2>
<ul class="phase-list">
${rows}
</ul>
</section>`;
}

function renderFooter(data: ExportData): string {
  const timestamp = data.completedAt ? escapeHtml(formatDateTime(data.completedAt)) : 'in progress';
  return `<footer class="footer">Generated by ${SPLITBRIEF_IDENTITY.displayName} · ${timestamp}</footer>`;
}

function renderTableRow(label: string, value: string): string {
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function normalizePhaseWidths(durations: number[], total: number): number[] {
  if (total <= 0) return durations.map(() => 0);
  const widths = durations.map((d) => Math.max(1, Math.round((Math.max(0, d) / total) * 100)));
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum > 100 && widths.length > 0) {
    let largestIndex = 0;
    for (let i = 1; i < widths.length; i++) {
      if ((widths[i] ?? 0) > (widths[largestIndex] ?? 0)) largestIndex = i;
    }
    widths[largestIndex] = (widths[largestIndex] ?? 0) - (sum - 100);
  }
  return widths;
}

function renderPhaseRow(phaseName: string, duration: number, width: number): string {
  return `<li class="phase-row">
<span>${escapeHtml(phaseName)}</span>
<span class="phase-track"><span class="phase-fill" style="width: ${width}%;"></span></span>
<span class="muted">${escapeHtml(formatTime(duration))}</span>
</li>`;
}

function formatActualCost(costBreakdown: CostBreakdown): string {
  const { implementerCostKnown } = costKnownFlags(costBreakdown);
  if (!implementerCostKnown) return 'local';
  return formatCost(costBreakdown.totalActualCost);
}

function getResultTone(result: DriftExport | BriefQualityExport): string {
  if (result.errorCount > 0 || !result.passed) return 'danger';
  if (result.warningCount > 0) return 'warning';
  return 'success';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
