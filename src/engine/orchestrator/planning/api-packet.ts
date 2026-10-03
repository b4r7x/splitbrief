import { buildApiPlanningContext } from '../../planners/api-context.js';
import { buildProjectContext } from '../../planners/context.js';
import type { PriorMessage } from '../../planners/types.js';
import { apiContextError } from '../../providers/api-context-diagnostic.js';
import {
  apiBudgetError,
  BASE_OUTPUT_RESERVE_TOKENS,
  measureApiBudget,
} from '../../providers/api-budget.js';
import type { ApiRuntimeContext } from '../../providers/runtime-context.js';

/**
 * A transport repair sends the turn again with the failed answer. The packet leaves one output
 * reserve of room for it, so the repair of an answer that size is admitted too.
 */
const TRANSPORT_REPAIR_TOKENS = BASE_OUTPUT_RESERVE_TOKENS;

/**
 * The project context of a planner that reads no files of its own: project instructions, the
 * current source of every path the request or the earlier planning names, and a named list of what
 * was not read. `compose` places it in the turn that is sent, so the whole turn is measured against
 * the seat's context. An incomplete or oversized packet refuses before anything is dispatched.
 */
export async function apiPlanningPacket(opts: {
  projectDir: string;
  context: ApiRuntimeContext;
  compose: (projectContext: string) => string;
  request: string;
  earlierPlanning?: string | undefined;
  steer?: string | undefined;
  priorMessages?: readonly PriorMessage[] | undefined;
  repoMap?: string | undefined;
  skills?: string | undefined;
}): Promise<string> {
  const { context, compose } = opts;
  const model = context.selectionId;
  const measure = (packet: string) =>
    measureApiBudget({
      context,
      messages: [...(opts.priorMessages ?? []), { role: 'user', content: compose(packet) }],
      role: 'plan',
    });
  const minimum = measure('');
  if (minimum.kind === 'insufficient' && minimum.reason === 'output') {
    throw apiBudgetError.contextInsufficient('planner', minimum, model, {
      budgetSource: context.budgetSource,
    });
  }

  const packet = await buildApiPlanningContext({
    projectDir: opts.projectDir,
    project: await buildProjectContext(opts.projectDir),
    request: opts.request,
    ...(opts.earlierPlanning !== undefined && {
      artifacts: [{ name: 'earlier planning', text: opts.earlierPlanning, required: false }],
    }),
    ...(opts.steer !== undefined && opts.steer !== '' && { steer: opts.steer }),
    ...(opts.priorMessages !== undefined && { priorMessages: opts.priorMessages }),
    ...(opts.repoMap !== undefined && { repoMap: opts.repoMap, repoMapInPrompt: true }),
    ...(opts.skills !== undefined && { skills: opts.skills }),
    availableTokens: Math.max(
      0,
      context.applicationContextTokens - BASE_OUTPUT_RESERVE_TOKENS - TRANSPORT_REPAIR_TOKENS,
    ),
    measureInput: (text) => {
      const measurement = measure(text);
      return measurement.inputEstimate + measurement.estimationMargin;
    },
    model,
  });
  if (packet.kind === 'insufficient-context') {
    throw apiContextError({
      code: 'insufficient-context',
      seat: 'plan',
      cause: packet.cause,
      missingSections: [...packet.missingSections],
      model,
      requiredTokens: packet.requiredTokens,
      availableTokens: packet.availableTokens,
    });
  }
  return packet.text;
}
