import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState, OrchestratorEvent } from '../types/index.js';
import { WorkflowStateSchema } from '../types/schemas/index.js';
import { CURRENT_STATE_VERSION } from './machine.js';
import { STATE_FILE, EVENTS_FILE } from '../paths.js';
import { currentDir } from '../paths-io.js';
import { narrowRecord } from '../../utils/type-guards.js';

export function saveState(projectDir: string, state: WorkflowState): void {
  const dir = currentDir(projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

export function loadState(projectDir: string): WorkflowState | null {
  const filePath = join(currentDir(projectDir), STATE_FILE);
  if (!existsSync(filePath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
  const record = narrowRecord(raw);
  if (!record) return null;
  if (record.stateVersion !== CURRENT_STATE_VERSION) return null;
  const result = WorkflowStateSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}

export function appendEvent(projectDir: string, event: OrchestratorEvent): void {
  const dir = currentDir(projectDir);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, EVENTS_FILE), JSON.stringify(event) + '\n');
}
