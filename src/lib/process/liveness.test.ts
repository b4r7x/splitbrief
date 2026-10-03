import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { hasLiveDescendants } from './liveness.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const leaders: ChildProcess[] = [];

afterEach(() => {
  for (const leader of leaders) {
    if (leader.pid === undefined) continue;
    try {
      process.kill(-leader.pid, 'SIGKILL');
    } catch {
      leader.kill('SIGKILL');
    }
  }
  leaders.length = 0;
});

function spawnLeader(script: string): ChildProcess {
  const leader = spawn(process.execPath, ['-e', script], { stdio: 'ignore', detached: true });
  leaders.push(leader);
  return leader;
}

describe('hasLiveDescendants', () => {
  itUnix('reports a leader with a sleeping child as live', async () => {
    const leader = spawnLeader(
      "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000);",
    );
    await once(leader, 'spawn');

    const deadline = Date.now() + 5_000;
    while (!hasLiveDescendants(leader.pid ?? 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(hasLiveDescendants(leader.pid ?? 0)).toBe(true);
  });

  itUnix('reports a leader with no child as not live', async () => {
    const leader = spawnLeader('setInterval(() => {}, 1000);');
    await once(leader, 'spawn');

    expect(hasLiveDescendants(leader.pid ?? 0)).toBe(false);
  });
});
