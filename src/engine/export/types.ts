import type { Summary } from '../../core/schemas/summary.js';

export interface ExportData {
  sessionId: string;
  feature: string;
  completedAt: string | null;
  isComplete: boolean;
  summary: Summary;
  evidence?: EvidenceExport;
  drift?: DriftExport;
  briefQuality?: BriefQualityExport;
}

export interface EvidenceExport {
  totalTasks: number;
  tasksWithValidationEvidence: number;
  escalatedTasks: number;
  failedTasks: number;
}

export interface DriftExport {
  passed: boolean;
  score: number;
  errorCount: number;
  warningCount: number;
}

export interface BriefQualityExport {
  score: number;
  passed: boolean;
  errorCount: number;
  warningCount: number;
}
