/**
 * Shared planner runtime: orchestrates the planning phases (research, spec, plan,
 * brief compilation) on top of a backend-specific invoke function. The durable
 * planner→implementer handoff is the array of Product Task Briefs that ends up
 * in `PlanResult.tasks`; the markdown phases (`spec.md`, `plan.md`, `tasks.md`)
 * are transport for human review and brief compilation, not the contract itself.
 *
 * @see docs/TASK-CONTRACT.md
 */
import type { Task } from '../../core/schemas/task.js';
import type { InvokeResult } from '../runners/types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { Planner, PlannerCallbacks, PlanResult, EscalationResult, RegenerateResult, PhaseResult, PlannerCapabilities, PriorMessage } from './types.js';
import { formatMessagesForCli } from '../streaming/format-messages.js';
import { buildResearchPrompt } from '../spec/prompts/research.js';
import { buildSpecPrompt } from '../spec/prompts/spec.js';
import { buildPlanPrompt } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { buildHintPrompt, buildEscalationPrompt } from '../spec/prompts/escalation.js';
import { buildQuickPlanPrompt } from '../spec/prompts/quick-plan.js';
import { buildInstantPrompt } from '../spec/prompts/instant.js';
import type { LanguageContext } from '../spec/prompts/language-context.js';
import { buildProjectLanguageContext, extractLanguageFromResearch } from '../spec/prompts/language-context.js';
import { parseTasks } from '../spec/parser.js';
import { RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE } from '../../core/paths.js';
import { extractCode } from '../parsers/response-extractor.js';
import { buildProjectContextMarkdown } from './context.js';
import { accumulateUsage } from '../streaming/token-utils.js';
import { DEFAULT_AVAILABILITY } from '../../lib/availability.js';
import { getChangedFiles } from '../../lib/git.js';
import { createChangeDetector } from '../change-detection.js';
import { createTranscriptBuffer } from '../streaming/transcript-buffer.js';
import type { Phase } from '../../core/schemas/enums.js';

function formatRepoMapBlock(codebaseContext: string | undefined): string {
  return codebaseContext ? `<repo-map>\n${codebaseContext}\n</repo-map>\n\n` : '';
}

const PHASE_MAP: Partial<Record<string, Phase>> = {
  researching: 'researching',
  specifying: 'specifying',
  planning: 'planning',
  'generating-tasks': 'planning',
  'quick-planning': 'planning',
};

type InternalInvokeFn = (opts: {
  prompt: string;
  projectDir: string;
  callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion' | 'onSessionId' | 'onSessionExpired'>;
  priorMessages?: PriorMessage[] | undefined;
  images?: Attachment[] | undefined;
}) => Promise<InvokeResult>;

// invokeEscalate exists separately: Claude Code uses session-chaining for plan phases but one-shot for escalations.
export interface PlannerBaseConfig {
  invokePlan: InternalInvokeFn;
  invokeEscalate: InternalInvokeFn;
  isAvailable: () => Promise<boolean>;
  getVersion?: () => Promise<string | null>;
  capabilities: PlannerCapabilities;
  /**
   * How to determine whether escalateHint succeeded.
   * - 'text': non-empty stdout (API/streaming planners)
   * - 'files': git changed files (CLI/agent planners that write files directly)
   * Default: 'text'
   */
  hintSuccessMode?: 'text' | 'files';
  /** Override to read the artifact from disk when the backend writes files directly (e.g., agent planner). Falls back to stdout text when not provided. */
  readPhaseOutput?: (filename: string, resultText: string, projectDir: string, sessionId?: string) => string;
  escalateFullPostProcess?: (task: Task, result: InvokeResult, extracted: { code: string }, projectDir: string) => EscalationResult;
  /**
   * When true, the backend handles `priorMessages` natively (e.g. API backends using an OpenAI
   * messages array). When false (default), the base layer prepends a CLI-format transcript
   * block to the prompt for the first planning phase.
   */
  consumesPriorMessages?: boolean;
  injectUserTurn?: (text: string, projectDir: string) => Promise<void>;
}

export function createPlannerBase(config: PlannerBaseConfig): Planner {
  return {
    async plan(
      feature: string,
      projectDir: string,
      callbacks: PlannerCallbacks,
      skillsContext?: string,
      codebaseContext?: string,
    ): Promise<PlanResult> {
      const projectContext = await buildProjectContextMarkdown(projectDir);
      const repoMapBlock = formatRepoMapBlock(codebaseContext);
      let usage: TokenDelta | null = null;
      const phases: PhaseResult[] = [];

      let priorInjected = false;
      let imagesInjected = false;
      const pendingImages = callbacks.attachments;
      async function runPhase(phase: string, prompt: string, filename: string): Promise<string> {
        callbacks.onPhase?.(phase);
        const plannerPhase = PHASE_MAP[phase];
        const buffer = createTranscriptBuffer(
          projectDir, callbacks.sessionId ?? '', plannerPhase, callbacks.persistTranscript ?? true,
        );

        // On the first phase of a resume, inject prior conversation. Backends that set
        // `consumesPriorMessages` receive the raw array via invokePlan; the rest get a
        // prompt-level prefix.
        const priorMessages = !priorInjected ? callbacks.priorMessages : undefined;
        let effectivePrompt = prompt;
        if (priorMessages && priorMessages.length > 0 && !config.consumesPriorMessages) {
          effectivePrompt = formatMessagesForCli(priorMessages) + prompt;
        }
        priorInjected = true;

        const images = !imagesInjected && pendingImages && pendingImages.length > 0 ? pendingImages : undefined;
        imagesInjected = true;

        const result = await config.invokePlan({
          prompt: effectivePrompt,
          projectDir,
          callbacks: {
            onOutput: (text) => { callbacks.onOutput(text); buffer.append(text); },
            onQuestion: callbacks.onQuestion,
            onSessionId: callbacks.onSessionId,
            onSessionExpired: callbacks.onSessionExpired,
          },
          ...(config.consumesPriorMessages && priorMessages ? { priorMessages } : {}),
          ...(images ? { images } : {}),
        });
        buffer.flush();
        if (result.usage) usage = accumulateUsage(usage, result.usage);
        const artifactText = config.readPhaseOutput
          ? config.readPhaseOutput(filename, result.text, projectDir, callbacks.sessionId)
          : result.text;
        const rawOutput = artifactText !== result.text ? result.text : undefined;
        phases.push({ text: artifactText, filename, rawOutput });
        return artifactText;
      }

      const research = await runPhase('researching', repoMapBlock + buildResearchPrompt(feature, projectContext, skillsContext), RESEARCH_FILE);
      const languageContext = buildProjectLanguageContext(
        projectDir,
        extractLanguageFromResearch(research) ?? callbacks.discoveredValidation?.language,
      );
      const spec = await runPhase('specifying', buildSpecPrompt(feature, research, languageContext), SPEC_FILE);
      const plan = await runPhase('planning', buildPlanPrompt({ content: spec, hasClarifications: spec.includes('## Clarifications') }, projectContext, skillsContext, languageContext), PLAN_FILE);
      const tasksMarkdown = await runPhase('generating-tasks', buildTasksPrompt(spec, plan, languageContext), TASKS_FILE);

      const tasks = parseTasks(tasksMarkdown);

      return { spec, plan, tasks, usage, phases };
    },

    async quickPlan(
      feature: string,
      projectDir: string,
      callbacks: PlannerCallbacks,
      codebaseContext?: string,
    ): Promise<PlanResult> {
      return runSinglePhasePlanning(
        config,
        (promptFeature, projectContext, languageContext) => buildQuickPlanPrompt(promptFeature, projectContext, languageContext),
        'quick-planning',
        feature,
        projectDir,
        callbacks,
        codebaseContext,
      );
    },

    async instantPlan(
      feature: string,
      projectDir: string,
      callbacks: PlannerCallbacks,
      codebaseContext?: string,
    ): Promise<PlanResult> {
      return runSinglePhasePlanning(
        config,
        (promptFeature, projectContext, languageContext) => buildInstantPrompt(promptFeature, projectContext, languageContext),
        'instant-planning',
        feature,
        projectDir,
        callbacks,
        codebaseContext,
      );
    },

    async regenerate(
      prompt: string,
      _artifactType: 'spec' | 'plan',
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<RegenerateResult> {
      const result = await config.invokeEscalate({ prompt, projectDir, callbacks });
      return { text: result.text, usage: result.usage };
    },

    async escalateHint(
      task: Task,
      error: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
      languageContext?: LanguageContext,
    ): Promise<EscalationResult> {
      if (config.capabilities.supportsHintEscalation === false) {
        return { success: false, output: '', code: null, usage: null };
      }
      const hintPrompt = buildHintPrompt(task, error, languageContext ?? buildProjectLanguageContext(projectDir, undefined));
      const useFiles = config.hintSuccessMode === 'files';
      const detect = useFiles ? createChangeDetector('Hint escalation') : null;
      const filesBefore = useFiles ? await getChangedFiles(projectDir) : [];
      const result = await config.invokeEscalate({ prompt: hintPrompt, projectDir, callbacks });
      const success = detect
        ? (await detect(projectDir, filesBefore)).changed
        : result.text.length > 0;
      return { success, output: result.text, code: null, usage: result.usage };
    },

    async escalateFull(
      task: Task,
      error: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
      languageContext?: LanguageContext,
    ): Promise<EscalationResult> {
      const escalationPrompt = buildEscalationPrompt(task, task.currentCode ?? '', error, languageContext ?? buildProjectLanguageContext(projectDir, undefined));
      const result = await config.invokeEscalate({ prompt: escalationPrompt, projectDir, callbacks });

      const extracted = extractCode(result.text);
      if ('error' in extracted) {
        return { success: false, output: result.text, code: null, usage: result.usage };
      }

      if (config.escalateFullPostProcess) {
        return config.escalateFullPostProcess(task, result, extracted, projectDir);
      }

      return { success: true, output: result.text, code: extracted.code, usage: result.usage };
    },

    async review(
      prompt: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<{ text: string; usage: TokenDelta | null }> {
      return config.invokeEscalate({ prompt, projectDir, callbacks });
    },

    ...DEFAULT_AVAILABILITY,
    isAvailable: config.isAvailable,
    ...(config.getVersion && { getVersion: config.getVersion }),
    ...(config.injectUserTurn && { injectUserTurn: config.injectUserTurn }),
    capabilities: config.capabilities,
  };
}

async function runSinglePhasePlanning(
  config: PlannerBaseConfig,
  promptBuilder: (feature: string, projectContext: string, languageContext: LanguageContext) => string,
  phaseName: string,
  feature: string,
  projectDir: string,
  callbacks: PlannerCallbacks,
  codebaseContext: string | undefined,
): Promise<PlanResult> {
  const projectContext = await buildProjectContextMarkdown(projectDir);
  const languageContext = buildProjectLanguageContext(projectDir, callbacks.discoveredValidation?.language);
  const repoMapBlock = formatRepoMapBlock(codebaseContext);
  const prompt = repoMapBlock + promptBuilder(feature, projectContext, languageContext);

  callbacks.onPhase?.(phaseName);
  const buffer = createTranscriptBuffer(
    projectDir, callbacks.sessionId ?? '', 'planning', callbacks.persistTranscript ?? true,
  );
  const priorMessages = callbacks.priorMessages;
  let effectivePrompt = prompt;
  if (priorMessages && priorMessages.length > 0 && !config.consumesPriorMessages) {
    effectivePrompt = formatMessagesForCli(priorMessages) + prompt;
  }
  const images = callbacks.attachments && callbacks.attachments.length > 0 ? callbacks.attachments : undefined;
  const result = await config.invokePlan({
    prompt: effectivePrompt,
    projectDir,
    callbacks: {
      onOutput: (text) => { callbacks.onOutput(text); buffer.append(text); },
      onQuestion: callbacks.onQuestion,
      onSessionId: callbacks.onSessionId,
      onSessionExpired: callbacks.onSessionExpired,
    },
    ...(config.consumesPriorMessages && priorMessages ? { priorMessages } : {}),
    ...(images ? { images } : {}),
  });
  buffer.flush();

  const tasksContent = config.readPhaseOutput
    ? config.readPhaseOutput(TASKS_FILE, result.text, projectDir, callbacks.sessionId)
    : result.text;
  const tasks = parseTasks(tasksContent);
  const rawOutput = tasksContent !== result.text ? result.text : undefined;
  return { spec: '', plan: '', tasks, usage: result.usage, phases: [{ text: tasksContent, filename: TASKS_FILE, rawOutput }] };
}
