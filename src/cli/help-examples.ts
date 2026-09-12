export const HELP_EXAMPLES = `
Examples:

  Quick start (shorthand — no subcommand needed):
    $ splitbrief "add user authentication with OAuth2"
    $ splitbrief "fix the broken pagination on /users endpoint"
    $ splitbrief "refactor database queries to use connection pooling"

  With context files:
    $ splitbrief "implement the auth flow" @design.md @screenshot.png
    $ splitbrief "fix this bug" @error-log.txt @repro-steps.md

  Workflow modes:
    $ splitbrief "rename variable" --mode quick
    $ splitbrief "add caching layer" --mode standard
    $ splitbrief "rebuild auth system" --mode speckit
    $ splitbrief spec "planning only" --mode quick

  Provider overrides:
    $ splitbrief "add tests" --planner anthropic --implementer ollama
    $ splitbrief "refactor models" --model qwen2.5-coder:32b
    $ splitbrief "complex migration" --planner-effort xhigh

  Headless:
    $ splitbrief "run migration" --json | jq .

  Explicit start (equivalent to shorthand):
    $ splitbrief start "add feature" --mode standard --approve none

  Other commands:
    $ splitbrief status
    $ splitbrief resume
    $ splitbrief doctor
`;
