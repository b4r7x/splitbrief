export const HELP_EXAMPLES = `
Examples:

  Quick start (shorthand — no subcommand needed):
    $ diptych "add user authentication with OAuth2"
    $ diptych "fix the broken pagination on /users endpoint"
    $ diptych "refactor database queries to use connection pooling"

  With context files:
    $ diptych "implement the auth flow" @design.md @screenshot.png
    $ diptych "fix this bug" @error-log.txt @repro-steps.md

  Workflow modes:
    $ diptych "rename variable" --mode instant
    $ diptych "add caching layer" --mode quick
    $ diptych "rebuild auth system" --mode speckit

  Provider overrides:
    $ diptych "add tests" --planner anthropic --implementer ollama
    $ diptych "refactor models" --model qwen2.5-coder:32b
    $ diptych "complex migration" --planner-effort xhigh

  Worktrees (isolated branches):
    $ diptych "add payments" --worktree payments
    $ diptych "experimental refactor" --worktree

  Background / headless:
    $ diptych "generate API docs" --detach
    $ diptych "run migration" --json | jq .

  Explicit start (equivalent to shorthand):
    $ diptych start "add feature" --mode standard --auto

  Other commands:
    $ diptych status
    $ diptych resume
    $ diptych doctor
`;
