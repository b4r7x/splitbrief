import { InvalidArgumentError } from 'commander';
import { isCliToolId, CLI_TOOL_CATALOG } from '../../core/runners/cli-tool/catalog.js';
import type { CliEffortChannel } from '../../core/runners/effort-channel.js';
import { type EffortLevel, EffortLevelSchema, EFFORT_LEVELS } from '../../core/schemas/enums.js';

export type SeatSpec = Readonly<{
  tool: string;
  model?: string;
  effort?: string;
  variant?: string;
}>;

/**
 * The seat grammar `<tool>[:<model>][@<effort>]` the skills already document for
 * `impl=` / `review=`: split on the first `:` and the last `@`, so a model id
 * may carry colons and the `@` word is always the tail. The word is the variant
 * on a tool that takes its effort as a variant, else the effort.
 */
export function parseSeatSpecOption(value: string): SeatSpec {
  const spec = value.trim();
  const at = spec.lastIndexOf('@');
  const head = at === -1 ? spec : spec.slice(0, at);
  const effort = at === -1 ? undefined : spec.slice(at + 1).trim();
  const colon = head.indexOf(':');
  const tool = (colon === -1 ? head : head.slice(0, colon)).trim();
  const model = colon === -1 ? undefined : head.slice(colon + 1).trim();
  if (tool === '') {
    throw new InvalidArgumentError(`'${value}' names no tool. Use <tool>[:<model>][@<effort>].`);
  }
  if (model === '') {
    throw new InvalidArgumentError(`'${value}' names an empty model after ':'.`);
  }
  if (effort === '') {
    throw new InvalidArgumentError(`'${value}' names an empty effort after '@'.`);
  }
  const axis =
    effort === undefined
      ? {}
      : effortChannelOfTool(tool) === 'variant'
        ? { variant: effort }
        : { effort };
  return { tool, ...(model !== undefined && { model }), ...axis };
}

/** A CLI tool's own effort channel; a provider or custom tool has none the seat can spend. */
function effortChannelOfTool(tool: string): CliEffortChannel {
  return isCliToolId(tool) ? CLI_TOOL_CATALOG[tool].effortChannel : 'none';
}

/** The seat grammar's `@<effort>` is the one effort spellings the seats admit. */
export function parseEffortLevel(effort: string, spec: string): EffortLevel {
  const parsed = EffortLevelSchema.safeParse(effort);
  if (!parsed.success) {
    throw new InvalidArgumentError(
      `'${spec}' names effort '${effort}', which is not one of: ${EFFORT_LEVELS.join(', ')}.`,
    );
  }
  return parsed.data;
}
