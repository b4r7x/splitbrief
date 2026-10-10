import { join } from 'node:path';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { GREET_FILE, GREET_SOURCE, MARKER_FILE, MARKER_SOURCE } from './stop-continue-fixture.js';

export type SteeringTool = 'claude-code' | 'opencode' | 'codex';

export function steeringPaths(directory: string, tool: SteeringTool) {
  return {
    started: join(directory, `${tool}-started`),
    finished: join(directory, `${tool}-finished`),
    release: join(directory, `${tool}-release`),
  };
}

function shimPrelude(directory: string, tool: SteeringTool) {
  const paths = steeringPaths(directory, tool);
  return `
const fs = require('node:fs');
const args = process.argv.slice(2);
const paths = ${JSON.stringify(paths)};
const record = entry => fs.appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))}, JSON.stringify({ tool: ${JSON.stringify(tool)}, pid: process.pid, ...entry }) + '\\n');
const emit = entry => console.log(JSON.stringify(entry));
const writeFiles = () => {
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  fs.writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
};
const hold = finish => {
  const timer = setInterval(() => {
    if (fs.existsSync(paths.release)) { clearInterval(timer); finish(); }
  }, 10);
  if (fs.existsSync(paths.release)) { clearInterval(timer); finish(); }
};
const finished = () => {
  fs.writeFileSync(paths.finished, '');
  record({ kind: 'finished' });
};
`;
}

export function installClaudeSteeringShim(directory: string, bin: string) {
  writeFakeNodeCli(
    bin,
    'claude',
    `${shimPrelude(directory, 'claude-code')}
const readline = require('node:readline');
if (args[0] === '--version') { console.log('claude 2.1.296'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (!args.includes('--input-format') || !args.includes('--replay-user-messages')) {
  throw new Error('Expected native Claude steering transport');
}
const lines = readline.createInterface({ input: process.stdin });
const echo = text => emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } });
let first = true;
let toolRunning = true;
lines.on('line', line => {
  const input = JSON.parse(line);
  if (input.type !== 'user' || input.message.role !== 'user') throw new Error('Unexpected Claude input');
  const text = input.message.content;
  if (first) {
    first = false;
    record({ kind: 'call', text, args });
    emit({ type: 'system', subtype: 'init', session_id: 'steer-e2e-claude' });
    echo(text);
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'build-tool', name: 'Bash', input: { command: 'build fixture' } }] } });
    fs.writeFileSync(paths.started, '');
    hold(() => {
      writeFiles(); finished();
      emit({ type: 'result', result: 'Greeting complete', usage: { input_tokens: 10, output_tokens: 5 } });
      lines.close(); process.stdin.destroy();
    });
    return;
  }
  record({ kind: 'steer', text, channel: 'stdin', beforeFinish: !fs.existsSync(paths.finished) });
  if (toolRunning) {
    toolRunning = false;
    emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'build-tool', content: 'done' }] } });
  }
  echo(text);
});
`,
  );
}

export function installCodexRefusalShim(directory: string, bin: string) {
  writeFakeNodeCli(
    bin,
    'codex',
    `${shimPrelude(directory, 'codex')}
if (args[0] === '--version') { console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (!args.includes('exec')) throw new Error('Unexpected Codex invocation');
const text = fs.readFileSync(0, 'utf8');
record({ kind: 'call', text, args });
record({ kind: 'refusal', text: 'Insufficient Balance' });
finished();
emit({ type: 'error', message: 'Insufficient Balance' });
process.exitCode = 1;
`,
  );
}

export function installOpencodeSteeringShim(directory: string, bin: string) {
  writeFakeNodeCli(
    bin,
    'opencode',
    `${shimPrelude(directory, 'opencode')}
const http = require('node:http');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const password = 'steer-e2e-sidecar-password';
const authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
const session = 'ses-steer-e2e';
if (args[0] === '--version') { console.log('${CLI_TOOL_CATALOG.opencode.compatibility.testedVersion}'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify([{ name: 'Anthropic', connections: [{ type: 'credential' }] }])); process.exit(0); }
if (args[0] === 'serve') {
  let inbox = [];
  const messages = [];
  let nextId = 0;
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== authorization) { respond(401, {}); return; }
    if (req.method === 'POST' && req.url === '/api/session/' + session + '/prompt') {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      if (input.delivery !== 'steer') { respond(400, {}); return; }
      const message = { id: 'msg-' + (++nextId), text: input.text };
      inbox.push(message);
      respond(200, { data: { id: message.id } }); return;
    }
    if (req.url === '/api/session/' + session + '/inbox') {
      respond(200, { data: inbox.map(({ id }) => ({ id })) }); return;
    }
    if (req.url === '/consume') {
      const consumed = inbox; inbox = []; messages.push(...consumed);
      respond(200, { data: consumed }); return;
    }
    const prefix = '/api/session/' + session + '/message/';
    if (req.url.startsWith(prefix)) {
      const id = decodeURIComponent(req.url.slice(prefix.length));
      const message = messages.find(message => message.id === id);
      respond(message === undefined ? 404 : 200, { data: message }); return;
    }
    respond(404, {});
  });
  server.listen(0, '127.0.0.1', () => {
    console.log('server listening on http://127.0.0.1:' + server.address().port);
    console.log('server password ' + password);
  });
} else {
  if (args[0] !== 'run' || !args.includes('--server') || args.includes('--standalone')) {
    throw new Error('Expected native OpenCode steering transport');
  }
  if (process.env.OPENCODE_PASSWORD !== password) throw new Error('Missing sidecar password');
  const url = args[args.indexOf('--server') + 1];
  const text = args[args.indexOf('--agent') + 2];
  record({ kind: 'call', text, args });
  const event = entry => emit({ sessionID: session, ...entry });
  event({ type: 'tool_use', part: { type: 'tool', callID: 'build-tool', tool: 'bash', state: { status: 'running', input: { command: 'build fixture' } } } });
  fs.writeFileSync(paths.started, '');
  (async () => {
    let consumed = [];
    while (consumed.length === 0 && !fs.existsSync(paths.release)) {
      const response = await fetch(url + '/consume', { headers: { authorization } });
      consumed = (await response.json()).data;
      if (consumed.length === 0) await delay(10);
    }
    for (const message of consumed) {
      record({ kind: 'steer', text: message.text, channel: 'http', beforeFinish: !fs.existsSync(paths.finished) });
    }
    event({ type: 'tool_result', part: { type: 'tool', callID: 'build-tool', tool: 'bash', state: { status: 'completed', input: { command: 'build fixture' }, output: 'done' } } });
    hold(() => {
      writeFiles(); finished();
      event({ type: 'text', part: { type: 'text', text: 'Greeting complete' } });
      event({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 10, output: 5 } } });
    });
  })().catch(cause => { console.error(cause); process.exit(1); });
}
`,
  );
}
