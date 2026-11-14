import type { Task } from '../../../core/schemas/task.js';

export type Brief = Pick<Task, 'id' | 'title'>;

/** What one excerpt row stands for, and therefore what `omittedCount` counts. */
export type ExcerptUnit = 'line' | 'section' | 'task';

export interface ArtifactExcerpt {
  lineCount: number;
  excerpt: string[];
  omittedCount: number;
  omittedUnit: ExcerptUnit;
}
