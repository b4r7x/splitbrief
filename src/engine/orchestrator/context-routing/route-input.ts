import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { LanguageContext } from '../../spec/prompts/language-context.js';
import type { RouteTaskOptions } from './types.js';

export interface BuildRouteTaskOptionsInput {
  task: Task;
  context: ProjectContext;
  profiles: ResolvedImplementerProfile[];
  modelCache?: ModelCacheAccessor | undefined;
  languageContext?: LanguageContext | undefined;
  detectedContextLength?: number | undefined;
  conservativeContextLength?: number | undefined;
}

export function buildRouteTaskOptions(opts: BuildRouteTaskOptionsInput): RouteTaskOptions {
  const conservativeContextLength = opts.conservativeContextLength;

  return {
    task: opts.task,
    context: opts.context,
    profiles: opts.profiles,
    ...(conservativeContextLength !== undefined && { conservativeContextLength }),
    ...(opts.modelCache !== undefined && { modelCache: opts.modelCache }),
    ...(opts.languageContext !== undefined && { languageContext: opts.languageContext }),
    ...(opts.detectedContextLength !== undefined && {
      detectedContextLength: opts.detectedContextLength,
    }),
  };
}
