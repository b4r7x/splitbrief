import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CLIOverrides } from '../../core/config/runtime/overrides.js';
import { normalizeLegacyMode } from '../../core/schemas/enums.js';
import { writeSecureFile } from '../../lib/fs.js';
import { error } from '../../utils/error.js';
import { isRecord } from '../../utils/type-guards.js';
import { isOptionalString } from './guards.js';

export const SERVER_ARGS_FILE = 'server-args.json';

export type IpcServerArgs = {
  sessionId: string;
  projectDir: string;
  feature: string;
  mode: string;
  configPath: string;
  overrides: CLIOverrides;
  allowHooks?: boolean;
  plannerContext?: string;
};

export const ipcServerArgsError = {
  invalidServerArgs: () => error('ipc-invalid-server-args', 'invalid server-args.json'),
} as const;

const RUNNER_OVERRIDE_KEYS = new Set(['tool', 'model', 'command']);
const CLI_OVERRIDE_KEYS = new Set([
  'planner',
  'implementer',
  'contextLength',
  'autoApprove',
  'approve',
  'mode',
  'budget',
  'plannerEffort',
  'yolo',
]);

type RunnerOverride = NonNullable<CLIOverrides['planner']>;

function hasOnlyKnownKeys(record: Record<string, unknown>, knownKeys: ReadonlySet<string>): boolean {
  return Object.keys(record).every(key => knownKeys.has(key));
}

function parseRunnerOverride(value: unknown): RunnerOverride | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKnownKeys(value, RUNNER_OVERRIDE_KEYS)) return null;
  if (value.tool !== undefined && typeof value.tool !== 'string') return null;
  if (value.model !== undefined && typeof value.model !== 'string') return null;
  if (value.command !== undefined && typeof value.command !== 'string') return null;
  return {
    ...(value.tool !== undefined && { tool: value.tool }),
    ...(value.model !== undefined && { model: value.model }),
    ...(value.command !== undefined && { command: value.command }),
  };
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function parseCliOverrides(value: unknown): CLIOverrides | null {
  if (value === undefined) return {};
  if (!isRecord(value) || !hasOnlyKnownKeys(value, CLI_OVERRIDE_KEYS)) return null;

  const planner = parseRunnerOverride(value.planner);
  const implementer = parseRunnerOverride(value.implementer);
  if (planner === null || implementer === null) return null;
  if (!isOptionalNumber(value.contextLength)) return null;
  if (!isOptionalBoolean(value.autoApprove)) return null;
  if (!isOptionalString(value.approve)) return null;
  const mode = value.mode === undefined
    ? undefined
    : typeof value.mode === 'string'
      ? normalizeLegacyMode(value.mode)
      : null;
  if (mode === null) return null;
  if (!isOptionalNumber(value.budget)) return null;
  if (!isOptionalString(value.plannerEffort)) return null;
  if (!isOptionalBoolean(value.yolo)) return null;

  return {
    ...(planner !== undefined && { planner }),
    ...(implementer !== undefined && { implementer }),
    ...(value.contextLength !== undefined && { contextLength: value.contextLength }),
    ...(value.autoApprove !== undefined && { autoApprove: value.autoApprove }),
    ...(value.approve !== undefined && { approve: value.approve }),
    ...(mode !== undefined && { mode }),
    ...(value.budget !== undefined && { budget: value.budget }),
    ...(value.plannerEffort !== undefined && { plannerEffort: value.plannerEffort }),
    ...(value.yolo !== undefined && { yolo: value.yolo }),
  };
}

export function parseIpcServerArgs(value: unknown): IpcServerArgs | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.sessionId !== 'string' ||
    typeof value.projectDir !== 'string' ||
    typeof value.feature !== 'string' ||
    typeof value.mode !== 'string' ||
    typeof value.configPath !== 'string'
  ) {
    return null;
  }
  const overrides = parseCliOverrides(value.overrides);
  if (overrides === null) return null;
  if (!isOptionalBoolean(value.allowHooks)) return null;
  if (!isOptionalString(value.plannerContext)) return null;
  return {
    sessionId: value.sessionId,
    projectDir: value.projectDir,
    feature: value.feature,
    mode: value.mode,
    configPath: value.configPath,
    overrides,
    ...(value.allowHooks !== undefined && { allowHooks: value.allowHooks }),
    ...(value.plannerContext !== undefined && { plannerContext: value.plannerContext }),
  };
}

export function readIpcServerArgsFile(argsFile: string): IpcServerArgs {
  const parsed = parseIpcServerArgs(JSON.parse(readFileSync(argsFile, 'utf8')));
  if (!parsed) throw ipcServerArgsError.invalidServerArgs();
  return parsed;
}

export function writeIpcServerArgsFile(sessionDir: string, args: IpcServerArgs): string {
  const argsFile = join(sessionDir, SERVER_ARGS_FILE);
  writeSecureFile(argsFile, JSON.stringify(args, null, 2));
  return argsFile;
}
