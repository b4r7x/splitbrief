# Contract: v1 → v2 Migration

**File**: `src/core/config/migration.ts` (REWRITTEN)

## Purpose

Detect v1 configs on load and transform them to v2 shape before zod parsing. Lazy and transparent — no user action required. Idempotent: v2 configs pass through unchanged.

## Exports

```ts
export function migrateConfig(raw: unknown): unknown
```

## Contract

### Entry point

```ts
function migrateConfig(raw: unknown): unknown {
  if (!isObject(raw)) throw new Error('Config must be an object');
  const version = typeof raw.version === 'number' ? raw.version : 1;

  if (version === 1) return migrateV1ToV2(raw);
  if (version === 2) return raw;
  throw new Error(`Unsupported config version: ${version}`);
}
```

### v1 → v2 root transform

```ts
function migrateV1ToV2(v1: Record<string, unknown>): Record<string, unknown> {
  return {
    ...v1,
    version: 2,
    planner: migrateRunnerV1ToV2(v1.planner, 'planner'),
    implementer: migrateRunnerV1ToV2(v1.implementer, 'implementer'),
  };
}
```

All sections other than `planner` and `implementer` are passed through unchanged.

### Per-runner migration rules

`migrateRunnerV1ToV2(raw, role)` applies these rules in order:

1. **Legacy CLI-tool-as-kind** (implementer only pre-refactor): if `raw.kind` is one of `CLI_TOOL_IDS` (e.g., `'claude-code'`), rewrite to `{ kind: 'cli', tool: <old-kind>, ...commonFields }`.

2. **Already-cli kind** with tool field: `{ kind: 'cli', tool: 'claude-code' }` passes through. If `tool` is missing or not in `CLI_TOOL_IDS`, defaults to `'claude-code'`.

3. **api kind**:
   - `provider` comes from new-shape `raw.provider`, or legacy `raw.tool`, or per-role default (`implementer → 'ollama'`, `planner → 'anthropic'`).
   - `apiBase` comes from `raw.apiBase` if non-empty, otherwise `resolveDefaultApiBase(provider)`.
   - If `apiBase` is still missing after lookup → throw with an actionable error naming the provider, listing `KNOWN_API_PROVIDERS`, and instructing the user to set `apiBase`.
   - `apiKey` passes through if present.

4. **shell kind**: `command` must be non-empty or migration throws.

5. **agent kind**: same as shell.

6. **agent-sdk kind**: pass through; `apiKey` optional.

7. **Missing `kind` field** (v1 without explicit kind): infer via `inferLegacyKind(raw)`:
   - If `raw.tool` is in `CLI_TOOL_IDS` → infer `'cli'`
   - Else if `raw.apiBase` is a string → infer `'api'`
   - Else if `raw.command` is a string → infer `'shell'`
   - Else → default to `'api'` (and rely on rule 3's per-role default provider)

8. **Unknown kind**: throw with message `${role}: unknown runner kind "${rawKind}"`.

### Common fields preservation

`pickCommonFields(raw)` extracts `model`, `customModels`, `contextLength`, `temperature`, `timeout` from the raw object and passes them through unchanged. `pickArgsOutputFormat(raw)` extracts `args` and `outputFormat` for shell/agent variants.

### Error messages

All migration errors MUST be actionable:
- Name the role (`planner` or `implementer`)
- Name the specific missing or invalid field
- List the valid alternatives where applicable (known providers, known CLI tools, valid kinds)
- Instruct the user on how to fix (e.g., "set apiBase explicitly", "pick a known provider")

### Test coverage

`migration.test.ts` (new) MUST cover at least:
1. v1 `{ kind: 'claude-code', tool: 'claude-code', ... }` → v2 `{ kind: 'cli', tool: 'claude-code', ... }`
2. v1 `{ kind: 'api', tool: 'ollama', ... }` without `apiBase` → v2 `{ kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1', ... }`
3. v1 `{ kind: 'api', tool: 'my-custom', ... }` without `apiBase` → throws with actionable message
4. v1 `{ tool: 'claude-code', model: 'opus-4' }` (no kind) → v2 `{ kind: 'cli', tool: 'claude-code', model: 'opus-4' }`
5. v1 `{ kind: 'shell', command: '' }` → throws
6. v2 config (already in new shape) → passes through unchanged
7. Non-object input → throws `'Config must be an object'`
8. v3 config (future) → throws `'Unsupported config version: 3'`

## Consumers

- `src/core/config/loading.ts:mergeWithDefaults` calls `migrateConfig` before `validateConfig` (the zod parse step). The migration output is then merged with defaults and validated.

## Invariants

- `migrateConfig(migrateConfig(x))` produces the same output as `migrateConfig(x)` (idempotent).
- `ConfigSchema.parse(migrateConfig(any_v1_config))` succeeds iff the v1 config's fields can be mapped to valid v2 fields.
- Migration NEVER partially upgrades: either the whole config migrates or the operation throws.
