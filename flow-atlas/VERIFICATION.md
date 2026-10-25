# Flow Atlas — weryfikacja sceptyka

Data: 2026-10-25. Rola: niezależny sceptyk (CLAUDE.md „Reporting findings”). Każdy werdykt opiera się na kodzie przeczytanym teraz w drzewie roboczym, nie na plikach atlasu ani na docs. Plik `runners.js` pominięty (w trakcie pisania).

Skróty: CONF = potwierdzone, REF = obalone, PART = częściowo. Kind: PRODUCT / TEST / ENV; klasa 1 blokuje pracę lub daje zły wynik, 2 mylący tekst, 3 kosmetyka.

## Część A — 19 roszczeń

### Kandydaci na defekt produktu

| # | Roszczenie | Werdykt | Dowód (plik:linia) | Kind / klasa · co widzi użytkownik |
|---|---|---|---|---|
| 1 | Headless `start --json/--plain` i headless resume nie wołają `ensureHooksTrusted`; `--allow-hooks` nic nie udziela; hook `pre_planning` odrzuca planowanie | **CONF** | `ensureHooksTrusted` wołane tylko z `src/cli/bootstrap/init.ts:22` (`initStores*`), `src/cli/commands/spec.ts:123`. `src/cli/commands/start/streaming.ts:21-47` woła `setupWorkflow`, `ensureHeadlessConfig`, `prepareStartExecution`, `runHeadless` — żadne nie woła trustu (grep `ensureHooksTrusted\|markHooksConfigTrusted` w `src/`: tylko `hook-trust-prompt.ts`, `init.ts`, `spec.ts`). `src/cli/commands/continue/resume.ts:113-123`: gałąź headless wraca przed `deps.initStores` (:139). `allowHooks` trafia tylko do `prepared.runtime.allowHooks` (`prepare-execution.ts:430`), które czyta jedynie `headlessResumePolicy` (`headless.ts:299`) — znów do policy, nigdzie do trustu. W runie `runPreHooks` (`src/engine/hooks/run-pre.ts:25-28`) zwraca `allow: false` z `hookTrustRefusal` (`dispatch.ts:28-33`), a `phases.ts:95-101` publikuje `pre_planning blocked: …` i `session.ts:318-320` kończy planowanie `cancelled`. Headless kończy `Workflow did not complete — the run stopped early.` exit 1 (`headless.ts:229-234`). | **PRODUCT · 1**. Użytkownik z `hooks:` w config i CI z `--allow-hooks` (jak każe `docs/CLI-REFERENCE.md:136,193`, `docs/HOOKS-CONFIG.md:265`) dostaje run, który kończy się na pierwszym hooku z komunikatem „hook configuration or hook files changed after trust; re-run with --allow-hooks” — mimo że flagę podał. |
| 2 | Na runie ready-to-apply notka composera mówi „⏎ on an empty line goes home”, a pusty ⏎ przenosi fokus do menu wyniku | **CONF** | `src/features/workflow/at-rest.ts:156` — `commandsOnly: !continuable`; ready nie jest `open`, więc `commandsOnly = true`. `src/components/composer/composer.tsx:79` tekst notki; `:576-581` i `:564-567` pokazują ją przy literze i przy wysłaniu. `src/app/screens/workflow.tsx:539-541`: `onEmptySubmit` przy `resultMenuOpen` = `setResultFocus({ menu: true })`, nie home. | **PRODUCT · 2**. Po wpisaniu litery na runie ready użytkownik czyta, że ⏎ wraca na home; ⏎ otwiera fokus menu Apply/Show diff/Discard. |
| 3 | `post_task: npx prettier --write ${event.file}` z docs dostaje pusty string, bo `task_completed` nie ma `file` | **CONF** | `src/engine/hooks/sink.ts:106-108` — `post_task` odpala się na `task_completed`; schema `src/engine/events/schema.ts:517-526` nie ma pola `file`; `substitute.ts:14` zwraca `''` dla `undefined`. Docs: `docs/HOOKS-CONFIG.md:16,34,62,128` obiecują `file`. | **PRODUCT · 2** (zły tekst docs i tabela pól); skutek: hook z przykładu dostaje `--write ""` i nic nie formatuje, a użytkownik widzi ostrzeżenie hooka. |
| 4 | Edycja skryptu hooka w trakcie runu: recheck trustu odmawia; każdy kolejny `pre_task` pomija brief „po cichu” | **PART** | Odmowa: `hashHooksConfig` hashuje pliki hooków (`trust-digest.ts:267,321`), `isHooksConfigTrusted` porównuje digest (`trust.ts:67`), `run-pre.ts:25-28` zwraca `allow: false`. Pominięcie briefu: `pre-task.ts:66-79` → `skipBrief`. **Nie „po cichu”**: `pre-task.ts:67-71` publikuje `warning` `pre_task blocked: …` (wiersz transkryptu, `event-rows/dispatch.ts:511`), a `skipBrief` publikuje `task_skipped`. | Zachowanie zamierzone (bezpieczeństwo trustu); użytkownik widzi ostrzeżenie i wiersz skip dla każdego briefu. Bez klasy. |
| 5 | stderr hooka nigdzie nie jest publikowany, choć docs mówią o warningu; `runPreHooks` zbiera `warnings`, nikt ich nie publikuje | **CONF** | `run-pre.ts:40` wkłada stderr do `warnings`; żaden wywołujący nie czyta `pre.warnings` (`phases.ts:95-101`, `pre-task.ts:66`, `handle.ts:331-353`). Post-hooki: `sink.ts:23-57` publikuje tylko `outcome.message`, nigdy `outcome.stderr`. Docs: `docs/HOOKS-CONFIG.md:190` „Anything written to stderr is surfaced as a warning event”. | **PRODUCT · 2**. Diagnostyka hooka na stderr nie pojawia się nigdzie; docs obiecują inaczej. |
| 6 | `/home` na żywym runie przerywa go bez czekania na park i bez `settleRun` — czy coś ginie? | **PART** | `src/app/command-context.ts:363`: `navigateHome` → `routerStore.navigate({ to: 'home' })` natychmiast. Odmontowanie ekranu: `use-run-loop.ts:585-592` `controller.abort()`; `startWorkflow` wraca na `abortedRef` (:549) bez `settleRun`. Silnik: `workflow.ts:405-406` `parkRun` → `parkStoppedRun` zapisuje stan `paused`, `killAllProcesses` (:375), `releaseLiveness` (:470). Stan nie ginie; run czyta `open · stopped`. Pominięte przez brak `settleRun`: `publishRetainedWorkspaceNotice` i natychmiastowy `sessionsStore.refresh()`; home odświeża listę co `LOCKFILE_PING_INTERVAL_MS` (`home.tsx:272-280`), więc do jednego pingu run może czytać się `running`. | Nic nie ginie. Przez chwilę lista sesji na home może pokazać run jako running. Co najwyżej **PRODUCT · 3**; nie potwierdzam jako defekt. |

### Docs kontra kod

| # | Roszczenie | Werdykt | Dowód |
|---|---|---|---|
| 7 | `docs/WORKFLOW.md:532` podaje retry ×3 i czekanie ≤10 min jako ogólną regułę seat-call; kod stosuje ją tylko w `runSeatCall` | **CONF** | `runSeatCall` (`seat-wait.ts:150`) wołany tylko z `consult/request.ts:339`, `task/run-implementation.ts:286`, `escalation/make-implementer-retry-invoker.ts:125`. `withSeatRetry` / `isTransientSeatFailure` użyte tylko w `seat-wait.ts` i `transient.ts`. Planowanie (`session.ts:513,771` → `handlePlanningFailure`) i werdykt (`final-review.ts:970` catch) nie mają retry ani czekania. |
| 8 | `docs/HOW-IT-WORKS.md:269`: nieudane wywołanie reviewera zapisuje `reviewStatus: 'failed'` i buduje summary; kod haltuje | **CONF** | `task-execution.ts:523-527` → `haltVerdictlessReview` (`review.ts:149-175`) → `raisePendingRecovery`; `stopHere()`. `noVerdictFailure` (`review.ts:37-45`) traktuje brak werdyktu jako `call-failed`. |
| 9 | `docs/APPROVAL-AND-RECOVERY.md:81`: przerwana próba cofa licznik; `local-retries.ts:241` liczy przed sprawdzeniem abortu (:247) | **CONF** | `local-retries.ts:241-245` `COUNT_ATTEMPT` (reducer `machine.ts:927` dodaje `attempts + 1`), potem `:247` `isAbortedOutcome` → return z tym samym `state`. Brak jakiejkolwiek akcji cofającej (grep `UNCOUNT\|ROLLBACK_ATTEMPT`: nic). Sprawdzenie na `:155` chroni tylko przed pierwszą próbą, nie po niej. |
| 10 | `docs/PLANNERS-AND-IMPLEMENTERS.md:229`: implementer nie ma dostępu do planu; prompt dodaje „Plan context (read-only)” | **CONF** | `src/engine/spec/prompt-formatter.ts:94-96`: `if (plan) sections.push('### Plan context (read-only)', plan.summary)` + decyzje. |
| 11 | `docs/WORKFLOW.md:272` wymienia stopped: paused/failed/interrupted; kod ma też `seat-wait` | **CONF** | `src/core/sessions/run-status.ts:16-24` (`StoppedOn` z `seat-wait`), `:210-216` produkuje go. Docs `:272` nie wymieniają `seat-wait`. |
| 12 | `docs/WORKFLOW.md:115`: check render „stays unverified” w weryfikacji claimów; kod uruchamia render i może dać pass | **CONF** | `final-review.ts:245-299` `verifyReviewClaims` → `verifyClaimChecks` (`triage.ts:193`) → `runChecks`; `run-checks.ts:405-406` obsługuje `render`; `runRenderCheck` zwraca `status: 'pass'` przy exit 0 (`run-checks.ts:376-379`); `checkVerificationStatus` (`triage.ts:42-48`) daje `pass`. Unverified wymuszone tylko gdy reviewer nie dostał obrazu (`final-review.ts:874-889`). |
| 13 | `docs/APPROVAL-AND-RECOVERY.md:398`: Accept as is „for every run”; kod wstrzymuje | **CONF** | `review.ts:84-85,115`: `acceptAsIs: !scheduled && !redPending`; final review z blokującym czerwonym inputem (`redInputs.length > 0`) nie dostaje Accept as is. Docs wymieniają tylko wyjątek scheduled task review. |
| 14 | `docs/LAYERS.md:16`: engine importują tylko cli, app, features/workflow, features/runners; w kodzie też components/composer, hooks, features/editor, palette, start-preparation | **CONF** | Importy wartości: `components/composer/composer.tsx:38`, `components/composer/completion/command/hook.ts:25`, `components/composer/home-hint.ts:7`, `hooks/use-crew-display-names.ts:3`, `features/editor/plan-save.ts:2`, `features/palette/sources.ts:19`; `features/start-preparation/use-start-preparation.ts:7` (import z `engine/runners/prepared-execution.js`). |
| 15 | `docs/EXTENDING.md` §3: nowy EngineEvent wymaga tylko case w `dispatch.ts`; w kodzie też `stores/workflow/tokens.ts:142` | **CONF** | `tokens.ts:141` `updateTokens` to `switch (event.type)` z `default: return typeGuards.assertNever(event)` (`:353-354`) — tsc wymusi case. `docs/EXTENDING.md:38-47` nie wspomina `tokens.ts`. |
| 16 | Z `workflow.approve: none` checki `npm run <script>` odmawia `checkPlan` | **CONF** | `session.ts:662` przekazuje `resolveApproveLevel(config) === 'plan'` jako `npmScriptsApproved`; `refusedCheckErrors` → `commandTextRefusal` (`sanitize-discovered-validation.ts:452-470`): `isApprovedNpmRun` false → `unsafeCommandReason` → `packageScriptRefusal` (`:253-275`, `run` ∈ `NPM_SCRIPT_SUBCOMMANDS` `:87`) → „runs a package script or binary (npm run)”. |
| 17 | Z domyślnym `workflow.review: end` bramka briefu nie uruchamia checków planu/zadania | **CONF** | `brief-gate.ts:49-70`: `cadence === 'task' ? […] : []`, zostają tylko `fixCheckIds` i `opts.checkIds`; wywołania `step.ts:530` i `validate-and-commit.ts:32` nie podają `checkIds`. Domyślne `end`: `config.test.ts:139` i `brief-gate.ts:53` (`?? 'end'`). |
| 18 | Auto-fallback: silnik zapisuje tylko `switchSeat.auto`; host stosuje; „raz na run i seat” liczy tylko rekordy `auto: true`; limit bez parsowalnego resetu → `account · quota` → auto | **CONF** | `recovery/builders/task.ts:310-328` `autoSwitchIntent`: `:313` filtr `record.seat === offer.seat && record.auto`; `:318-321` `switchable` = `account` lub `rate-limited` z resetem > `rateLimitResetWaitMs`. Host: `use-run-loop.ts:391-415` (`applyOfferedSeatSwap`) i `:427` (zużycie intencji), `headless.ts:379-399`. Klasyfikacja: `seat-failure.ts:129-146` — fraza wyczerpania bez resetu → `quota`; `status === 429` → `quota`. |
| 19 | Lock `stale` (proces żyje, heartbeat > 8 s) nie da się przejąć | **CONF** | `lockfile-status.ts:10` `HEARTBEAT_STALENESS_MS = 8000`, `:156-159` → `stale`; `liveness.ts:116` `stale: { live: false, takeoverMayBeAttempted: false }`; `active-pointer.ts:367` rzuca `stillActive`. |

Podsumowanie A: 16 CONF, 3 PART (#4, #6 oraz #4 „po cichu” obalone w części), 0 REF.

Potwierdzone defekty PRODUCT: #1 (klasa 1), #2 (klasa 2), #3 (klasa 2), #5 (klasa 2). #6 nie potwierdzam jako defekt.

## Część B — próbka 60 kart decyzji (6 na plik, seed LCG 20261025)

Kryteria: `where` wskazuje właściwą funkcję; gałęzie i default zgodne z kodem.

| Plik | Id | Wynik | Uwaga |
|---|---|---|---|
| journey | JR_RESULT_MENU | OK | `options.ts:118-122`, `close.ts:125`, `continue.ts:82` zgodne |
| journey | JR_HALT_KIND | OK | listy = `REASON_HALT` (`halt.ts:44-77`), akcje `halt.ts:16-32` |
| journey | JR_LIVENESS | OK | `liveness.ts:69` rzuca przy alive; default = warn `liveness.ts:61-66` |
| journey | JR_APPROVE | OK | `session.ts:717`, `:790` |
| journey | JR_RESUME_STEP | OK | `phases.ts:22-25,38-71` |
| journey | JR_CARD | OK | `session.ts:735-745` |
| startup | ST_RETIRED_VALUES | OK | `config.ts:127-184` |
| startup | ST_RETIRED_FLAG | OK | `unknown-command.ts:84-99` |
| startup | ST_UNVERIFIED_AUTH | OK | `runner-evidence.ts:253-259` |
| startup | ST_HEADLESS_MODE | OK | `register.ts:31,86` |
| startup | ST_END_CHECKS | OK | `validation.ts:58-66` |
| startup | ST_HEADLESS_LOOP | OK | `headless.ts:458-462` |
| planning | PL_RESULT_KIND | OK | `plan-session.ts:104-112` |
| planning | PL_SPEC_OUTCOME | OK | `spec.ts:75-89,237-246` |
| planning | PL_APPROVE_LEVEL | OK | `resolve.ts:5-7`, `session.ts:662` (npm run) |
| planning | PL_PROTECTED_CHECK | OK | `plan-checks.ts:300-330` |
| planning | PL_TYPED_TRANSPORT | OK | `typed-output.ts:316-321` |
| planning | PL_RENDER_UNCONFIGURED | OK | `plan-checks.ts:209-211,363-370` |
| build | BD_CLASSIFY_WRITE | OK | `action-classifier.ts:27-33,170-186` |
| build | BD_APPROVAL_CALLBACK | OK | `confirm.ts:106-114` |
| build | BD_PRE_ESCALATION_HOOK | OK | `handle.ts:331-353` |
| build | BD_SNAPSHOT_OK | OK | `pre-task.ts:103-120`, `loop.ts:234` |
| build | BD_ASK_REPLY | OK | `apply.ts:406-411` |
| build | BD_CONTEXT_FIT | OK | `estimation.ts:7-8,38-46`, `assessment.ts:16` |
| review | RV_HALT_FAILED_REVIEW | OK | `review.ts:84-120` |
| review | RV_APPROVE_CHECKS | OK | `review-checks.ts:402-410` |
| review | RV_PROMPT_FIT | OK | `fit.ts:42-50`, `review-packet.ts:41-43` |
| review | RV_SEAT_IMAGES | OK | `review-renders.ts:176-186` |
| review | RV_STOP_RULE | OK | `review-checks.ts:579-589` |
| review | RV_VERDICTLESS_HALT | OK | `review.ts:149-175`; w `default` odwołanie „halt.ts:51” wskazuje tabelę `REASON_HALT`, funkcja `haltOf` jest w `:82` (bez zmiany, nie `where`) |
| recovery | RC_AUTHORITATIVE | OK | `seat-failure.ts:169-176` |
| recovery | RC_REVIEW_FAILURE_KIND | OK | `final-review.ts:141-148,984-996` |
| recovery | RC_FAILURE_SOURCE | OK | wywołujący `runSeatCall`, `session.ts:513,771`, `final-review.ts:970` |
| recovery | RC_CONFIG_LOADS | OK | `seat-swap-context.ts:57-76` |
| recovery | RC_RESUME_SEAT_WAIT | OK | `init.ts:331`, `seat-wait.ts:120-140`, `byline.ts:271` |
| recovery | RC_STALE_HALT | OK | `init.ts:619-625`, `loop.ts:91-99` |
| lifecycle | LC_CLOSED | OK | `run-status.ts:174-178` |
| lifecycle | LC_PARKED | OK | `run-status.ts:226-233` |
| lifecycle | LC_STOP_KIND | OK | `stop/options.ts:114`, `task-execution.ts:62` |
| lifecycle | LC_APPLY_CUT | OK | `apply/run.ts:223-228` |
| lifecycle | LC_APPLY_GATE | OK | `apply/run.ts:134-142` |
| lifecycle | LC_LOCK_STATUS | OK | `lockfile-status.ts:10-12,145-162` |
| ui | UI_ROUTE_TRANSITION | OK | `router.ts:42-46,72-75` |
| ui | UI_SCREEN_RENDER | OK | `router.tsx:75` |
| ui | UI_FALLBACK_COMMIT | OK | `use-picker-actions.ts:420-428,451-458` |
| ui | UI_ESC_FIRST | OK | `keys.ts:305-311`, `typeahead-grace.ts:1` (150 ms) |
| ui | UI_DRAFT_LEAVE | OK | `handlers.ts:320-328` |
| ui | UI_STEER | OK | `handlers.ts:206-228` |
| subsystems | SS_BUS_SINK_ISOLATION | OK | `bus.ts:10-16` |
| subsystems | SS_CHANGE_KIND | OK | `change-detection.ts:95-96`, `create.ts:457` |
| subsystems | SS_LOGGER_ENABLED | OK | `logger.ts:9-18`, `key-debug.ts:12-14` |
| subsystems | SS_ATTACH_COMPOSER | OK | `submission.ts:42-49` |
| subsystems | SS_EVIDENCE_WRITE_FAIL | OK | `persistence.ts:38,312-314`, `record-checks.ts:88-92` |
| subsystems | SS_REPOMAP_FOCUS | OK | `pagerank.ts:26-33` |
| structure | SR_STATE | OK | `docs/STRUCTURE.md:372` |
| structure | SR_GATE_STORES_ENGINE | OK | `import-boundaries.ts:207-210`, `.dependency-cruiser.cjs:45-51` |
| structure | SR_GATE_ENGINE_REACT | OK | `gates.ts:81-90,232-237` |
| structure | SR_GATE_ENGINE_UI | OK | `import-boundaries.ts:189-196`, gate 12c `gates.ts:94` |
| structure | SR_GATE_SHELL | OK | `import-boundaries.ts:182-187` |
| structure | SR_GATE_COMPONENTS_FEATURES | OK | `import-boundaries.ts:170-172`, gate 9 `gates.ts:62-64` |

Wynik próbki: 60 OK, 0 FIXED, 0 WRONG-UNFIXED. Trafność 60/60 = 100 %.

### Pierwsze diagramy (po jednym na plik)

| Plik | Diagram | Wynik | Uwaga |
|---|---|---|---|
| journey | journey-master | OK | gałęzie `JR_APPLY_OUTCOME` zgodne z `phases.ts:51-66`; TUI ma „hook trust”, headless nie — zgodne z A#1 |
| startup | startup-cli-dispatch | OK | kolejność `cli.ts:46-51`, `unknown-command.ts:46-48`; exit 2 `options.ts:353` |
| planning | planning-master | OK | `cancelled` z hooka `session.ts:318`; `unanswered` `plan-session.ts:21,94` |
| build | build-master | OK | `loop.ts:91-291`; pin profilu `routing-selection.ts:41-58` |
| review | review-master | OK | zgodny z `task-execution.ts:500-535` i `final-review.ts` |
| recovery | rc-master | **FIXED** | etykieta `RC_TRANSIENT` „429 bez resetu” była błędna: `status === 429` i `429` z rzeczownikiem limitu to `account · quota` (`seat-failure.ts:129-146`), transient jest tylko `429` w tekście z silną frazą i bez rzeczownika (`:148-161`, `usage-limit.ts:57-71`) |
| lifecycle | lc-run-status | OK | `seatWait` jako stopped: `run-status.ts:210` |
| ui | ui-nav-map | OK | `router.ts:42-46`; resume → `workflow · local` `resume.ts:148-152` |
| subsystems | ss-eventbus-fanout | OK | sinki `init-sinks.ts:35-77`; wykluczenia JSONL `sinks/jsonl.ts:20-22` |
| structure | sr-layers | OK | liczby plików policzone na nowo: cli 36, app 21, features 206, components 47, hooks 5, stores 72, engine 488, core 278, lib 55, utils 40 |

## Edycje w plikach danych

1. `flow-atlas/data/recovery.js` — karta `RC_TRANSIENT`, trzecia gałąź: warunek zmieniony na „`429` w tekście (bez pola `status`), bez resetu, z silną frazą limitu, ale bez rzeczownika”; dopisek, że rzeczownik lub pole `status: 429` daje `account · quota` (`seat-failure.ts:129, 143`).
2. `flow-atlas/data/recovery.js` — diagram `rc-master`, etykieta rombu `RC_TRANSIENT`: „429 w tekście bez rzeczownika limitu?”.

Parse po edycji: `node -e "global.window={};require('/home/user/splitbrief/flow-atlas/data/recovery.js')"` — wynik w raporcie końcowym.

Nie zmieniono kodu produktu ani docs. Nic nie zostało zestage'owane ani zacommitowane.
