import type { TreeEntryEnvelope } from './schemas.js';

export interface BranchContext {
  entries: TreeEntryEnvelope[];
  recoveryReason: string;
  taskTitle?: string | undefined;
}
