# Data Model: Interactive UX Overhaul

## New Entities

### ClarificationQuestion

A question embedded in planner output, parsed from `<!-- Q:{JSON} -->` markers.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique question ID (e.g., "q1", "auth_strategy") |
| type | "choice" \| "input" \| "confirm" | Question type |
| text | string | Question text displayed to user |
| options | string[] \| undefined | For choice type: list of options |
| default | string \| number \| boolean \| undefined | Default answer (index for choice, text for input, boolean for confirm) |

### ClarificationAnswer

User's response to a clarification question.

| Field | Type | Description |
|-------|------|-------------|
| questionId | string | References ClarificationQuestion.id |
| answer | string | User's answer text |
| source | "tui" \| "file-edit" | How the answer was provided |
| timestamp | string | ISO timestamp of when answered |

### PlannerDetection

Result of checking if a planner tool is available on the system.

| Field | Type | Description |
|-------|------|-------------|
| tool | PlannerTool | Tool identifier (claude-code, codex, etc.) |
| available | boolean | Whether the tool was found and responds to --version |
| error | string \| undefined | Error message if detection failed |

### ImplementerDetection

Result of probing a local implementer endpoint.

| Field | Type | Description |
|-------|------|-------------|
| provider | string | Provider name (ollama, lm-studio) |
| available | boolean | Whether the endpoint is running and has models |
| models | string[] \| undefined | List of available models if running |

## Modified Entities

### Config.implementer (extended)

New fields added for shell implementer support.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| type | "api" \| "shell" | "api" | Implementer backend type |
| command | string \| undefined | — | Shell command (required when type is shell) |
| args | string[] \| undefined | [] | Shell command arguments |
| outputFormat | OutputFormat \| undefined | "text" | Output parsing format for shell |

### OrchestratorCallbacks (extended)

New callbacks for conversational planning.

| Field | Type | Description |
|-------|------|-------------|
| onQuestionAsked | (question: ClarificationQuestion) => Promise\<string\> | Called when planner asks a question; returns user's answer |
| onCommentRequested | (type: "spec" \| "plan", filePath: string) => Promise\<string \| null\> | Called at approval gate; returns comment text or null for approve |

### PlannerBackend (extended callbacks)

Extended to support question extraction from output stream.

| Field | Type | Description |
|-------|------|-------------|
| onQuestion | (questions: ClarificationQuestion[]) => void | Callback emitted when questions are found in stream |

## State Transitions

No changes to the core state machine (11 phases, 20 transitions). The conversational flow happens WITHIN existing phases:

- `researching` phase: planner asks questions → user answers → answers recorded in spec.md
- `reviewing-spec` phase: user can approve, edit, or comment → comment triggers re-spec within same phase
- `reviewing-plan` phase: same as reviewing-spec but for plan.md

The state machine doesn't need new phases because the conversational interaction is sub-phase behavior, not a new workflow state.
