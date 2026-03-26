# Data Model: Agent-Mode Implementer & Workflow Hardening

**Source**: [spec.md](spec.md) Key Entities section

## Entity Changes

This feature modifies existing entities. No new entities are introduced.

### Config (modified)

New and changed fields in `implementer` section:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| implementer.type | `'api' \| 'shell' \| 'agent'` | `'api'` | Implementer mode. `api`: OpenAI chat API (system writes files). `shell`: subprocess returns code text (system writes files). `agent`: subprocess writes files directly (system only validates/commits). |
| implementer.command | `string` | (none) | Required for `shell` and `agent` types. The command to run. |
| implementer.args | `string[]` | `[]` | Arguments for the command. May contain `{prompt}` placeholder (replaced with task description). |
| implementer.timeout | `number` | `300000` | Timeout in ms for agent-mode processes. Default 5 minutes. |
| implementer.outputFormat | `'stream-json' \| 'jsonl' \| 'text'` | `'text'` | Output parsing format for `shell` type. Ignored for `agent` type. |

### PlannerBackend (modified)

New method on the planner backend interface:

| Method | Return Type | Description |
|--------|-------------|-------------|
| `getVersion()` | `Promise<string \| null>` | Detect and return the CLI tool's version string. Returns null if version cannot be determined. |

### ClarificationQuestion (unchanged)

No changes to the question structure. The parser implementation changes but the data shape stays the same:

| Field | Type | Description |
|-------|------|-------------|
| id | `string` | Unique question identifier |
| type | `'choice' \| 'input' \| 'confirm'` | Input type |
| text | `string` | Question text |
| options | `string[]` (optional) | Available choices for `choice` type |
| default | `string \| number \| boolean` (optional) | Default answer |

## State Transitions

No changes to the state machine. Agent-mode tasks follow the same phase transitions:

```
implementing → validating-task → (pass) → implementing [next task]
implementing → validating-task → (fail) → implementing [retry]
implementing → validating-task → (fail, max retries) → escalating
```

The only difference: in agent mode, the `implementing` phase does not call `extractCode()` or `applyCode()`. Files are already on disk when validation begins.

## Validation Rules

- `implementer.type: 'agent'` requires `implementer.command` to be set
- `implementer.type: 'agent'` ignores `implementer.outputFormat` (agent writes files, not code text)
- `implementer.timeout` must be > 0 and <= 600000 (10 minutes max)
- `planner.getVersion()` failure is non-fatal (warning + fallback to latest known flags)
