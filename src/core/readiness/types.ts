import type {
  ReadinessDiagnosticStateId,
  ReadinessMetadata,
  ReadinessNextActionKind,
  ReadinessSeverity,
  ReadinessStatus,
} from '../schemas/readiness.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import type { ActiveRunnerRole } from '../runners/seat-roles.js';

export interface ReadinessNextAction {
  kind: ReadinessNextActionKind;
  label: string;
  reason: string;
  command?: string | undefined;
}

export interface ReadinessCheck {
  id: string;
  severity: ReadinessSeverity;
  summary: string;
  details?: string[] | undefined;
  fix?: string | undefined;
  /** Stable failure family, set by the builder that knows why the check failed. */
  diagnosticState?: ReadinessDiagnosticStateId | undefined;
  nextAction?: ReadinessNextActionKind | undefined;
  metadata?: Record<string, ReadinessMetadata> | undefined;
}

export interface ReadinessSection {
  id: string;
  title: string;
  checks: ReadinessCheck[];
}

export interface ReadinessCounts {
  ok: number;
  info: number;
  warning: number;
  blocker: number;
}

export interface ReadinessReport {
  generatedAt: string;
  projectDir: string;
  status: ReadinessStatus;
  counts: ReadinessCounts;
  nextAction: ReadinessNextAction;
  sections: ReadinessSection[];
  metadata: {
    approve?: string | undefined;
    configPath?: string | undefined;
    configExists?: boolean | undefined;
  };
}

/** A seat's identity as a readiness check names it. */
export type SeatNamer = (runner: RunnerConfig, role: ActiveRunnerRole) => string;
