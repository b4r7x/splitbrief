import { readFileSync, lstatSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { CLIOverridesSchema } from '../../core/config/runtime/overrides.js';
import { WorkflowModeSchema, normalizeLegacyMode } from '../../core/schemas/enums.js';
import { writeSecureFile } from '../../lib/fs.js';
import { error } from '../../utils/error.js';
import { sessionDir } from '../../core/paths.js';
import { assertSessionConfinement } from '../../core/sessions/confinement.js';
import type { Attachment } from '../../core/schemas/attachment.js';

export const SERVER_ARGS_FILE = 'server-args.json';

const IpcServerAttachmentSchema = z.object({
  id: z.string(),
  path: z.string(),
  mimeType: z.string(),
});

export type IpcServerAttachment = z.infer<typeof IpcServerAttachmentSchema>;

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
  persistTranscript: z.boolean().optional(),
  allowHooks: z.boolean().optional(),
  allowRepoRunners: z.boolean().optional(),
  plannerContext: z.string().optional(),
  attachments: z.array(IpcServerAttachmentSchema).optional(),
});

export type IpcServerArgs = z.infer<typeof IpcServerArgsSchema>;

export const ipcServerArgsError = {
  invalidServerArgs: () => error('ipc-invalid-server-args', 'invalid server-args.json'),
  symlinkRead: (path: string) =>
    error('server-args-symlink-read', `Refusing to read server-args through symlink: ${path}`, {
      path,
    }),
  escapesSession: (path: string, expected: string) =>
    error('server-args-escapes-session', `server-args.json path escapes expected session dir`, {
      path,
      expected,
    }),
  mismatchedSessionId: (expected: string, actual: string) =>
    error(
      'server-args-mismatched-id',
      `server-args sessionId '${actual}' does not match expected '${expected}'`,
      { expected, actual },
    ),
} as const;

export function parseIpcServerArgs(value: unknown): IpcServerArgs | null {
  const result = IpcServerArgsSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function readIpcServerArgsFileConfined(
  argsFile: string,
  expectedSessionId?: string,
): IpcServerArgs {
  try {
    const st = lstatSync(argsFile);
    if (st.isSymbolicLink()) {
      throw ipcServerArgsError.symlinkRead(argsFile);
    }
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      typeof (err as { kind?: unknown }).kind === 'string' &&
      String((err as { kind?: unknown }).kind) === 'server-args-symlink-read'
    ) {
      throw err;
    }
    throw ipcServerArgsError.invalidServerArgs();
  }

  const parsed = parseIpcServerArgs(JSON.parse(readFileSync(argsFile, 'utf8')));
  if (!parsed) throw ipcServerArgsError.invalidServerArgs();

  const expectedSessionDir = sessionDir(parsed.projectDir, parsed.sessionId);
  assertSessionConfinement(argsFile, expectedSessionDir);

  if (expectedSessionId !== undefined && parsed.sessionId !== expectedSessionId) {
    throw ipcServerArgsError.mismatchedSessionId(expectedSessionId, parsed.sessionId);
  }

  const expectedArgsFile = resolve(expectedSessionDir, SERVER_ARGS_FILE);
  if (resolve(argsFile) !== expectedArgsFile) {
    throw ipcServerArgsError.escapesSession(argsFile, expectedArgsFile);
  }

  return parsed;
}

export function writeIpcServerArgsFile(sessionDir: string, args: IpcServerArgs): string {
  const argsFile = join(sessionDir, SERVER_ARGS_FILE);
  writeSecureFile(argsFile, JSON.stringify(args, null, 2));
  return argsFile;
}

function materializeAttachment(record: IpcServerAttachment): Attachment {
  let sizeBytes = 1;
  try {
    const size = statSync(record.path).size;
    if (size > 0) sizeBytes = size;
  } catch {
    // File may have been removed since spawn; downstream only reads path + mimeType.
  }
  return {
    id: record.id,
    kind: 'image',
    path: record.path,
    mimeType: record.mimeType,
    sizeBytes,
  };
}

export function createServerArgsAttachmentDrain(
  attachments: IpcServerAttachment[] | undefined,
): () => Attachment[] {
  let pending = attachments ?? [];
  return () => {
    if (pending.length === 0) return [];
    const drained = pending.map(materializeAttachment);
    pending = [];
    return drained;
  };
}
