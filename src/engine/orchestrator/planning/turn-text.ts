import { stat } from 'node:fs/promises';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveApproveLevel } from '../../../core/config/runtime/resolve.js';
import {
  PLAN_JSON_FILE,
  RESEARCH_FILE,
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
} from '../../../core/paths.js';
import { PLAN_ANSWER_JSON_SCHEMA } from '../../../core/schemas/plan.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { type SpecFileRef, readSpecFile } from '../../../core/sessions/spec-files.js';
import { isSessionConversation } from '../../../core/state/planning-conversation.js';
import { buildRepoMap } from '../../codebase/repomap.js';
import { absolutePathsNamed } from '../../planners/api-context.js';
import { buildProjectContextMarkdown } from '../../planners/context.js';
import type { PriorMessage, Planner } from '../../planners/types.js';
import { fallbackInstruction } from '../../runners/typed-output.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import {
  type BuildSeat,
  planHistory,
  buildPlanSessionPrompt,
} from '../../spec/prompts/plan-session.js';
import {
  resolveProfileContextLength,
  profileEffectiveModelId,
} from '../context-routing/context-length.js';
import type { PlannerCallbacksContext } from '../types.js';
import { apiPlanningPacket } from './api-packet.js';
import { plannerRejectionContext } from './call-loop.js';
import type { PlanCheckContext } from './types.js';

function buildSeat(wctx: PlanCheckContext): BuildSeat {
  const profile = resolveImplementerProfiles(wctx.config).defaultProfile;
  const window = resolveProfileContextLength(
    profile,
    undefined,
    wctx.modelCache,
    wctx.detectedContextLength,
  );
  return {
    model: profileEffectiveModelId(profile),
    contextTokens: window.usedConservativeContextLength ? undefined : window.contextLength,
    writesFiles: profile.capabilities.writesFiles,
  };
}

/**
 * What an older multi-step planning chain of this run wrote: its documents and the conversation it
 * was holding, its open question answered by `answer` when the run continued with one. A run that
 * already has `plan.json` wrote its documents itself.
 */
export function earlierPlanning(
  ref: SpecFileRef,
  state: WorkflowState,
  answer: string | undefined,
): string | undefined {
  if (readSpecFile(ref, PLAN_JSON_FILE) !== null) return undefined;
  const documents = [RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE].flatMap((file) => {
    const text = readSpecFile(ref, file)?.trim();
    return text === undefined || text === '' ? [] : [`### ${file}\n${text}`];
  });
  const conversation = state.pendingPlannerConversation;
  if (conversation !== undefined && !isSessionConversation(conversation)) {
    const rounds = [
      ...conversation.answers,
      ...(conversation.answered
        ? []
        : [{ reply: conversation.text, answer: answer ?? '(not answered)' }]),
    ];
    documents.push(planHistory(rounds));
  }
  return documents.length === 0 ? undefined : documents.join('\n\n');
}

/**
 * The text of one planning session turn: `turn` places the session prompt in the turn that carries
 * it, and `priorMessages` is the transcript the call is sent with.
 */
export type PlanTurnText = (
  turn: (prompt: string) => string,
  priorMessages?: readonly PriorMessage[] | undefined,
) => Promise<string>;

/**
 * The session prompt every turn of a planning session carries, for the run and for `splitbrief
 * spec` alike. A planner that reads no files of its own gets the current source of what the request
 * names, measured against its context inside the very turn that is sent; any other planner reads the
 * project itself.
 */
export async function planTurnText(opts: {
  wctx: PlanCheckContext & Pick<PlannerCallbacksContext, 'sessionId' | 'signal'>;
  planner: Pick<Planner, 'resolvePlanningContext'>;
  feature: string;
  language: string | undefined;
  earlierPlanning?: string | undefined;
  steer?: string | undefined;
  onWarn: (message: string, details?: string) => void;
}): Promise<PlanTurnText> {
  const { wctx, planner } = opts;
  const { projectDir, config } = wctx;
  const repoMap =
    config.codebase?.enabled === false
      ? ''
      : await buildRepoMap(projectDir, {
          featureText: opts.feature,
          tokenBudget: config.codebase?.tokenBudget ?? 4000,
          onWarn: opts.onWarn,
          ...(config.codebase?.include && { include: config.codebase.include }),
          ...(config.codebase?.exclude && { exclude: config.codebase.exclude }),
        });
  const codebaseContext = repoMap === '' ? undefined : repoMap;
  const languageContext = buildProjectLanguageContext(projectDir, opts.language);
  const compose = (projectContext: string): string =>
    plannerRejectionContext(wctx) +
    buildPlanSessionPrompt({
      feature: opts.feature,
      projectContext,
      languageContext,
      build: buildSeat(wctx),
      approvesPlan: resolveApproveLevel(config) === 'plan',
      skillsContext: wctx.skillsContext,
      codebaseContext,
      earlierPlanning: opts.earlierPlanning,
    });
  if (planner.resolvePlanningContext === undefined) {
    const prompt = compose(await buildProjectContextMarkdown(projectDir));
    return async (turn) => turn(prompt);
  }
  const entries = await Promise.all(
    absolutePathsNamed([opts.feature, opts.steer].join('\n')).map(async (path) => {
      try {
        const stats = await stat(path);
        return stats.isFile() || stats.isDirectory() ? [path] : [];
      } catch (err) {
        if (
          err instanceof Error &&
          'code' in err &&
          typeof err.code === 'string' &&
          ['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP', 'EACCES', 'EPERM'].includes(err.code)
        ) {
          return [];
        }
        throw err;
      }
    }),
  );
  const paths = entries.flat();
  if (paths.length > 0) {
    opts.onWarn(
      `The plan seat reads no files, so it cannot open ${paths.join(', ')}. Put @ before a file path to attach its text.`,
    );
  }
  const context = await planner.resolvePlanningContext(wctx.signal);
  return async (turn, priorMessages) =>
    turn(
      compose(
        await apiPlanningPacket({
          projectDir,
          context,
          // A tool that refuses the native schema gets it as text, so the measure carries it too.
          compose: (packet) => turn(compose(packet)) + fallbackInstruction(PLAN_ANSWER_JSON_SCHEMA),
          request: opts.feature,
          earlierPlanning: opts.earlierPlanning,
          steer: opts.steer,
          priorMessages,
          repoMap: codebaseContext,
          skills: wctx.skillsContext,
        }),
      ),
    );
}
