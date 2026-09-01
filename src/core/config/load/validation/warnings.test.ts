import { describe, expect, it } from 'vitest';
import { securityWarnings } from './warnings.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

describe('securityWarnings', () => {
  it('reports nothing for runners that pass the prompt through stdin', () => {
    expect(securityWarnings(makeConfig())).toEqual([]);
  });

  it('warns about a {prompt} argv placeholder on every runner seat', () => {
    const placeholderRunner = {
      kind: 'agent' as const,
      command: './agent',
      args: ['--prompt', '{prompt}'],
      model: 'agent-default',
    };

    const warnings = securityWarnings(
      makeConfig({
        planner: placeholderRunner,
        reviewer: placeholderRunner,
        implementer: placeholderRunner,
      }),
    );

    for (const label of ['planner', 'reviewer', 'implementer']) {
      expect(warnings).toContainEqual(expect.stringContaining(`${label}.args contains {prompt}`));
    }
  });

  it('names the profile in a {prompt} argv warning from an implementer profile', () => {
    const warnings = securityWarnings(
      makeConfig({
        implementerProfiles: {
          default: 'scripted',
          profiles: {
            scripted: {
              kind: 'shell',
              command: './run',
              args: ['--prompt={prompt}'],
              model: 'local-shell',
            },
          },
        },
      }),
    );

    expect(warnings).toContainEqual(
      expect.stringContaining('implementer profile scripted.args contains {prompt}'),
    );
  });

  it.each([
    { name: 'plain bash -c', command: 'bash', args: ['-c', 'printf "%s" "{prompt}"'] },
    {
      name: 'bash with options before -c',
      command: 'bash',
      args: ['--noprofile', '-c', 'printf "%s" "{prompt}"'],
    },
    { name: 'bash combined flags', command: 'bash', args: ['-lc', 'printf "%s" "{prompt}"'] },
    { name: 'sh combined flags', command: 'sh', args: ['-ec', 'printf "%s" "{prompt}"'] },
  ])(
    'warns harder when {prompt} reaches a shell-evaluated argument: $name',
    ({ command, args }) => {
      const warnings = securityWarnings(
        makeConfig({
          implementer: {
            kind: 'shell',
            command,
            args,
            model: 'local-shell',
          },
        }),
      );

      expect(warnings).toContainEqual(
        expect.stringContaining(`implementer.args passes {prompt} through ${command} -c`),
      );
      expect(warnings).toContainEqual(expect.stringContaining('shell-evaluate prompt text'));
    },
  );
});
