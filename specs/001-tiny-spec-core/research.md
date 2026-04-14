# Research Summary: diptych

## The Problem

Claude Code Max 20x costs $200/mo. Max 5x costs $100/mo but has lower limits.
~55-60% of tokens in a typical Claude Code session go to implementation (writing code).
Only ~30% goes to planning + validation (where Opus quality actually matters).

## The Solution (Validated by Research)

Use Opus for research/spec/plan/validation. Use cheap/local models for implementation.

- **Self-Planning Code Generation** (ACM TOSEM): +25.4% Pass@1 improvement over direct generation
- **Aider architect/editor**: R1+Sonnet at 14x less cost scores higher than either alone
- **DisCIPL (MIT)**: Near-o1 quality at 1000-10,000x lower cost
- **Claude Code `opusplan`**: Built-in simple version of this pattern

## Best Small Models for Implementation (March 2026)

### For RTX 4070 Ti S (12GB VRAM)
- **Qwen 2.5 Coder 7B** (Q4, ~5GB): 88.4% HumanEval, best FIM/autocomplete
- **Qwen 3.5 9B** (Q4, ~6.6GB): Strong general + coding, 262K context
- **Devstral Small 2 24B** won't fit; **Qwen3-Coder-Next** (80B total) won't fit

### For Mac M4 32GB
- **Qwen 3.5 27B** (Q4, ~16GB): 72.4% SWE-bench, best dense model under 35B
- **Qwen 2.5 Coder 14B** (Q4, ~9GB): Great coding, fits easily

### Via API (near-free)
- **DeepSeek V3.2**: $0.28/M input, $0.42/M output. 73% SWE-bench
- **Qwen3 Coder 480B on OpenRouter**: Free tier available
- **Ollama Cloud**: $20-100/mo subscription, not per-token

## Optimal Spec Format for Small Models

Research-validated format: **Markdown + YAML frontmatter**
- 16% more token-efficient than JSON
- 62% accuracy on hierarchical data (YAML) vs 50% (JSON)
- Self-contained tasks (inline all context, never reference external files)
- One function per task for models <15B
- Concrete test cases with actual values (not Gherkin)
- Whole-function replacement over surgical diffs

## Tool Integration

### OpenCode
- Supports Ollama, LM Studio, llama.cpp via `@ai-sdk/openai-compatible`
- Has Plan/Build agent split
- Headless mode: `opencode run "prompt"`
- Config in `opencode.json` with custom providers

### Claude Code
- `ANTHROPIC_BASE_URL` for custom endpoints
- Three model slots: SONNET, OPUS, HAIKU (all configurable)
- `opusplan` mode: Opus for planning, Sonnet for implementation
- MCP server support for tool integration

### Ollama API
- OpenAI-compatible at `/v1/chat/completions`
- Tool calling supported (Qwen, Llama, Mistral)
- Structured output via JSON Schema in `format` field
- Default context only 2048 tokens -- must set `num_ctx` explicitly
- Performance on M4 32GB: 9B ~40-55 tok/s, 27B ~18-25 tok/s

### LM Studio
- OpenAI + Anthropic compatible endpoints
- MLX backend for Apple Silicon (26-30% faster than llama.cpp)
- Tool calling support (beta quality)

## Validation Pipeline

Research-validated order (fastest/cheapest first):
1. Parse/Compile (~0.1s, free)
2. Lint + Format (~1s, free)
3. Type Check (~2-5s, free)
4. Static Analysis (~5-10s, free)
5. Test Execution (~10-60s, free)
6. Opus Review (~30s, expensive) -- only for code that passes 1-5

Max 3 retries at automated gates. If same error persists across retries, escalate.

## Code Edit Formats for Small Models

- **Whole file**: Most reliable for <15B models, but expensive in tokens
- **Search/Replace**: Good for 15-35B, needs fuzzy matching on apply side
- **Unified diff**: Poor for small models (hunk headers too complex)
- For 7-9B models on RTX 4070 Ti S: use whole-file for files <200 lines

## Key Architecture Decisions

1. **Two-pane TUI** (like tmux): Left = Claude Code, Right = OpenCode
2. **Orchestrator** manages workflow state machine
3. **Spec files** committed to git as source of truth
4. **Each task = one commit** for atomic rollback
5. **Git worktrees** for parallel task execution (future)
6. **MCP integration** possible but not MVP
