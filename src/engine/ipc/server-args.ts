import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CLIOverridesSchema } from '../../core/config/runtime/overrides.js';
import { WorkflowModeSchema, normalizeLegacyMode } from '../../core/schemas/enums.js';
import { writeSecureFile } from '../../lib/fs.js';
import { error } from '../../utils/error.js';

export const SERVER_ARGS_FILE = 'server-args.json';

const IpcServerArgsSchema = z.object({
  sessionId: z.string(),
  projectDir: z.string(),
  feature: z.string(),
  mode: z.preprocess(
    (m) => (typeof m === 'string' ? (normalizeLegacyMode(m) ?? m) : m),
    WorkflowModeSchema,
  ),
  configPath: z.string(),
  overrides: CLIOverridesSchema.default({}),
  allowHooks: z.boolean().optional(),
  plannerContext: z.string().optional(),
});

export type IpcServerArgs = z.infer<typeof IpcServerArgsSchema>;

export const ipcServerArgsError = {
  invalidServerArgs: () => error('ipc-invalid-server-args', 'invalid server-args.json'),
} as const;

export function parseIpcServerArgs(value: unknown): IpcServerArgs | null {
  const result = IpcServerArgsSchema.safeParse(value);
  return result.success ? result.data : null;
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
