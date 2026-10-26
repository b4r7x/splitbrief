import { execFileSync } from 'node:child_process';
import { error, type AppError } from '../../utils/error.js';

/** The largest prompt a seat's tool takes, in the unit the tool counts. */
export type PromptLimit = Readonly<{ max: number; unit: 'characters' | 'bytes' }>;

/** A too-large prompt's size and the limit it broke, in the unit the refusal counts. */
export type PromptSize = Readonly<{
  unit: 'characters' | 'bytes';
  size: number | null;
  limit: number | null;
}>;

const ARGV_REFUSAL = /CLI prompt is (\d+) bytes and exceeds the (\d+)-byte argv limit/;

/**
 * The figures a too-large refusal names: SPLITBRIEF's own command-line refusal counts bytes,
 * Codex counts characters, and Claude Code names none.
 */
export function inputTooLargeFigures(message: string): PromptSize {
  const argv = ARGV_REFUSAL.exec(message);
  if (argv !== null) return { unit: 'bytes', size: Number(argv[1]), limit: Number(argv[2]) };
  const chars = /"actual_chars"\s*:\s*(\d+)/.exec(message)?.[1];
  const maxChars =
    /"max_chars"\s*:\s*(\d+)/.exec(message)?.[1] ??
    /maximum length of (\d+) characters/i.exec(message)?.[1];
  return {
    unit: 'characters',
    size: chars === undefined ? null : Number(chars),
    limit: maxChars === undefined ? null : Number(maxChars),
  };
}

/**
 * A too-large prompt in SPLITBRIEF's words: its size and the tool's limit where the refusal
 * named them, never a figure it did not name. Bytes are the command line's limit.
 */
export function inputTooLargeSentence(subject: string, figures: PromptSize, tool: string): string {
  const { unit, size, limit } = figures;
  const where = unit === 'bytes' ? ' on its command line' : '';
  if (size === null) {
    return limit === null
      ? `${subject} is too large for ${tool}`
      : `${subject} is larger than the ${limit.toLocaleString('en-US')} ${unit} ${tool} takes${where}`;
  }
  return `${subject} is ${size.toLocaleString('en-US')} ${unit}; ${tool} ${
    limit === null
      ? 'refused it as too large'
      : `takes at most ${limit.toLocaleString('en-US')}${where}`
  }`;
}

/** The facts a halt keeps for a too-large prompt, named by the unit the refusal counted. */
export function inputTooLargeFacts({
  unit,
  size,
  limit,
}: PromptSize): Record<string, number | undefined> {
  return unit === 'bytes'
    ? { bytes: size ?? undefined, maxBytes: limit ?? undefined }
    : { chars: size ?? undefined, maxChars: limit ?? undefined };
}

/** The size of `prompt` in the unit `limit` counts. */
export function promptSizeIn(prompt: string, unit: PromptLimit['unit']): number {
  return unit === 'bytes' ? Buffer.byteLength(prompt, 'utf8') : prompt.length;
}

/** A prompt's size in each unit a tool's limit can count. */
export type PromptLength = Readonly<Record<PromptLimit['unit'], number>>;

export function promptLength(prompt: string): PromptLength {
  return { characters: promptSizeIn(prompt, 'characters'), bytes: promptSizeIn(prompt, 'bytes') };
}

const ARGV_MARGIN_BYTES = 16 * 1024;
let hostArgvBytes: number | undefined;

/**
 * The largest prompt one command-line argument can carry on this host. Linux caps one argument
 * at MAX_ARG_STRLEN, 32 pages (execve(2)); macOS caps the arguments and the environment together
 * at ARG_MAX, so the environment's share is taken off.
 */
export function argvPromptMaxBytes(): number {
  if (process.platform === 'linux') {
    hostArgvBytes ??= 32 * getconf('PAGESIZE');
    return hostArgvBytes - ARGV_MARGIN_BYTES;
  }
  hostArgvBytes ??= getconf('ARG_MAX');
  return hostArgvBytes - environmentBytes() - ARGV_MARGIN_BYTES;
}

function getconf(name: string): number {
  return Number(execFileSync('getconf', [name], { encoding: 'utf8' }).trim());
}

function environmentBytes(): number {
  return Object.entries(process.env).reduce(
    (total, [key, value]) => total + Buffer.byteLength(`${key}=${value ?? ''}`, 'utf8') + 1,
    0,
  );
}

function argvRefusalMessage(bytes: number, maxBytes: number): string {
  return `CLI prompt is ${bytes} bytes and exceeds the ${maxBytes}-byte argv limit`;
}

/**
 * The refusal SPLITBRIEF raises when a prompt is larger than a tool takes on its command line,
 * before it starts the tool. `inputTooLargeFigures` reads its figures back.
 */
export function argvPromptTooLarge(
  bytes: number,
  maxBytes: number,
): AppError<'argv-prompt-too-large'> {
  return error('argv-prompt-too-large', argvRefusalMessage(bytes, maxBytes));
}

/**
 * The refusal SPLITBRIEF raises when a prompt it built is larger than the seat's
 * tool accepts, before sending it. Shaped like the tool's own refusal so the one
 * reader classifies both the same way.
 */
export function inputTooLargeRefusal(
  size: number,
  limit: PromptLimit,
): AppError<'input-too-large', { error: { code: 'input-too-large'; message: string } }> {
  const message =
    limit.unit === 'bytes'
      ? argvRefusalMessage(size, limit.max)
      : `Input exceeds the maximum length of ${limit.max} characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":${limit.max},"actual_chars":${size}}`;
  return error('input-too-large', message, {
    error: { code: 'input-too-large' as const, message },
  });
}
