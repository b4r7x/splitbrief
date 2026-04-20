import { Command } from 'commander';

export function addWorkflowOptions(cmd: Command): Command {
  return cmd
    .option('--auto', 'Auto-approve spec and plan')
    .option('--model <model>', 'Override implementer model (alias for --implementer-model)')
    .option('--provider <provider>', 'Override implementer provider (alias for --implementer)')
    .option('--planner <tool>', 'Planner tool (claude-code, codex, opencode, aider, copilot, kilo-code, agent-sdk, anthropic, openrouter, shell)')
    .option('--planner-model <model>', 'Planner model (for API planners)')
    .option('--planner-command <cmd>', 'Custom planner command (when --planner=shell)')
    .option('--implementer <provider>', 'Implementer provider (ollama, lm-studio, deepseek, openrouter, claude-code, codex, opencode, aider, copilot, kilo-code, shell)')
    .option('--implementer-model <model>', 'Implementer model')
    .option('--implementer-command <cmd>', 'Custom implementer command (when --implementer=shell)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--no-fullscreen', 'Disable fullscreen alternate screen buffer')
    .option('--no-mouse', 'Disable mouse tracking')
    .option('--mode <mode>', 'Workflow mode: quick, standard, or full')
    .option('--budget <amount>', 'Maximum budget in dollars (e.g., 2.00)', parseFloat)
    .option('--allow-hooks', 'Trust hook config without prompting (use in CI)', false)
    .option('--json', 'Headless mode: emit each EngineEvent as NDJSON to stdout, skip TUI render', false)
    .option('--otel-exporter <name>', 'Bootstrap an OTel exporter (currently only "console"); requires otel.enabled in config');
}
