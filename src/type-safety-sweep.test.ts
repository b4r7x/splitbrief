import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// Tree walkers
// ---------------------------------------------------------------------------

function walkSrc(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkSrc(full, results);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

function walkTestFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTestFiles(full, results);
    } else if (/\.test\.(ts|tsx)$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

// Sanctioned boundary files — assertions are allowed there by project convention.
// Also includes this file itself to avoid self-scanning false positives.
const SANCTIONED: readonly string[] = [
  'src/utils/type-guards.ts',
  'src/stores/create-store.ts',
  'src/stores/use-stores.ts',
  'src/core/types/workflow.ts',
  'src/core/types/schemas/task.ts',
  'src/type-safety-sweep.test.ts',
];

function isSanctioned(rel: string): boolean {
  return SANCTIONED.some((s) => rel === s || rel.endsWith(`/${s}`));
}

// ---------------------------------------------------------------------------
// Allowlist — irreducible casts/assertions at boundary / interop sites.
// Each entry is { file, line } where `line` is the trimmed source line.
// These are the ONLY casts permitted outside the sanctioned files.
// ---------------------------------------------------------------------------

type Allowance = { file: string; lineSubstring: string };

// `as <UpperCase>` casts that are irreducible at their respective boundaries:
const AS_CAST_ALLOWLIST: readonly Allowance[] = [
  // Config defaults merging — double-cast through unknown is the only way to
  // convert a typed Config into Record<string,unknown> for the merge helper.
  { file: 'src/core/config/loading.ts', lineSubstring: 'defaults.implementer as unknown as Record<string, unknown>' },

  // JSON.parse boundaries — result is unknown, narrowing via narrowRecord
  // happens immediately after; no stronger static type is available.
  { file: 'src/core/sessions/log-reader.ts', lineSubstring: 'yield parsed as SessionLogEntry' },
  { file: 'src/cli/commands/migrate.ts', lineSubstring: 'JSON.parse(trimmed) as Record<string, unknown>' },
  { file: 'src/cli/commands/migrate.ts', lineSubstring: 'JSON.parse(stateRaw) as Record<string, unknown>' },

  // bridgeTty — PassThrough cast to NodeJS.ReadStream for Ink stdin interop;
  // no stronger static type is available from the Node.js stream types.
  { file: 'src/utils/mouse.ts', lineSubstring: 'return filtered as unknown as NodeJS.ReadStream' },

  // CliError — custom error with dynamic property; cast is in the factory and
  // the type guard, both within the same 12-line module.
  { file: 'src/cli/errors.ts', lineSubstring: 'new Error(message) as CliError' },
  { file: 'src/cli/errors.ts', lineSubstring: '(err as unknown as Record<string, unknown>)' },

  // Ink stdin interop — filteredStdin.stdin is typed as Readable; Ink expects
  // NodeJS.ReadStream at the render boundary.
  { file: 'src/cli/render.ts', lineSubstring: 'filteredStdin?.stdin as NodeJS.ReadStream | undefined' },

  // RENDERERS lookup — TypeScript cannot narrow RENDERERS[event.type] to the
  // per-key EventRenderer<K> without a cast because the map type is
  // { [K in TuiEvent["type"]]: EventRenderer<K> } and event.type is a union.
  { file: 'src/components/event-cards/index.tsx', lineSubstring: 'RENDERERS[event.type] as EventRenderer<typeof event.type>' },

  // PlannerConfig omitModel — discriminated union spread; cast is documented
  // inline in the function comment.
  { file: 'src/components/overlays/tool-model-picker/config-transforms.ts', lineSubstring: 'planner as Record<string, unknown>' },
  { file: 'src/components/overlays/tool-model-picker/config-transforms.ts', lineSubstring: '} as PlannerConfig' },

  // Detection catch fallback — {} typed as Partial<Record<...>> for the
  // Promise.all destructure; no runtime data flows through this value.
  { file: 'src/engine/detection/service.ts', lineSubstring: '{} as Partial<Record<CliToolId, DetectedModel[]>>' },

  // anthropic-stream getEventType — casting a string proven to be in the
  // ANTHROPIC_EVENT_TYPES array back to the AnthropicEventType union after the
  // array membership check. This is the narrowing pattern used instead of
  // a series of if-else branches.
  { file: 'src/engine/streaming/anthropic-stream.ts', lineSubstring: '(t as AnthropicEventType)' },

  // findLatestEventByType — generic reverse-scan helper; TypeScript cannot
  // narrow `e` to `Extract<TuiEvent, { type: T }>` from a generic type
  // parameter check alone. Sanctioned boundary pattern.
  { file: 'src/core/event-sections.ts', lineSubstring: 'return e as Extract<TuiEvent, { type: T }>' },

  // renderable-conversation HEIGHT_RULES — per-type height functions receive
  // TuiEvent (the union) and cast to the specific variant. Pattern mirrors
  // event-sections.ts; TypeScript cannot narrow through a Record<type, fn> dispatch.
  { file: 'src/core/renderable-conversation.ts', lineSubstring: "(e as Extract<TuiEvent, { type: 'planner-text' }>)" },
  { file: 'src/core/renderable-conversation.ts', lineSubstring: "e as Extract<TuiEvent, { type: 'implementer-generate-done' }>" },
  { file: 'src/core/renderable-conversation.ts', lineSubstring: "e as Extract<TuiEvent, { type: 'validate' }>" },
  { file: 'src/core/renderable-conversation.ts', lineSubstring: "e as Extract<TuiEvent, { type: 'escalate' }>" },
  { file: 'src/core/renderable-conversation.ts', lineSubstring: "(e as Extract<TuiEvent, { type: 'warning' }>)" },
  { file: 'src/core/renderable-conversation.ts', lineSubstring: "(e as Extract<TuiEvent, { type: 'error' }>)" },
  { file: 'src/core/renderable-conversation.ts', lineSubstring: "(e as Extract<TuiEvent, { type: 'user-message' }>)" },

  // detection cache Zod transforms — stripUndefined returns the same object
  // with undefined keys removed; cast restores the precise type after the
  // transform (Zod infers the return as the full shape including optionals).
  { file: 'src/engine/detection/cache.ts', lineSubstring: 'stripUndefined(m) as DetectedModel' },
  { file: 'src/engine/detection/cache.ts', lineSubstring: 'stripUndefined(p) as PlannerDetection' },
  { file: 'src/engine/detection/cache.ts', lineSubstring: 'stripUndefined(p) as ProviderDetection' },

  // mouse-scroll test stub — process.stdin is Readable; FilteredStdin.stdin requires
  // NodeJS.ReadStream. Interop boundary in test-only code, no runtime impact.
  { file: 'src/cli/mouse-scroll.test.ts', lineSubstring: 'process.stdin as unknown as NodeJS.ReadStream' },
];

// ---------------------------------------------------------------------------
// Test-file allowlists — pre-existing casts/assertions in test files that
// cannot be fixed without modifying those files. Grouped by file.
// New test code must NOT add entries here; use vi.mocked() and typed factories.
// ---------------------------------------------------------------------------

// Pre-existing `as <UpperCase>` casts in test files (deduplicated by substring).
const TEST_AS_CAST_ALLOWLIST: readonly Allowance[] = [
  // migrate.test.ts — JSON.parse result used as Record for shape assertions;
  // mirroring the production boundary pattern in migrate.ts itself.
  { file: 'src/cli/commands/migrate.test.ts', lineSubstring: 'const line0 = JSON.parse(lines[0]!) as Record<string, unknown>;' },
  { file: 'src/cli/commands/migrate.test.ts', lineSubstring: 'const line1 = JSON.parse(lines[1]!) as Record<string, unknown>;' },

  // sessions-picker.test.tsx — PassThrough cast to NodeJS stream types for Ink test harness.
  { file: 'src/components/overlays/sessions-picker/sessions-picker.test.tsx', lineSubstring: 'stdout: new PassThrough() as unknown as NodeJS.WriteStream,' },
  { file: 'src/components/overlays/sessions-picker/sessions-picker.test.tsx', lineSubstring: 'stdin: new PassThrough() as unknown as NodeJS.ReadStream,' },
  { file: 'src/components/overlays/sessions-picker/sessions-picker.test.tsx', lineSubstring: 'stderr: new PassThrough() as unknown as NodeJS.WriteStream,' },

  // use-stores.test.tsx — same Ink test harness pattern; PassThrough cast to NodeJS stream types.
  { file: 'src/stores/use-stores.test.tsx', lineSubstring: 'stdout: new PassThrough() as unknown as NodeJS.WriteStream,' },
  { file: 'src/stores/use-stores.test.tsx', lineSubstring: 'stdin: new PassThrough() as unknown as NodeJS.ReadStream,' },
  { file: 'src/stores/use-stores.test.tsx', lineSubstring: 'stderr: new PassThrough() as unknown as NodeJS.WriteStream,' },

  // access.test.ts — discriminated union inspection via Record for fields not
  // statically exposed on the common type.
  { file: 'src/core/config/access.test.ts', lineSubstring: "expect((updated.planner as Record<string, unknown>).outputFormat).toBe('stream-json');" },

  // loading.test.ts — inspecting implementer fields not in the shared base type.
  { file: 'src/core/config/loading.test.ts', lineSubstring: 'expect((config.implementer as Record<string, unknown>).provider).toBeUndefined();' },
  { file: 'src/core/config/loading.test.ts', lineSubstring: 'expect((config.implementer as Record<string, unknown>).apiBase).toBeUndefined();' },
  { file: 'src/core/config/loading.test.ts', lineSubstring: 'expect((config.implementer as Record<string, unknown>).contextLength).toBe(32768);' },
  { file: 'src/core/config/loading.test.ts', lineSubstring: 'expect((config.implementer as Record<string, unknown>).temperature).toBe(0.3);' },
  { file: 'src/core/config/loading.test.ts', lineSubstring: 'const workflow = result.workflow as Record<string, unknown>;' },

  // migration.test.ts — migrateConfig returns unknown-shaped Config; tests
  // cast to concrete subtypes to verify discriminated-union fields.
  { file: 'src/core/config/migration.test.ts', lineSubstring: 'const result = migrateConfig(noVersion) as Record<string, unknown>;' },
  { file: 'src/core/config/migration.test.ts', lineSubstring: 'const result = migrateConfig(v1) as Record<string, unknown>;' },
  { file: 'src/core/config/migration.test.ts', lineSubstring: 'const result = migrateConfig({ planner: null, implementer: { kind: \'api\' } }) as Record<string, unknown>;' },
  { file: 'src/core/config/migration.test.ts', lineSubstring: 'const planner = result.planner as CliPlannerConfig;' },
  { file: 'src/core/config/migration.test.ts', lineSubstring: 'const planner = result.planner as AgentSdkPlannerConfig;' },
  { file: 'src/core/config/migration.test.ts', lineSubstring: 'const planner = result.planner as ApiPlannerConfig;' },
  { file: 'src/core/config/migration.test.ts', lineSubstring: 'const planner = result.planner as Record<string, unknown>;' },
  { file: 'src/core/config/migration.test.ts', lineSubstring: 'const impl = result.implementer as ApiImplementerConfig;' },
  { file: 'src/core/config/migration.test.ts', lineSubstring: 'const impl = result.implementer as ShellImplementerConfig;' },
  { file: 'src/core/config/migration.test.ts', lineSubstring: 'const impl = result.implementer as AgentImplementerConfig;' },
  { file: 'src/core/config/migration.test.ts', lineSubstring: 'const impl = result.implementer as Record<string, unknown>;' },

  // event-sections.test.ts — Extract<Section, ...> casts for narrowing union
  // after filtering; same structural reason as production event-sections.ts.
  { file: 'src/core/event-sections.test.ts', lineSubstring: "expect((sections[0] as Extract<Section, { type: 'events' }>).items).toHaveLength(2);" },
  { file: 'src/core/event-sections.test.ts', lineSubstring: "const summary = (sections[0] as Extract<Section, { type: 'completed-task' }>).summary;" },
  { file: 'src/core/event-sections.test.ts', lineSubstring: "expect((sections[0] as Extract<Section, { type: 'active-task' }>).items).toHaveLength(2);" },

  // id.test.ts — "as YYYY-MM-DD" appears in a test description string, not a cast.
  { file: 'src/core/sessions/id.test.ts', lineSubstring: "it('formats date as YYYY-MM-DD with feature slug', () => {" },

  // implementer-config.test.ts — casting Zod parse result to concrete subtype.
  { file: 'src/core/types/schemas/implementer-config.test.ts', lineSubstring: '}) as CliImplementerConfig;' },
  { file: 'src/core/types/schemas/implementer-config.test.ts', lineSubstring: '}) as ApiImplementerConfig;' },

  // events.test.ts — inspecting dynamic event fields via Record.
  { file: 'src/engine/orchestrator/events.test.ts', lineSubstring: "expect((events[0] as Record<string, unknown>)['error']).toBeUndefined();" },
  { file: 'src/engine/orchestrator/events.test.ts', lineSubstring: 'const e = events[0] as Record<string, unknown>;' },

  // api.test.ts — server.address() returns AddressInfo | string | null.
  { file: 'src/engine/planners/api.test.ts', lineSubstring: 'port = (server.address() as AddressInfo).port;' },

  // registry.test.ts — partial Config literal cast for test fixtures.
  { file: 'src/engine/providers/registry.test.ts', lineSubstring: '} as Config;' },

  // use-filterable-list.test.ts — dynamic key write into merged object.
  { file: 'src/hooks/use-filterable-list.test.ts', lineSubstring: 'if (v !== undefined) (merged as Record<string, boolean>)[k] = v;' },

  // use-workflow-review-input.test.ts — mock hook return typed as unknown to
  // simulate different input modes; `as unknown as UseInputModeResult` is the
  // only pattern available when mocking a hook with multiple discriminated shapes.
  { file: 'src/hooks/use-workflow-review-input.test.ts', lineSubstring: "if (mode === 'review') return { mode, resolve } as unknown as UseInputModeResult;" },
  { file: 'src/hooks/use-workflow-review-input.test.ts', lineSubstring: "if (mode === 'question') return { mode, resolve } as unknown as UseInputModeResult;" },
  { file: 'src/hooks/use-workflow-review-input.test.ts', lineSubstring: "return { mode: 'normal' } as unknown as UseInputModeResult;" },

  // skills.test.ts — 'claude-code' string cast to branded PlannerTool.
  { file: 'src/stores/skills.test.ts', lineSubstring: "await skillsStore.discover(discoverSkillsMock, 'claude-code' as PlannerTool, '/tmp/proj');" },
  { file: 'src/stores/skills.test.ts', lineSubstring: "await skillsStore.discover(discoverSkillsMock, 'claude-code' as PlannerTool, '/tmp');" },

  // config.test.ts — `as any` for accessing dynamic implementer fields not in base type.
  { file: 'src/stores/config.test.ts', lineSubstring: "expect((configStore.get().config!.implementer as any).provider).toBe('ollama');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect((configStore.get().config!.implementer as any).provider).toBe('deepseek');" },

  // ollama integration test — Buffer typed as Uint8Array for TextDecoder interop.
  { file: 'testing/integration/ollama.integration.test.ts', lineSubstring: 'const text = decoder.decode(raw as Uint8Array, { stream: true });' },
];

// Pre-existing `!.` non-null assertions in test files.
const TEST_NON_NULL_ALLOWLIST: readonly Allowance[] = [
  // event-sections.test.ts — array index access where test data guarantees presence.
  { file: 'src/core/event-sections.test.ts', lineSubstring: "expect(sections[0]!.type).toBe('events');" },
  { file: 'src/core/event-sections.test.ts', lineSubstring: "expect(sections[0]!.type).toBe('completed-task');" },
  { file: 'src/core/event-sections.test.ts', lineSubstring: "expect(sections[0]!.type).toBe('active-task');" },
  { file: 'src/core/event-sections.test.ts', lineSubstring: "expect(sections[1]!.type).toBe('completed-task');" },
  { file: 'src/core/event-sections.test.ts', lineSubstring: "expect(sections[2]!.type).toBe('events');" },
  { file: 'src/core/event-sections.test.ts', lineSubstring: "expect(sections[3]!.type).toBe('completed-task');" },

  // analytics.test.ts — known key access on providerTotals record.
  { file: 'src/core/sessions/analytics.test.ts', lineSubstring: "expect(result.providerTotals['claude-code']!.sessions).toBe(2);" },
  { file: 'src/core/sessions/analytics.test.ts', lineSubstring: "expect(result.providerTotals['claude-code']!.cost).toBeCloseTo(1.89);" },

  // machine.test.ts — tasks[i]!.id where test data guarantees the index exists.
  { file: 'src/core/state/machine.test.ts', lineSubstring: "const next = transition(state, { type: 'START_TASK', taskId: tasks[0]!.id });" },
  { file: 'src/core/state/machine.test.ts', lineSubstring: "const next = transition(state, { type: 'RESET_TASK', taskId: tasks[1]!.id });" },
  { file: 'src/core/state/machine.test.ts', lineSubstring: "const next = transition(state, { type: 'RESET_TASK', taskId: tasks[0]!.id });" },

  // persistence.test.ts — loaded! after a write+read cycle; null is impossible in practice.
  { file: 'src/core/state/persistence.test.ts', lineSubstring: "expect(loaded!.plannerTool).toBe('openrouter');" },
  { file: 'src/core/state/persistence.test.ts', lineSubstring: "expect(loaded!.plannerModel).toBe('claude-sonnet-4-20250514');" },
  { file: 'src/core/state/persistence.test.ts', lineSubstring: "expect(loaded!.implementerTool).toBe('ollama');" },
  { file: 'src/core/state/persistence.test.ts', lineSubstring: "expect(loaded!.implementerModel).toBe('qwen2.5-coder:14b');" },

  // cli-tools.test.ts — planner!/implementer! on known tool definitions.
  { file: 'src/engine/cli-tools.test.ts', lineSubstring: "const args = tool.planner!.buildArgs({ prompt: 'test prompt', model: undefined, projectDir: '/tmp', mode: 'plan' });" },
  { file: 'src/engine/cli-tools.test.ts', lineSubstring: "const args = tool.planner!.buildArgs({ prompt: 'test', model: 'gpt-5.2', projectDir: '/tmp', mode: 'plan' });" },
  { file: 'src/engine/cli-tools.test.ts', lineSubstring: "const args = tool.planner!.buildArgs({ prompt: 'test', model: undefined, projectDir: '/tmp', mode: 'plan' });" },
  { file: 'src/engine/cli-tools.test.ts', lineSubstring: "const args = tool.implementer!.buildArgs({ prompt: 'implement this', model: undefined });" },
  { file: 'src/engine/cli-tools.test.ts', lineSubstring: "const args = tool.implementer!.buildArgs({ prompt: 'test', model: 'claude-sonnet-4-6' });" },
  { file: 'src/engine/cli-tools.test.ts', lineSubstring: "const args = tool.planner!.buildArgs({ prompt: 'plan this', model: undefined, projectDir: '/tmp', mode: 'plan' });" },
  { file: 'src/engine/cli-tools.test.ts', lineSubstring: "const args = tool.planner!.buildArgs({ prompt: 'test', model: 'claude-sonnet-4-6', projectDir: '/tmp', mode: 'plan' });" },
  { file: 'src/engine/cli-tools.test.ts', lineSubstring: "const args = tool.implementer!.buildArgs({ prompt: 'do this', model: undefined });" },
  { file: 'src/engine/cli-tools.test.ts', lineSubstring: "const args = tool.implementer!.buildArgs({ prompt: 'test', model: 'qwen2.5-coder:7b' });" },
  { file: 'src/engine/cli-tools.test.ts', lineSubstring: "expect(tool.planner!.isAvailableOpts?.timeout).toBe(5000);" },

  // clarifications.test.ts — known index after pushing a message.
  { file: 'src/engine/orchestrator/clarifications.test.ts', lineSubstring: "expect(resultState.messageQueue[0]!.origin).toBe('clarification');" },

  // summary.test.ts — optional fields that are present after a full workflow run.
  { file: 'src/engine/orchestrator/summary.test.ts', lineSubstring: "expect(Number.isFinite(summary.costBreakdown!.savingsPercentage)).toBe(true);" },
  { file: 'src/engine/orchestrator/summary.test.ts', lineSubstring: "expect(summary.taskBreakdown![0]!.cost).toBeDefined();" },
  { file: 'src/engine/orchestrator/summary.test.ts', lineSubstring: "expect(summary.taskBreakdown![1]!.cost).toBeDefined();" },
  { file: 'src/engine/orchestrator/summary.test.ts', lineSubstring: "expect(summary.taskBreakdown![0]!.cost! + summary.taskBreakdown![1]!.cost!).toBeCloseTo(" },
  { file: 'src/engine/orchestrator/summary.test.ts', lineSubstring: "summary.costBreakdown!.actualImplementerCost," },
  { file: 'src/engine/orchestrator/summary.test.ts', lineSubstring: "expect(summary.taskBreakdown![0]!.cost).toBe(0);" },

  // scope-extractor.test.ts — result! after calling extractor on known input.
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.targetFunction).toContain('export function foo()');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.imports).toContain('import { join }');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.otherExports).toContain('other');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.targetFunction).toContain('export const bar');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.targetFunction).toContain('export async function baz');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.targetFunction).toContain('export interface Config');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.otherExports).toContain('create');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.targetFunction).toContain('export type Status');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.targetFunction).toContain('export class MyClass');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.otherExports).toContain('helper');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.imports).toContain('import { join } from \"node:path\"');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.imports).toContain('import fs from \"node:fs\"');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.targetFunction).toContain('// some note');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.otherExports.sort()).toEqual(['Delta', 'Epsilon', 'Gamma', 'alpha'].sort());" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.targetFunction).toContain('export { name }');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.targetFunction).not.toContain('export function fooBar()');" },
  { file: 'src/engine/parsers/scope-extractor.test.ts', lineSubstring: "expect(result!.otherExports).toContain('fooBar');" },

  // base.test.ts — phases![0]!.text access on known planner result shape.
  { file: 'src/engine/planners/base.test.ts', lineSubstring: "expect(result.phases![0]!.text).toContain('id: t1');" },
  { file: 'src/engine/planners/base.test.ts', lineSubstring: "expect(result.phases![0]!.rawOutput).toBe('raw quick output');" },

  // config.test.ts — config! after a load that is guaranteed to succeed.
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(expectCli(configStore.get().config!.planner).tool).toBe('claude-code');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.implementer.model).toBe('qwen2.5-coder:7b');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect((configStore.get().config!.implementer as any).provider).toBe('ollama');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect((configStore.get().config!.implementer as any).provider).toBe('deepseek');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.implementer.model).toBe('deepseek-r1');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "const planner = expectCli(configStore.get().config!.planner);" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(expectShell(configStore.get().config!.planner).command).toBe('my-planner');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.implementer.contextLength).toBe(16384);" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.workflow.mode).toBe('full');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.workflow.maxBudget).toBe(10.5);" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.workflow.autoApproveSpec).toBe(true);" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.workflow.autoApprovePlan).toBe(true);" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.implementer.model).toBe('first');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.theme).toBe('mono');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.implementer.model).toBe('cli-override');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "const updated = { ...configStore.get().config!, implementer: { ...configStore.get().config!.implementer, model: 'picker-choice' } };" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.implementer.model).toBe('picker-choice');" },
  { file: 'src/stores/config.test.ts', lineSubstring: "expect(configStore.get().config!.implementer.model).toBe('cli-override');" },

  // workflow-reducers.test.ts — Map.get()! on keys the test just inserted.
  { file: 'src/stores/workflow-reducers.test.ts', lineSubstring: "expect(next.get('T001')!.status).toBe('done');" },
  { file: 'src/stores/workflow-reducers.test.ts', lineSubstring: "expect(next.get('T002')!.status).toBe('skipped');" },

  // workflow.test.ts — same pattern as workflow-reducers.test.ts.
  { file: 'src/stores/workflow.test.ts', lineSubstring: "expect(workflowStore.get().taskMap.get('T001')!.status).toBe('done');" },
  { file: 'src/stores/workflow.test.ts', lineSubstring: "expect(workflowStore.get().taskMap.get('T001')!.status).toBe('skipped');" },
];

function isAllowlisted(rel: string, trimmedLine: string, allowlist: readonly Allowance[]): boolean {
  return allowlist.some(
    (a) => rel === a.file && trimmedLine.includes(a.lineSubstring),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectOffenders(
  files: string[],
  pattern: RegExp,
  allowlist: readonly Allowance[],
): string[] {
  const offenders: string[] = [];
  for (const fullPath of files) {
    const rel = relative(ROOT, fullPath);
    if (isSanctioned(rel)) continue;
    const lines = readFileSync(fullPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (pattern.test(line)) {
        const trimmed = line.trim();
        if (!isAllowlisted(rel, trimmed, allowlist)) {
          offenders.push(`${rel}:${i + 1}: ${trimmed}`);
        }
      }
    }
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('type-safety sweep', () => {
  it('removes the targeted production non-null assertions', () => {
    expect(read('src/ui/input/text-editing.ts')).not.toMatch(/visualLines\[i\]!|lines\[i\]!/);
    expect(read('src/core/event-sections.ts')).not.toMatch(/events\[i\]!|taskRanges\[rangeIdx\]!/);
    expect(read('src/utils/frontmatter.ts')).not.toMatch(/lines\[i\]!|lines\[j\]!/);
    expect(read('src/core/viewport-trimming.ts')).not.toMatch(/sections\[i\]!/);
  });

  it('uses explicit exhaustive guards for the updated dispatchers', () => {
    expect(read('src/engine/streaming/output-parsers.ts')).toContain('assertNever(format)');
    expect(read('src/components/workflow/sidebar.tsx')).toContain('assertNever(status)');
    expect(read('src/components/event-cards/index.tsx')).toContain('assertNever(event)');
    expect(read('src/engine/streaming/anthropic-stream.ts')).toContain('assertNever(eventType)');
  });

  it('removes the unsafe event renderer cast', () => {
    expect(read('src/components/event-cards/index.tsx')).not.toContain(
      "const renderer = RENDERERS[event.type] as (e: TuiEvent, ctx: RenderCtx) => ReactNode;",
    );
  });

  it('tree-wide: no unapproved `as <UpperCase>` casts', () => {
    const srcDir = join(ROOT, 'src');
    const files = walkSrc(srcDir);
    // Matches `as UpperCaseLetter...` but NOT `as const` or `as unknown`
    // (unknown is a safe widening cast, not a narrowing assertion).
    const pattern = /\bas\s+[A-Z][A-Za-z]/;
    const offenders = collectOffenders(files, pattern, AS_CAST_ALLOWLIST);
    expect(offenders, `Unapproved unsafe casts found:\n${offenders.join('\n')}`).toHaveLength(0);
  });

  it('tree-wide: no non-null assertions (`!.`) outside sanctioned files', () => {
    const srcDir = join(ROOT, 'src');
    const files = walkSrc(srcDir);
    // Matches `!.` — non-null assertion followed by property access.
    const pattern = /!\./;
    // No non-null assertions exist outside sanctioned files, so no allowlist needed.
    const offenders = collectOffenders(files, pattern, []);
    expect(offenders, `Unapproved non-null assertions found:\n${offenders.join('\n')}`).toHaveLength(0);
  });

  it('test files: no unapproved `as <UpperCase>` casts', () => {
    const srcDir = join(ROOT, 'src');
    const testingDir = join(ROOT, 'testing');
    const files = [
      ...walkTestFiles(srcDir),
      ...walkTestFiles(testingDir),
    ];
    // Same pattern as production: `as UpperCaseLetter...` but NOT `as const` or `as unknown`.
    const pattern = /\bas\s+[A-Z][A-Za-z]/;
    // Merge the production allowlist (already covers some test-file paths like
    // mouse-scroll.test.ts) with the test-specific allowlist of pre-existing patterns.
    const allowlist = [...AS_CAST_ALLOWLIST, ...TEST_AS_CAST_ALLOWLIST];
    const offenders = collectOffenders(files, pattern, allowlist);
    expect(offenders, `Unapproved unsafe casts in test files:\n${offenders.join('\n')}`).toHaveLength(0);
  });

  it('test files: no non-null assertions (`!.`)', () => {
    const srcDir = join(ROOT, 'src');
    const testingDir = join(ROOT, 'testing');
    const files = [
      ...walkTestFiles(srcDir),
      ...walkTestFiles(testingDir),
    ];
    const pattern = /!\./;
    const offenders = collectOffenders(files, pattern, TEST_NON_NULL_ALLOWLIST);
    expect(offenders, `Non-null assertions in test files:\n${offenders.join('\n')}`).toHaveLength(0);
  });
});
