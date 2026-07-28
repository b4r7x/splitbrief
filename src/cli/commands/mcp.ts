import type { Command } from 'commander';
import { loadConfigOrExit, resolveProjectDir } from '../setup.js';
import { resolveSessionIds } from '../../engine/mcp/discovery.js';
import { generateToken } from '../../engine/mcp/auth-token.js';
import { createResolver } from '../../engine/mcp/resolver.js';
import { startMcpServer } from '../../engine/mcp/server.js';
import { createToolHandler } from '../../engine/mcp/tool/handler.js';
import { getSplitbriefVersion } from '../../core/paths-io.js';
import { cliError, withCliErrors } from '../errors.js';
import { resolveSessionAlias } from '../sessions/aliases.js';

const DEFAULT_PORT = 4321;

export type McpDeps = {
  startMcpServer: typeof startMcpServer;
};

const defaultDeps: McpDeps = {
  startMcpServer,
};

export function registerMcpCommand(program: Command, deps: McpDeps = defaultDeps): void {
  const mcp = program.command('mcp').description('MCP resource and evidence-tool server commands');

  mcp
    .command('serve')
    .description('Start an MCP server for project resources and evidence tools')
    .option('--port <number>', 'Port to listen on', String(DEFAULT_PORT))
    .option('--session <id>', 'Serve only this session')
    .option('--all-sessions', 'Serve all sessions in the project')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(
      async (opts: {
        port?: string;
        session?: string;
        allSessions?: boolean;
        project?: string;
      }) => {
        const projectDir = resolveProjectDir(opts.project);

        if (opts.session !== undefined && opts.allSessions) {
          throw cliError('--session and --all-sessions are mutually exclusive.', 1);
        }

        const rawPort = opts.port ?? String(DEFAULT_PORT);
        const port = Number.parseInt(rawPort, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort) {
          throw cliError(
            `Invalid --port: "${rawPort}". Must be an integer between 1 and 65535.`,
            1,
          );
        }

        const session = await resolveSessionAlias(opts.session, projectDir);
        const sessionIds = await withCliErrors(() =>
          resolveSessionIds(projectDir, {
            ...(session !== undefined && { session }),
            ...(opts.allSessions && { allSessions: opts.allSessions }),
          }),
        );

        const token = generateToken();
        const splitbriefVersion = getSplitbriefVersion();
        const persistTranscript = loadConfigOrExit(projectDir).config.workflow.persistTranscript;
        const resolver = createResolver({
          projectDir,
          sessionIds,
          splitbriefVersion,
          persistTranscript,
        });
        const toolHandler = createToolHandler(projectDir, sessionIds);

        const handle = await withCliErrors(() =>
          deps.startMcpServer({
            port,
            host: '127.0.0.1',
            token,
            resolver,
            serverVersion: splitbriefVersion,
            toolHandler,
          }),
        );

        const actualPort = handle.port;
        const sessionsLabel = opts.allSessions ? 'all' : sessionIds.join(', ');

        process.stdout.write(
          [
            'SPLITBRIEF MCP server ready',
            `  Exposes session resources and ${toolHandler.listTools().length} evidence tools.`,
            '',
            `  URL:    http://127.0.0.1:${actualPort}/mcp`,
            `  Token:  ${token}`,
            `  Sessions: ${sessionsLabel}`,
            '',
            'To configure in Claude Code (.claude/settings.json):',
            '  {',
            '    "mcpServers": {',
            '      "splitbrief": {',
            '        "type": "http",',
            `        "url": "http://127.0.0.1:${actualPort}/mcp",`,
            `        "headers": { "Authorization": "Bearer ${token}" }`,
            '      }',
            '    }',
            '  }',
            '',
            'Press Ctrl+C to stop.',
            '',
          ].join('\n'),
        );

        const shutdown = async () => {
          await handle.close();
          process.exit(0);
        };

        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
      },
    );
}
