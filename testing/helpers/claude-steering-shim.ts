import { join } from 'node:path';
import { writeFakeNodeCli } from './command-shim.js';

export function installClaudeSteeringShim(
  dir: string,
  mode: 'tool' | 'follow-up' | 'exit' | 'abort' | 'unsolicited' | 'repeated' = 'tool',
): { executable: string; stdinFile: string; argvFile: string } {
  const stdinFile = join(dir, 'steering-stdin.jsonl');
  const argvFile = join(dir, 'steering-argv.json');
  const executable = writeFakeNodeCli(
    dir,
    'claude',
    `
const fs = require('node:fs');
const readline = require('node:readline');
const mode = ${JSON.stringify(mode)};
const stdinFile = ${JSON.stringify(stdinFile)};
fs.writeFileSync(stdinFile, '');
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
const emit = value => console.log(JSON.stringify(value));
const result = (text, input, output) => emit({type:'result',result:text,structured_output:{answer:text},usage:{input_tokens:input,output_tokens:output}});
const echo = text => emit({type:'user',parent_tool_use_id:null,message:{role:'user',content:text}});
const init = () => emit({type:'system',subtype:'init',session_id:'steering-session'});
if (!process.argv.includes('--input-format')) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => text += chunk);
  process.stdin.on('end', () => { fs.writeFileSync(stdinFile, text); result('old',10,5); });
} else {
  const lines = readline.createInterface({input:process.stdin});
  const steers = [];
  let first = true;
  lines.on('line', line => {
    fs.appendFileSync(stdinFile, line + '\\n');
    const text = JSON.parse(line).message.content;
    if (first) {
      first = false;
      init(); echo(text);
      emit({type:'assistant',message:{content:[{type:'tool_use',id:'tool',name:'Bash',input:{command:'sleep'}}]}});
      return;
    }
    steers.push(text);
    if (mode === 'exit') { process.exit(0); }
    if (mode === 'abort') return;
    if (mode === 'repeated' && steers.length < 2) return;
    if (mode === 'follow-up') {
      result('first',10,5);
      setTimeout(() => {
        init(); echo(text);
        emit({type:'assistant',message:{id:'second',content:[{type:'text',text:'last'}],usage:{input_tokens:3,output_tokens:0}}});
        result('last',3,7);
      }, 30);
    } else {
      emit({type:'user',parent_tool_use_id:null,message:{content:[{type:'tool_result',tool_use_id:'tool'}]}});
      for (const steer of steers) echo(steer);
      result('last',10,5);
      if (mode === 'unsolicited') init();
    }
  });
}
`,
  );
  return { executable, stdinFile, argvFile };
}
