import { join } from 'node:path';

export const CLI_HELP_FIXTURES = join(import.meta.dirname, '../fixtures/cli-help');

export const CODEX_HELP = [
  'Usage: codex exec [OPTIONS]',
  '  -c, --config <key=value>              Override a configuration value',
  '          Examples: - `-c model="o3"` - `-c shell_environment_policy.inherit=all`',
  '      --enable <FEATURE>                Enable a feature (repeatable)',
  '          Equivalent to `-c features.<name>=true`',
  '  --model <MODEL>                       Model to use',
  '  --json                                Emit JSON output',
  '  --sandbox <SANDBOX_MODE>              Sandbox policy',
  '  --ask-for-approval <APPROVAL_POLICY>  Approval policy',
  '  --ignore-user-config                  Do not load the user config',
  '  --ignore-rules                        Do not load rules files',
  '  --ephemeral                           Run without persisting sessions',
  '  --skip-git-repo-check                 Allow running outside a git repo',
  '  -C, --cd <DIR>                        Working directory',
].join('\n');
