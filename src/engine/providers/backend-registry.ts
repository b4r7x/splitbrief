import type { PlannerDetection } from '../detection.js';
import type { ProviderDetection } from './types.js';
import { KNOWN_PLANNER_MODELS, KNOWN_IMPLEMENTER_MODELS, type KnownModel } from './known-models.js';
import { TOOL_NAMES, type ToolName } from '../implementers/tool.js';

export interface BackendOption {
  id: string;
  displayName: string;
  kind: 'cli' | 'api' | 'provider' | 'shell';
  available: boolean;
  badge: string;
  version?: string | null;
}

export interface ModelOption {
  id: string;
  isDefault?: boolean;
  isDetected?: boolean;
  isCustom?: boolean;
}

export const DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  aider: 'Aider',
  'agent-sdk': 'Agent SDK',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  'lm-studio': 'LM Studio',
  deepseek: 'DeepSeek',
  shell: 'Custom Shell',
};

export function getDisplayName(id: string): string {
  return DISPLAY_NAMES[id] ?? id;
}

function plannerBadge(d: PlannerDetection): string {
  if (d.type === 'shell') return 'Custom';
  if (d.type === 'provider') return 'Provider';
  return d.type === 'cli' ? 'CLI' : 'API';
}

export function buildPlannerOptions(detections: PlannerDetection[]): BackendOption[] {
  const items: BackendOption[] = [];

  const shell = detections.find(d => d.type === 'shell');
  if (shell) {
    items.push({
      id: 'shell',
      displayName: getDisplayName('shell'),
      kind: 'shell',
      available: true,
      badge: 'Custom',
    });
  }

  for (const d of detections.filter(d => d.type !== 'shell')) {
    items.push({
      id: d.tool,
      displayName: getDisplayName(d.tool),
      kind: d.type,
      available: d.available,
      badge: plannerBadge(d),
      version: d.version,
    });
  }

  // Sort: available first, unavailable last (stable sort preserves original order within groups)
  items.sort((a, b) => {
    if (a.available && !b.available) return -1;
    if (!a.available && b.available) return 1;
    return 0;
  });

  return items;
}

function implementerBadge(item: { kind: string; isLocal?: boolean }): string {
  if (item.kind === 'shell') return 'Custom';
  if (item.kind === 'tool') return 'CLI tool';
  return (item as { isLocal: boolean }).isLocal ? 'local, free' : 'remote';
}

export function buildImplementerOptions(detections: ProviderDetection[]): BackendOption[] {
  const items: BackendOption[] = [];

  items.push({
    id: 'shell',
    displayName: getDisplayName('shell'),
    kind: 'shell',
    available: true,
    badge: 'Custom',
  });

  for (const tool of TOOL_NAMES) {
    items.push({
      id: tool,
      displayName: getDisplayName(tool),
      kind: 'cli' as const,
      available: true,
      badge: 'CLI tool',
    });
  }

  for (const d of detections) {
    items.push({
      id: d.provider,
      displayName: getDisplayName(d.provider),
      kind: 'provider',
      available: d.available,
      badge: implementerBadge({ kind: 'provider', isLocal: d.isLocal }),
    });
  }

  const detectedNames = new Set(detections.map(d => d.provider));
  for (const provider of Object.keys(KNOWN_IMPLEMENTER_MODELS)) {
    if (!detectedNames.has(provider)) {
      const hasKey = provider === 'anthropic'
        ? !!process.env['ANTHROPIC_API_KEY']
        : provider === 'openrouter'
          ? !!process.env['OPENROUTER_API_KEY']
          : false;
      items.push({
        id: provider,
        displayName: getDisplayName(provider),
        kind: 'provider',
        available: hasKey,
        badge: 'remote',
      });
    }
  }

  // Sort: available first, unavailable last (stable sort preserves original order within groups)
  items.sort((a, b) => {
    if (a.available && !b.available) return -1;
    if (!a.available && b.available) return 1;
    return 0;
  });

  return items;
}

function knownToModelOptions(models: KnownModel[], isDetected = false): ModelOption[] {
  return models.map(m => ({
    id: m.name,
    isDefault: m.isDefault,
    isDetected,
  }));
}

export function modelsForPlannerBackend(backendId: string): ModelOption[] {
  return knownToModelOptions(KNOWN_PLANNER_MODELS[backendId] ?? []);
}

export function modelsForImplementerBackend(
  detections: ProviderDetection[],
  backendId: string,
  backendKind: BackendOption['kind'],
): ModelOption[] {
  if (backendKind === 'cli') {
    // CLI tool implementers (claude-code, codex, etc.) share the same model
    // catalog as planners — they invoke the same underlying CLI binary.
    return knownToModelOptions(KNOWN_PLANNER_MODELS[backendId] ?? []);
  }

  if (backendKind === 'shell') return [];

  const d = detections.find(det => det.provider === backendId);
  const detected = (d?.models ?? []).map(m => ({ id: m, isDetected: true }));
  const known = knownToModelOptions(KNOWN_IMPLEMENTER_MODELS[backendId] ?? []);

  if (detected.length === 0) return known;

  const detectedSet = new Set(detected.map(m => m.id));
  const merged: ModelOption[] = [...detected];
  for (const k of known) {
    if (!detectedSet.has(k.id)) merged.push(k);
  }
  return merged;
}
