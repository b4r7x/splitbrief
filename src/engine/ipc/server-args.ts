import { readFileSync, lstatSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  CLIOverridesSchema,
  RunnerOverrideSchema,
} from '../../core/config/runtime/overrides/schema.js';
import { writeSecureFile } from '../../lib/fs.js';
import { error } from '../../utils/error.js';
import { isRecord } from '../../utils/type-guards.js';
import { detachedBootstrapRoot, isValidSessionId } from '../../core/paths.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type {
  ActiveSessionReceipt,
  SessionOwnershipReceipt,
} from '../../core/sessions/lifecycle.js';

export const SERVER_ARGS_FILE = 'server-args.json';
export const SERVER_RESULT_FILE = 'server-result.json';
export const SERVER_BOOTSTRAP_PREFIX = 'server-';

const IpcServerAttachmentSchema = z.object({
  id: z.string(),
  path: z.string(),
  mimeType: z.string(),
});

const SessionReceiptSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().refine(isValidSessionId),
    generation: z.uuid(),
  })
  .strict();

const DetachedRunnerOverrideSchema = RunnerOverrideSchema.pick({
  tool: true,
  model: true,
  command: true,
  apiBase: true,
  outputFormat: true,
  contextLength: true,
}).strict();
const DetachedOverridesSchema = CLIOverridesSchema.extend({
  planner: DetachedRunnerOverrideSchema.optional(),
  implementer: DetachedRunnerOverrideSchema.optional(),
});

export type IpcServerAttachment = z.infer<typeof IpcServerAttachmentSchema>;

const IpcServerArgsSchema = z
  .object({
    version: z.literal(1),
    parentPid: z.number().int().positive(),
    candidate: SessionReceiptSchema,
    projectDir: z.string(),
    feature: z.string(),
    overrides: DetachedOverridesSchema.default({}),
    allowHooks: z.boolean().optional(),
    allowRepoRunners: z.boolean().optional(),
    allowUnverifiedAuth: z.boolean().optional(),
    plannerContext: z.string().optional(),
    attachments: z.array(IpcServerAttachmentSchema).optional(),
  })
  .strict();

export type IpcServerArgs = z.infer<typeof IpcServerArgsSchema>;

const DetachedPreparedResultSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('prepared'),
    sessionId: z.string().refine(isValidSessionId),
    ownership: SessionReceiptSchema,
    active: SessionReceiptSchema,
    pid: z.number().int().positive(),
  })
  .strict();

export type DetachedPreparedResultV1 = Readonly<{
  version: 1;
  kind: 'prepared';
  sessionId: string;
  ownership: SessionOwnershipReceipt;
  active: ActiveSessionReceipt;
  pid: number;
}>;

export const ipcServerArgsError = {
  invalidServerArgs: () => error('ipc-invalid-server-args', 'invalid server-args.json'),
  symlinkRead: (path: string) =>
    error(
      'server-bootstrap-symlink-read',
      `Refusing to read bootstrap data through symlink: ${path}`,
      {
        path,
      },
    ),
  escapesBootstrap: (path: string, expected: string) =>
    error('server-args-escapes-bootstrap', `Detached bootstrap path escapes its project root`, {
      path,
      expected,
    }),
} as const;

export function parseIpcServerArgs(value: unknown): IpcServerArgs | null {
  const result = IpcServerArgsSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseDetachedPreparedResult(value: unknown): DetachedPreparedResultV1 | null {
  const result = DetachedPreparedResultSchema.safeParse(value);
  return result.success ? result.data : null;
}

function assertBootstrapFile(
  input: Readonly<{
    filePath: string;
    projectDir: string;
    fileName: string;
  }>,
): void {
  const { filePath, projectDir, fileName } = input;
  const absolute = resolve(filePath);
  const bootstrapDir = dirname(absolute);
  const root = resolve(detachedBootstrapRoot(projectDir));
  if (
    resolve(dirname(bootstrapDir)) !== root ||
    !basename(bootstrapDir).startsWith(SERVER_BOOTSTRAP_PREFIX) ||
    absolute !== join(bootstrapDir, fileName)
  ) {
    throw ipcServerArgsError.escapesBootstrap(filePath, root);
  }
  try {
    assertExistingPathConfined(relative(projectDir, absolute), projectDir);
  } catch {
    throw ipcServerArgsError.escapesBootstrap(filePath, root);
  }
}

function readJsonFileWithoutSymlink(filePath: string): unknown {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw ipcServerArgsError.symlinkRead(filePath);
    }
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err: unknown) {
    if (err instanceof Error && isRecord(err) && err.kind === 'server-bootstrap-symlink-read') {
      throw err;
    }
    throw ipcServerArgsError.invalidServerArgs();
  }
}

export function readIpcServerArgsFileConfined(
  input: Readonly<{ argsFile: string }>,
): IpcServerArgs {
  const { argsFile } = input;
  const parsed = parseIpcServerArgs(readJsonFileWithoutSymlink(argsFile));
  if (!parsed) throw ipcServerArgsError.invalidServerArgs();
  assertBootstrapFile({
    filePath: argsFile,
    projectDir: parsed.projectDir,
    fileName: SERVER_ARGS_FILE,
  });
  return parsed;
}

export function writeIpcServerArgsFile(
  input: Readonly<{
    bootstrapDir: string;
    args: IpcServerArgs;
  }>,
): string {
  const { bootstrapDir, args } = input;
  const argsFile = join(bootstrapDir, SERVER_ARGS_FILE);
  writeSecureFile(argsFile, JSON.stringify(args, null, 2));
  return argsFile;
}

export function readDetachedPreparedResultFile(
  input: Readonly<{
    resultFile: string;
    projectDir: string;
  }>,
): DetachedPreparedResultV1 | null {
  const { resultFile, projectDir } = input;
  try {
    assertBootstrapFile({ filePath: resultFile, projectDir, fileName: SERVER_RESULT_FILE });
    return parseDetachedPreparedResult(readJsonFileWithoutSymlink(resultFile));
  } catch {
    return null;
  }
}

export function writeDetachedPreparedResultFile(
  input: Readonly<{
    bootstrapDir: string;
    result: DetachedPreparedResultV1;
  }>,
): string {
  const { bootstrapDir, result } = input;
  const resultFile = join(bootstrapDir, SERVER_RESULT_FILE);
  writeSecureFile(resultFile, `${JSON.stringify(result)}\n`);
  return resultFile;
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
