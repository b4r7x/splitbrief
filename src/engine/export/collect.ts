import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { SummarySchema } from '../../core/schemas/summary.js';
import { SessionSchema } from '../../core/schemas/session.js';
import { EvidenceLedgerSchema, type EvidenceLedger } from '../../core/schemas/evidence.js';
import { BRIEF_QUALITY_FILE, DRIFT_REPORT_FILE, EVIDENCE_FILE } from '../../core/paths.js';
import { readJsonSafe, writeSecureFile } from '../../lib/fs.js';
import { isBriefQualityReport } from '../spec/brief-quality.js';
import { isDriftReport } from '../orchestrator/drift/drift.js';
import { renderSessionHtml } from './html-renderer.js';
import type { BriefQualityExport, DriftExport, EvidenceExport, ExportData } from './types.js';

export type CollectResult =
  | { status: 'ok'; data: ExportData }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

export type WriteSessionHtmlReportResult =
  | { status: 'ok'; path: string }
  | { status: 'error'; error: string };

export function collectExportData(sessionDirectory: string, sessionId: string): CollectResult {
  const summaryPath = join(sessionDirectory, 'summary.json');
  if (!existsSync(summaryPath)) return { status: 'missing' };

  const raw = readJsonSafe(summaryPath);
  if (raw === null) return { status: 'invalid', reason: 'summary.json exists but could not be parsed as JSON' };

  const base = readSummaryExport(raw, sessionId);
  if (!base) return { status: 'invalid', reason: 'summary.json does not match the expected schema' };

  const evidence = readEvidenceExport(sessionDirectory);
  const drift = readDriftExport(sessionDirectory);
  const briefQuality = readBriefQualityExport(sessionDirectory);

  return {
    status: 'ok',
    data: {
      ...base,
      ...(evidence && { evidence }),
      ...(drift && { drift }),
      ...(briefQuality && { briefQuality }),
    },
  };
}

export function writeSessionHtmlReport(
  sessionDirectory: string,
  sessionId: string,
  outPath = join(sessionDirectory, 'report.html'),
): WriteSessionHtmlReportResult {
  const result = collectExportData(sessionDirectory, sessionId);
  if (result.status === 'missing') return { status: 'error', error: 'No summary.json found for session' };
  if (result.status === 'invalid') return { status: 'error', error: result.reason };

  writeSecureFile(outPath, renderSessionHtml(result.data));
  return { status: 'ok', path: outPath };
}

function readSummaryExport(raw: unknown, sessionId: string): Omit<ExportData, 'evidence' | 'drift' | 'briefQuality'> | null {
  const session = SessionSchema.safeParse(raw);
  if (session.success && session.data.summary) {
    const { completedAt } = session.data;
    return {
      sessionId,
      feature: session.data.summary.feature || session.data.feature || 'unknown',
      completedAt: completedAt !== null ? new Date(completedAt).toISOString() : null,
      isComplete: completedAt !== null,
      summary: session.data.summary,
    };
  }

  const summary = SummarySchema.safeParse(raw);
  if (!summary.success) return null;
  return {
    sessionId,
    feature: summary.data.feature || 'unknown',
    completedAt: null,
    isComplete: false,
    summary: summary.data,
  };
}

function readEvidenceExport(sessionDirectory: string): EvidenceExport | null {
  const raw = readJsonSafe(join(sessionDirectory, EVIDENCE_FILE));
  if (raw === null) return null;

  const result = EvidenceLedgerSchema.safeParse(raw);
  if (!result.success) return null;

  return evidenceToExport(result.data);
}

function evidenceToExport(ledger: EvidenceLedger): EvidenceExport {
  return {
    totalTasks: ledger.tasks.length,
    tasksWithValidationEvidence: ledger.tasks.filter(task => task.validation.some(entry => entry.passed)).length,
    escalatedTasks: ledger.tasks.filter(task => task.status === 'escalated' || task.escalated).length,
    failedTasks: ledger.tasks.filter(task => task.status === 'failed').length,
  };
}

function readDriftExport(sessionDirectory: string): DriftExport | null {
  const raw = readJsonSafe(join(sessionDirectory, DRIFT_REPORT_FILE));
  if (!isDriftReport(raw)) return null;

  return {
    passed: raw.passed,
    score: raw.score,
    errorCount: raw.findings.filter(finding => finding.severity === 'error').length,
    warningCount: raw.findings.filter(finding => finding.severity === 'warning').length,
  };
}

function readBriefQualityExport(sessionDirectory: string): BriefQualityExport | null {
  const raw = readJsonSafe(join(sessionDirectory, BRIEF_QUALITY_FILE));
  if (!isBriefQualityReport(raw)) return null;

  return {
    score: raw.score,
    passed: raw.passed,
    errorCount: raw.issues.filter(issue => issue.severity === 'error').length,
    warningCount: raw.issues.filter(issue => issue.severity === 'warning').length,
  };
}

