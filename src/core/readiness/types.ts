import type {
  ReadinessMetadata,
  ReadinessNextActionKind,
  ReadinessSeverity,
  ReadinessStatus,
} from '../schemas/readiness.js';

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
    mode?: string | undefined;
    approve?: string | undefined;
    configPath?: string | undefined;
    configExists?: boolean | undefined;
  };
}
