# After Apply: land the change of a supervised run

Use these steps after a supervised run ends with Apply. The run applied its change to its checkout: the main checkout or a clone of it. The steps take that change to the main branch with review, proofs, gates and renders.

## Roles

- The orchestrating session runs the steps and decides each finding.
- With delegation, each review, skeptic and fix is a fresh agent. Never reuse an agent for a second step.
- When a babysitter subagent supervised the run, it ends at its final record. The orchestrating session then runs these steps.
- Only the orchestrating session stages and commits, as the repository's agent instructions say. Agents never stage or commit.

## Steps

1. **Record the start.** Write down the run ID, the base commit of the run checkout and `git -C <checkout> diff --stat`.
2. **Review.** A fresh agent reviews the applied diff against the task file and the repository review bar. It writes each finding with the four points of "Reporting findings": evidence, cause at `file:line`, kind (`PRODUCT`, `TEST` or `ENV`) and what the user sees.
3. **Skeptic.** A different fresh agent tries to refute each finding against the current tree. Only the findings that it confirms go on.
4. **Fix.** A fresh agent fixes the confirmed findings in the run checkout.
   - Fix every confirmed finding in the run's own diff, of every class.
   - A finding that the run did not cause and that is class 2, class 3 or `TEST` goes to the debt list for a later run.
   - Each fix adds its test first and proves the red before the change.
   - Do steps 2 to 4 again until the skeptic confirms zero findings. Start no review while a fix agent works.
5. **Red.** Prove the red of each new test:
   - On the old tree: `git archive <base>` into a scratch directory, link `node_modules` from the checkout, add the new test files and their `testing/` support files, and run them.
   - For a test that pins a kept state: use a named mutant on a copy of the new tree. Take the mutant out and compare the file with `cmp`.
   - Keep each red output in a file.
6. **Green five times.** Run each touched test file five times in a row. All runs pass. A flaky test is a defect: find the race and fix it at the root.
7. **Gates.** Run `format:check`, `typecheck`, `lint`, `check:invariants` and `skills:check`, and the touched e2e files. Do not run test batches in parallel with other heavy runs.
8. **Renders.** Do the look-and-logic loop of the repository agent instructions for each changed scenario and its neighbours. Render before and after, write the critique and stop at zero open items.
9. **Commit in the run checkout.** The orchestrating session stages the change and commits with one sentence in the `/human-commit` style. Use one git command for each shell call. When the repository's agent instructions do not let the session commit, stop here and leave the change unstaged for the maintainer.
10. **Land on main.** When the run ran in a clone:
    - Fetch the commit into the main checkout.
    - Check the merge with `git merge-tree --write-tree --name-only --messages HEAD <commit>`.
    - Apply it with `git cherry-pick -n <commit>`.
    - In a `CHANGELOG.md` conflict, keep the lines of both sides. A later run puts its lines after the lines of an earlier run.
    - Run the main gates: the step 7 gates, the staged test files once, `npm run build`, the staged e2e files and the step 8 renders.
    - Commit on main.
11. **Release check.** After the last landing of a batch, run `npm run release-check` once on the main checkout. Then write the report.

## Order of several runs

Land the runs in the order that their task files name. Steps 1 to 9 of a later run can go first. Its step 10 starts only after the run before it is on main.

## Records

Keep the red outputs, the green outputs, the gate outputs and the render critiques in files. The report names each file, each commit and each finding with its kind and class.
