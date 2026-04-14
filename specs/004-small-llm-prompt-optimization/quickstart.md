# Quickstart: diptych v0.2 -- Prompt Optimization

## What Changed in v0.2

Task prompts are now optimized for small models with limited context windows (8K-32K tokens):

1. **Inlined type definitions** -- every task includes the TypeScript types it needs
2. **Implementation steps** -- 3-5 steps describing HOW to implement, not just WHAT
3. **Few-shot example** -- system preamble shows the expected output format
4. **Retry with full context** -- all retry attempts keep signatures, types, tests, constraints
5. **Auto-degradation** -- large files use function-level context instead of whole-file
6. **8K minimum** -- works on 12GB VRAM cards with 7B models in Q4

## Supported Hardware

| VRAM | Model | Context | Config |
|------|-------|---------|--------|
| 8GB | Qwen 2.5 Coder 3B Q4 | 8K | `contextLength: 8192` |
| 12GB | Qwen 2.5 Coder 7B Q4 | 8-16K | `contextLength: 8192` |
| 16GB | Qwen 2.5 Coder 14B Q4 | 16-32K | `contextLength: 16384` |
| 32GB+ | Qwen 3.5 27B Q4 | 32K+ | `contextLength: 32768` |

## Configuration

Set your context length in `.diptych/config.yaml`:

```yaml
implementer:
  provider: ollama
  model: qwen2.5-coder:7b
  context_length: 8192   # Match your model's effective context
  temperature: 0.3
```

**IMPORTANT**: Also set Ollama's context length:
```bash
export DIPTYCH_CONTEXT_LENGTH=8192
```

## What Happens Under the Hood

When context is tight (8K), the formatter automatically adjusts:

```
Task for 50-line file  →  whole-file included (fits easily)
Task for 300-line file →  whole-file included (tight but fits)
Task for 500-line file →  function-level: only imports + target function
Task too large even then →  truncated with marker
```

You don't need to configure this -- it happens automatically based on `contextLength`.

## Verifying It Works

After running a workflow, check the events log:

```bash
# See token counts per task
grep '"type":"task_started"' .diptych/current/events.jsonl

# Check for any degradation warnings
grep '"type":"context_degraded"' .diptych/current/events.jsonl
```
