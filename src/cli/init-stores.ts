import { configStore } from '../stores/project/config.js';
import { sessionsStore } from '../stores/project/sessions.js';
import { skillsStore } from '../stores/project/skills.js';
import { installHistoryPersistence } from '../stores/ui/persistence.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { setHighlightTheme } from '../lib/highlight.js';
import { warnError, warnStderr } from '../lib/warn.js';
import { detectCapabilities } from '../engine/providers/registry.js';
import { detectAll } from '../engine/detection/detect.js';
import { loadDetectionIntoStores } from '../stores/discovery/detection-adapter.js';
import { fetchModelsDevCatalog } from '../engine/providers/models-dev.js';
import { discoverAllCliTools } from '../engine/providers/discovery.js';
import { discoverSkills } from '../engine/skill-discovery.js';
import type { WorkflowOpts } from '../core/types/config-options.js';
import { cliError } from './errors.js';
import { getPlannerToolId } from '../core/config/accessors/runner-config.js';
import { ensureHooksTrusted } from './hook-trust-prompt.js';
import { normalizeLegacyMode } from '../core/schemas/enums.js';

export async function initStores(projectDir: string, opts: WorkflowOpts = {}): Promise<void> {
  initUIChrome();
  loadProjectState(projectDir, opts);
  const storeConfig = configStore.get().config;
  await ensureHooksTrusted({
    projectDir,
    hooks: storeConfig?.hooks,
    allowHooks: opts.allowHooks ?? false,
  });
  await loadDiscovery(projectDir);
}

function initUIChrome(): void {
  terminalSizeStore.subscribeToResize();
}

function loadProjectState(projectDir: string, opts: WorkflowOpts): void {
  const rawMode = opts.mode as string | undefined;
  if (rawMode === 'full' && process.env.DIPTYCH_QUIET !== '1') {
    warnStderr('--mode full is deprecated; use --mode speckit');
  }
  const normalizedMode = rawMode ? normalizeLegacyMode(rawMode) ?? undefined : undefined;
  configStore.load(projectDir, {
    planner: {
      tool: opts.planner,
      model: opts.plannerModel,
      command: opts.plannerCommand,
    },
    implementer: {
      tool: opts.implementer ?? opts.provider,
      model: opts.implementerModel ?? opts.model,
      command: opts.implementerCommand,
    },
    autoApprove: opts.auto,
    ...(opts.approve !== undefined ? { approve: opts.approve } : {}),
    mode: normalizedMode,
    budget: opts.budget,
    ...(opts.plannerEffort !== undefined ? { plannerEffort: opts.plannerEffort } : {}),
    yolo: opts.yolo,
  });
  const storeConfig = configStore.get().config;
  if (!storeConfig) throw cliError('configStore.load did not populate config');
  if (storeConfig.shikiTheme) setHighlightTheme(storeConfig.shikiTheme);
  sessionsStore.load(projectDir);
  installHistoryPersistence();
}

async function loadDiscovery(projectDir: string): Promise<void> {
  const storeConfig = configStore.get().config;
  if (!storeConfig) return;

  let contextLength: number | undefined;
  try {
    const caps = await detectCapabilities(storeConfig);
    if (caps.contextLength) {
      contextLength = caps.contextLength;
    }
  } catch (err) {
    warnError('Could not detect provider capabilities', err);
    feedbackStore.setMessage('Provider detection failed — using defaults');
  }

  if (contextLength !== undefined) {
    configStore.setContextLength(contextLength);
  }

  await Promise.all([
    discoverSkills(getPlannerToolId(storeConfig.planner), projectDir).then(skills => {
      skillsStore.setAvailable(skills);
    }),
    loadDetectionIntoStores({ detectAll, fetchModelsDevCatalog, discoverAllCliTools }, projectDir),
  ]);
}
