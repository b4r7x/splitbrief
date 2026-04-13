import { createStore, storeBase } from './create-store.js';
import { loadConfig, writeConfig, buildRunnerConfig, type BuildRunnerOpts } from '../core/config/index.js';
import { feedbackStore } from './feedback.js';
import { toErrorMessage } from '../utils/format.js';
import { WORKFLOW_MODES } from '../types.js';
import type { Config, PlannerConfig, ImplementerConfig } from '../types.js';
import { includes } from '../utils/type-guards.js';

interface CLIOverrides {
  planner?: { tool?: string | undefined; model?: string | undefined; command?: string | undefined };
  implementer?: { tool?: string | undefined; model?: string | undefined; command?: string | undefined };
  contextLength?: number | undefined;
  autoApprove?: boolean | undefined;
  mode?: string | undefined;
  budget?: number | undefined;
}

interface ConfigState {
  config: Config | null;
  projectDir: string;
  overrides: CLIOverrides;
}

const empty: ConfigState = {
  config: null,
  projectDir: '',
  overrides: {},
};

const store = createStore<ConfigState>(empty);

interface PlannerOverrides {
  tool?: string | undefined;
  model?: string | undefined;
  command?: string | undefined;
}

interface ImplementerOverrides {
  tool?: string | undefined;
  model?: string | undefined;
  command?: string | undefined;
  contextLength?: number | undefined;
}

// Extract the kind-identifying/transport fields from an existing runner config into BuildRunnerOpts.
// Generation params (model, contextLength, temperature, timeout, customModels) are inherited
// automatically by buildRunnerConfig via opts.existing — no need to forward them here.
function existingToOpts(existing: PlannerConfig | ImplementerConfig): BuildRunnerOpts {
  if (existing.kind === 'cli') {
    return { kind: 'cli', tool: existing.tool, ...('args' in existing && { args: existing.args }), ...('outputFormat' in existing && { outputFormat: existing.outputFormat }) };
  }
  if (existing.kind === 'api') {
    return { kind: 'api', tool: existing.provider, apiBase: existing.apiBase, ...('apiKey' in existing && { apiKey: existing.apiKey }) };
  }
  if (existing.kind === 'shell' || existing.kind === 'agent') {
    return { kind: existing.kind, command: existing.command, ...('args' in existing && { args: existing.args }), ...('outputFormat' in existing && { outputFormat: existing.outputFormat }) };
  }
  // agent-sdk
  return { kind: 'agent-sdk', ...('apiKey' in existing && { apiKey: existing.apiKey }) };
}

function applyPlannerOverrides(config: Config, overrides: PlannerOverrides): Config {
  const { tool, model, command } = overrides;
  if (tool === undefined && model === undefined && command === undefined) {
    return config;
  }

  // tool='shell' is a special sentinel meaning "switch to shell kind with the given command"
  // buildRunnerConfig does not treat 'shell' as a CLI tool id, so we map it to kind explicitly
  const opts: BuildRunnerOpts = {
    ...existingToOpts(config.planner),
    ...(tool === 'shell' ? { kind: 'shell' } : { tool }),
    ...(model !== undefined && { model }),
    ...(command !== undefined && { command }),
    existing: config.planner,
  };

  const newPlanner = buildRunnerConfig('planner', opts);
  return { ...config, planner: newPlanner };
}

function applyImplementerOverrides(config: Config, overrides: ImplementerOverrides): Config {
  const { tool, model, command, contextLength } = overrides;
  if (tool === undefined && model === undefined && command === undefined && contextLength === undefined) {
    return config;
  }

  const opts: BuildRunnerOpts = {
    ...existingToOpts(config.implementer),
    ...(tool === 'shell' ? { kind: 'shell' } : { tool }),
    ...(model !== undefined && { model }),
    ...(command !== undefined && { command }),
    ...(contextLength !== undefined && { contextLength }),
    existing: config.implementer,
  };

  const newImplementer = buildRunnerConfig('implementer', opts);
  return { ...config, implementer: newImplementer };
}

// load() throws on invalid config — startup error that must be fixed before
// the TUI can render. This is a programming/configuration error.
function load(projectDir: string, overrides: CLIOverrides = {}) {
  let config = structuredClone(loadConfig(projectDir));
  if (overrides.planner) {
    config = applyPlannerOverrides(config, {
      ...(overrides.planner.tool !== undefined && { tool: overrides.planner.tool }),
      ...(overrides.planner.model !== undefined && { model: overrides.planner.model }),
      ...(overrides.planner.command !== undefined && { command: overrides.planner.command }),
    });
  }
  if (overrides.implementer || overrides.contextLength !== undefined) {
    config = applyImplementerOverrides(config, {
      ...(overrides.contextLength !== undefined && { contextLength: overrides.contextLength }),
      ...(overrides.implementer?.tool !== undefined && { tool: overrides.implementer.tool }),
      ...(overrides.implementer?.model !== undefined && { model: overrides.implementer.model }),
      ...(overrides.implementer?.command !== undefined && { command: overrides.implementer.command }),
    });
  }
  if (overrides.autoApprove !== undefined) {
    config.workflow.autoApproveSpec = overrides.autoApprove;
    config.workflow.autoApprovePlan = overrides.autoApprove;
  }
  if (overrides.mode !== undefined) {
    if (!includes(WORKFLOW_MODES, overrides.mode)) {
      throw new Error(`Invalid workflow mode: ${overrides.mode}. Must be: ${WORKFLOW_MODES.join(', ')}`);
    }
    config.workflow.mode = overrides.mode;
  }
  if (overrides.budget !== undefined) {
    if (!Number.isFinite(overrides.budget) || overrides.budget <= 0) {
      throw new Error(`Invalid budget: ${overrides.budget}. Must be a positive number.`);
    }
    config.workflow.maxBudget = overrides.budget;
  }
  store.set({ config, projectDir, overrides });
}

function reload() {
  const { projectDir, overrides } = store.get();
  load(projectDir, overrides);
}

// save() uses feedbackStore for errors — runtime issue the user can address
// (e.g., disk full, permissions). The TUI continues running.
function save(updated: Config) {
  const { projectDir } = store.get();
  if (!projectDir) throw new Error('configStore.load must be called before save');
  try {
    writeConfig(projectDir, updated);
    store.set(s => ({ ...s, config: updated }));
  } catch (err) {
    feedbackStore.setError(`Failed to save config: ${toErrorMessage(err)}`);
  }
}

function useConfig(): Config {
  const config = store.use(s => s.config);
  if (!config) throw new Error('configStore.load must be called before rendering');
  return config;
}

function setContextLength(contextLength: number) {
  store.set(s => {
    if (!s.config) return s;
    if (s.config.implementer.contextLength === contextLength) return s;
    return {
      ...s,
      config: applyImplementerOverrides(s.config, { contextLength }),
    };
  });
}

export const configStore = { ...storeBase(store), load, reload, save, useConfig, setContextLength };
