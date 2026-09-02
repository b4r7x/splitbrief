import { EFFORT_LEVELS } from '../schemas/enums.js';
import { includes } from '../../utils/type-guards.js';

/** How a seat's effort intent actually reaches the tool it runs. */
export type CliEffortChannel = 'effort-flag' | 'variant' | 'model-id' | 'none';

/**
 * The closed effort vocabulary a model id can spell, widest to narrowest. It is
 * a superset of EFFORT_LEVELS: `none` and `max` exist in tool ids but are not
 * config-settable effort levels.
 */
export const EFFORT_AXIS_TOKENS = ['none', ...EFFORT_LEVELS, 'max'] as const;

export type EffortAxisToken = (typeof EFFORT_AXIS_TOKENS)[number];

/** The effort token a `model-id`-channel selection spells, or undefined when it spells none. */
export function effortTokenOfModelId(model: string | undefined): EffortAxisToken | undefined {
  if (model === undefined) return undefined;
  const tokens = model
    .slice(model.lastIndexOf('/') + 1)
    .toLowerCase()
    .split('-');
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token === 'high' && tokens[index - 1] === 'extra') return 'xhigh';
    if (includes(EFFORT_AXIS_TOKENS, token)) return token;
  }
  return undefined;
}
