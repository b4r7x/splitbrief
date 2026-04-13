import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState, OrchestratorEvent } from '../types/index.js';
import type { OrchestratorEventType } from '../types/events.js';
import { WorkflowStateSchema } from '../types/schemas/index.js';
import { CURRENT_STATE_VERSION } from './machine.js';
import { STATE_FILE, EVENTS_FILE } from '../paths.js';
import { currentDir } from '../paths-io.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { ensureSecureDir, writeSecureFile, SECURE_FILE_MODE } from '../../utils/fs.js';
import { warnStderr } from '../../utils/format.js';

export function saveState(projectDir: string, state: WorkflowState): void {
  writeSecureFile(join(currentDir(projectDir), STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

export function loadState(projectDir: string): WorkflowState | null {
  const filePath = join(currentDir(projectDir), STATE_FILE);
  if (!existsSync(filePath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    warnStderr('Warning: corrupt state file, ignoring');
    return null;
  }
  const record = narrowRecord(raw);
  if (!record) return null;
  if (record.stateVersion !== CURRENT_STATE_VERSION) return null;
  const result = WorkflowStateSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}

export function appendEvent<T extends OrchestratorEventType>(projectDir: string, event: OrchestratorEvent<T>): void {
  const dir = currentDir(projectDir);
  ensureSecureDir(dir);
  appendFileSync(join(dir, EVENTS_FILE), JSON.stringify(event) + '\n', { mode: SECURE_FILE_MODE });
}
