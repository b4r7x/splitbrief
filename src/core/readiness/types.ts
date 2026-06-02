import { z } from 'zod';

export type ReadinessSeverity = 'ok' | 'info' | 'warning' | 'blocker';

export const READINESS_STATUSES = ['ready', 'ready-with-warnings', 'blocked'] as const;
export const ReadinessStatusSchema = z.enum(READINESS_STATUSES);
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;

export const READINESS_NEXT_ACTION_KINDS = [
  'continue',
  'run-init',
  'fix-config',
  'clean-or-isolate-repo',
  'raise-context',
  'set-budget',
  'exit',
] as const;
export const ReadinessNextActionKindSchema = z.enum(READINESS_NEXT_ACTION_KINDS);
export type ReadinessNextActionKind = z.infer<typeof ReadinessNextActionKindSchema>;

export interface ReadinessNextAction {
  kind: ReadinessNextActionKind;
  label: string;
  reason: string;
  command?: string | undefined;
}

export type ReadinessMetadata =
  | string
  | number
  | boolean
  | null
  | ReadinessMetadata[]
  | { [key: string]: ReadinessMetadata };

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

export interface StartReadinessRecord {
  type: 'start-readiness';
  generatedAt: string;
  status: ReadinessStatus;
  nextAction: ReadinessNextActionKind;
  blockerCount: number;
  warningCount: number;
  checks: Array<{
    id: string;
    severity: ReadinessSeverity;
    summary: string;
  }>;
}
