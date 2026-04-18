import { configStore } from '../stores/project/config.js';
import { sessionsStore } from '../stores/project/sessions.js';
import { skillsStore } from '../stores/project/skills.js';
import { installHistoryPersistence } from '../stores/ui/persistence.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { setHighlightTheme } from '../lib/highlight.js';
import { warnError } from '../lib/warn.js';
import { detectCapabilities } from '../engine/providers/registry.js';
import { detectAll } from '../engine/detection/detect.js';
import { loadDetectionIntoStores } from '../engine/detection/adapter.js';
import { fetchModelsDevCatalog } from '../engine/providers/models-dev.js';
import { discoverAllCliTools } from '../engine/providers/discovery.js';
import type { WorkflowOpts } from '../core/types/config-options.js';
import { cliError } from './errors.js';
import { getPlannerToolId } from '../core/config/accessors/runner-config.js';

export async function initStores(projectDir: string, opts: WorkflowOpts = {}): Promise<void> {
  initUIChrome();
  loadProjectState(projectDir, opts);
  await loadDiscovery(projectDir);
}

function initUIChrome(): void {
  terminalSizeStore.subscribeToResize();
}

function loadProjectState(projectDir: string, opts: WorkflowOpts): void {
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
    mode: opts.mode,
    budget: opts.budget,
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
    skillsStore.discover(getPlannerToolId(storeConfig.planner), projectDir),
    loadDetectionIntoStores({ detectAll, fetchModelsDevCatalog, discoverAllCliTools }, projectDir),
  ]);
}
