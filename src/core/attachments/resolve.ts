import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { EXT_TO_MIME, MAX_ATTACHMENT_BYTES, SUPPORTED_IMAGE_EXTS } from '../schemas/attachment.js';
import { truncateTerminalDisplayText } from '../../utils/display-text.js';
import { includes } from '../../utils/type-guards.js';
import { isNodeError } from '../../lib/process/errors.js';
import type { Attachment } from '../schemas/attachment.js';

export type InputFileFailureReason =
  | 'not-found'
  | 'not-a-file'
  | 'too-large'
  | 'unreadable'
  | 'not-text';

export type ResolveInputFileResult =
  | { ok: true; kind: 'text'; path: string; sizeBytes: number; content: string }
  | { ok: true; kind: 'image'; path: string; sizeBytes: number; attachment: Attachment }
  | { ok: false; reason: InputFileFailureReason };

export type ResolveAttachmentReason = InputFileFailureReason | 'not-image';

export type ResolveAttachmentResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; reason: ResolveAttachmentReason };

export type ResolveRenderAttachmentResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; reason: ResolveAttachmentReason | 'outside-safe-roots' };

type ResolveAttachmentOpts =
  | { input: string; projectDir: string }
  | { path: string; projectDir: string };

type InspectedInputFile = { inputPath: string; path: string; sizeBytes: number };

type InspectInputFileResult =
  | ({ ok: true } & InspectedInputFile)
  | { ok: false; reason: InputFileFailureReason };

function ensureTrailingSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

function isUnderRoot(absPath: string, root: string): boolean {
  const normalizedRoot = ensureTrailingSep(normalize(root));
  const normalizedPath = normalize(absPath);
  return normalizedPath === normalize(root) || normalizedPath.startsWith(normalizedRoot);
}

function realRootOf(root: string): string {
  return normalize(realpathSync(root));
}

function isInsideSafeRoot(absPath: string, realPath: string, root: string): boolean {
  const lexicalRoot = normalize(root);
  const realRoot = realRootOf(root);
  const pathIsInsideRoot = isUnderRoot(absPath, lexicalRoot) || isUnderRoot(absPath, realRoot);
  return pathIsInsideRoot && isUnderRoot(realPath, realRoot);
}

export function resolveInputFile(opts: ResolveAttachmentOpts): ResolveInputFileResult {
  const result = inspectInputFile(opts);
  if (!result.ok) return result;
  const image = resolveInspectedImage(result);
  if (image.ok) {
    return {
      ok: true,
      kind: 'image',
      path: result.path,
      sizeBytes: result.sizeBytes,
      attachment: image.attachment,
    };
  }
  try {
    const content = readFileSync(result.path);
    if (!isUtf8(content) || content.some((byte) => byte < 9 || (byte > 13 && byte < 32))) {
      return { ok: false, reason: 'not-text' };
    }
    return {
      ok: true,
      kind: 'text',
      path: result.path,
      sizeBytes: result.sizeBytes,
      content: content.toString('utf-8'),
    };
  } catch (err) {
    return inputFileFailure(err);
  }
}

export function resolveAttachment(
  opts: ResolveAttachmentOpts | { attachment: Attachment; projectDir: string },
): ResolveAttachmentResult {
  const result = inspectInputFile(
    'attachment' in opts ? { path: opts.attachment.path, projectDir: opts.projectDir } : opts,
  );
  if (!result.ok) return result;
  return 'attachment' in opts
    ? {
        ok: true,
        attachment: { ...opts.attachment, path: result.path, sizeBytes: result.sizeBytes },
      }
    : resolveInspectedImage(result);
}

export function resolveRenderAttachment(
  opts: ResolveAttachmentOpts,
): ResolveRenderAttachmentResult {
  const result = inspectInputFile(opts);
  if (!result.ok) return result;
  const image = resolveInspectedImage(result);
  if (!image.ok) return image;

  const safeRoots = [opts.projectDir, homedir()].map((r) => normalize(r));
  try {
    const inSafeRoot = safeRoots.some((root) =>
      isInsideSafeRoot(result.inputPath, result.path, root),
    );
    if (!inSafeRoot) return { ok: false, reason: 'outside-safe-roots' };
  } catch (err) {
    return inputFileFailure(err);
  }
  return image;
}

function inspectInputFile(opts: ResolveAttachmentOpts): InspectInputFileResult {
  const value = 'input' in opts ? opts.input.trim() : opts.path;
  const quoted =
    'input' in opts &&
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  const input = quoted ? value.slice(1, -1) : value;
  if (!input) return { ok: false, reason: 'not-found' };

  const expanded = input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;
  const inputPath = isAbsolute(expanded) ? normalize(expanded) : resolve(opts.projectDir, expanded);
  try {
    const stat = statSync(inputPath);
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
    if (stat.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'too-large' };
    const path = realpathSync(inputPath);
    accessSync(path, constants.R_OK);
    return { ok: true, inputPath, path, sizeBytes: stat.size };
  } catch (err) {
    return inputFileFailure(err);
  }
}

function inputFileFailure(err: unknown): { ok: false; reason: InputFileFailureReason } {
  if (isNodeError(err)) {
    switch (err.code) {
      case 'ENOENT':
      case 'ENOTDIR':
      case 'ENAMETOOLONG':
      case 'ELOOP':
        return { ok: false, reason: 'not-found' };
      case 'EACCES':
      case 'EPERM':
        return { ok: false, reason: 'unreadable' };
    }
  }
  throw err;
}

function resolveInspectedImage(
  file: InspectedInputFile,
): { ok: true; attachment: Attachment } | { ok: false; reason: 'not-image' } {
  const ext = extname(file.inputPath).slice(1).toLowerCase();
  if (!includes(SUPPORTED_IMAGE_EXTS, ext)) return { ok: false, reason: 'not-image' };
  return {
    ok: true,
    attachment: {
      id: `att-${randomUUID()}`,
      kind: 'image',
      path: file.path,
      mimeType: EXT_TO_MIME[ext],
      sizeBytes: file.sizeBytes,
    },
  };
}

export function formatAttachedText(typedPath: string, content: string): string {
  return `--- @${typedPath} ---\n${content}`;
}

const ATTACHMENT_SHORT_NAME_MAX = 24;

export function attachmentShortName(p: string): string {
  const path = p.replace(/[\\/]+$/, '');
  const base = path.split(/[\\/]/).pop() || p;
  return truncateTerminalDisplayText(base, ATTACHMENT_SHORT_NAME_MAX);
}
