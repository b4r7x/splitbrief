# Quickstart: tiny-spec v0.1

## Prerequisites

1. **Claude Code** installed and authenticated (Max 5x or higher plan)
2. **Ollama** running with a coding model:
   ```bash
   # Install Ollama (if not already)
   brew install ollama

   # Pull a coding model
   ollama pull qwen2.5-coder:7b

   # IMPORTANT: Set context length (default is only 2048!)
   export OLLAMA_CONTEXT_LENGTH=32768
   ```
3. **Node.js 22+** installed
4. **Git** initialized in your project

## Setup

```bash
# Install tiny-spec globally
npm install -g tiny-spec

# Navigate to your project
cd your-typescript-project

# Initialize configuration (auto-detects models)
tiny-spec init
```

## Usage

### Full Workflow (Plan + Implement)

```bash
# Start the full pipeline
tiny-spec start "add user authentication with JWT"

# What happens:
# 1. Claude Code (Opus) researches your codebase        [LEFT PANE]
# 2. Opus writes a detailed spec → you review            [LEFT PANE]
# 3. Opus breaks it into atomic tasks                     [LEFT PANE]
# 4. Each task is sent to your local model                [RIGHT PANE]
# 5. After each task: tsc → lint → test                   [RIGHT PANE]
# 6. Pass → commit + next task                            [RIGHT PANE]
# 7. Fail → retry (max 3) → escalate to Opus             [LEFT PANE]
# 8. After all tasks: Opus reviews the full diff          [LEFT PANE]
# 9. Summary: tasks done, escalated, time, savings        [STATUS BAR]
```

### Spec Only (No Implementation)

```bash
# Generate spec/plan/tasks for manual use
tiny-spec spec "add rate limiting"

# Use the generated tasks with any AI tool:
# - Claude Code: paste task prompts
# - Cursor/Aider: use as context
# - Manual implementation: follow the spec
```

### Auto Mode (No Approvals)

```bash
# Skip spec/plan approval prompts
tiny-spec start "add caching layer" --auto
```

### Resume After Interruption

```bash
# If you Ctrl+C or your session crashes:
tiny-spec resume
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Switch pane focus |
| `Enter` | Approve spec/plan |
| `e` | Open in editor |
| `s` | Skip task |
| `q` | Quit |

## Typical Results

For a medium-complexity feature (10-15 tasks):
- **Time**: ~15-30 minutes
- **Opus tokens used**: ~350K (planning + validation only)
- **Local model tasks**: ~70-85% completed without escalation
- **Extra cost**: $0 (uses existing Claude Code subscription + local model)
- **Effective value**: 2-2.5x your subscription

## Troubleshooting

**"Model not found"**: Run `ollama list` to see available models, then update `.tiny-spec/config.yaml`.

**Tasks keep failing**: Your model may be too small. Try `qwen3.5:27b` (Mac) or `qwen2.5-coder:14b`.

**"Context length exceeded"**: Set `OLLAMA_CONTEXT_LENGTH=32768` in your shell profile.

**Validation skipped**: Ensure `tsc` is available (`npx tsc --version`) and your project has a test command in `package.json`.
