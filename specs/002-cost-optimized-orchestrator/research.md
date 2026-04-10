# Research: tiny-spec v0.1

**Date**: 2026-03-25 | **Method**: 9 parallel Opus research agents with WebSearch

## 1. Architecture: Claude Code CLI + Direct API

**Decision**: Use Claude Code CLI (`claude -p`) for planning/escalation, OpenAI-compatible SDK for implementation.

**Rationale**:
- Claude Code CLI uses the user's existing $100/mo subscription -- $0 extra cost
- `claude -p --output-format stream-json` gives reliable structured streaming output
- `--session-id` enables multi-turn planning sessions
- OpenCode has critical reliability issues (hangs on API errors [#8203], exits code 0 on failures [#15558], subagent hangs [#6573, #9003])
- Aider uses direct API (most successful open-source AI coding tool)
- Direct API gives full control over the "harness" -- research shows harness choice has MORE impact than model choice (GPT-4: 26%→59% just by changing edit format)

**Alternatives considered**:
- OpenCode as subprocess: Rejected -- multiple unresolved hang/reliability issues make it unsuitable for automation
- Anthropic SDK directly: Rejected -- costs $28/mo extra on top of subscription, user already pays for Claude Code
- Claude Agent SDK: Rejected for implementer -- only works with Anthropic models, can't route to local models
- Aider as subprocess: Rejected -- adds Python dependency, unsupported programmatic API

**Claude Code CLI patterns**:
```bash
# Single prompt, structured JSON output
claude -p "research this codebase and write a spec" --output-format stream-json

# Continue a session
claude -p "now write the plan" --session-id <id> --output-format stream-json

# Bare mode for scripting
claude -p "prompt" --output-format json --bare
```

## 2. Implementation Provider Abstraction

**Decision**: Use `openai` npm package with provider-specific baseURL configuration.

**Rationale**: All target providers speak OpenAI-compatible API. Provider abstraction is ~20 lines.

| Provider | Base URL | Auth | Notes |
|----------|----------|------|-------|
| Ollama | `localhost:11434/v1` | `apiKey: 'ollama'` | Default ctx 2048 -- MUST override |
| LM Studio | `localhost:1234/v1` | `apiKey: 'lm-studio'` | MLX backend 26-30% faster on Apple Silicon |
| DeepSeek | `api.deepseek.com/v1` | `DEEPSEEK_API_KEY` env | $0.28/$0.42 per M tokens, 73% SWE-bench |
| OpenRouter | `openrouter.ai/api/v1` | `OPENROUTER_API_KEY` env | Free tier available for some models |
| Ollama Cloud | `api.ollama.com/v1` | subscription | $0-100/mo flat, vague limits |

**Critical trap -- Ollama context window**: Default is 2048 tokens. The `/v1/` endpoint does NOT support `num_ctx` parameter. Must use either:
1. Custom Modelfile with `PARAMETER num_ctx 32768`
2. `TINY_SPEC_CONTEXT_LENGTH` environment variable
3. Ollama native API (`/api/chat`) with `num_ctx` in options (not OpenAI-compat)

**Model capability detection**:
- Ollama: `POST /api/show { name: "model" }` returns parameters
- LM Studio: `GET /v1/models` returns `max_context_length` + `capabilities` array
- Cloud: hardcode known values or query model list endpoints

## 3. Best Small Models (March 2026)

### For RTX 4070 Ti S (12GB VRAM)
- **Qwen 2.5 Coder 7B** (Q4, ~5GB): 88.4% HumanEval, best FIM/autocomplete, ~35-50 tok/s
- **Qwen 3.5 9B** (Q4, ~6.6GB): Strong general + coding, 262K context, ~40-55 tok/s

### For Mac M4 32GB
- **Qwen 3.5 27B** (Q4, ~16GB): 72.4% SWE-bench, best dense model under 35B, ~18-25 tok/s
- **Qwen 2.5 Coder 14B** (Q4, ~9GB): Great coding, fits easily, ~30-40 tok/s

### Via API
- **DeepSeek V3.2**: $0.28/M input, 73% SWE-bench -- best cheap API option
- **Qwen3 Coder on OpenRouter**: Free tier available

## 4. Code Edit Format

**Decision**: Whole-file replacement for files <200 lines, search/replace blocks for larger files.

**Rationale**:
- Aider benchmarks show 100% well-formed rate for whole-file with Qwen models of all sizes
- Search/replace accuracy degrades with file size: 85% (<100 LOC), 75% (100-300), 60% (300+)
- Small models (<15B) cannot reliably produce unified diffs (hunk headers too complex)
- The "harness problem" research (Can.ac, Feb 2026) showed format choice alone swung GPT-4 from 26% to 59%

**Alternatives considered**:
- Unified diff: Rejected -- poor accuracy for small models
- Hashline format: Promising (5-14pt improvement) but new/unproven -- deferred to v0.2
- Morph Fast Apply: External API dependency, 98% accuracy at 10,500 tok/s -- consider for v0.2

## 5. Task Prompt Format

**Decision**: Markdown body + YAML frontmatter, self-contained, one function per task for <15B models.

**Rationale**:
- YAML 62% accuracy on hierarchical data vs 50% JSON
- Markdown 16% more token-efficient than JSON
- Self-contained tasks eliminate hallucination of referenced file contents
- One function per task: Qwen 2.5 Coder 7B at 57.9% whole-file accuracy -- multi-function would push this lower

**Prompt structure** (lost-in-the-middle mitigation):
1. System prompt (role + format rules) -- beginning, high attention
2. Task description + function signature -- beginning, high attention
3. Test cases -- early, good attention
4. Type definitions -- middle
5. Current file contents -- middle
6. Constraints + output format -- end, high attention

**Token budget per task**: <8K total for 7B models, <16K for 27B models.

**System prompt best practices for small models**:
- Assign specific role: "You are a TypeScript code generator"
- Rigid output format: "Output ONLY the complete file contents. No markdown fences. No explanations."
- Negative constraints: "Do NOT invent new functions. Do NOT add features not in the task."
- Do NOT use chain-of-thought -- plan is already provided by Opus (ICML 2025: traditional CoT doesn't help code gen)
- Temperature: 0.3 default, increase on retries (0.4, 0.5)

## 6. Validation Pipeline

**Decision**: tsc → lint → affected tests per task, full suite at end.

**Rationale**: Research-validated order (fastest/cheapest first). Stops on first failure.

| Step | Check | Time | Catches |
|------|-------|------|---------|
| 1 | `tsc --noEmit` | ~0.1-2s | Type errors, missing imports, syntax |
| 2 | Lint (ESLint/Biome) | ~0.5-1s | Style, unused vars, suspicious patterns |
| 3 | Affected tests | ~5-30s | Logic errors, regressions |
| 4 | Full test suite (end only) | ~30-120s | Cross-task regressions |
| 5 | Opus review (final only) | ~30-60s | Spec gaps, architecture, security |

**Affected test detection**: Simple file-name matching heuristic (`src/X.ts` → `tests/X.test.ts`). Avoid complex import graph analysis in v0.1.

## 7. Retry & Escalation Strategy

**Decision**: 3 retries with varied framing, then two-tier escalation (hints → full).

**Rationale**:
- LLMs can self-correct with external feedback but NOT via internal reasoning (TACL 2024)
- Retry 1 catches 60-70% of fixable errors, retry 2: 80-90%, retry 3: 95%+ (diminishing returns after)
- Two-tier escalation cuts costs 30-50%

**Retry approach**:
- Retry 1 (temp 0.3): Include exact error message + line number + 5-10 lines of context
- Retry 2 (temp 0.4): Rephrase the task + different framing
- Retry 3 (temp 0.5): Increase temperature to explore different solutions
- If same error persists across 2 retries: escalate immediately (model is stuck)

**Escalation tiers**:
- Tier 1 (hint): Send task + error to Opus via `claude -p`, ask for diagnosis/hints only (~500 tokens). Feed hints to local model for one more attempt.
- Tier 2 (full): Send full task + context to Opus for complete implementation (~5000 tokens).

**Error feedback format**:
```
Your previous code had an error. Fix it.
Error type: TypeScript type error
Error message: TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
Error location: line 42
Line content: const result = add(name, 5);
[... previous output ...]
Fix the error and output the complete corrected file.
```

## 8. TUI Architecture

**Decision**: Split-pane Ink 5.x TUI with Claude Code output (left) and implementer activity (right).

**Rationale**: User wants to SEE both planner and implementer working. Claude Code output piped from subprocess stdout to left pane. Implementer shows streaming API response + file changes + validation.

**Ink capabilities & limitations**:
- `<Box flexDirection="row">` for split panes
- No native scrolling -- must implement windowed rendering (~40 LOC)
- `useStdoutDimensions()` for terminal size + resize
- `useInput()` for keyboard handling
- Batch state updates on newlines to avoid excessive re-renders during streaming

**Layout**:
```
┌─────────── Header (1 line) ──────────────┐
│ tiny-spec | feature-name | 00:03:42      │
├──────────────────┬───────────────────────┤
│ PLANNER          │ IMPLEMENTER           │
│ (Claude Code)    │ (Local Model)         │
│ [scrollable]     │ [scrollable]          │
├──────────────────┴───────────────────────┤
│ Phase: implementing | Task: 3/12 | 7b    │
└──────────────────────────────────────────┘
```

**Keyboard**: `Tab` switch pane focus, `q` quit, `Enter` approve, `s` skip task, `e` escalate, `↑↓` scroll.

## 9. State Management

**Decision**: JSON snapshot (`state.json`) + JSONL event log (`events.jsonl`).

**Rationale**: Simple resume via snapshot + debugging/cost-reporting via event log.

- Save state BEFORE starting each task (on resume, you know which task to retry)
- Event log is append-only, never read during normal operation
- Graceful shutdown: `process.on('SIGINT')` saves state, discards uncommitted changes

## 10. Git Integration

**Decision**: Commit per task, `git checkout -- .` for rollback, sequential execution.

**Rationale**: Atomic rollback, bisect-friendly history, clear audit trail.

- Each commit references task ID: `[tiny-spec] T003: implement config loader`
- Failed tasks: discard uncommitted changes, skip dependents
- External change detection: `git status` before each task, warn user if unexpected changes
- Git worktrees for parallel execution: deferred to v0.2

## 11. Cost Analysis

| Setup | Monthly Cost | Features/mo | Effective Value |
|-------|-------------|-------------|-----------------|
| Max 5x (Opus only) | $100 | 5-6 | $100 |
| **Max 5x + tiny-spec** | **$100** | **12-15** | **$200-250** |
| Max 20x (Opus only) | $200 | 15-20 | $200 |

- Planning phase: ~348K Opus tokens/feature (uses existing subscription)
- Implementation: $0 (local) or $0.20/feature (DeepSeek)
- Local inference electricity: $0.04-0.16/month
- Crossover to Max 20x: only at 15+ features/month

## 12. Prain Integration (v0.2)

**Decision**: Optional MCP client integration in v0.2.

**Rationale**: Prain's `brain_context` tool solves tiny-spec's hardest problem -- building the right context for a 7B model with a 32K context window. Without Prain, context is naive file-reading. With Prain, it's ranked, symbol-level, token-budgeted.

**Integration points**: `brain_context` for task prompts, `brain_conventions` for style matching, `brain_impact` for blast radius checks.

## Sources

Key references (full list in individual agent outputs):
- [Aider Architect/Editor](https://aider.chat/2024/09/26/architect.html) -- R1+Sonnet at 14x less cost
- [The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/) -- edit format > model choice
- [Self-Planning Code Generation](https://arxiv.org/abs/2303.06689) -- +25.4% Pass@1
- [DisCIPL (MIT)](https://www.marktechpost.com/2025/04/16/mit-researchers-introduce-discipl/) -- 80.2% cost savings
- [Context Rot (Morph)](https://www.morphllm.com/context-rot) -- degradation at 30K for 8B models
- [CoCoS (EMNLP 2025)](https://arxiv.org/html/2505.23060) -- self-correction with external feedback
- [LLM Self-Correction (TACL 2024)](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00713/) -- external feedback essential
- [Claude Code Headless](https://code.claude.com/docs/en/headless) -- CLI subprocess patterns
- [OpenCode reliability issues](https://github.com/anomalyco/opencode/issues/13851) -- hangs, exit code 0 on errors
