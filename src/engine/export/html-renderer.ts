import { formatCost } from '../../core/formatting.js';
import { formatToolModel } from '../../core/model-display.js';
import type { CostBreakdown } from '../../core/schemas/summary.js';
import { formatTime } from '../../utils/format-time.js';
import type { BriefQualityExport, DriftExport, EvidenceExport, ExportData } from './types.js';

const CSS = `
:root {
  color-scheme: dark;
  --bg: #0a0a0a;
  --panel: #141414;
  --panel-2: #1e1e1e;
  --text: #e0e0e0;
  --muted: #8c8c8c;
  --accent: #00bcd4;
  --success: #5bd46f;
  --warning: #ffd166;
  --danger: #ff6b6b;
  --border: #2a2a2a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
main {
  width: min(800px, calc(100% - 32px));
  margin: 0 auto;
  padding: 36px 0;
}
a { color: var(--accent); }
.report-header, .report-section, .footer {
  border-left: 3px solid var(--accent);
  background: var(--panel);
  padding: 18px 20px;
  margin-bottom: 16px;
}
.report-section { background: var(--panel-2); }
.logo {
  color: var(--success);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0;
}
h1, h2, p { margin: 0; }
h1 {
  margin-top: 6px;
  font-size: 24px;
  line-height: 1.25;
}
h2 {
  margin-bottom: 10px;
  color: var(--text);
  font-size: 16px;
}
.muted { color: var(--muted); }
.hero {
  color: var(--success);
  font-size: 24px;
  font-weight: 700;
  line-height: 1.3;
}
.hero-subtext { margin-top: 6px; color: var(--muted); }
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  border-bottom: 1px solid var(--border);
  padding: 8px 0;
  text-align: left;
  vertical-align: top;
}
th {
  width: 34%;
  color: var(--muted);
  font-weight: 400;
}
.badge {
  display: inline-block;
  margin: 4px 8px 0 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 7px;
  background: #101010;
}
.success { color: var(--success); }
.warning { color: var(--warning); }
.danger { color: var(--danger); }
.score {
  display: inline-block;
  min-width: 54px;
  margin-right: 8px;
  border-radius: 4px;
  padding: 2px 6px;
  background: #101010;
  text-align: center;
  font-weight: 700;
}
.phase-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.phase-row {
  display: grid;
  grid-template-columns: minmax(110px, 1fr) 3fr 70px;
  gap: 10px;
  align-items: center;
}
.phase-track {
  height: 9px;
  overflow: hidden;
  border-radius: 999px;
  background: #0f0f0f;
}
.phase-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
}
.footer {
  color: var(--muted);
  font-size: 12px;
}
`;

export function renderSessionHtml(data: ExportData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>diptych — ${escapeHtml(data.feature)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${renderHeader(data)}
${renderHeroSavings(data)}
${renderMetadata(data)}
${renderTaskSummary(data)}
${data.evidence ? renderEvidence(data.evidence) : ''}
${data.drift ? renderDrift(data.drift) : ''}
${data.briefQuality ? renderBriefQuality(data.briefQuality) : ''}
${renderPhaseTiming(data)}
${renderFooter(data)}
</main>
</body>
</html>`;
}

function renderHeader(data: ExportData): string {
  const completionLabel = data.isComplete && data.completedAt
    ? `Completed ${escapeHtml(formatDateTime(data.completedAt))}`
    : 'In progress';
  return `<header class="report-header">
<div class="logo">diptych ${data.isComplete ? 'complete' : 'in progress'}</div>
<h1>${escapeHtml(data.feature)}</h1>
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
  const percentage = `${Math.round(costBreakdown.savingsPercentage)}%`;
  const localRate = `${Math.round(costBreakdown.localCompletionRate * 100)}%`;

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
<p class="muted">See <a href="evidence.json">evidence.json</a> for the full ledger. ${evidence.escalatedTasks} escalated · ${evidence.failedTasks} failed.</p>
</section>`;
}

function renderDrift(drift: DriftExport): string {
  return `<section class="report-section">
<h2>Drift</h2>
<p><span class="score ${getResultTone(drift)}">${drift.score.toFixed(2)}</span>${drift.passed ? 'Passed' : 'Failed'}</p>
<p class="muted">${drift.errorCount} errors · ${drift.warningCount} warnings</p>
</section>`;
}

function renderBriefQuality(briefQuality: BriefQualityExport): string {
  return `<section class="report-section">
<h2>Brief quality</h2>
<p><span class="score ${getResultTone(briefQuality)}">${briefQuality.score.toFixed(2)}</span>${briefQuality.passed ? 'Passed' : 'Failed'}</p>
<p class="muted">${briefQuality.errorCount} errors · ${briefQuality.warningCount} warnings</p>
</section>`;
}

function renderPhaseTiming(data: ExportData): string {
  const entries = Object.entries(data.summary.phaseTimings ?? {});
  if (entries.length === 0) return '';

  const total = entries.reduce((sum, [, duration]) => sum + Math.max(0, duration), 0);
  const widths = normalizePhaseWidths(entries.map(([, duration]) => duration), total);
  const rows = entries.map(([phase, duration], i) => renderPhaseRow(phase, duration, widths[i] ?? 0)).join('\n');

  return `<section class="report-section">
<h2>Phase timing</h2>
<ul class="phase-list">
${rows}
</ul>
</section>`;
}

function renderFooter(data: ExportData): string {
  const timestamp = data.completedAt ? escapeHtml(formatDateTime(data.completedAt)) : 'in progress';
  return `<footer class="footer">Generated by diptych · ${timestamp}</footer>`;
}

function renderTableRow(label: string, value: string): string {
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function normalizePhaseWidths(durations: number[], total: number): number[] {
  if (total <= 0) return durations.map(() => 0);
  const widths = durations.map(d => Math.max(1, Math.round((Math.max(0, d) / total) * 100)));
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

function renderPhaseRow(phase: string, duration: number, width: number): string {
  return `<li class="phase-row">
<span>${escapeHtml(phase)}</span>
<span class="phase-track"><span class="phase-fill" style="width: ${width}%;"></span></span>
<span class="muted">${escapeHtml(formatTime(duration))}</span>
</li>`;
}

function formatActualCost(costBreakdown: CostBreakdown): string {
  const isImplementerCostKnown = costBreakdown.isActualImplementerCostKnown ?? !costBreakdown.hasUnpricedUsage;
  if (!isImplementerCostKnown) return 'local';
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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
