import {
  sanitizeTerminalDiagnosticText,
  type TerminalDiagnosticTextOptions,
} from './display-text.js';
import { projectRelativePathLabel } from './path-links.js';

/**
 * Node spells a file error `EACCES: permission denied, open '<absolute path>'`: the user needs
 * only its words.
 */
export function fileErrorReason(err: unknown): string | undefined {
  if (!(err instanceof Error) || !('code' in err)) return undefined;
  return /^E[A-Z]+: ([^,]+)/.exec(err.message)?.[1];
}

/** The cause comes before the file, so a cut line hides the file, not the cause. */
export const fileFailure = (reason: string, file: string): string => `${reason} · ${file}`;

/**
 * The file a file error names. A rename, link or symlink names the file it makes as `dest`; a
 * write through a temporary or lock sibling names the file it meant (`nameWriteTarget`).
 */
function errorFile(err: Error): string | undefined {
  const path =
    ('dest' in err && typeof err.dest === 'string' && err.dest) ||
    ('path' in err && typeof err.path === 'string' && err.path);
  return path ? projectRelativePathLabel({ path, rootDir: process.cwd() }) : undefined;
}

/** A `write` or `fsync` error names no file: its words alone, after the caller's label. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const reason = fileErrorReason(err);
  if (reason === undefined) return err.message;
  const file = errorFile(err);
  return file === undefined ? reason : fileFailure(reason, file);
}

export function toErrorMessage(err: unknown, opts: TerminalDiagnosticTextOptions = {}): string {
  return sanitizeTerminalDiagnosticText(errorText(err), opts);
}

export const labelError = (action: string, err: unknown): string =>
  `${action}: ${toErrorMessage(err)}`;
