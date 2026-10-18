import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import { takesHostModel } from '../../core/providers/automatic-model.js';
import { assertNever, isRecord } from '../../utils/type-guards.js';

/** The model a tool has selected on this host, and the file that said so. */
export type HostModelSelection = Readonly<{ model: string; source: string }>;

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
}

const XDG_BASE_DEFAULTS = {
  XDG_CONFIG_HOME: ['.config'],
  XDG_DATA_HOME: ['.local', 'share'],
  XDG_STATE_HOME: ['.local', 'state'],
} as const;

/**
 * An XDG base folder resolved the way OpenCode and Kilo Code resolve it: a
 * non-empty variable replaces the default under `home`, and a missing folder
 * there never falls back to that default.
 */
export function xdgBaseDir(
  env: NodeJS.ProcessEnv,
  base: keyof typeof XDG_BASE_DEFAULTS,
  home: string,
): string;
export function xdgBaseDir(
  env: NodeJS.ProcessEnv,
  base: keyof typeof XDG_BASE_DEFAULTS,
  home: string | undefined,
): string | undefined;
export function xdgBaseDir(
  env: NodeJS.ProcessEnv,
  base: keyof typeof XDG_BASE_DEFAULTS,
  home: string | undefined,
): string | undefined {
  return env[base] || (home === undefined ? undefined : join(home, ...XDG_BASE_DEFAULTS[base]));
}

// A `//` inside a string is a URL, not a comment: `opencode.jsonc` opens with a
// `$schema` line, and a blind strip would turn it into unparseable JSON.
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let comment: 'line' | 'block' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (comment === 'line') {
      if (char === '\n') {
        comment = null;
        out += char;
      }
      continue;
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = null;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && (next === '/' || next === '*')) {
      comment = next === '/' ? 'line' : 'block';
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
}

function stringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) return null;
  const found = value[field];
  if (typeof found !== 'string') return null;
  const trimmed = found.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * OpenCode and Kilo Code share one layout under different names: an optional
 * config file naming a model, and a state file whose `recent` list is the
 * picker's history with the last selection first.
 */
async function readXdgSelection(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<HostModelSelection | null> {
  for (const extension of ['json', 'jsonc']) {
    const path = join(
      xdgBaseDir(env, 'XDG_CONFIG_HOME', homeDir(env)),
      name,
      `${name}.${extension}`,
    );
    const model = stringField(await readJson(path), 'model');
    if (model !== null) return { model, source: path };
  }
  const path = join(xdgBaseDir(env, 'XDG_STATE_HOME', homeDir(env)), name, 'model.json');
  const state = await readJson(path);
  if (!isRecord(state)) return null;
  const recent = Array.isArray(state.recent) ? state.recent[0] : undefined;
  const providerId = stringField(recent, 'providerID');
  const modelId = stringField(recent, 'modelID');
  if (providerId === null || modelId === null) return null;
  return { model: `${providerId}/${modelId}`, source: path };
}

const TOML_MODEL_LINE = /^\s*model\s*=\s*["']([^"']+)["']/;
const TOML_SECTION_LINE = /^\s*\[/;

// Codex keeps its selection as a top-level key; a `model` under a profile or
// provider section belongs to that section, not to the tool's own default.
async function readCodexSelection(env: NodeJS.ProcessEnv): Promise<HostModelSelection | null> {
  const path = join(homeDir(env), '.codex', 'config.toml');
  const text = await readText(path);
  if (text === null) return null;
  for (const line of text.split('\n')) {
    if (TOML_SECTION_LINE.test(line)) return null;
    const model = TOML_MODEL_LINE.exec(line)?.[1];
    if (model !== undefined) return { model, source: path };
  }
  return null;
}

// Antigravity settings name the model the way its picker spells it, so the id
// the argv needs comes from the detected catalog row behind that display name.
async function readAntigravitySelection(
  env: NodeJS.ProcessEnv,
  detectedModels: readonly DetectedModel[] | undefined,
): Promise<HostModelSelection | null> {
  const path = join(homeDir(env), '.gemini', 'antigravity-cli', 'settings.json');
  const selected = stringField(await readJson(path), 'model');
  if (selected === null) return null;
  const match = detectedModels?.find(
    (model) => model.displayName === selected || model.id === selected,
  );
  return match === undefined ? null : { model: match.id, source: path };
}

/**
 * The model the tool itself would use on this host, read from its own config or
 * state at preparation time so a seat left on `auto` can be started with that
 * model named explicitly. A missing or unparseable file is not an error: the
 * seat keeps `auto` and the tool keeps deciding.
 */
export async function readHostModelSelection(
  tool: CliToolId,
  env: NodeJS.ProcessEnv = process.env,
  detectedModels?: readonly DetectedModel[],
): Promise<HostModelSelection | null> {
  switch (tool) {
    case 'opencode':
      return readXdgSelection('opencode', env);
    case 'kilo-code':
      return readXdgSelection('kilo', env);
    case 'codex':
      return readCodexSelection(env);
    case 'claude-code': {
      const path = join(homeDir(env), '.claude', 'settings.json');
      const model = stringField(await readJson(path), 'model');
      return model === null ? null : { model, source: path };
    }
    case 'antigravity':
      return readAntigravitySelection(env, detectedModels);
    // Cursor's own `Auto` is the tool routing each request, not a stored
    // choice; Copilot and CommandCode write no selection file found on a real
    // install. Inventing a path here would report a model the tool never picked.
    case 'cursor':
    case 'copilot':
    case 'command-code':
      return null;
    default:
      return assertNever(tool);
  }
}

/**
 * The model a CLI seat calls: `named`, the model the seat names (or none, when it names none and
 * the tool keeps no readable selection); `host`, the tool's own selection on this host for a seat on
 * `auto` or with no model; `auto-unread`, a seat on `auto` whose tool keeps no readable selection.
 * Start and doctor read the seat's route on this model.
 */
export type SeatModel =
  | Readonly<{ kind: 'named'; model: string | undefined }>
  | Readonly<{ kind: 'host'; model: string; source: string }>
  | Readonly<{ kind: 'auto-unread'; model: string }>;

export async function resolveSeatModel(
  runner: Readonly<{ tool: CliToolId; model?: string | undefined }>,
  env: NodeJS.ProcessEnv,
  detectedModels: readonly DetectedModel[] | undefined,
): Promise<SeatModel> {
  const { tool, model } = runner;
  if (!takesHostModel(model, tool)) return { kind: 'named', model };
  const selection = await readHostModelSelection(tool, env, detectedModels);
  if (selection !== null) return { kind: 'host', ...selection };
  // A seat that named no model never asked for one, so the tool's own default is the answer it
  // wanted; only a declared `auto` is left unmet.
  return model === undefined ? { kind: 'named', model } : { kind: 'auto-unread', model };
}
