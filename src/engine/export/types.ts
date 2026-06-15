import type { Summary } from '../../core/schemas/summary.js';

export type ExportData = {
  sessionId: string;
  feature: string;
  completedAt: string | null;
  isComplete: boolean;
  summary: Summary;
  evidence?: EvidenceExport;
  drift?: DriftExport;
  briefQuality?: BriefQualityExport;
};

export type EvidenceExport = {
  totalTasks: number;
  tasksWithValidationEvidence: number;
  escalatedTasks: number;
  failedTasks: number;
  href: string;
};

export type DriftExport = {
  passed: boolean;
  score: number;
  errorCount: number;
  warningCount: number;
};

export type BriefQualityExport = {
  score: number;
  passed: boolean;
  errorCount: number;
  warningCount: number;
};
