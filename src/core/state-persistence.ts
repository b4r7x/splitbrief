import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState, OrchestratorEvent } from './types.js';

function stateDir(projectDir: string): string {
  return join(projectDir, '.tiny-spec', 'current');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function saveState(projectDir: string, state: WorkflowState): void {
  const dir = stateDir(projectDir);
  ensureDir(dir);
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

export function loadState(projectDir: string): WorkflowState | null {
  const filePath = join(stateDir(projectDir), 'state.json');
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8')) as WorkflowState;
}

export function appendEvent(projectDir: string, event: OrchestratorEvent): void {
  const dir = stateDir(projectDir);
  ensureDir(dir);
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
}
