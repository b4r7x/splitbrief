# Brief 05 — `--planner-effort` pass-through

> **You are a fresh AI context.** Read `../spec.md` §4.3 and `../decisions.md` ADR-008 before starting. Do NOT commit (see `../../../../CLAUDE.md`).

## Goal

Add a `--planner-effort <low|medium|high|xhigh>` CLI flag and a `planner.effort` config key. Plumb the value per backend: prompt-prefix injection for Claude Code CLI, `--reasoning-effort` argv for Codex, `thinking.budget_tokens` for Anthropic API, `reasoning_effort` body field for OpenAI-compat API, SDK option for Agent SDK. Unsupported backends no-op and log.

## Dependencies

- None strictly, but best sequenced after brief 01 so the config schema is at v3.

## Files to touch

Write-authoritative:

- `src/core/schemas/enums.ts` (add `EFFORT_LEVELS`)
- `src/core/schemas/config.ts` (add `planner.effort`)
- `src/core/schemas/runner-fields.ts`
- `src/core/config/runtime/resolve.ts` (add `resolveEffortLevel`)
- `src/core/config/runtime/overrides.ts`
- `src/core/settings/catalog.ts`
- `src/cli/options.ts`
- `src/cli/init-stores.ts`
- `src/engine/planners/types.ts` (add `supportsEffort` to `PlannerCapabilities`)
- `src/engine/planners/claude-code.ts`
- `src/engine/planners/cli.ts`
- `src/engine/planners/api.ts`
- `src/engine/planners/agent-sdk.ts`
- `src/engine/planners/command-invoke.ts` (for shell/agent capabilities override)
- `src/engine/planners/base.ts`
- `src/engine/claude-runner.ts`
- `src/engine/cli-tools.ts`
- `src/engine/providers/anthropic/stream.ts`
- `src/engine/providers/openai-stream.ts`
- `src/engine/events/types.ts`
- `src/features/workflow/components/input-footer.tsx` (effort badge)
- `src/core/slash-commands/catalog.ts` (add `/effort`)
- `docs/CONFIG.md`

## Step-by-step

### 1. Effort level enum

File: `src/core/schemas/enums.ts`

```ts
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export const EffortLevelSchema = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

/** Map an effort level to the Anthropic `thinking.budget_tokens` approximation. */
export function effortToAnthropicBudget(level: EffortLevel): number {
  return { low: 2_000, medium: 8_000, high: 24_000, xhigh: 48_000 }[level];
}
```

### 2. Schema additions

File: `src/core/schemas/runner-fields.ts`

Add `effort` to `CommonFields` (shared across all runner kinds for planners):

```ts
export const CommonFields = z.object({
  model: z.string().optional(),
  customModels: z.array(z.string()).optional(),
  contextLength: z.number().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeout: z.number().positive().optional(),
  effort: EffortLevelSchema.optional(),  // NEW
}).strict();
```

Note: `effort` on `ImplementerConfig` is accepted by the schema for symmetry but unused. We do not currently apply effort to implementers; documented in ADR-008.

### 3. Capability flag

File: `src/engine/planners/types.ts`

Extend `PlannerCapabilities`:

```ts
export type PlannerCapabilities = {
  supportsConversationalPlanning: boolean;
  supportsHintEscalation: boolean;
  supportsSessionResume: boolean;
  supportsEffort: boolean;           // NEW
  supportsImages: boolean;           // brief 06 adds, add here too for colocation
};
```

Touch every backend declaration (see explore-report §2 for locations):

| Backend | File:line | `supportsEffort` | `supportsImages` |
|---|---|:---:|:---:|
| claude-code | `planners/claude-code.ts:58` | true | true |
| codex | `planners/cli.ts:86` (codex variant) | true | false |
| opencode | `planners/cli.ts:86` (opencode variant) | false | false |
| aider | same | false | false |
| copilot | same | false | true (copilot Pro+ has vision) |
| kilo-code | same | false | false |
| api (anthropic) | `planners/api.ts:97` — dynamic based on model | computed | computed |
| api (openai-compat) | same | computed | computed |
| shell | `planners/command-invoke.ts:13-17` | config-override default false | config-override default false |
| agent | same | false | false |
| agent-sdk | `planners/agent-sdk.ts:48` | true | true |

The `api` kind needs dynamic capability based on the model. Add a helper `inferApiCapabilities(provider, model)` in `src/engine/providers/capability-inference.ts` (NEW):

```ts
import type { Provider } from './registry.js';

export function modelSupportsEffort(provider: Provider, model: string): boolean {
  // Anthropic: claude-opus-*, claude-sonnet-* (4.x+) support thinking.
  if (provider === 'anthropic') return /claude-(opus|sonnet)-4/i.test(model);
  // OpenAI reasoning models: o1*, o3*, o4-mini, o5 family.
  if (provider === 'openai' || provider === 'openrouter') return /^(o[1345]|gpt-[4-9])/.test(model);
  // DeepSeek: R1 series has reasoning.
  if (provider === 'deepseek') return /r1|reasoner/i.test(model);
  // Groq: no reasoning control today.
  if (provider === 'groq') return false;
  // Ollama / LM Studio: user runs whatever, no control.
  return false;
}

export function modelSupportsVision(provider: Provider, model: string): boolean {
  if (provider === 'anthropic') return /claude-(opus|sonnet)/i.test(model);
  if (provider === 'openai' || provider === 'openrouter') return /gpt-(4o|5)|vision/i.test(model);
  return false;
}
```

Use this in `src/engine/planners/api.ts` when building capabilities:

```ts
const effectiveModel = resolveEffectiveModel(config);
capabilities: {
  supportsConversationalPlanning: false,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsEffort: modelSupportsEffort(config.provider, effectiveModel),
  supportsImages: modelSupportsVision(config.provider, effectiveModel),
},
```

### 4. Resolve function

File: `src/core/config/runtime/resolve.ts`

Append:

```ts
import type { EffortLevel } from '../../schemas/enums.js';

export function resolveEffortLevel(opts: {
  config: Config;
  cliOverride?: EffortLevel;
}): EffortLevel | undefined {
  if (opts.cliOverride) return opts.cliOverride;
  return opts.config.planner.effort;
}
```

Test:

```ts
describe('resolveEffortLevel', () => {
  it('returns cli override when present', () => {
    expect(resolveEffortLevel({ config: baseConfig(), cliOverride: 'high' })).toBe('high');
  });
  it('returns config value when no override', () => {
    const c = baseConfig();
    c.planner.effort = 'medium';
    expect(resolveEffortLevel({ config: c })).toBe('medium');
  });
  it('returns undefined when neither set', () => {
    expect(resolveEffortLevel({ config: baseConfig() })).toBeUndefined();
  });
});
```

### 5. CLI flag

File: `src/cli/options.ts`

```ts
.option(
  '--planner-effort <level>',
  'Planner effort hint: low, medium, high, xhigh. Dropped on unsupported backends.',
)
```

File: `src/cli/init-stores.ts`

```ts
configStore.load(projectDir, {
  // ...
  plannerEffort: opts.plannerEffort as EffortLevel | undefined,
});
```

File: `src/core/config/runtime/overrides.ts`

Add to `CLIOverrides`:

```ts
plannerEffort?: EffortLevel;
```

In `applyCLIOverrides`:

```ts
if (overrides.plannerEffort) {
  const parsed = EffortLevelSchema.safeParse(overrides.plannerEffort);
  if (!parsed.success) {
    throw new Error(`invalid --planner-effort: ${overrides.plannerEffort}`);
  }
  config.planner.effort = parsed.data;
}
```

### 6. Engine event

File: `src/engine/events/types.ts`

```ts
| { type: 'planner_effort_unsupported'; phase: Phase; ts: number; effort: EffortLevel; plannerKind: string }
```

Renderer in `event-card.tsx`:

```tsx
case 'planner_effort_unsupported':
  return <Text color={theme.warning}>effort: {event.effort} dropped ({event.plannerKind} unsupported)</Text>;
```

### 7. Thread effort into planner invocations

File: `src/engine/planners/base.ts`

In every place that builds a prompt for invocation (`invokePlan`, `invokeQuickPlan`, `invokeInstantPlan`, `invokeRegenerate`, `invokeEscalate*`, `invokeCheckConstitution`, `invokeClarifySpec`, `invokeAnalyzeArtifacts`), add an effort parameter that flows from the planner's config.

Simplest approach: add a method to the planner base that lazily reads the effective effort at each invocation:

```ts
function getEffectiveEffort(this: Planner): EffortLevel | undefined {
  return this.config.effort;  // where config is the planner's own config slice
}
```

When invoking, pass it down to the backend-specific invocation function:

```ts
const effort = this.getEffectiveEffort();
if (effort && !this.capabilities.supportsEffort) {
  this.bus.publish({
    type: 'planner_effort_unsupported',
    phase: state.phase,
    ts: Date.now(),
    effort,
    plannerKind: this.config.kind,
  });
}
const { text, usage } = await this.invokePlan(prompt, callbacks, { effort });
```

Extend `invokePlan`'s signature across all backends to accept an optional `{ effort }` options arg. Default parameter ensures existing call sites don't break.

### 8. Claude Code CLI — effort pass-through

> **VERIFY AT IMPLEMENTATION TIME:** Claude Code's slash commands (`/effort`) work in the interactive TUI but may NOT be parsed when injected via `claude -p <prompt>` non-interactive mode. Before implementing, run `claude --help 2>&1 | grep -i effort` on the user's install. Three strategies, in order of preference:
>
> **Strategy A (preferred):** If Claude Code CLI has a `--effort <level>` argv flag, use it directly in `buildClaudeArgs`.
> **Strategy B:** If Claude Code respects `/effort` inside `-p` prompt text, prepend `/effort {level}\n\n` to the prompt.
> **Strategy C (fallback):** If neither works, set `supportsEffort: false` for `claude-code` and log `planner_effort_unsupported`. Re-enable when Claude Code adds explicit CLI effort control.
>
> The code below shows Strategy B as a starting point. The implementing agent MUST verify before committing to a strategy.

File: `src/engine/claude-runner.ts:107-116`

```ts
type ClaudeArgs = {
  prompt: string;
  sessionId?: string;
  model?: string;
  useStdin?: boolean;
  effort?: EffortLevel;   // NEW
};

function buildClaudeArgs(args: ClaudeArgs): { argv: string[]; stdin?: string } {
  // Strategy A: if claude CLI supports --effort, use it.
  // Strategy B (fallback): prepend /effort as prompt prefix.
  const effortPrefix = args.effort ? `/effort ${args.effort}\n\n` : '';
  const effectivePrompt = effortPrefix + args.prompt;

  const argv: string[] = args.useStdin
    ? ['-p', '--output-format', 'stream-json', '--verbose']
    : ['-p', effectivePrompt, '--output-format', 'stream-json', '--verbose'];
  if (args.model) argv.push('--model', args.model);
  if (args.sessionId) argv.push('--session-id', args.sessionId);

  return { argv, stdin: args.useStdin ? effectivePrompt : undefined };
}
```

Test `src/engine/claude-runner.test.ts`:

```ts
it('includes effort in prompt when effort set', () => {
  const { argv } = buildClaudeArgs({ prompt: 'do x', effort: 'high' });
  expect(argv).toContain('-p');
  // Verify effort is threaded through (exact mechanism depends on strategy chosen).
  const promptArg = argv[argv.indexOf('-p') + 1];
  expect(promptArg).toContain('effort');
  expect(promptArg).toContain('high');
});
```

### 9. Codex CLI — argv flag

File: `src/engine/cli-tools.ts`

In the codex `buildArgs` (line ~40-50):

```ts
export function buildCodexArgs(params: CodexArgs): string[] {
  // ... existing args ...
  if (params.effort) {
    args.push('--reasoning-effort', params.effort);
  }
  return args;
}
```

**VERIFY AT IMPLEMENTATION TIME:** Run `codex --help 2>&1 | grep -i reasoning` to confirm `--reasoning-effort` exists. If it does not, set `supportsEffort: false` for codex and skip the argv addition. Re-enable when confirmed.

### 10. Anthropic API — thinking budget

File: `src/engine/providers/anthropic/stream.ts`

Extend the request-construction function:

```ts
type AnthropicStreamOptions = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  onProgress: (text: string) => void;
  effort?: EffortLevel;                // NEW
};

async function streamAnthropicCompletion(opts: AnthropicStreamOptions) {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature,
    max_tokens: 4096,
  };
  if (opts.effort) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: effortToAnthropicBudget(opts.effort),
    };
  }
  // ... rest unchanged
}
```

### 11. OpenAI-compat — reasoning_effort

File: `src/engine/providers/openai-stream.ts`

```ts
type OpenAIStreamOptions = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  onProgress: (text: string) => void;
  endpoint: string;
  effort?: EffortLevel;   // NEW
};

async function streamCompletion(opts: OpenAIStreamOptions) {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature,
    stream: true,
  };
  if (opts.effort) {
    body.reasoning_effort = opts.effort;
  }
  // ... rest unchanged
}
```

### 12. Agent SDK

File: `src/engine/agent-sdk.ts` — add to the options passed to `query()`:

```ts
if (effort) {
  options.thinking = {
    type: 'enabled',
    budget_tokens: effortToAnthropicBudget(effort),
  };
}
```

Validate against the SDK's actual option keys — if the Anthropic SDK uses a different name, adjust.

### 13. Slash command

File: `src/core/slash-commands/catalog.ts`

```ts
{
  name: '/effort',
  kind: 'arg',
  validScreens: ['workflow', 'home'],
  argChoices: ['low', 'medium', 'high', 'xhigh'],
  handler: async (ctx, arg) => {
    const parsed = EffortLevelSchema.safeParse(arg);
    if (!parsed.success) {
      ctx.setFeedbackMessage(`invalid effort: ${arg}`, 'error');
      return;
    }
    await ctx.updateConfig((c) => { c.planner.effort = parsed.data; return c; });
    ctx.setFeedbackMessage(`effort: ${parsed.data}`, 'success');
  },
  help: 'Set planner effort level for this session.',
},
```

### 14. Footer badge

File: `src/features/workflow/components/input-footer.tsx`

Pull effort from config:

```tsx
const effort = configStore.useConfig().planner.effort;
// ... in the right-side Box:
{effort && <Text color={t.info}>[effort: {effort}]</Text>}
```

### 15. Settings

File: `src/core/settings/catalog.ts`

```ts
{
  id: 'planner.effort',
  label: 'Planner effort',
  section: 'planner',
  description: 'Reasoning depth hint. Dropped on unsupported backends.',
  kind: 'enum',
  values: [...EFFORT_LEVELS, '(unset)'],
  readValue: (config) => config.planner.effort ?? '(unset)',
  writeValue: (config, value) => {
    config.planner.effort = value === '(unset)' ? undefined : value as EffortLevel;
    return config;
  },
},
```

### 16. Tests

Add to each backend's existing test file (if any) or create colocated tests:

- `src/engine/claude-runner.test.ts` — effort prefix in prompt.
- `src/engine/cli-tools.test.ts` — codex `--reasoning-effort` argv.
- `src/engine/providers/anthropic/stream.test.ts` — `thinking` field in body.
- `src/engine/providers/openai-stream.test.ts` — `reasoning_effort` field in body.
- `src/engine/providers/capability-inference.test.ts` — model-name pattern matching.
- `src/engine/planners/base.test.ts` — `planner_effort_unsupported` event when capability is false.

### 17. Docs

File: `docs/CONFIG.md`

Add under `planner`:

```md
- `planner.effort` — `'low' | 'medium' | 'high' | 'xhigh'`. Reasoning-depth hint. Pass-through per backend. Dropped on backends without reasoning support; a one-time event is logged. CLI equivalent: `--planner-effort`.
```

### 18. Verification gate

```bash
npm run typecheck
npm run lint
npm test
```

## Rollback

Revert the listed files. The capability-inference module can be deleted if no other brief references it (brief 06 also uses `modelSupportsVision`, so if brief 06 has landed, leave the file; just remove `modelSupportsEffort`).

## Checkpoint

- `--planner-effort high` sets the YAML key in memory.
- Every supported backend threads the value through and sends the right bytes.
- Unsupported backends emit one `planner_effort_unsupported` event.
- Footer badge shows `[effort: high]` when set.
- `/effort` slash command works.
