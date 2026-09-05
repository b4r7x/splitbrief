import { EFFORT_LEVELS, type EffortLevel } from '../schemas/enums.js';
import { includes } from '../../utils/type-guards.js';

/** How a seat's effort intent actually reaches the tool it runs. */
export type CliEffortChannel = 'effort-flag' | 'variant' | 'model-id' | 'none';

export const EFFORT_AXIS_TOKENS = EFFORT_LEVELS;

/** The effort token a `model-id`-channel selection spells, or undefined when it spells none. */
export function effortTokenOfModelId(model: string | undefined): EffortLevel | undefined {
  if (model === undefined) return undefined;
  const tokens = model
    .slice(model.lastIndexOf('/') + 1)
    .toLowerCase()
    .split('-');
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token === 'high' && tokens[index - 1] === 'extra') return 'xhigh';
    if (includes(EFFORT_LEVELS, token)) return token;
  }
  return undefined;
}
