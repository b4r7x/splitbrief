# Security policy

## Report a vulnerability

Report a vulnerability privately through GitHub:

1. Open the [Security tab](https://github.com/b4r7x/splitbrief/security) of `b4r7x/splitbrief`.
2. Select **Report a vulnerability**.
3. Fill in the form and submit it.

The report stays private between you and the maintainers. Do not open a public issue, pull request or discussion for a vulnerability.

## What to include

- The SPLITBRIEF version (`splitbrief --version`), your operating system and your Node.js version.
- The seat configuration that the problem needs: the runner kinds and tools, without credentials.
- The steps that reproduce the problem, and what an attacker gains.
- Logs or a `session.jsonl` excerpt, if they help. Remove API keys, tokens and private source code first.

## Scope

SPLITBRIEF runs coding tools, checks and hooks on your machine with your permissions. In worktree and staged-copy mode, the run workspace keeps the run's changes out of your checkout until you apply them. SPLITBRIEF does not isolate the file system, the network or other processes from a check ([CONFIGURATION.md](./docs/CONFIGURATION.md#what-a-check-can-reach)). These are examples of a vulnerability in SPLITBRIEF:

- A secret reaches a check, a hook, a log or a seat that SPLITBRIEF says it keeps out.
- In worktree or staged-copy mode, SPLITBRIEF writes a run's changes into your checkout before you apply them.
- A command runs that the reviewer command policy, the plan allowlist or the hook trust prompt says it refuses.
- An installed SPLITBRIEF agent skill runs a command that you did not ask for.

A defect in a coding tool that SPLITBRIEF runs belongs to that tool's own project.
