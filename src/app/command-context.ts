import { useRef } from 'react';
import { createRuntimeCommands } from '../core/runtime/commands/registry.js';
import { executeRuntimeCommand } from '../core/runtime/commands/dispatch.js';
import { requestClearQueue } from '../features/workflow/run-requests/registry.js';
import { requestLeaveSession, requestQuit } from '../features/workflow/run-requests/departure.js';
import { requestResume, requestSteer } from '../features/workflow/run-requests/stop-resume.js';
import { requestEndRun } from '../features/workflow/run-requests/end-run.js';
import type { ConversationRowAction } from '../features/workflow/conversation-rows/row-actions/build.js';
import { readConversationRowActions } from '../features/workflow/conversation-rows/row-actions/read.js';
import { readConversationScrollSnapshot } from '../features/workflow/layout/snapshot.js';
import {
  scrollConversation,
  toggleLatestActivityBatch,
  type ConversationScrollMetrics,
} from '../features/workflow/layout/scroll-commands.js';
import { acceptRun, rejectRun } from '../features/workflow/result/run-commands.js';
import { getWorkflowSidebarWidth } from '../features/workflow/layout/rect.js';
import { resolveCopyValue } from '../features/workflow/copy-target.js';
import type { Phase } from '../core/schemas/enums.js';
import type { Config } from '../core/schemas/config.js';
import type { Screen } from '../core/navigation/types.js';
import { configStore } from '../stores/project/config.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { composerDraftStore } from '../stores/ui/composer-draft.js';
import { composerLiveStore } from '../stores/ui/composer-live.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { questionPromptStore } from '../stores/prompts/question.js';
import { controlsStore } from '../stores/ui/controls.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import {
  isApplyUnfinishedAtRest,
  isOpenRunAtRest,
  routerStore,
} from '../stores/navigation/router.js';
import { runViewStore } from '../stores/workflow/run-view.js';
import { currentQueueCopy } from '../features/workflow/queue-copy.js';
import { projectFilesStore } from '../stores/ui/project-files.js';
import { skillsStore } from '../stores/project/skills.js';
import { refreshSkills } from './refresh-skills.js';
import { attachImage, detachImage, listAttachments } from '../stores/workflow/attachments.js';
import { resolveAttachment } from '../core/attachments/resolve.js';
import { getDefaultDetectionService } from '../engine/detection/service/create.js';
import { refreshDetectionForCurrentConfig } from '../engine/detection/store-publication.js';
import { detectionStore } from '../stores/discovery/detection.js';
import { readActive } from '../core/sessions/active-pointer.js';
import type {
  AttachImageResult,
  CopyResult,
  CopyTarget,
  QueueClearCommandResult,
  RuntimeCommandContext,
  SkillCommandOption,
  SkillToggleResult,
} from '../core/runtime/commands/types.js';
import { plannerSupportsImages } from '../engine/providers/capabilities.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';
import { createCommandContext } from '../core/runtime/commands/context-factory.js';
import { copyToClipboard } from '../lib/clipboard/copy.js';
import { appPreparationError } from './prepare-resume.js';
import { activeApply } from '../engine/orchestrator/session-lifecycle/shutdown.js';
import { readRunRecord } from '../core/sessions/run/record-io.js';
import { writeUiPrefs } from '../core/settings/ui-prefs.js';
import { error } from '../utils/error.js';
import type { RouteData } from '../stores/navigation/router.js';
import { createDraftDocument } from '../core/composer/document.js';
import { prepareDraftSubmission } from '../core/composer/submission.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';
import { formatSubmissionFailure } from '../components/composer/home-hint.js';
import { plainUserMessage } from '../core/types/user-input.js';

// Workflow-feature operations the runtime commands need but that the page tree must not
// reach into. `useRuntimeCommands` (below, in this module) wires the real
// `features/workflow/**` implementations into these ports; the page files never see them.
export interface WorkflowCommandPorts {
  requestClearQueue: () => QueueClearCommandResult | Promise<QueueClearCommandResult>;
  getRowActions: () => ReadonlyMap<string, ConversationRowAction>;
  readScrollMetrics: () => ConversationScrollMetrics;
  resolveCopyValue: (target: CopyTarget) => string | null;
}

const appCommandContextError = {
  noActiveSession: (command: string) =>
    error('app-command-no-active-session', `No active session for ${command}`, { command }),
} as const;

function routeSessionId(route: RouteData, projectDir: string): string | null {
  if (route.screen === 'workflow') return route.run.ref.sessionId;
  return readActive(projectDir);
}

function insertImageIntoComposer(input: Parameters<typeof attachImage>[0]): AttachImageResult {
  if (!input.supportsImages) return { ok: false, reason: 'no-vision' };
  const result = resolveAttachment({ input: input.path, projectDir: input.projectDir });
  if (!result.ok) return { ok: false, reason: result.reason };
  composerDraftStore.requestImage(result.attachment);
  return { ok: true, path: result.attachment.path };
}

// Project skills first, then the ones already selected this session — the in-session selection set
// is what "recently used" means here; there is no persisted recency store.
function listSkills(): readonly SkillCommandOption[] {
  const { available, selected } = skillsStore.get();
  const project = available.filter((skill) => skill.scope === 'project');
  const globals = available.filter((skill) => skill.scope === 'global');
  return [
    ...project,
    ...globals.filter((skill) => selected.has(skill.id)),
    ...globals.filter((skill) => !selected.has(skill.id)),
  ].map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    attached: selected.has(skill.id),
  }));
}

function toggleSkill(id: string): SkillToggleResult {
  const { available, selected } = skillsStore.get();
  const skill = available.find((candidate) => candidate.id === id);
  if (skill === undefined) return { status: 'unknown' };
  const wasSelected = selected.has(id);
  skillsStore.toggleSelected(id);
  return { status: wasSelected ? 'deselected' : 'selected', name: skill.name };
}

async function copyTarget(
  target: CopyTarget,
  resolveCopyValue: WorkflowCommandPorts['resolveCopyValue'],
): Promise<CopyResult> {
  const value = resolveCopyValue(target);
  if (value === null || value.length === 0) return 'empty';
  return copyToClipboard(value);
}

function readLoadedConfig(): Config {
  configStore.reloadIfChanged();
  const config = configStore.get().config;
  if (config === null) throw appPreparationError.configNotLoaded();
  return config;
}

export function buildCommandContext({
  exit,
  workflow,
}: {
  exit: () => void;
  workflow: WorkflowCommandPorts;
}): RuntimeCommandContext {
  const route = routerStore.get();
  const projectDir =
    route.screen === 'workflow' ? route.run.ref.projectDir : configStore.get().projectDir;
  return createCommandContext({
    projectDir: () => projectDir,
    getSessionId: () => routeSessionId(route, projectDir),
    noActiveSession: appCommandContextError.noActiveSession,
    openOverlay: overlayStore.open,
    // Apply cannot be cut: a /home typed while it writes waits for it, as Esc does.
    navigateHome: () =>
      activeApply() === undefined ? routerStore.navigate({ to: 'home' }) : requestLeaveSession(),
    quit: () => requestQuit(exit),
    setFeedbackMessage: feedbackStore.setInfo,
    setFeedbackError: feedbackStore.setError,
    refreshDetection: async () => {
      return refreshDetectionForCurrentConfig({
        service: getDefaultDetectionService(),
        publication: detectionStore,
        getCurrent: () => {
          const { config, projectDir } = configStore.get();
          if (config === null) return null;
          return { config, projectDir };
        },
      });
    },
    refreshProjectFiles: projectFilesStore.requestRefresh,
    listSkills,
    toggleSkill,
    refreshSkills,
    resumeRun: () => requestResume(plainUserMessage('')),
    steerRun: (text) => {
      const submission = prepareDraftSubmission(createDraftDocument(text), {
        projectDir,
        supportsImages: plannerSupportsImages(configStore.get().config, modelCacheStore),
      });
      if (!submission.ok) return formatSubmissionFailure(submission);
      attachmentsStore.replacePendingImages(submission.message.images);
      return requestSteer(submission.message);
    },
    endRun: requestEndRun,
    getQueueCopy: currentQueueCopy,
    clearQueue: workflow.requestClearQueue,
    insertImage: insertImageIntoComposer,
    attachImage,
    plannerSupportsImages: () => plannerSupportsImages(configStore.get().config, modelCacheStore),
    detachImage,
    listAttachments,
    acceptRun: (projectDir, sessionId, confirm) =>
      acceptRun(projectDir, sessionId, confirm, readLoadedConfig),
    rejectRun,
    refreshRun: () => {
      const route = routerStore.get();
      if (route.screen !== 'workflow') return;
      routerStore.updateRun({ run: readRunRecord(route.run.ref, configStore.reviewNone()) });
    },
    scrollConversation: (target) => scrollConversation(target, workflow.readScrollMetrics),
    toggleLatestActivityBatch: () => toggleLatestActivityBatch(workflow.getRowActions),
    listBriefs: () => runViewStore.get().briefs.tasks.map(({ id, status }) => ({ id, status })),
    copyTarget: (target) => copyTarget(target, workflow.resolveCopyValue),
    toggleSidebar: () => {
      // The layout owns the breakpoint: at exactly 120 columns `isSmall` is false while
      // `getWorkflowSidebarWidth` is 0, so only the layout can say whether a column will paint.
      const { cols } = terminalSizeStore.get();
      if (getWorkflowSidebarWidth({ cols, sidebarVisible: true }) === 0) {
        return { status: 'unavailable', message: 'Sidebar is hidden on small terminals.' };
      }
      controlsStore.toggleSidebar();
      const visible = controlsStore.get().sidebarVisible;
      if (projectDir) {
        writeUiPrefs(projectDir, { sidebarVisible: visible });
      }
      return { status: 'toggled', visible };
    },
  });
}

export function useRuntimeCommands({
  exit,
  phase,
  createContext,
}: {
  exit: () => void;
  phase: Phase;
  /** A supplied context replaces the production one outright; the registry is unchanged. */
  createContext?: (() => RuntimeCommandContext) | undefined;
}) {
  const ctx =
    createContext === undefined
      ? buildCommandContext({
          exit,
          workflow: {
            requestClearQueue,
            getRowActions: readConversationRowActions,
            readScrollMetrics: readConversationScrollSnapshot,
            resolveCopyValue,
          },
        })
      : createContext();
  // The command list embeds the skill id set as `/skills`'s closed options, so it has to be
  // rebuilt whenever that store changes.
  skillsStore.use((s) => s);
  const commands = createRuntimeCommands(ctx);
  const runtimeChainRef = useRef(Promise.resolve());
  // A typed line left its field at submit: the composer, or the answer field of a question. A
  // refusal gives it back to that field, unless the user typed there again in the meantime. A
  // command that a menu row sent was never in a field.
  const handleRuntimeCommand = (raw: string, from: Screen, sentBy?: 'row' | 'answer') => {
    const config = configStore.get().config;
    runtimeChainRef.current = runtimeChainRef.current.then(() => {
      const applyBefore = activeApply();
      const command = executeRuntimeCommand(commands, raw, {
        screen: from,
        phase,
        plannerSupportsImages: plannerSupportsImages(config, modelCacheStore),
        openRunAtRest: isOpenRunAtRest(routerStore.get()),
        applyUnfinished: isApplyUnfinishedAtRest(routerStore.get()),
        applying: applyBefore !== undefined,
        onError: (message, line, outcome) => {
          const show = outcome === 'failed' ? feedbackStore.setError : feedbackStore.setWarning;
          if (sentBy === 'answer') {
            const { drafts, index } = questionPromptStore.get();
            if (drafts[index]?.text === '') questionPromptStore.setFocus('answer', line);
          } else if (sentBy !== 'row' && composerLiveStore.get().empty) {
            const previous = feedbackStore.get();
            composerDraftStore.requestPrepend(createDraftDocument(line), () => {
              if (feedbackStore.get() === previous) show(message);
            });
            return;
          }
          show(message);
        },
      });
      // A command that started an Apply reports it when Apply settles; the next command runs now.
      return activeApply() === applyBefore ? command : undefined;
    });
  };
  return {
    commands,
    handleRuntimeCommand,
  };
}
