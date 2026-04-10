import { createStore, storeBase } from './create-store.js';
import { loadConfig, writeConfig } from '../core/config/index.js';
import { feedbackStore } from './feedback.js';
import { toErrorMessage } from '../utils/format.js';
import { WORKFLOW_MODES } from '../types.js';
import { buildPlannerConfig } from '../core/config/planner-config.js';
import { PROVIDER_IDS } from '../core/providers/catalog.js';
import type { Config, PlannerConfig } from '../types.js';
import { includes } from '../utils/type-guards.js';

interface CLIOverrides {
  planner?: { tool?: string | undefined; model?: string | undefined; command?: string | undefined };
  implementer?: { tool?: string | undefined; model?: string | undefined; command?: string | undefined };
  contextLength?: number | undefined;
  autoApprove?: boolean | undefined;
  mode?: string | undefined;
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

function applyPlannerOverrides(existing: PlannerConfig, override: { tool?: string; model?: string; command?: string }): PlannerConfig {
  const { tool, model, command } = override;

  if (tool !== undefined) {
    if (!includes(PROVIDER_IDS, tool)) {
      throw new Error(`Invalid planner tool: ${tool}. Must be one of: ${PROVIDER_IDS.join(', ')}`);
    }
    const next = buildPlannerConfig(tool, { model, existing });
    if (command !== undefined && next.kind === 'shell') {
      return { ...next, command };
    }
    return next;
  }

  if (command !== undefined) {
    // command-only override implies shell kind.
    return { kind: 'shell', command, ...(model !== undefined && { model }) };
  }

  if (model !== undefined) {
    return { ...existing, model };
  }

  return existing;
}

function load(projectDir: string, overrides: CLIOverrides = {}) {
  const cfg = structuredClone(loadConfig(projectDir));
  if (overrides.contextLength !== undefined) cfg.implementer.contextLength = overrides.contextLength;
  if (overrides.planner) {
    cfg.planner = applyPlannerOverrides(cfg.planner, {
      ...(overrides.planner.tool !== undefined && { tool: overrides.planner.tool }),
      ...(overrides.planner.model !== undefined && { model: overrides.planner.model }),
      ...(overrides.planner.command !== undefined && { command: overrides.planner.command }),
    });
  }
  if (overrides.implementer?.tool !== undefined) cfg.implementer.tool = overrides.implementer.tool;
  if (overrides.implementer?.model !== undefined) cfg.implementer.model = overrides.implementer.model;
  if (overrides.implementer?.command !== undefined) cfg.implementer.command = overrides.implementer.command;
  if (overrides.autoApprove !== undefined) {
    cfg.workflow.autoApproveSpec = overrides.autoApprove;
    cfg.workflow.autoApprovePlan = overrides.autoApprove;
  }
  if (overrides.mode !== undefined) {
    if (!includes(WORKFLOW_MODES, overrides.mode)) {
      throw new Error(`Invalid workflow mode: ${overrides.mode}. Must be: ${WORKFLOW_MODES.join(', ')}`);
    }
    cfg.workflow.mode = overrides.mode;
  }
  store.set({ config: cfg, projectDir, overrides });
}

function reload() {
  const { projectDir, overrides } = store.get();
  load(projectDir, overrides);
}

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

export const configStore = { ...storeBase(store), load, reload, save, useConfig };
