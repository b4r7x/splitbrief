import { EFFORT_LEVELS, type EffortLevel } from '../schemas/enums.js';
import { assertNever, includes } from '../../utils/type-guards.js';
import { CLI_TOOL_CATALOG } from './cli-tool-catalog.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';

/** How a seat's effort intent actually reaches the tool it runs. */
export type CliEffortChannel = 'effort-flag' | 'variant' | 'model-id' | 'none';

export const EFFORT_AXIS_TOKENS = EFFORT_LEVELS;

function idTokens(model: string): readonly string[] {
  const id = model.trim();
  return id
    .slice(id.lastIndexOf('/') + 1)
    .toLowerCase()
    .split('-');
}

type AxisRun = Readonly<{
  effort: EffortLevel | undefined;
  thinking: boolean;
  fast: boolean;
  head: readonly string[];
}>;

/**
 * Axis tokens count only where a tool appends them — the id's trailing run. A
 * rung anywhere else is part of the family name (`high-flyer-2`, `fast-1`), and
 * an id with nothing but axis words (`extra-high`) is a name, not a selection:
 * it keeps every word and reports no axis, so the peel and the words agree.
 */
function trailingAxisRun(tokens: readonly string[]): AxisRun {
  let effort: EffortLevel | undefined;
  let thinking = false;
  let fast = false;
  let end = tokens.length;
  while (end > 0) {
    const token = tokens[end - 1];
    if (token === 'high' && end > 1 && tokens[end - 2] === 'extra') {
      effort ??= 'xhigh';
      end -= 2;
    } else if (includes(EFFORT_LEVELS, token)) {
      effort ??= token;
      end -= 1;
    } else if (token === 'thinking') {
      thinking = true;
      end -= 1;
    } else if (token === 'fast') {
      fast = true;
      end -= 1;
    } else {
      break;
    }
  }
  if (end === 0) return { effort: undefined, thinking: false, fast: false, head: tokens };
  return { effort, thinking, fast, head: tokens.slice(0, end) };
}

/** The effort token a `model-id`-channel selection spells, or undefined when it spells none. */
export function effortTokenOfModelId(model: string | undefined): EffortLevel | undefined {
  if (model === undefined) return undefined;
  const tokens = idTokens(model);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token === 'high' && tokens[index - 1] === 'extra') return 'xhigh';
    if (includes(EFFORT_LEVELS, token)) return token;
  }
  return undefined;
}

/** The axis words a `model-id` seat spells, in the order the identity states them. */
export function optionTokensOfModelId(model: string | undefined): readonly string[] {
  if (model === undefined) return [];
  const run = trailingAxisRun(idTokens(model));
  const words: string[] = [];
  if (run.effort !== undefined) words.push(run.effort);
  if (run.thinking) words.push('thinking');
  if (run.fast) words.push('fast');
  return words;
}

/** The same id with its trailing run of axis words taken back out. */
export function peelAxisTokensFromModelId(model: string): string {
  const id = model.trim();
  const prefix = id.slice(0, id.lastIndexOf('/') + 1);
  return `${prefix}${trailingAxisRun(idTokens(id)).head.join('-')}`;
}

export function runnerEffortChannel(runner: RunnerConfig): CliEffortChannel {
  switch (runner.kind) {
    case 'cli':
      return CLI_TOOL_CATALOG[runner.tool].effortChannel;
    case 'api':
    case 'shell':
    case 'agent':
      return 'none';
    default:
      return assertNever(runner);
  }
}

/** The seat's reasoning axes as the mirror surfaces spell them: effort, then thinking, then fast. */
export function seatAxisWords(runner: RunnerConfig): readonly string[] {
  const channel = runnerEffortChannel(runner);
  switch (channel) {
    case 'effort-flag': {
      const effort = 'effort' in runner ? runner.effort : undefined;
      return effort === undefined ? [] : [effort];
    }
    case 'variant': {
      const variant = 'variant' in runner ? runner.variant : undefined;
      return variant === undefined ? [] : [variant];
    }
    case 'model-id':
      return optionTokensOfModelId('model' in runner ? runner.model : undefined);
    case 'none':
      return [];
    default:
      return assertNever(channel);
  }
}
