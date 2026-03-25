# Feature Specification: tiny-spec v0.2 -- Small LLM Prompt Optimization

**Feature Branch**: `004-small-llm-prompt-optimization`
**Created**: 2026-03-25
**Status**: Draft
**Input**: Optimize task generation and prompt formatting for small LLMs (7B-27B) with limited context windows (8K-32K tokens). Improve documentation and create an LLM skill for the project.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tasks Fit in 8K Context Window (Priority: P1)

A developer on a machine with 12GB VRAM runs tiny-spec with Qwen 2.5 Coder 7B (Q4, ~5GB, 8K effective context). Every task prompt -- including system preamble, task description, type definitions, implementation steps, code context, and constraints -- fits within 8K tokens with 25% reserved for model output. For MODIFY tasks on large files (300+ LOC), the tool automatically switches from whole-file to function-level context, sending only the target function, its imports, and surrounding context instead of the entire file.

**Why this priority**: This is the core accessibility constraint. Users with 12-16GB VRAM are the primary audience. If tasks overflow their context window, the model produces garbage or truncated output, and the entire pipeline fails.

**Independent Test**: Configure `contextLength: 8192` in config, run `tiny-spec start` on a project with files ranging from 50 to 600 LOC. Verify that every generated task prompt (logged to events.jsonl) is under 6144 tokens (8192 minus 25% output reserve). Verify that MODIFY tasks on files >200 LOC use function-level context.

**Acceptance Scenarios**:

1. **Given** contextLength is 8192, **When** a CREATE task is generated for a new 100-line module, **Then** the total prompt (system + user) is under 6144 tokens.

2. **Given** contextLength is 8192, **When** a MODIFY task targets a 50-line file, **Then** the full file content is included in the prompt and the total is under 6144 tokens.

3. **Given** contextLength is 8192, **When** a MODIFY task targets a 400-line file, **Then** the prompt includes only the target function (with 5 lines of surrounding context) and the import section, NOT the entire file. The total prompt is under 6144 tokens.

4. **Given** contextLength is 32768, **When** a MODIFY task targets a 400-line file, **Then** the full file content is included because it fits within the budget.

5. **Given** a task prompt would exceed the budget even with function-level context, **When** the formatter assembles the prompt, **Then** it truncates the code context using middle-out truncation with a visible marker, and the total stays under budget.

---

### User Story 2 - Self-Contained Tasks with Inlined Types and Steps (Priority: P1)

A developer runs the full pipeline. Claude Code (Opus) generates tasks where each task contains ALL information a small model needs: inlined type definitions for every type the task references, a 3-5 step implementation plan, and a concrete output example. The small model never has to guess what a type looks like, how to structure its approach, or what format to use.

**Why this priority**: Small models (7B-9B) cannot infer type definitions from context clues. Without inlined types, they hallucinate field names and signatures. Without implementation steps, they take wrong approaches. Without output examples, they wrap code in markdown fences or add explanations. These are the top 3 causes of task failure.

**Independent Test**: Run `tiny-spec spec "add a config validator"`. Open the generated tasks.md. Verify that each task contains a `### Type Definitions` section with all referenced types, a `### Implementation Steps` section with 3-5 numbered steps, and that the system preamble includes a few-shot output example.

**Acceptance Scenarios**:

1. **Given** a task that implements `validateConfig(config: Config): ConfigError[]`, **When** the task is generated, **Then** it includes the full `Config` interface and `ConfigError` interface inlined in a `### Type Definitions` section.

2. **Given** a task that implements a function returning `ValidationResult[]`, **When** the task is generated, **Then** `ValidationResult` is inlined in the task, even though it's defined in a different file.

3. **Given** any task, **When** the task is generated, **Then** it includes a `### Implementation Steps` section with 3-5 numbered steps describing HOW to implement (not just WHAT).

4. **Given** the system preamble sent to the local model, **When** inspected, **Then** it includes a 10-15 line few-shot example showing the expected output format (raw TypeScript, no fences, no explanation).

5. **Given** a task with `depends_on: [T003]`, **When** T003 exports types used by this task, **Then** those exported types are inlined in this task's type definitions section.

---

### User Story 3 - Retry Prompts Preserve Full Context (Priority: P1)

A developer's local model fails a task. On retry attempts 2 and 3, the model receives the SAME complete context as attempt 1 -- signature, tests, type definitions, constraints, implementation steps -- plus the error from the previous attempt. The retry strategy varies by framing and temperature, NOT by removing information.

**Why this priority**: Current retry attempts 2 and 3 strip critical context (signatures, tests, constraints). A 7B model cannot fix a type error if it doesn't know what types to use. This directly causes unnecessary escalation to Opus, wasting the user's subscription tokens.

**Independent Test**: Trigger a task that fails 3 times (e.g., by making the test always fail). Capture all 3 retry prompts from events.jsonl. Verify that all 3 contain the function signature, test expectations, type definitions, and constraints.

**Acceptance Scenarios**:

1. **Given** a task fails attempt 1, **When** retry attempt 2 fires, **Then** the prompt includes: error message, original task description, function signature, tests, type definitions, constraints, and implementation steps. Temperature is 0.4.

2. **Given** a task fails attempt 2, **When** retry attempt 3 fires, **Then** the prompt includes ALL the same context as attempt 2 plus the latest error. The framing is rephrased. Temperature is 0.5.

3. **Given** a retry prompt for a MODIFY task, **When** the current code has changed since the first attempt (due to a partial fix), **Then** the retry prompt includes the LATEST file content, not the original.

4. **Given** a task with 5 constraints, **When** retry attempt 3 fires, **Then** all 5 constraints are present in the prompt (none dropped).

---

### User Story 4 - Updated Documentation (Priority: P2)

A new contributor clones the repo and reads CLAUDE.md and README.md. The documentation accurately reflects the current state of the project including v0.2 changes: token budgeting strategy, supported context windows, function-level editing, task prompt structure, and the project's LLM skill.

**Why this priority**: Stale documentation causes confusion for both human contributors and AI assistants. CLAUDE.md is read by every Claude Code session -- inaccurate information there leads to wrong assumptions.

**Independent Test**: Read CLAUDE.md and README.md after updates. Verify they mention: 8K minimum context support, function-level edit mode, inlined type definitions, implementation steps, few-shot examples, token budget breakdown.

**Acceptance Scenarios**:

1. **Given** CLAUDE.md, **When** read by a new contributor, **Then** it documents: token budget per task, 8K minimum context, function-level edit strategy, task prompt structure with all sections (types, steps, few-shot).

2. **Given** README.md, **When** read by a new user, **Then** it documents the supported context window range (8K-32K+) and the auto-degradation behavior.

3. **Given** the quickstart guide, **When** read by a first-time user, **Then** it mentions setting OLLAMA_CONTEXT_LENGTH and explains why (default 2048 is too small).

---

### User Story 5 - LLM Project Skill (Priority: P2)

A developer using Claude Code on this project can invoke a skill that provides complete context about tiny-spec's architecture, conventions, task prompt format, and implementation patterns. This skill is loaded automatically when relevant and gives the LLM everything it needs to work effectively on the codebase.

**Why this priority**: Without a skill, every new Claude Code session starts with incomplete context about the project. The skill eliminates repeated context-gathering and ensures consistent understanding across sessions.

**Independent Test**: Invoke the tiny-spec skill in a new Claude Code session. Verify it provides: project architecture, module responsibilities, task prompt format specification, type definitions, coding conventions, and testing patterns.

**Acceptance Scenarios**:

1. **Given** a new Claude Code session in the tiny-spec project, **When** the skill is invoked, **Then** it provides: project purpose, architecture overview, module map with responsibilities, key types, coding conventions (zero classes, ESM .js extensions, pure functions), and testing patterns.

2. **Given** the skill content, **When** used by Claude Code to implement a new feature, **Then** it includes the task prompt format specification so Claude knows how to generate tasks that small models can understand.

3. **Given** the skill content, **When** read, **Then** it fits within reasonable size limits and is organized for quick reference (not a wall of text).

---

### Edge Cases

- What happens when a task requires types from 5+ different files? The inlined type definitions section may become very large. The system should prioritize directly-used types and omit transitive dependencies, with a token budget cap for the types section.
- What happens when a function to modify cannot be identified by name? Fall back to whole-file with truncation, and log a warning.
- What happens when the model's context window is not set in config? Default to 32768 (current behavior) and warn the user to verify.
- What happens when the few-shot example in the preamble doesn't match the task's language/framework? The example should use generic TypeScript patterns that apply to any TS/JS project.
- What happens when a task has no function signature (e.g., config file generation)? Skip the Implementation Steps section and use whole-file approach regardless of file size.

## Clarifications

### Session 2026-03-25

- Q: What is the minimum context window to support? A: 8K tokens (Qwen 7B Q4 on 12GB VRAM).
- Q: Should function-level edit use AST parsing or regex? A: Start with regex-based function boundary detection (export function/const boundaries). AST parsing (ts-morph) is v0.3 if regex proves insufficient.
- Q: Should the few-shot example be per-language or generic? A: Generic TypeScript for v0.2 (only TS/JS projects supported).
- Q: How many implementation steps per task? A: 3-5 steps. Opus generates them during task creation.
- Q: Token budget split for 8K context? A: System preamble + few-shot (~500 tok) + task prompt (~600 tok) + type defs (~300 tok) + impl steps (~150 tok) + code context (~400-1000 tok, auto-scaled) + output reserve (25% = ~2048 tok).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST enforce a strict token budget per task prompt. The total prompt (system + user message) MUST NOT exceed `contextLength - (contextLength * 0.25)` tokens, where the 25% is reserved for model output.
- **FR-002**: System MUST include inlined type definitions in each task. Every type referenced in the task's signature, description, or tests MUST be included in a `### Type Definitions` section within the task. Types MUST be copied verbatim from their source files.
- **FR-003**: System MUST include 3-5 implementation steps in each task in a `### Implementation Steps` section. Steps describe HOW to implement, not just WHAT. Steps are generated by Opus during task creation.
- **FR-004**: System MUST include a few-shot output example (10-15 lines of sample TypeScript) in the system preamble to demonstrate the expected output format.
- **FR-005**: System MUST auto-degrade code context when the prompt exceeds the token budget: (1) try whole-file, (2) if overflow, switch to function-level context (imports + target function + 5 lines surrounding context), (3) if still overflow, truncate middle with visible marker, (4) if still overflow, error with "task too large, split required".
- **FR-006**: For function-level context, the system MUST extract the target function by detecting export boundaries (regex-based: `export function`, `export const`, `export class`, `export interface`, `export type` declarations) and include 5 lines before and after the matched function.
- **FR-007**: All retry prompts (attempts 1, 2, and 3) MUST include the complete task context: description, function signature, type definitions, tests, constraints, and implementation steps. Retry prompts MUST also include the latest error and the current file content (not the original).
- **FR-008**: Retry prompts MUST vary by framing and temperature only: attempt 1 adds error with "Fix the error" framing (temp +0.1), attempt 2 rephrases the task with "Here's a different way to think about it" framing (temp +0.2), attempt 3 adds "Try a completely different approach" framing (temp +0.3).
- **FR-009**: The `Task` type MUST be extended with a `typeDefs: string` field containing inlined type definitions and an `implSteps: string[]` field containing implementation steps.
- **FR-010**: The `buildTasksPrompt` template MUST instruct Opus to generate `typeDefs` and `implSteps` for each task, inlining all referenced types from the codebase.
- **FR-011**: The task parser MUST parse the new `### Type Definitions` and `### Implementation Steps` sections from generated tasks.md into the corresponding Task fields.
- **FR-012**: CLAUDE.md MUST be updated to document: token budget strategy, 8K minimum context, function-level edit, task prompt structure, and new Task fields.
- **FR-013**: README.md MUST be updated to document: supported context window range (8K-32K+), auto-degradation behavior, recommended models per VRAM tier.
- **FR-014**: A project skill file MUST be created that provides complete context about tiny-spec's architecture, conventions, task prompt format, and implementation patterns for use by LLM coding assistants.
- **FR-015**: The `estimateTokens` function MUST use a more accurate heuristic: `Math.ceil(text.length / 4)` for TypeScript code (closer to real tokenization than current `/3.5`).

### Key Entities

- **Task** (extended): Adds `typeDefs: string` (inlined type definitions) and `implSteps: string[]` (3-5 implementation steps). Both populated by Opus during task generation.
- **TokenBudget**: A computed breakdown of how tokens are allocated within a prompt: `{ system, taskBody, typeDefs, implSteps, codeContext, outputReserve, total, remaining }`. Used by the formatter to make degradation decisions.
- **CodeContext**: Represents the code included in a MODIFY task prompt. Either `{ mode: 'whole-file', content: string }` or `{ mode: 'function-level', imports: string, targetFunction: string, surroundingContext: string }`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of generated task prompts fit within the configured context window (minus 25% output reserve) for context windows as small as 8192 tokens.
- **SC-002**: Task success rate on first attempt improves by at least 15% compared to v0.1 prompts (measured by running the same task set with v0.1 and v0.2 prompt formats against the same model).
- **SC-003**: Retry prompts at all attempts (1, 2, 3) contain signature, types, tests, and constraints -- verified by automated test.
- **SC-004**: Every task in generated tasks.md contains non-empty `### Type Definitions` and `### Implementation Steps` sections -- verified by parser test.
- **SC-005**: CLAUDE.md and README.md pass a documentation review covering all v0.2 prompt optimization features.
- **SC-006**: The project skill file loads correctly and contains architecture, conventions, task format spec, and key types.

## Assumptions

- Users have Ollama or LM Studio configured with explicit context length (not the 2048 default).
- TypeScript/JavaScript projects only (v0.2 scope unchanged).
- Opus (Claude Code) can reliably identify and inline relevant type definitions when instructed in the task generation prompt.
- Regex-based function boundary detection works for >90% of TypeScript export patterns. Edge cases (re-exports, default exports, class methods) are handled by fallback to whole-file with truncation.
- The few-shot example in the system preamble is generic enough for any TS/JS project.

## Out of Scope (v0.2)

- AST-based function extraction (ts-morph) -- deferred to v0.3 if regex proves insufficient
- Multi-language support (Python, Go, Rust) -- separate feature
- Parallel task execution via git worktrees -- separate feature
- Custom few-shot examples per project/language -- future
- Prain MCP integration for intelligent context assembly -- separate feature
- Mid-tier model cascade (DeepSeek/Sonnet for escalation) -- separate feature
- Hashline edit format -- separate feature
