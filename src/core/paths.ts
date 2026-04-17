import { join } from 'node:path';

export const DIPTYCH_DIR = '.diptych';
export const CODEX_DIR = '.codex';
export const SKILLS_DIR = 'skills';
export const SESSIONS_DIR = 'sessions';
export const ACTIVE_FILE = 'active';

export const diptychDir = (projectDir: string): string =>
  join(projectDir, DIPTYCH_DIR);

export const activeFile = (projectDir: string): string =>
  join(projectDir, DIPTYCH_DIR, ACTIVE_FILE);

export const sessionsRoot = (projectDir: string): string =>
  join(projectDir, DIPTYCH_DIR, SESSIONS_DIR);

export const sessionDir = (projectDir: string, sessionId: string): string =>
  join(projectDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId);

export const getDiptychPath = (projectDir: string, ...parts: string[]): string =>
  join(projectDir, DIPTYCH_DIR, ...parts);

export const SPEC_FILE = 'spec.md';
export const PLAN_FILE = 'plan.md';
export const TASKS_FILE = 'tasks.md';
export const RESEARCH_FILE = 'research.md';
export const REVIEW_FILE = 'review.md';
export const STATE_FILE = 'state.json';
export const SESSION_LOG_FILE = 'session.jsonl';
export const CONFIG_FILE = 'config.yaml';
