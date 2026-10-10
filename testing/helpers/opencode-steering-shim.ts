import { join } from 'node:path';
import { writeFakeNodeCli } from './command-shim.js';

export type OpencodeSteeringShimMode =
  | 'tool'
  | 'repeated'
  | 'late'
  | 'unconsumed'
  | 'reject'
  | 'disconnect'
  | 'abort'
  | 'no-url'
  | 'no-password'
  | 'serve-exit'
  | 'server-exit'
  | 'protocol-failure'
  | 'error-secret';

export function installOpencodeSteeringShim(dir: string, mode: OpencodeSteeringShimMode = 'tool') {
  const captureFile = join(dir, 'opencode-run.json');
  const serverFile = join(dir, 'opencode-server.json');
  const requestsFile = join(dir, 'opencode-requests.jsonl');
  const password = 'sidecar-credential-1234567890';
  const executable = writeFakeNodeCli(
    dir,
    'opencode',
    `
const fs = require('node:fs');
const http = require('node:http');
const mode = ${JSON.stringify(mode)};
const password = ${JSON.stringify(password)};
const requestsFile = ${JSON.stringify(requestsFile)};
const args = process.argv.slice(2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const environment = {
  xdgConfig: process.env.XDG_CONFIG_HOME,
  xdgData: process.env.XDG_DATA_HOME,
  auth: process.env.XDG_DATA_HOME && fs.existsSync(process.env.XDG_DATA_HOME + '/opencode/auth.json') ? fs.readFileSync(process.env.XDG_DATA_HOME + '/opencode/auth.json', 'utf8') : undefined,
  unrelatedSecret: process.env.UNRELATED_HOST_SECRET,
};
if (args[0] === 'serve') {
  fs.writeFileSync(${JSON.stringify(serverFile)}, JSON.stringify({pid:process.pid, home:process.env.HOME, cwd:process.cwd(), args, ...environment}));
  if (mode === 'serve-exit') process.exit(7);
  let inbox = [];
  const messages = [];
  let nextId = 0;
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + password).toString('base64')) {
      respond(401, {error:'password required'}); return;
    }
    if (req.method === 'POST' && req.url === '/api/session/ses-steering/prompt') {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      fs.appendFileSync(requestsFile, JSON.stringify(input) + '\\n');
      if (mode === 'reject') { respond(500, {error:password}); return; }
      if (mode === 'disconnect') { req.socket.destroy(); return; }
      const item = {id:'msg-' + (++nextId), text:input.text, delivery:input.delivery};
      inbox.push(item);
      if (mode === 'server-exit') setTimeout(() => process.exit(8), 50);
      if (mode === 'late') await sleep(300);
      respond(200, {data:{id:item.id}}); return;
    }
    if (req.url === '/api/session/ses-steering/inbox') {
      if (mode === 'unconsumed') {
        await sleep(300);
        inbox = [];
      }
      respond(200, {data:inbox.map(item => ({id:item.id}))}); return;
    }
    if (req.url === '/consume') {
      const consumed = inbox; inbox = []; messages.push(...consumed.map(item => ({id:item.id, type:'user', text:item.text, time:{created:Date.now()}, files:[]}))); respond(200, {data:consumed}); return;
    }
    if (req.url === '/api/session/ses-steering/message') { respond(200, {data:messages.toReversed(), cursor:null}); return; }
    if (req.url.startsWith('/api/session/ses-steering/message/')) {
      const messageID = decodeURIComponent(req.url.split('/').at(-1));
      const message = messages.find(item => item.id === messageID);
      if (message === undefined) {
        respond(404, {_tag:'MessageNotFoundError', sessionID:'ses-steering', messageID, message:'Message not found: ' + messageID}); return;
      }
      respond(200, {data:message}); return;
    }
    respond(404, {});
  });
  server.listen(0, '127.0.0.1', () => {
    if (mode !== 'no-url') console.log('server listening on http://127.0.0.1:' + server.address().port);
    if (mode !== 'no-password') console.log('server password ' + password);
    setInterval(() => console.log('server draining ' + password), 50);
  });
} else {
  const serverIndex = args.indexOf('--server');
  const url = serverIndex < 0 ? null : args[serverIndex + 1];
  fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({pid:process.pid, home:process.env.HOME, cwd:process.cwd(), args, password:process.env.OPENCODE_PASSWORD, ...environment}));
  const emit = value => console.log(JSON.stringify({sessionID:'ses-steering', ...value}));
  const text = value => emit({type:'text',part:{type:'text',text:value}});
  const usage = () => emit({type:'step_finish',part:{type:'step-finish',tokens:{input:10,output:5}}});
  if (url === null) { text('standalone'); usage(); }
  else if (process.env.OPENCODE_PASSWORD !== password) { console.error('set OPENCODE_PASSWORD'); process.exit(1); }
  else {
    const headers = {authorization:'Basic ' + Buffer.from('opencode:' + password).toString('base64')};
    emit({type:'tool_use',part:{type:'tool',callID:'tool',tool:'bash',state:{status:'running',input:{command:'sleep'}}}});
    if (mode === 'abort' || mode === 'server-exit') setInterval(() => {}, 1000);
    else (async () => {
      if (mode === 'late' || mode === 'unconsumed') {
        while (!fs.existsSync(requestsFile)) await sleep(10);
        text('ended'); usage(); process.exit(0);
      }
      if (mode === 'protocol-failure') {
        await sleep(100); emit({type:'error',error:{message:'failed'}});
        text('unsolicited'); setInterval(() => {}, 1000); return;
      }
      if (mode === 'error-secret') {
        emit({type:'error',error:{message:'failure ' + password}}); process.exit(1);
      }
      if (mode === 'tool' || mode === 'repeated') {
        while (!fs.existsSync(requestsFile) || fs.readFileSync(requestsFile,'utf8').trim().split('\\n').length < (mode === 'repeated' ? 2 : 1)) await sleep(10);
      }
      await sleep(150);
      const consumed = await (await fetch(url + '/consume', {headers})).json();
      emit({type:'tool_result',part:{type:'tool',callID:'tool',tool:'bash',state:{status:'completed',input:{command:'sleep'},output:'done'}}});
      text(consumed.data.map(item => item.text).join('|') || 'done');
      text(password);
      console.error('diagnostic ' + password);
      emit({type:'unknown_' + password});
      usage();
      await sleep(200);
    })().catch(err => { console.error(err.message); process.exit(1); });
  }
}
`,
  );
  return { executable, captureFile, serverFile, requestsFile, password };
}
