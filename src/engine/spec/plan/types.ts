import type { TaskContextFit } from '../../../core/schemas/enums.js';

export type PlanCheckCode =
  | 'empty-plan'
  | 'duplicate-task-id'
  | 'duplicate-check-id'
  | 'reserved-check-id'
  | 'duplicate-criterion-id'
  | 'criterion-without-check'
  | 'unknown-check'
  | 'uncovered-criterion'
  | 'unknown-criterion'
  | 'task-without-check'
  | 'task-without-criterion'
  | 'task-without-intent'
  | 'path-outside-project'
  | 'path-not-file'
  | 'missing-context-file'
  | 'unprotected-operation'
  | 'unlisted-protected-operation'
  | 'protected-path-not-file'
  | 'unknown-dependency'
  | 'dependency-later-batch'
  | 'dependency-later-task'
  | 'batch-out-of-order'
  | 'dependency-cycle'
  | 'context-overflow'
  | 'no-capable-worker'
  | 'render-check-unconfigured'
  | 'refused-check-command';

/** BUILD's fit for one task, and the routing reason when no implementer can take it. */
export type PlanTaskFit = Readonly<{ fit: TaskContextFit; blocked?: string | undefined }>;

export type PlanCheckError = Readonly<{ code: PlanCheckCode; message: string }>;
