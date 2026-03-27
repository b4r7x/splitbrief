# What to Work on Next

**Last updated**: 2026-03-27
**Branch**: `008-tui-conversation-flow`
**Context**: Load `/tiny-spec-dev` skill first, then read this file.

## What Just Happened

TUI conversation flow redesign implemented (47 tasks, 402 tests pass). The dual-pane raw text layout is replaced with a single-column conversation flow showing structured event cards, collapsible diffs, pipeline progress bar, and real-time cost savings footer.

## Decision: Full TUI Redesign (2026-03-27)

After extensive research and discussion, we decided to **replace the dual-pane raw text layout** with a **single-column conversation flow** with structured event cards.

### Why

The current TUI has fundamental UX problems:
1. **No visible collaboration** — planner and implementer are two independent text logs
2. **No pipeline visibility** — `Phase: implementing` is a string, not a visual flow
3. **No code display** — implementer generates code but it's shown as plain text, no diff
4. **No cost savings visibility** — the entire USP (50%+ savings) is invisible to the user
5. **Escalation is invisible** — the most valuable moment (planner helping stuck implementer) looks like any other line

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Layout | Single-column conversation flow | Shows dialog between roles naturally |
| Planner output | Conversational text | Planner thinks — show the thinking |
| Implementer output | Structured tool-call cards | Implementer executes — show operations |
| Code display | Collapsible diff (summary default) | Clean by default, detail on demand |
| Completed tasks | Collapse to 1 line | Prevent scroll overload |
| Pipeline | Sticky header progress bar | Always visible: `● res → ● spec → ◉ impl` |
| Cost savings | Sticky footer | Always visible: `Local: 75% │ Saved: $1.40` |
| Framework | Stay on Ink 5.x | Works, known, React. OpenTUI later if needed |
| Callback system | Full replace → structured events | `TuiEvent` union type replaces `string[]` |
| Constitution | v1.3.0 | Beautiful orchestration UX = product identity |

### Research References

- [Pragmatic Engineer Survey 2026](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026) — devs prefer structured output over raw streams
- ["Terminal Is All You Need" (arxiv)](https://arxiv.org/html/2603.10664) — transparency + representational compatibility
- [Anthropic: Effective Harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — progress files, feature decomposition
- [Google: Refining Coding UX](https://developers.googleblog.com/en/unleash-your-development-superpowers-refining-the-core-coding-experience/) — collapsible code blocks
- Competitive analysis: Claude Squad, Conduit, Ralph TUI, AgentPipe, OpenCode, Codex CLI

### Target Layout

```
┌─ sticky header ──────────────────────────────────────────────────────┐
│ tiny-spec │ feature name │ ● res ● spec ● plan ◉ impl ○ rev │ 04:12│
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ● Planner researching... (conversational text)                      │
│  ● Planner spec ready [approve/edit/comment]                         │
│  ● Planner plan: 8 tasks                                            │
│                                                                      │
│  ✓ T1 auth middleware — local, 12s                                   │
│  ✓ T2 JWT utils — local, 8s                                         │
│  ─── T3: Login endpoint ──────────────────────                       │
│  ⚡ implementer.generate(qwen2.5-coder:7b)          12s              │
│    → src/routes/auth.ts (+47 lines)             [d] diff             │
│  ⚡ validate(tsc, lint, test)                        ✓ 7s            │
│  ⚡ git.commit("feat(auth): login endpoint")         1s              │
│  ─── T4: Register (active) ──────────────────────                    │
│  ⚡ implementer.generate(qwen2.5-coder:7b)          running...       │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ Task 4/8 │ Local: 75% │ $0.02 │ Saved: ~$1.40 │ qwen2.5-coder:7b  │
└──────────────────────────────────────────────────────────────────────┘
```

## Priority Order

1. ~~**TUI redesign**~~ — DONE (47 tasks, 402 tests, all 7 user stories implemented)
2. **End-to-end battle-test** — Run the full pipeline with real Claude Code + Ollama to validate the new conversation flow in practice
3. Token dashboard, integration tests
4. Multi-language support

## Key Files to Understand

| File | What it does | Why it matters for redesign |
|------|-------------|---------------------------|
| `src/app.tsx` | Root TUI component | Wires orchestrator callbacks → TUI state. Full rewrite needed. |
| `src/tui/layout.tsx` | Dual-pane layout | **Replace** with conversation flow layout |
| `src/tui/pane.tsx` | Scrollable text pane | **Replace** with event card renderer |
| `src/tui/header.tsx` | Feature + timer | **Extend** with pipeline progress bar |
| `src/tui/status-bar.tsx` | Phase/task/model | **Redesign** with cost savings display |
| `src/tui/prompt.tsx` | Approval prompts | Keep, integrate inline in flow |
| `src/types.ts` | All shared types | Add `TuiEvent` union type |
| `src/orchestrator/orchestrator.ts` | Main workflow loop | Emit structured events instead of text |

## Conversation History Summary

The owner wants tiny-spec to feel alive — to show the planner/implementer collaboration visually. Not another multi-agent coordinator, but a cost optimizer with state-of-the-art UX. The dual-pane raw text layout is being replaced because it hides the product's core value.
