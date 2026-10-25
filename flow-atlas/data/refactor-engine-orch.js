window.ATLAS_REFACTOR = window.ATLAS_REFACTOR || [];
window.ATLAS_REFACTOR.push({
  part: 'engine-orch',
  title: 'src/engine/orchestrator',
  summary: `Orchestrator to 206 plików produkcyjnych i 39 803 linie (wc -l, bez testów; stan po synchronizacji z main 2026-10, doszedł usage-limit-gate.ts, 53 linie), prawie połowa engine. Podfoldery są w większości dobrze nazwane (planning, task, escalation, recovery, apply, isolation), a średni plik ma ok. 190 linii. Problem skupia się w 15 plikach powyżej 500 linii (razem ok. 12 tys. linii) i w korzeniu folderu: 21 luźnych plików, w tym klaster review (final-review.ts, review-call, review-checks, review-plan, review-renders, api-review-context, triage), który prosi się o własny folder.

Główne problemy: (1) jedna funkcja runFinalReviewPhase ma 821 linii, a recovery/actions.ts (1212) i recovery/builders/task.ts (1190) mają po ok. 1200 linii mieszanych odpowiedzialności; (2) polityka komend recenzenta (1106 linii) i allowlista planu (577 linii) leżą w dwóch folderach, a validation importuje stałe z planning; (3) prawdziwe duplikaty: halt seat-down i runner-defect budowany dwa razy (task/implementation-failure.ts trzy razy oraz escalation/handle.ts), halt consult-bound dwa razy, rozpisanie tożsamości seatów na SummaryBase dwa razy, własne kopie uniquePush, isENOENT i sha256Hex; (4) grupy prefiksowe w 15 miejscach (review-*, init-*, *-worktree, routing-*, seat-* i switch-seat-*, artifact-stage-*, *-gate).

Kolejność: najpierw tanie deduplikacje (RF_ORCH_05 do RF_ORCH_10, każda poniżej godziny, mały zasięg). Potem podział builders/task.ts, polityk komend i recovery/actions.ts oraz folder review/ (RF_ORCH_01 do RF_ORCH_04). Na końcu mechaniczne podziały o dużym zasięgu (state-ops.ts ma 76 importerów, events.ts 60) i porządki folderów. Szacunek po wszystkich propozycjach: ok. 252 pliki, ok. 30 plików powyżej 300 linii (było 40), 1 plik powyżej 500 linii (isolation/create.ts, uzasadniony w keep).`,
  stats: { files: 206, prodLines: 39803, over300: 41, over500: 15, prefixGroups: 15, duplicates: 14 },
  proposals: [
    {
      id: 'RF_ORCH_01',
      kind: 'folderize',
      priority: 1,
      effort: 'L',
      risk: 'medium',
      title: 'Folder review/: podział final-review.ts i review-checks.ts, przeniesienie klastra review z korzenia',
      why: 'final-review.ts ma 1119 linie, z czego runFinalReviewPhase (linie 299-1119) to jedna funkcja na 821 linii (main dołożył m.in. odmowę checku, którego nie da się uruchomić, w befef41). Robi ona osiem rzeczy: rebase stanu i ALL_DONE, pre-review, zbieranie wejść (universe, scope, ledger, drift, rendery), schemat werdyktu z superRefine, budowę promptu (pakiet API albo fitReviewPrompt), pętlę wywołań z kontynuacją, weryfikację twierdzeń, zapis rekordu i mapowanie błędu na FinalReviewFailure. Nic z tego nie da się dziś przetestować osobno. review-checks.ts (676 linii) łączy odczyt plików projektu, ponowne uruchomienie na bazie runu (preExistingKeys, 98 linii), uruchomienie jednego checku i orkiestrację runReviewChecks (215 linii). Do tego 7 plików review w korzeniu orchestratora tworzy grupę prefiksową review-* (review-call, review-checks, review-plan, review-renders) plus final-review, api-review-context i triage.',
      before: [
        { path: 'src/engine/orchestrator/final-review.ts', lines: 1119, note: 'typy FinalReview*, reviewCheckResults, reviewConsultLog, reviewPlanningAnswers, verifyReviewClaims, runFinalReviewPhase (821 linii)' },
        { path: 'src/engine/orchestrator/review-checks.ts', lines: 676, note: 'PROJECT_FILES, readProjectFiles, preExistingKeys, splitAtRunBase, runReviewCheck, skipReason, skippedSection, runReviewChecks' },
        { path: 'src/engine/orchestrator/triage.ts', lines: 401, note: 'triageContractErrors, fixTaskTargetErrors, verifyClaimChecks, applyTriage, startFixCycle' },
        { path: 'src/engine/orchestrator/api-review-context.ts', lines: 297, note: 'buildApiReviewContext' },
        { path: 'src/engine/orchestrator/review-renders.ts', lines: 232, note: 'reviewRenders, forceUnverifiedRenderCriteria' },
        { path: 'src/engine/orchestrator/review-call.ts', lines: 77, note: 'runReviewerCall' },
        { path: 'src/engine/orchestrator/review-plan.ts', lines: 45, note: 'reviewPlanData, reviewOperatorInstructions' }
      ],
      after: [
        { path: 'src/engine/orchestrator/review/phase.ts', lines: 280, note: 'runFinalReviewPhase jako sekwencja kroków: rebase, ALL_DONE, preReview, review_started, interrupted(), ledger evidence, writeReviewPacket, review_completed' },
        { path: 'src/engine/orchestrator/review/types.ts', lines: 70, note: 'REVIEW_UNAVAILABLE, FinalReviewFailure, ReviewPhaseStatus, FinalReview, FinalReviewResult, finalReviewError' },
        { path: 'src/engine/orchestrator/review/inputs.ts', lines: 150, note: 'universe, userFiles, reviewScope, spec i taskBriefs, checksLog lub wholeChecksLog, raport drift, currentCandidateId, rendery' },
        { path: 'src/engine/orchestrator/review/prompt.ts', lines: 230, note: 'reviewCheckResults, reviewConsultLog, reviewPlanningAnswers, touchedNotSuggested, preparePrompt (pakiet API albo fitReviewPrompt, failure input-too-large)' },
        { path: 'src/engine/orchestrator/review/verdict-schema.ts', lines: 60, note: 'schemat werdyktu: ReviewAnswerSchema.superRefine z verdictCoverageErrors, triageContractErrors, fixTaskTargetErrors, refusedCheckErrors' },
        { path: 'src/engine/orchestrator/review/verify-claims.ts', lines: 110, note: 'verifyReviewClaims, ReviewVerification, krok forceUnverifiedRenderCriteria' },
        { path: 'src/engine/orchestrator/review/record.ts', lines: 120, note: 'RECORD_REVIEW, persistReviewEvidence, SET_PENDING_REVIEW_COMMANDS, RECORD_TRIAGE, review.json i review.md' },
        { path: 'src/engine/orchestrator/review/failure.ts', lines: 90, note: 'blok catch: diagnoza błędu na FinalReviewFailure, komunikat, publishError' },
        { path: 'src/engine/orchestrator/review/call.ts', lines: 190, note: 'runReviewerCall (z review-call.ts) i callReviewer z withContinuationLoop' },
        { path: 'src/engine/orchestrator/review/plan.ts', lines: 45, note: 'z review-plan.ts bez zmian' },
        { path: 'src/engine/orchestrator/review/renders.ts', lines: 232, note: 'z review-renders.ts bez zmian' },
        { path: 'src/engine/orchestrator/review/api-context.ts', lines: 297, note: 'z api-review-context.ts bez zmian' },
        { path: 'src/engine/orchestrator/review/triage.ts', lines: 393, note: 'z triage.ts bez zmian' },
        { path: 'src/engine/orchestrator/review/checks/run-all.ts', lines: 240, note: 'runReviewChecks, ReviewChecksOptions, ReviewChecksOutcome, replaceReviewCheckInputs' },
        { path: 'src/engine/orchestrator/review/checks/run-one.ts', lines: 90, note: 'runReviewCheck (używa go też task/task-checks.ts)' },
        { path: 'src/engine/orchestrator/review/checks/run-base.ts', lines: 180, note: 'notVerifiedReason, preExistingKeys, noRunBase, splitAtRunBase' },
        { path: 'src/engine/orchestrator/review/checks/project-files.ts', lines: 70, note: 'PROJECT_FILES, CI_DIR, MAX_FILE_CHARS, MAX_PROJECT_CHARS, readText, readProjectFiles' },
        { path: 'src/engine/orchestrator/review/checks/skip.ts', lines: 70, note: 'REVIEW_CHECKS_SKIP_REASON, OFF_SECTION, skipReason, skippedSection, planLines' }
      ],
      moves: [
        'REVIEW_UNAVAILABLE, FinalReviewFailure, ReviewPhaseStatus, FinalReview, FinalReviewResult, finalReviewError (final-review.ts:139-196) → review/types.ts',
        'reviewCheckResults, reviewConsultLog, reviewPlanningAnswers (final-review.ts:199-234) oraz preparePrompt i budowa touchedNotSuggested (final-review.ts:558-764) → review/prompt.ts',
        'odczyt ledgera, buildChecks, analyzeBriefDrift, writeDriftReport, currentCandidateId, reviewRenders (final-review.ts:479-601) → review/inputs.ts',
        'verdictSchema (final-review.ts:525-547) → review/verdict-schema.ts jako reviewVerdictSchema(input)',
        'verifyReviewClaims, ReviewVerification (final-review.ts:236-297) i blok forceUnverifiedRenderCriteria (final-review.ts:884-909) → review/verify-claims.ts',
        'zapis RECORD_REVIEW, persistReviewEvidence, pendingCommands, RECORD_TRIAGE, writeSpecFile REVIEW_JSON_FILE i REVIEW_FILE (final-review.ts:910-987) → review/record.ts',
        'blok catch z diagnosePlannerCallFailure i readApiContextDiagnostic (final-review.ts:988-1047), errorKind → review/failure.ts',
        'callReviewer i pętla settleMidCallDeliveries (final-review.ts:766-882) + cały review-call.ts → review/call.ts',
        'review-plan.ts → review/plan.ts; review-renders.ts → review/renders.ts; api-review-context.ts → review/api-context.ts; triage.ts → review/triage.ts',
        'review-checks.ts: runReviewChecks → review/checks/run-all.ts; runReviewCheck → review/checks/run-one.ts; preExistingKeys, noRunBase, splitAtRunBase, notVerifiedReason → review/checks/run-base.ts; PROJECT_FILES, readText, readProjectFiles → review/checks/project-files.ts; skipReason, skippedSection, planLines, REVIEW_CHECKS_SKIP_REASON → review/checks/skip.ts'
      ],
      tests: 'Przenoszą się: final-review.test.ts → review/phase.test.ts; final-review.integration.test.ts, final-review-input-cap, final-review-renders, final-review-scope, final-review-seat-wait (.integration.test.ts) → review/phase-*.integration.test.ts; review-call.test.ts → review/call.test.ts; review-checks.integration.test.ts → review/checks/run-all.integration.test.ts; review-renders.test.ts → review/renders.test.ts; api-review-context.test.ts → review/api-context.test.ts; triage.test.ts i triage.integration.test.ts → review/triage*.test.ts. Nowe testy jednostkowe bez gita i bez fałszywego CLI: verdict-schema (czysta funkcja nad ReviewAnswer), prompt (wejścia na tekst promptu, przycięcie dla maxInputChars), failure (błąd na FinalReviewFailure), verify-claims (fałszywy runner checków), checks/run-base (preExistingKeys z fałszywym runem bazy). Dziś każdy z tych przypadków wymaga integracji przez runFinalReviewPhase.',
      importers: 22,
      references: [
        'docs/APPROVAL-AND-RECOVERY.md:436,456', 'docs/ARCHITECTURE.md:445,1302', 'docs/ENGINE.md:553', 'docs/HOW-IT-WORKS.md:136,159,261,265',
        'docs/TROUBLESHOOTING.md:494,1101,1120,1408', 'docs/PLANNERS-AND-IMPLEMENTERS.md:61,94,98', 'docs/CONCEPTS.md:30,168', 'docs/CONFIGURATION.md:709',
        'docs/IMPLEMENTER-DIRECTION.md:96', 'docs/WORKFLOW.md:163,276', 'docs/TASK-CONTRACT.md:285', 'docs/LAYERS.md:142', 'CONTRIBUTING.md:141',
        'flow-atlas/data/review.js:18,371,384,397,410,423,437,631,643,657,671,684,697,709,755,774,786,819,835,849,1058,1059,1060,1070,1071,1212-1218',
        'flow-atlas/data/recovery.js:506,1093', 'flow-atlas/data/structure.js:481', 'flow-atlas/data/journey.js:873'
      ],
      steps: [
        '1. git mv review-plan.ts, review-renders.ts, api-review-context.ts, triage.ts, review-call.ts do review/ (nowe nazwy jak wyżej) razem z testami; popraw importy względne (6 plików produkcyjnych: run/review.ts, run/task-execution.ts, recovery/builders/review-input.ts, recovery/builders/task.ts, consult/request.ts, task/task-checks.ts).',
        '2. Rozbij review-checks.ts na review/checks/{run-all,run-one,run-base,project-files,skip}.ts; task/task-checks.ts importuje runReviewCheck z review/checks/run-one.js.',
        '3. Wydziel review/types.ts z final-review.ts; recovery/builders/task.ts i review-input.ts importują FinalReviewFailure z review/types.js.',
        '4. Wydziel kolejno czyste części runFinalReviewPhase: verdict-schema.ts, verify-claims.ts, failure.ts, record.ts, potem inputs.ts i prompt.ts (stan przekazywany jawnie, bez domknięć); na końcu call.ts.',
        '5. Pozostałość zostaje jako review/phase.ts; usuń final-review.ts. Uruchom npm run typecheck, npm run lint i node scripts/dangling-imports.mjs.',
        '6. Popraw ścieżki w dokumentach i flow-atlas z listy references.'
      ],
      risks: 'Średnie: runFinalReviewPhase trzyma mutowalne state, failure, fullPrompt i reviewInput w domknięciach; ekstrakcja musi zwracać nowy stan jawnie, inaczej zgubi się aktualizacja setTrackedState albo failure. Wyłapią to testy integracyjne final-review-* (input-cap, scope, seat-wait, renders) i testy e2e review-input-refused oraz review-fix-again. Ścieżki: typecheck i dangling-imports. Nie powstaje żaden index.ts.'
    },
    {
      id: 'RF_ORCH_02',
      kind: 'split',
      priority: 1,
      effort: 'M',
      risk: 'low',
      title: 'Podział recovery/builders/task.ts na buildery według rodzaju haltu',
      why: 'recovery/builders/task.ts ma 1190 linii i 22 eksportowane funkcje sześciu różnych rodzin: seat-down (switchSeatOffer, autoSwitchIntent, buildSeatDownIssue), wyczerpane próby i kontekst (retry exhausted, context overflow, implementer unavailable, dependency blocked), defekty runnera (recipe, missing model, repeated timeout, input too large, RUNNER_DEFECT_BUILDERS), izolacja (left isolation, checkout changed), approval i snapshot, review failed. Nazwa task.ts nie mówi, co tu jest. Main przerobił builder promptu za dużego (afbb4ea: inputTooLargeDetail, rozmiar w bajtach albo znakach, także dla odmowy argv przed startem narzędzia) i nazwy narzędzi z katalogu (283c8e6), bez zmiany podziału na rodziny. Typy SeatSwapContext i DetectedSeatTool są zdefiniowane w builderze, a importuje je loader recovery/seat-swap-context.ts. Plik ma 42 importerów, w tym 26 testów i fikstury testing/visual.',
      before: [
        { path: 'src/engine/orchestrator/recovery/builders/task.ts', lines: 1190, note: '6 rodzin builderów, typy SeatSwapContext i DetectedSeatTool' }
      ],
      after: [
        { path: 'src/engine/orchestrator/recovery/builders/seat-down.ts', lines: 330, note: 'DetectedSeatTool, SeatSwapContext, switchSeatOffer, seatHostableTools, modelRefusalSeatOffer, SeatDownRecoveryOptions, fallbackDetail, toolReported, reportedDetail, autoSwitchIntent, buildSeatDownIssue, runnerModel, refusalStopDetail, seatRouteRefusal, modelRefusalHalt' },
        { path: 'src/engine/orchestrator/recovery/builders/retry.ts', lines: 230, note: 'ValidationRecoveryOptions, RetryExhaustedRecoveryOptions, ContextOverflowRecoveryOptions, ImplementerUnavailableRecoveryOptions, DependencyBlockedRecoveryOptions, buildRetryExhaustedRecoveryIssue, contextDetails, rejectedProfileDetails, buildContextOverflowRecoveryIssue, buildImplementerUnavailableRecoveryIssue, dependencyDetail, buildDependencyBlockedRecoveryIssue' },
        { path: 'src/engine/orchestrator/recovery/builders/runner-defect.ts', lines: 250, note: 'RunnerFailureRecoveryOptions, runnerHaltRow, runnerDefectRow, recipeHaltIssue, buildRecipeInvalidRecoveryIssue, buildMissingModelRecoveryIssue, buildRepeatedTimeoutRecoveryIssue, buildRunnerInputTooLargeRecoveryIssue, RUNNER_DEFECT_BUILDERS, recoveryBuilderForRunnerOutcome' },
        { path: 'src/engine/orchestrator/recovery/builders/isolation.ts', lines: 100, note: 'isolationHaltIssue, buildLeftIsolationRecoveryIssue, buildCheckoutChangedRecoveryIssue' },
        { path: 'src/engine/orchestrator/recovery/builders/approval.ts', lines: 85, note: 'ApprovalDeniedRecoveryOptions, buildApprovalDeniedRecoveryIssue, SnapshotFailedRecoveryOptions, buildSnapshotFailedRecoveryIssue' },
        { path: 'src/engine/orchestrator/recovery/builders/review.ts', lines: 125, note: 'NoVerdictReviewFailure, ReviewFailedRecoveryOptions, buildNoVerdictReviewIssue, buildReviewFailedRecoveryIssue' },
        { path: 'src/engine/orchestrator/recovery/builders/details.ts', lines: 90, note: 'istniejący plik (76 linii) dostaje wspólne lastErrorDetail i handBackQuote' }
      ],
      moves: [
        'linie 140-430, 665-672, 742-759 (seat-down i odmowy modelu) → builders/seat-down.ts',
        'linie 76-111 (opcje) i 467-663 (retry, context overflow, implementer unavailable, dependency) → builders/retry.ts',
        'linie 120-132, 438-452, 678-1009 (defekty runnera, RUNNER_DEFECT_BUILDERS, recoveryBuilderForRunnerOutcome) → builders/runner-defect.ts',
        'linie 843-931 → builders/isolation.ts; linie 1011-1077 → builders/approval.ts; linie 1080-1190 → builders/review.ts',
        'lastErrorDetail, handBackQuote (linie 455-465) → builders/details.ts',
        'gdy wejdzie RF_ORCH_14: typy SeatSwapContext i DetectedSeatTool → recovery/seat/swap-context.ts (loader jest ich właścicielem), builder importuje je jako type'
      ],
      tests: 'builders/task.test.ts dzieli się na seat-down.test.ts, retry.test.ts, runner-defect.test.ts, isolation.test.ts, approval.test.ts i review.test.ts. Każda rodzina haltów dostaje własny plik testu bez importu 1190 linii. Fikstury testing/visual/fixtures/workflow/projections.ts i at-rest-projections.ts zmieniają importy na nowe pliki.',
      importers: 42,
      references: [
        'docs/APPROVAL-AND-RECOVERY.md:201', 'docs/TESTING.md:157',
        'flow-atlas/data/recovery.js:521,587,600,613,626,639,893,1096', 'flow-atlas/data/review.js:1235', 'flow-atlas/data/runners.js:900,1384', 'flow-atlas/data/journey.js:525,827'
      ],
      steps: [
        '1. Utwórz pięć nowych plików builderów i przenieś funkcje według listy moves (bez zmiany ciał).',
        '2. Przenieś lastErrorDetail i handBackQuote do builders/details.ts.',
        '3. Popraw importy w 16 plikach produkcyjnych (escalation/handle.ts, escalation/local-retries.ts, builders/planner.ts, builders/seat-protocol.ts, recovery/planner-call-failure.ts, recovery/seat-swap-context.ts, run/review.ts, task/dependency-gate.ts, task/implementation-failure.ts, task/loop.ts, task/pre-task.ts, task/retry.ts, task/routing-selection.ts, task/step.ts i 2 fikstury testing/visual).',
        '4. Podziel task.test.ts; usuń builders/task.ts.',
        '5. npm run typecheck, npm run lint, node scripts/dangling-imports.mjs; zaktualizuj references.'
      ],
      risks: 'Niskie: czyste przeniesienie funkcji bez stanu. Ryzyko cyklu importów między seat-down.ts a runner-defect.ts (runnerHaltRow używa identity seatu); gate 19 (cykle modułów) i typecheck to wyłapią. scripts/recovery-producers.ts skanuje całe src/engine, więc nie zależy od nazwy pliku.'
    },
    {
      id: 'RF_ORCH_03',
      kind: 'split',
      priority: 1,
      effort: 'M',
      risk: 'medium',
      title: 'Podział recovery/actions.ts: jedna akcja recovery na moduł',
      why: 'recovery/actions.ts ma 1212 linie: typy wyniku, dispatcher applyRecoveryAction (89 linii) i 12 funkcji akcji (continue, consult grant 86 linii, revise, accept as is, review correction, skip task 72 linie, retry same worker, plan switch seat 110 linii, commit seat switch 93 linie, retry later, retry current task) plus 7 wspólnych helperów. Main dołożył tu 28 linii: retry later zapisuje teraz w seatWait narzędzie wywołania i trzymany seat (`holds`) z configu następnego wejścia (890d992, 42fb57f), a komunikaty używają nazwy z katalogu (283c8e6). Część switch-seat (linie 610-885) jest importowana przez recovery/switch-seat-resume.ts, więc dwa pliki o przełączaniu seatu zależą od siebie przez plik o wszystkich akcjach. 35 testów importuje ten plik.',
      before: [
        { path: 'src/engine/orchestrator/recovery/actions.ts', lines: 1212, note: 'typy, applyRecoveryAction, 12 akcji, helpery zapisu odpowiedzi i blokady' }
      ],
      after: [
        { path: 'src/engine/orchestrator/recovery/actions/types.ts', lines: 80, note: 'RecoveryActionBlockedCode, RecoveryActionAppliedStatus, ApplyRecoveryActionResult, ApplyRecoveryActionBlocked, ApplyRecoveryActionOptions' },
        { path: 'src/engine/orchestrator/recovery/actions/apply.ts', lines: 120, note: 'applyRecoveryAction (dispatcher), ApplyRecoveryActionOptionsWithIssue' },
        { path: 'src/engine/orchestrator/recovery/actions/shared.ts', lines: 160, note: 'markRecoveryApplying, saveRecoveryAnswer, briefWords, blockRecoveryAction, currentRecoveryTask, recordRecoverySkipEvidence, isSafeContinue' },
        { path: 'src/engine/orchestrator/recovery/actions/retry.ts', lines: 190, note: 'applyContinueRecoveryAction, isSeatLevelRetry, applyRetrySameWorkerRecoveryAction, resolveSeatIssueWithoutTask, applyRetryLaterRecoveryAction, applyRetryCurrentTaskRecoveryAction' },
        { path: 'src/engine/orchestrator/recovery/actions/consult-grant.ts', lines: 100, note: 'applyConsultGrantRecoveryAction' },
        { path: 'src/engine/orchestrator/recovery/actions/review.ts', lines: 140, note: 'applyReviseRecoveryAction, readCriticalFindings, applyAcceptAsIsRecoveryAction, applyReviewCorrectionAction' },
        { path: 'src/engine/orchestrator/recovery/actions/skip-task.ts', lines: 90, note: 'applySkipCurrentTaskRecoveryAction' },
        { path: 'src/engine/orchestrator/recovery/seat/switch-action.ts', lines: 340, note: 'SeatSwitchPlan, SeatSwitchPlanResult, ApplySwitchSeatResult, planSwitchSeatRecoveryAction, commitSeatSwitch, applySwitchSeatRecoveryAction, seatRunnerValue' }
      ],
      moves: [
        'linie 62-134 → actions/types.ts; linie 136-228 → actions/apply.ts',
        'linie 1067-1212 i 1124-1128 (helpery) → actions/shared.ts',
        'linie 230-273, 581-607, 891-1040 → actions/retry.ts',
        'linie 281-366 → actions/consult-grant.ts; linie 373-500 → actions/review.ts; linie 502-573 → actions/skip-task.ts',
        'linie 610-885 i 1043-1065 → recovery/seat/switch-action.ts (folder z RF_ORCH_14; bez niego: actions/switch-seat.ts)'
      ],
      tests: 'actions.test.ts, actions-persistence.test.ts, actions-one-write.test.ts zostają testami dispatchera w actions/ (apply.test.ts, apply-persistence.test.ts, apply-one-write.test.ts); przypadki pojedynczych akcji można przenieść do testów modułów (consult-grant.test.ts, skip-task.test.ts, review.test.ts). switch-seat-resume.test.ts importuje commitSeatSwitch z seat/switch-action.js. Nowa testowalność: akcja consult grant albo accept-as-is bez ładowania dispatchera i wszystkich zależności 12 akcji.',
      importers: 40,
      references: [
        'docs/APPROVAL-AND-RECOVERY.md:165,355', 'docs/TESTING.md:157', 'skills/splitbrief-babysit/SKILL.md:227',
        'flow-atlas/data/recovery.js:697,713,730,743,757,769,827,1102', 'flow-atlas/data/review.js:1033,1238'
      ],
      steps: [
        '1. Utwórz recovery/actions/ i przenieś typy oraz helpery (types.ts, shared.ts).',
        '2. Przenieś akcje do modułów według listy moves; dispatcher w apply.ts importuje każdą akcję.',
        '3. Przenieś część switch-seat do recovery/seat/switch-action.ts; switch-seat-resume importuje stamtąd.',
        '4. Popraw importy: src/cli/commands/continue/command.ts (applyRecoveryAction, seatRunnerValue), src/features/workflow/recovery-driver.ts, src/features/workflow/recovery-prompt.ts (isSeatLevelRetry), testing/e2e/helpers/stop-continue-fixture.ts i 35 testów.',
        '5. Usuń recovery/actions.ts (nie zostawiaj pliku obok folderu actions/). npm run typecheck, lint, dangling-imports.'
      ],
      risks: 'Średnie: dwa pliki UI i jeden CLI importują z tego modułu, więc zmiana ścieżki przechodzi przez warstwy; reguła import-boundaries dopuszcza features → engine. Akcje dzielą helpery zapisu (saveRecoveryAnswer, markRecoveryApplying), łatwo o cykl actions/apply ↔ actions/retry; gate 19 to wyłapie. Zachowanie się nie zmienia, testy dispatchera (35 importów) to potwierdzą.'
    },
    {
      id: 'RF_ORCH_04',
      kind: 'split',
      priority: 1,
      effort: 'M',
      risk: 'medium',
      title: 'Polityki komend w validation/: reviewer-policy/, plan-policy/ i wspólne flagi interpreterów',
      why: 'validation/reviewer-command-policy.ts ma 1106 linii: ok. 500 linii tabel (linie 9-531), REVIEWER_COMMAND_RULES (opis reguł słowami), ok. 290 linii analizy argv, ok. 180 linii odmów i ok. 100 linii checkDefinition. planning/sanitize-discovered-validation.ts (577 linii) to allowlista komend planu; nie jest częścią sesji planowania, a validation/reviewer-command-policy.ts importuje z niej INLINE_CODE_FLAGS, NODE_SYNTAX_CHECK_FLAGS i nodeParsesOnly (krawędź validation → planning). Oba pliki trzymają osobny regex składni powłoki (SHELL_OPERATORS bez <> i SHELL_SYNTAX z <>). Konsumenci są też w engine/spec (plan-checks.ts, prompts/plan-session.ts, prompts/review-checks.ts).',
      before: [
        { path: 'src/engine/orchestrator/validation/reviewer-command-policy.ts', lines: 1106, note: 'tabele programów i menedżerów pakietów, REVIEWER_COMMAND_RULES, walker argv, tokensRefusal, checkDefinition' },
        { path: 'src/engine/orchestrator/planning/sanitize-discovered-validation.ts', lines: 577, note: 'tabele allowlisty, flagi interpreterów, odmowy, sanitizeDiscoveredValidation' }
      ],
      after: [
        { path: 'src/engine/orchestrator/validation/interpreter-flags.ts', lines: 65, note: 'CODE_LOAD_FLAGS, INLINE_CODE_FLAGS, NODE_TEST_REPORTERS, NODE_TEST_BOOLEAN_FLAGS, NODE_TEST_VALUE_FLAGS, NODE_SYNTAX_CHECK_FLAGS, nodeParsesOnly' },
        { path: 'src/engine/orchestrator/validation/plan-policy/tables.ts', lines: 110, note: 'PACKAGE_MANAGERS, ALLOWED_COMMANDS, SHELL_OPERATORS, INTERPRETERS, NPX_*, *_SCRIPT_SUBCOMMANDS, RUN_TEST_ALIASES, TASK_RUNNERS, STAGE_TARGETS, RUN_FRONT_ENDS, PYTHON_TOOLS, TEST_CONFIG_FLAGS, NODE_TEST_STACKS, commandFamily, isPathLikeScriptArg, executedProgramPositions, isWorkspacePath, isWorkspaceFile' },
        { path: 'src/engine/orchestrator/validation/plan-policy/refusal.ts', lines: 340, note: 'interpreterRefusal, npxScriptRefusal, packageScriptRefusal, packageCommandRefusal, testPathRefusal, taskRecipeRefusal, forwardedCommandRefusal, programArgumentRefusal, programRefusal, testRunnerConfigRefusal, asBareTest, unsafeCommandReason, FILE_TESTS, fileTestRefusal, isApprovedNpmRun, commandTextRefusal, checkCommandRefusal' },
        { path: 'src/engine/orchestrator/validation/plan-policy/sanitize.ts', lines: 80, note: 'REFUSED_WARNING, testPatternRefusal, TestResolutionContext, sanitizeDiscoveredValidation' },
        { path: 'src/engine/orchestrator/validation/reviewer-policy/programs.ts', lines: 300, note: 'SHELL_SYNTAX, CONTROL_CHARACTER, REMOTE, SCRIPT_FILE, SHELLS, WRAPPERS, NOT_VERIFICATION, SCRIPT_INTERPRETERS, SUBCOMMAND_INTERPRETERS, ELIXIR_OPTIONS, INTERPRETER_CODE_OPTIONS, VALUE_LETTERS, EXEC_*_FLAGS, UV_RUN_DOWNLOAD_FLAGS, FORWARDERS, TASK_RUNNERS, PROJECT_WRAPPERS, TASK_FILES, TASK_CODE_GOALS, MAKE_CONTROL_VARIABLES' },
        { path: 'src/engine/orchestrator/validation/reviewer-policy/package-managers.ts', lines: 215, note: 'PACKAGE_MANAGER_COMMANDS, APPLICATION_SCRIPTS, *_VALUE_OPTIONS, DIRECTORY_OPTIONS, PACKAGE_MANAGER_PREFIXES, LAUNCHERS, SETUP_VERBS, SCOPED_SETUP_VERBS, PACKAGE_MUTATIONS, FIND_ACTIONS, COMMAND_GROUPS, GOAL_RUNNERS, BARE_INSTALLERS' },
        { path: 'src/engine/orchestrator/validation/reviewer-policy/rules.ts', lines: 40, note: 'code, taskRunnerOptions, REVIEWER_COMMAND_RULES' },
        { path: 'src/engine/orchestrator/validation/reviewer-policy/argv.ts', lines: 300, note: 'isFlag, lookup, projectWrapper, argumentsWithoutValues, operands, leavesWorkspace, interpreterName, interpreterCall, npxProgram, npmSubcommandAt, packageManagerWord, packageManagerForwarded, forwarded, handsOn, leadingOperands, subcommandWords' },
        { path: 'src/engine/orchestrator/validation/reviewer-policy/refusal.ts', lines: 190, note: 'setupRefusal, launcherRefusal, taskRunnerOption, makeVariableRefusal, taskRunnerRefusal, mixTasksRefusal, tokensRefusal, reviewerCommandRefusal' },
        { path: 'src/engine/orchestrator/validation/reviewer-policy/definition.ts', lines: 110, note: 'CheckDefinition, directoryOf, packageScript, definitionOf, checkDefinition' }
      ],
      moves: [
        'sanitize-discovered-validation.ts:32-85 (flagi kodu i node --test, nodeParsesOnly) → validation/interpreter-flags.ts',
        'sanitize-discovered-validation.ts:20-29, 87-158 → validation/plan-policy/tables.ts',
        'sanitize-discovered-validation.ts:161-509 → validation/plan-policy/refusal.ts; :511-577 → validation/plan-policy/sanitize.ts',
        'reviewer-command-policy.ts:9-202 i 421-513 → reviewer-policy/programs.ts; :207-414 → reviewer-policy/package-managers.ts; :505-531 → reviewer-policy/rules.ts',
        'reviewer-command-policy.ts:533-825 → reviewer-policy/argv.ts; :827-1006 → reviewer-policy/refusal.ts; :1009-1106 → reviewer-policy/definition.ts'
      ],
      tests: 'reviewer-command-policy.test.ts dzieli się na reviewer-policy/refusal.test.ts i reviewer-policy/definition.test.ts (checkDefinition testowany osobno), rules.test.ts dla zgodności REVIEWER_COMMAND_RULES z tabelami. sanitize-discovered-validation.test.ts → plan-policy/sanitize.test.ts, z przypadkami odmów w plan-policy/refusal.test.ts. Nowa testowalność: walker argv (forwarded, packageManagerWord) bez całej polityki.',
      importers: 11,
      references: [
        'docs/STRUCTURE.md:651', 'docs/TASK-CONTRACT.md:595,597', 'docs/CONFIGURATION.md:624,637,671', 'docs/TROUBLESHOOTING.md:751,785', 'docs/EXTENDING.md:212',
        'flow-atlas/data/review.js:463,483,498,513,531,550,562,1049,1219', 'flow-atlas/data/planning.js:635,718,938,1099'
      ],
      steps: [
        '1. Utwórz validation/interpreter-flags.ts i przenieś flagi; obie polityki importują stamtąd.',
        '2. Przenieś sanitize-discovered-validation.ts do validation/plan-policy/ jako trzy pliki; popraw importy w planning/session.ts, validation/run-checks.ts, validation/run.ts, src/engine/spec/plan-checks.ts, src/engine/spec/prompts/plan-session.ts, testing/visual/fixtures/workflow/projections.ts.',
        '3. Rozbij reviewer-command-policy.ts na reviewer-policy/ (sześć plików); popraw importy w validation/changed-script.ts, validation/run-checks.ts, src/engine/spec/prompts/review-checks.ts.',
        '4. Podziel testy; npm run typecheck, lint, dangling-imports; npm run skills:check (skill-blocks renderuje reguły z core/pipeline-spec, nie z tych plików, ale sprawdź).',
        '5. Zaktualizuj drzewo w docs/STRUCTURE.md:641-653 (planning/ traci sanitize-discovered-validation.ts) i references.'
      ],
      risks: 'Średnie: to granica bezpieczeństwa (co SPLITBRIEF uruchamia). Przeniesienie bez zmiany ciał nie zmienia decyzji, ale tabele są współdzielone przez wiele funkcji, więc zgubiony import da undefined w Set.has dopiero w runtime przy stałej typu ReadonlySet; typecheck to wyłapie, bo stałe są typowane. Testy polityk są szczegółowe. Decyzja dla właściciela: obie polityki są czyste (bez I/O), więc ich naturalny dom mógłby być w core/validation/ obok stosów; propozycja zostawia je w engine, żeby nie zmieniać warstw.'
    },
    {
      id: 'RF_ORCH_05',
      kind: 'extract-shared',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'Jeden halt seat-down i runner-defect dla seatu build',
      why: 'Ten sam halt seatu build jest zbudowany w dwóch miejscach. task/implementation-failure.ts ma trzy prawie identyczne bloki (unauthenticated linie 67-114, usage-limit 118-166, defekt runnera 168-206): loadSeatSwapContext, buildSeatDownIssue albo builder defektu, publishError z runnerHaltRow lub runnerDefectRow, INTERRUPT_STEP, raisePendingRecovery. escalation/handle.ts powtarza to w seatDownHalt (linie 82-142) i runnerDefectHalt (149-199). Razem ok. 230 linii. flow-atlas już opisuje to jako ten sam halt (journey.js:612, recovery.js:467-468).',
      before: [
        { path: 'src/engine/orchestrator/task/implementation-failure.ts', lines: 230, note: 'handleFailedImplementation z trzema blokami haltu' },
        { path: 'src/engine/orchestrator/escalation/handle.ts', lines: 567, note: 'seatDownHalt, runnerDefectHalt, runnerHalt' }
      ],
      after: [
        { path: 'src/engine/orchestrator/escalation/halts.ts', lines: 170, note: 'buildSeatHalt({ ctx, state, task, failure: { outcome, runner, message }, booked }) → { issue, row, resetAt } lub null; raiseBuildSeatHalt (publish, INTERRUPT_STEP dla seat-down, raisePendingRecovery); także halt consult-bound z RF_ORCH_06' },
        { path: 'src/engine/orchestrator/task/implementation-failure.ts', lines: 110, note: 'jedno wywołanie raiseBuildSeatHalt zamiast trzech bloków' },
        { path: 'src/engine/orchestrator/escalation/handle.ts', lines: 400, note: 'runnerHalt deleguje do raiseBuildSeatHalt, consultBoundHalt znika (RF_ORCH_06)' }
      ],
      moves: [
        'wspólna część seatDownHalt i runnerDefectHalt (escalation/handle.ts:82-199) → escalation/halts.ts',
        'trzy bloki task/implementation-failure.ts:67-206 → wywołanie raiseBuildSeatHalt z outcome z implResult',
        'różnice zostają parametrami: booked dla runner-timeout-repeated, inPlace.revertedDir dla checkout, cleanup workspace przed defektem zostaje u wywołującego'
      ],
      tests: 'implementation-failure.integration.test.ts i handle.integration.test.ts oraz handle-blocked.integration.test.ts zostają i potwierdzają zachowanie. Nowy escalation/halts.test.ts sprawdza wybór buildera (unauthenticated, usage-limit, RUNNER_DEFECT_BUILDERS) bez pętli retry.',
      importers: 11,
      references: [
        'flow-atlas/data/journey.js:607,612', 'flow-atlas/data/recovery.js:448,467,468,961,1089', 'flow-atlas/data/runners.js:908', 'flow-atlas/data/build.js:1202'
      ],
      steps: [
        '1. Napisz escalation/halts.ts z funkcją, przez którą przejdą oba miejsca (wejście: kontekst z projectDir, modelCache, config, implementerProfile, bus).',
        '2. Zastąp seatDownHalt i runnerDefectHalt w handle.ts wywołaniem nowej funkcji; usuń stare.',
        '3. Zastąp trzy bloki w implementation-failure.ts; usuń stare.',
        '4. npm run typecheck i lint; na końcu testy integracyjne escalation i task.'
      ],
      risks: 'Niskie: drobne różnice (runner z wctx.config.implementer zamiast failure.runner, resetAt tylko dla usage-limit, brak INTERRUPT_STEP przy defekcie) muszą zostać parametrami, nie zgadywaniem. Testy integracyjne seat-down i e2e brief-escalation to wyłapią.'
    },
    {
      id: 'RF_ORCH_06',
      kind: 'extract-shared',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'Jeden halt consult-bound w escalation',
      why: 'consultBoundHalt (escalation/handle.ts:223-265, 43 linie) i raiseConsultBound (escalation/local-retries.ts:78-117, 40 linii) budują ten sam buildConsultBoundRecoveryIssue z tymi samymi 11 polami, publikują publishConsultBoundSpent i ten sam publishError z kodem planner_calls_spent lub consult_bound_spent, a potem raisePendingRecovery. Różnią się tylko kształtem zwracanego wyniku.',
      before: [
        { path: 'src/engine/orchestrator/escalation/handle.ts', lines: 567, note: 'consultBoundHalt' },
        { path: 'src/engine/orchestrator/escalation/local-retries.ts', lines: 303, note: 'raiseConsultBound' }
      ],
      after: [
        { path: 'src/engine/orchestrator/escalation/halts.ts', lines: 170, note: 'raiseConsultBoundHalt(ctx, state, task, lastDiagnosis, lastError, spent) → stan z pending recovery (wspólny plik z RF_ORCH_05)' },
        { path: 'src/engine/orchestrator/escalation/local-retries.ts', lines: 270, note: 'raiseConsultBound znika, zostaje owinięcie wyniku' }
      ],
      moves: [
        'ciało consultBoundHalt i raiseConsultBound → escalation/halts.ts raiseConsultBoundHalt',
        'oba wywołania owijają wynik we własny RetryResult lub RetryStepResult'
      ],
      tests: 'local-retries.integration.test.ts i handle.integration.test.ts zostają. halts.test.ts sprawdza kod bezpieczeństwa dla planner-calls-spent i consult-bound-spent.',
      importers: 0,
      references: [ 'flow-atlas/data/build.js:1210', 'flow-atlas/data/recovery.js:1089' ],
      steps: [
        '1. Dodaj raiseConsultBoundHalt do escalation/halts.ts.',
        '2. Zastąp consultBoundHalt i raiseConsultBound; usuń stare funkcje.',
        '3. typecheck, lint; testy escalation na końcu.'
      ],
      risks: 'Niskie: dwie funkcje są niemal identyczne. Różnica: handle.ts przekazuje handBack do failedRetry, local-retries nie; to zostaje u wywołującego.'
    },
    {
      id: 'RF_ORCH_07',
      kind: 'extract-shared',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'Jedno rozpisanie tożsamości seatów na SummaryBase',
      why: 'run/workflow.ts:120-139 (seatIdentityOf) i session-lifecycle/finalize.ts:71-88 rozpisują te same 12 opcjonalnych pól SeatIdentity (planner, implementer, reviewer × tool, model, kind, axes) na SummaryBase linia w linię. run/init.ts:448-463 robi to samo dla 9 pól stanu z summaryBase. Nowe pole seatu wymaga dziś trzech zmian.',
      before: [
        { path: 'src/engine/orchestrator/run/workflow.ts', lines: 472, note: 'seatIdentityOf' },
        { path: 'src/engine/orchestrator/session-lifecycle/finalize.ts', lines: 155, note: 'finalizeEndedRun rozpisuje ident' },
        { path: 'src/engine/orchestrator/run/init.ts', lines: 801, note: 'kopiowanie pól seatów do nowego stanu' }
      ],
      after: [
        { path: 'src/engine/orchestrator/summary/build.ts', lines: 280, note: 'summaryBaseFromIdentity(ident, { feature, startTime, projectDir, sessionId, modelCache }) i seatFieldsOf(summaryBase) obok typu SummaryBase' }
      ],
      moves: [
        'ciało seatIdentityOf (run/workflow.ts:120-139) → summary/build.ts summaryBaseFromIdentity',
        'finalize.ts:71-88 → wywołanie summaryBaseFromIdentity(recordedSeatIdentity(ref, state), …)',
        'run/init.ts:448-463 → wywołanie seatFieldsOf(summaryBase)'
      ],
      tests: 'build.test.ts dostaje test helpera (pola opcjonalne nie pojawiają się jako undefined). finalize.test.ts i workflow-summary.integration.test.ts zostają.',
      importers: 0,
      references: [],
      steps: [ '1. Dodaj helpery do summary/build.ts.', '2. Zastąp trzy rozpisania; usuń stare.', '3. typecheck (exactOptionalPropertyTypes wyłapie pole undefined), lint.' ],
      risks: 'Niskie. Gate typecheck pilnuje exactOptionalPropertyTypes.'
    },
    {
      id: 'RF_ORCH_08',
      kind: 'extract-shared',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'Użycie istniejących helperów zamiast lokalnych kopii',
      why: 'evidence/review-packet/missing-artifacts.ts (3 linie) to addMissing, identyczne z uniquePush z src/utils/collections.ts:5; 12 wywołań. approval/planner-artifact.ts:191-193 ma isNoEntry, kopię isENOENT z src/lib/process/errors.ts:16. approval/artifact-stage-manifest.ts:603-609 ma digest i digestText, kopie sha256Hex z src/utils/sha256.ts:3; :624-626 ma isAlreadyExists przez ręczne sprawdzenie code, choć isNodeError istnieje w src/lib/process/errors.ts:12.',
      before: [
        { path: 'src/engine/orchestrator/evidence/review-packet/missing-artifacts.ts', lines: 3, note: 'addMissing' },
        { path: 'src/engine/orchestrator/approval/planner-artifact.ts', lines: 193, note: 'isNoEntry' },
        { path: 'src/engine/orchestrator/approval/artifact-stage-manifest.ts', lines: 637, note: 'digest, digestText, isAlreadyExists' }
      ],
      after: [
        { path: 'src/utils/collections.ts', lines: 52, note: 'uniquePush bez zmian, 3 nowe miejsca użycia' },
        { path: 'src/engine/orchestrator/approval/artifact-stage-manifest.ts', lines: 625, note: 'sha256Hex i isNodeError(err) && err.code === EEXIST' }
      ],
      moves: [
        'addMissing → uniquePush w evidence/review-packet/artifacts.ts, build.ts, sections-io.ts; usuń missing-artifacts.ts',
        'isNoEntry → isENOENT w approval/planner-artifact.ts',
        'digest, digestText → sha256Hex; isAlreadyExists → isNodeError w approval/artifact-stage-manifest.ts'
      ],
      tests: 'Bez nowych testów: artifact-stage-manifest.test.ts, planner-artifact*.test.ts i testy review-packet pokrywają te ścieżki.',
      importers: 6,
      references: [],
      steps: [ '1. Zamień wywołania na istniejące helpery.', '2. Usuń missing-artifacts.ts i lokalne funkcje.', '3. typecheck, lint, dangling-imports.' ],
      risks: 'Niskie. sha256Hex(string) haszuje UTF-8 tak jak digestText; typecheck pilnuje typu Buffer → Uint8Array.'
    },
    {
      id: 'RF_ORCH_09',
      kind: 'merge',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'Scalenie jednolinijkowych plików typów w validation/types.ts',
      why: 'validation/acceptance.ts ma 1 linię (ValidationAcceptance), validation/result.ts ma 8 linii (ValidationResult). Obok leży validation/types.ts (25 linii) z typami tego samego folderu. Dwa pliki typów na jeden typ to szum w folderze o 12 plikach.',
      before: [
        { path: 'src/engine/orchestrator/validation/acceptance.ts', lines: 1, note: 'ValidationAcceptance' },
        { path: 'src/engine/orchestrator/validation/result.ts', lines: 8, note: 'ValidationResult' }
      ],
      after: [ { path: 'src/engine/orchestrator/validation/types.ts', lines: 35, note: 'ValidationAcceptance, ValidationResult i dotychczasowe typy' } ],
      moves: [ 'ValidationAcceptance → validation/types.ts', 'ValidationResult → validation/types.ts' ],
      tests: 'Brak testów do przeniesienia; 4 testy task/commit*.test.ts zmieniają import.',
      importers: 8,
      references: [],
      steps: [ '1. Przenieś typy.', '2. Popraw importy: task/brief-gate.ts, task/commit.ts, validation/run-checks.ts, validation/stage.ts i 4 testy commit.', '3. Usuń dwa pliki; typecheck.' ],
      risks: 'Niskie; typecheck i dangling-imports.'
    },
    {
      id: 'RF_ORCH_10',
      kind: 'delete-dead',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'Usunięcie funkcji używanych tylko przez testy',
      why: 'approval/file-snapshots/contents.ts:48-62 writeCurrentFileContent i approval/file-snapshots/entry.ts:240-257 entriesMatch nie mają żadnego wywołania w kodzie produkcyjnym (grep po src, testing, scripts: tylko contents.integration.test.ts i entry.test.ts). Testy sprawdzają kod, którego produkt nie uruchamia.',
      before: [
        { path: 'src/engine/orchestrator/approval/file-snapshots/contents.ts', lines: 64, note: 'writeCurrentFileContent' },
        { path: 'src/engine/orchestrator/approval/file-snapshots/entry.ts', lines: 411, note: 'entriesMatch' }
      ],
      after: [
        { path: 'src/engine/orchestrator/approval/file-snapshots/contents.ts', lines: 48, note: 'bez writeCurrentFileContent' },
        { path: 'src/engine/orchestrator/approval/file-snapshots/entry.ts', lines: 392, note: 'bez entriesMatch' }
      ],
      moves: [ 'usuń writeCurrentFileContent i jego test w contents.integration.test.ts', 'usuń entriesMatch i jego przypadki w entry.test.ts' ],
      tests: 'Usuwa się test writeCurrentFileContent rejects writing through final symlinks i przypadki entriesMatch. Komentarz w restore.integration.test.ts:201 nazywa writeCurrentFileContent(null) i wymaga poprawy.',
      importers: 0,
      references: [],
      steps: [ '1. Potwierdź npm run knip.', '2. Usuń obie funkcje i ich testy.', '3. typecheck, lint.' ],
      risks: 'Niskie: brak wywołań produkcyjnych. Jeśli właściciel chce ich jako kontraktu przyszłej funkcji, zostają; reguła change-discipline mówi o usuwaniu martwej ścieżki.'
    },
    {
      id: 'RF_ORCH_11',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'state-ops.ts → folder state-ops/ (błędy, głowa stanu, CAS, operacje)',
      why: 'state-ops.ts ma 819 linii i dwie odpowiedzialności: mechanikę zapisu state.json z porównaniem rewizji (readStateHead, commitState, commitWorkflowState, mutateState z pętlą konfliktów, linie 34-557) i nazwane operacje domenowe (transitionAndSave, recordBriefCorrection, recordResumeUserMessage, pruneResumeUserMessages, recordLastFailure, raisePendingRecovery, parkStoppedRun, addUsageAndSave, linie 559-819). Mechanika CAS jest dziś testowalna tylko przez operacje. Plik ma 76 importerów (56 produkcyjnych), z czego 47 importuje transitionAndSave.',
      before: [ { path: 'src/engine/orchestrator/state-ops.ts', lines: 819, note: 'błędy, head, rebase, CAS, operacje domenowe' } ],
      after: [
        { path: 'src/engine/orchestrator/state-ops/errors.ts', lines: 85, note: 'MAX_STATE_CONFLICT_RETRIES, StateOperationExpectedRevision, StateOperationContext, StateOperationConflictData, StateOperationConflictError, stateOpsError' },
        { path: 'src/engine/orchestrator/state-ops/head.ts', lines: 180, note: 'workflowStatePath, followCommittedState, revisionsMatch, readStateHead, WorkflowStateHead, readWorkflowStateHead, mergeNativeDeliveryState, mergeQueues, rebaseOnPersistedWorkflowState' },
        { path: 'src/engine/orchestrator/state-ops/commit.ts', lines: 290, note: 'expectedIdentity, conflictData, retryLimit, writeStateFile, commitState, commitWorkflowState, mutateState (eksport wewnątrz folderu), applyTransition' },
        { path: 'src/engine/orchestrator/state-ops/ops.ts', lines: 280, note: 'transitionAndSave, transitionsAndSave, recordBriefCorrection, briefCorrectionStep, recordResumeUserMessage, pruneResumeUserMessages, recordLastFailure, raisePendingRecovery, parkStoppedRun, addUsageAndSave' }
      ],
      moves: [
        'linie 34-118 → state-ops/errors.ts',
        'linie 120-285 → state-ops/head.ts',
        'linie 287-557 → state-ops/commit.ts',
        'linie 559-819 → state-ops/ops.ts'
      ],
      tests: 'state-ops.test.ts dzieli się na commit.test.ts (konflikty, retry, durability-uncertain), head.test.ts (rebase, mergeQueues) i ops.test.ts. Nowa testowalność: mutateState i mergeQueues osobno.',
      importers: 76,
      references: [ 'docs/HOW-IT-WORKS.md:239', 'docs/ENGINE.md:113,241', 'docs/ARCHITECTURE.md:896', 'docs/TROUBLESHOOTING.md:906', 'flow-atlas/data/lifecycle.js:1317' ],
      steps: [
        '1. Utwórz cztery pliki i przenieś kod.',
        '2. Mechanicznie popraw importy w 76 plikach (sed po nazwach: transitionAndSave, raisePendingRecovery, addUsageAndSave, parkStoppedRun → ops.js; rebaseOnPersistedWorkflowState, readWorkflowStateHead → head.js; stateOpsError → errors.js; commitWorkflowState → commit.js).',
        '3. Usuń state-ops.ts; typecheck, lint, dangling-imports.'
      ],
      risks: 'Niskie ryzyko zachowania, duży zasięg zmian (76 plików). Reguła zero barrels zabrania fasady state-ops.ts z reeksportami, więc każdy importer się zmienia; decyzja właściciela, czy zysk (osobne testy CAS) wart jest tej rotacji. typecheck wyłapie każdy błędny import.'
    },
    {
      id: 'RF_ORCH_12',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'events.ts → folder publish/ według dziedziny zdarzeń',
      why: 'events.ts ma 746 linie i 41 eksportowanych helperów: zdarzenia runnera i plannera, briefów, review, recovery i seatów oraz komunikaty (error, warning, info). 52 pliki produkcyjne importują go, z czego 20 bierze tylko publishWarning, publishError, publishWarningFromError lub publishInfo; 18 helperów ma po jednym importerze produkcyjnym. Nazwa events.ts myli się z src/engine/events/ (bus i schemat) i z approval/events.ts.',
      before: [
        { path: 'src/engine/orchestrator/events.ts', lines: 746, note: '41 helperów publish* i create*' },
        { path: 'src/engine/orchestrator/approval/events.ts', lines: 57, note: 'publishApprovalRejected, publishApprovalGranted, publishApprovalPrompted' }
      ],
      after: [
        { path: 'src/engine/orchestrator/publish/notice.ts', lines: 120, note: 'publishError, publishInfo, publishWarning, publishWarningFromError, publishUserMessage, publishWorkflowConfig' },
        { path: 'src/engine/orchestrator/publish/runner.ts', lines: 170, note: 'publishRunnerCallEvent, createBusTextHandler, createImplementerTextHandler, publishPlannerStatus, publishImplementerGenerate*, createImplementerPublisher, publishCostUpdate' },
        { path: 'src/engine/orchestrator/publish/task.ts', lines: 190, note: 'publishTasksPlanned, publishTaskStart, publishTaskSkipped, publishTaskComplete, publishTaskReplaced, publishTasksInserted, publishTaskValidating, publishRetry, publishChecksRun, publishNoProgressCut, publishGitBranchCreated' },
        { path: 'src/engine/orchestrator/publish/review.ts', lines: 150, note: 'publishReviewEvent, publishFixCycleStarted, publishReviewChecksPlan, publishReviewCheck, planCheckRow, unranCheckRow, publishRunRejected' },
        { path: 'src/engine/orchestrator/publish/recovery.ts', lines: 170, note: 'publishRecoveryPrompted, publishRecoveryEvent, publishRecoveryActionSelected, publishRecoveryActionFailed, publishRecoveryResolved, publishConsultAnswered, publishConsultBoundSpent, publishSeatWaitStarted, publishSeatSwitched, publishSeatRetry' },
        { path: 'src/engine/orchestrator/publish/approval.ts', lines: 57, note: 'z approval/events.ts' }
      ],
      moves: [ 'helpery według listy after; BusContext i OperationalMessageSafety → publish/notice.ts', 'approval/events.ts → publish/approval.ts' ],
      tests: 'events.test.ts dzieli się według modułów (notice.test.ts, runner.test.ts, review.test.ts, recovery.test.ts).',
      importers: 61,
      references: [ 'docs/ARCHITECTURE.md:368', 'docs/ENGINE.md:137,314', 'docs/TYPES.md:139', 'docs/EXTENDING.md:43', 'flow-atlas/data/review.js:1069,1245', 'flow-atlas/data/structure.js:884,1686', 'flow-atlas/data/subsystems.js:582,1336' ],
      steps: [
        '1. Utwórz publish/ i przenieś helpery.',
        '2. Popraw importy w 61 plikach (mechanicznie po nazwie helpera).',
        '3. Zaktualizuj przepis w docs/EXTENDING.md:43 (gdzie dodać nowy helper publish).',
        '4. Usuń events.ts i approval/events.ts; typecheck, lint, dangling-imports.'
      ],
      risks: 'Niskie ryzyko zachowania, duży zasięg (61 plików). Ta sama decyzja co RF_ORCH_11: bez fasady każdy importer się zmienia.'
    },
    {
      id: 'RF_ORCH_13',
      kind: 'folderize',
      priority: 2,
      effort: 'M',
      risk: 'medium',
      title: 'run/init.ts i run/init-* → folder run/init/',
      why: 'run/init.ts ma 801 linii: initializeWorkflow to 379 linii (przypięcie approve, recordInterruptedCalls, seedUsageLimitSteps z a9f2ab9, uzgodnienie rekordu seatów, seat wait (od 42fb57f resumeSeatWait dostaje config), workflow_config z rodzajem i osiami seatów (016daca), kontynuacja, skille, seaty, nowy stan albo wznowienie, WorkflowContext), a linie 571-801 to osobny temat: naprawa stanu przy wznowieniu (stale halt, realignPassedTaskIndex, restoreUnresumedBriefCut, restartInterruptedTask). Obok leżą init-seats.ts i init-sinks.ts: plik x.ts obok rodzeństwa x-*.ts.',
      before: [
        { path: 'src/engine/orchestrator/run/init.ts', lines: 801, note: 'opcje, initializeWorkflow, naprawy wznowienia' },
        { path: 'src/engine/orchestrator/run/init-seats.ts', lines: 101, note: 'createPlannerSeat, createImplementerSeat' },
        { path: 'src/engine/orchestrator/run/init-sinks.ts', lines: 87, note: 'attachRunSinks' }
      ],
      after: [
        { path: 'src/engine/orchestrator/run/init/initialize.ts', lines: 260, note: 'initializeWorkflow jako sekwencja kroków' },
        { path: 'src/engine/orchestrator/run/init/options.ts', lines: 65, note: 'RunWorkflowOptions, InitResult, InitializeWorkflowArgs' },
        { path: 'src/engine/orchestrator/run/init/saved-state.ts', lines: 110, note: 'przypięcie approve (linie 231-253) i uzgodnienie rekordu seatów z publishSeatSwitched (linie 266-316)' },
        { path: 'src/engine/orchestrator/run/init/start-state.ts', lines: 75, note: 'nowy stan: START, workflow_started, wiadomość użytkownika, ostrzeżenia gotowości, gałąź git (linie 438-494)' },
        { path: 'src/engine/orchestrator/run/init/resume-repair.ts', lines: 240, note: 'publishResumedSteer, resumeContinuation, isStaleHalt, hasStaleHalt, settleStaleHalt, realignPassedTaskIndex, restoreUnresumedBriefCut, isTaskInFlight, restartInterruptedTask, shouldPublishResumePlannerStatus' },
        { path: 'src/engine/orchestrator/run/init/custom-runtime.ts', lines: 45, note: 'composeWorkflowCustomRunnerRuntime, plannerUnavailableMessage' },
        { path: 'src/engine/orchestrator/run/init/seats.ts', lines: 101, note: 'z run/init-seats.ts' },
        { path: 'src/engine/orchestrator/run/init/sinks.ts', lines: 87, note: 'z run/init-sinks.ts' }
      ],
      moves: [
        'run/init.ts:108-165 → init/options.ts; :167-190 i :98-106 → init/custom-runtime.ts; :571-801 → init/resume-repair.ts',
        'bloki z initializeWorkflow → init/saved-state.ts i init/start-state.ts; reszta → init/initialize.ts',
        'run/init-seats.ts → run/init/seats.ts; run/init-sinks.ts → run/init/sinks.ts'
      ],
      tests: 'init.integration.test.ts, init-configured-custom.integration.test.ts, init-configured-custom-direct-stage.integration.test.ts, init-hook-trust.integration.test.ts → run/init/initialize*.integration.test.ts; init-seats.test.ts → run/init/seats.test.ts; init-sinks.test.ts → run/init/sinks.test.ts. Nowe testy jednostkowe dla resume-repair (realignPassedTaskIndex, restoreUnresumedBriefCut na czystym stanie) i saved-state.',
      importers: 24,
      references: [
        'docs/STRUCTURE.md:148', 'docs/HOW-IT-WORKS.md:71,73,77,85,89,291', 'docs/ENGINE.md:13', 'docs/ARCHITECTURE.md:876,886', 'docs/CONCEPTS.md:282', 'docs/MIGRATION.md:98', 'docs/EXTENDING.md:107', 'docs/DOGFOODING.md:126', 'docs/APPROVAL-AND-RECOVERY.md:349',
        'flow-atlas/data/lifecycle.js:640,652,667,679,1124,1131,1319', 'flow-atlas/data/recovery.js:435,869,881,1107', 'flow-atlas/data/structure.js:1599,1793', 'flow-atlas/data/ui.js:31,1081', 'flow-atlas/data/journey.js:812,882', 'flow-atlas/data/subsystems.js:23,519,531,803,872,985,1333,1375', 'flow-atlas/data/runners.js:892', 'flow-atlas/data/startup.js:941'
      ],
      steps: [
        '1. git mv run/init-seats.ts i run/init-sinks.ts do run/init/ z testami.',
        '2. Wydziel options.ts, custom-runtime.ts i resume-repair.ts (czyste przeniesienie).',
        '3. Wydziel saved-state.ts i start-state.ts z initializeWorkflow; stan i setTrackedState przekazuj jawnie.',
        '4. Popraw importy: run/workflow.ts, src/features/workflow/hooks/use-run-loop.ts (RunWorkflowOptions), testing/helpers/tracked-workflow.ts, testing/integration/cli/pty/child.ts i 20 testów.',
        '5. Usuń run/init.ts; typecheck, lint, dangling-imports; zaktualizuj references (STRUCTURE.md:148 nazywa jedyne miejsce subskrypcji sinków).'
      ],
      risks: 'Średnie: initializeWorkflow mutuje savedState w kilku krokach (approve, plannerSessionId po zmianie seatu planu); kroki muszą zwracać nowy stan. Wyłapią to init*.integration.test.ts i testy stop-continue e2e. Dokument INVARIANTS gate 52 i STRUCTURE.md:148 nazywają attachRunSinks jako jedyne miejsce subskrypcji; ścieżka się zmienia, zasada nie.'
    },
    {
      id: 'RF_ORCH_14',
      kind: 'folderize',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'Folder recovery/seat/ dla przełączania seatu',
      why: 'W recovery/ leżą dwie grupy prefiksowe o jednym temacie: switch-seat.ts (150) i switch-seat-resume.ts (216) oraz seat-swap-context.ts (269) i seat-protocol-halt.ts (42). Do tego część switch-seat siedzi w recovery/actions.ts (patrz RF_ORCH_03), a typy SeatSwapContext i DetectedSeatTool w builders/task.ts.',
      before: [
        { path: 'src/engine/orchestrator/recovery/switch-seat.ts', lines: 150, note: 'configWithSwitchedSeat, seatCandidateOfRunner' },
        { path: 'src/engine/orchestrator/recovery/switch-seat-resume.ts', lines: 216, note: 'switchSeatAndPrepareResume' },
        { path: 'src/engine/orchestrator/recovery/seat-swap-context.ts', lines: 269, note: 'readSeatOfRecord, loadSeatSwapContext' },
        { path: 'src/engine/orchestrator/recovery/seat-protocol-halt.ts', lines: 42, note: 'seatProtocolHaltIssue' }
      ],
      after: [
        { path: 'src/engine/orchestrator/recovery/seat/switch-config.ts', lines: 150, note: 'z switch-seat.ts' },
        { path: 'src/engine/orchestrator/recovery/seat/switch-resume.ts', lines: 216, note: 'z switch-seat-resume.ts' },
        { path: 'src/engine/orchestrator/recovery/seat/swap-context.ts', lines: 300, note: 'z seat-swap-context.ts plus typy SeatSwapContext i DetectedSeatTool z builders' },
        { path: 'src/engine/orchestrator/recovery/seat/protocol-halt.ts', lines: 42, note: 'z seat-protocol-halt.ts' },
        { path: 'src/engine/orchestrator/recovery/seat/switch-action.ts', lines: 340, note: 'z RF_ORCH_03' }
      ],
      moves: [ 'cztery pliki → recovery/seat/ bez zmiany treści', 'typy SeatSwapContext, DetectedSeatTool → seat/swap-context.ts' ],
      tests: 'switch-seat.test.ts → seat/switch-config.test.ts; switch-seat-resume.test.ts i .integration.test.ts → seat/switch-resume*.test.ts; seat-swap-context.test.ts i .integration.test.ts → seat/swap-context*.test.ts; seat-protocol-halt.test.ts → seat/protocol-halt.test.ts.',
      importers: 21,
      references: [ 'docs/APPROVAL-AND-RECOVERY.md:234,258', 'flow-atlas/data/recovery.js:547,560,572,787,801,814,920,1095,1100,1103,1104', 'flow-atlas/data/runners.js:528', 'flow-atlas/data/journey.js:828' ],
      steps: [ '1. git mv cztery pliki i ich testy.', '2. Popraw importy w 10 plikach produkcyjnych (m.in. run/init.ts, run/seat-swap.ts, escalation/handle.ts, planning/session.ts, task/retry.ts, task/implementation-failure.ts, run/review.ts, recovery/planner-call-failure.ts) i fiksturze testing/visual.', '3. typecheck, dangling-imports.' ],
      risks: 'Niskie: czyste przeniesienie. Kolejność z RF_ORCH_02 i RF_ORCH_03 nie ma znaczenia, ale robione razem dają jedną zmianę importów.'
    },
    {
      id: 'RF_ORCH_15',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'medium',
      title: 'task/step.ts: wydzielenie odświeżenia nieaktualnego briefu i decyzji po próbie',
      why: 'task/step.ts ma 631 linii; runSingleTask to 380 linii liniowego potoku (stale refresh, pre-task, implementacja, status apply, gate zmian, potwierdzenie decyzji, brief gate, retry). refreshStaleTask (95 linii) z rerunReplacedTask i staleConsultError to osobny temat, który dokumentacja opisuje osobno (APPROVAL-AND-RECOVERY.md:101). Blok gateAttemptChanges → confirmAttemptDecisions (ok. linie 427-520) z recordApprovalDenial to druga osobna decyzja.',
      before: [
        { path: 'src/engine/orchestrator/task/step.ts', lines: 631, note: 'recordApprovalDenial, rerunReplacedTask, refreshStaleTask, staleConsultError, runSingleTask' },
        { path: 'src/engine/orchestrator/task/stale-inputs.ts', lines: 91, note: 'hashe wejść briefu' }
      ],
      after: [
        { path: 'src/engine/orchestrator/task/step.ts', lines: 330, note: 'runSingleTask jako potok kroków' },
        { path: 'src/engine/orchestrator/task/stale.ts', lines: 235, note: 'stale-inputs.ts plus StaleRefresh, rerunReplacedTask, refreshStaleTask, staleConsultError' },
        { path: 'src/engine/orchestrator/task/attempt-decisions.ts', lines: 150, note: 'recordApprovalDenial i krok gate → confirm zwracający validate albo stan zatrzymania' }
      ],
      moves: [ 'step.ts:111-250 i stale-inputs.ts → task/stale.ts', 'step.ts:59-87 i blok gate/confirm → task/attempt-decisions.ts' ],
      tests: 'step-stale.integration.test.ts → stale.integration.test.ts; step-approval.integration.test.ts i step-user-edit.integration.test.ts testują attempt-decisions; pozostałe step-*.integration.test.ts zostają. Testy stale-inputs → stale.test.ts.',
      importers: 20,
      references: [ 'docs/APPROVAL-AND-RECOVERY.md:101', 'docs/HOW-IT-WORKS.md:152', 'docs/ARCHITECTURE.md:1324', 'docs/DIRECTION.md:91', 'docs/TESTING.md:159', 'docs/STRUCTURE.md:656', 'CONTRIBUTING.md:137', 'flow-atlas/data/build.js:17,518,533,573,961,1263,1273' ],
      steps: [ '1. Scal stale-inputs.ts z funkcjami refresh w task/stale.ts; popraw 9 importerów stale-inputs.', '2. Wydziel attempt-decisions.ts.', '3. typecheck, lint; testy step-* na końcu.' ],
      risks: 'Średnie: runSingleTask ma wiele wczesnych return state; wydzielony krok musi zwracać unię (kontynuuj albo stan). Wyłapią to step-*.integration.test.ts (8 plików).'
    },
    {
      id: 'RF_ORCH_16',
      kind: 'split',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'run/task-execution.ts: wydzielenie ponownego sprawdzenia po scaleniu i parkowania na granicy',
      why: 'run/task-execution.ts ma 570 linii: runTasksAndReview (295), recheckMergedCandidate (137) z buildIntegrationSection (17) i parkAtBoundary (52). Ponowne sprawdzenie kandydata po scaleniu Apply to osobny przypadek, testowalny osobno.',
      before: [ { path: 'src/engine/orchestrator/run/task-execution.ts', lines: 570, note: 'parkAtBoundary, buildIntegrationSection, recheckMergedCandidate, runTasksAndReview' } ],
      after: [
        { path: 'src/engine/orchestrator/run/task-execution.ts', lines: 345, note: 'runTasksAndReview' },
        { path: 'src/engine/orchestrator/run/integration-recheck.ts', lines: 175, note: 'buildIntegrationSection, recheckMergedCandidate' },
        { path: 'src/engine/orchestrator/run/boundary-park.ts', lines: 65, note: 'parkAtBoundary' }
      ],
      moves: [ 'linie 120-274 → run/integration-recheck.ts', 'linie 62-113 → run/boundary-park.ts' ],
      tests: 'task-execution.integration.test.ts i task-execution-conformance.integration.test.ts zostają; przypadki merged-candidate można przenieść do integration-recheck.integration.test.ts.',
      importers: 8,
      references: [ 'docs/HOW-IT-WORKS.md:131', 'docs/SUBSYSTEMS.md:29', 'flow-atlas/data/review.js:16,306,332,1209', 'flow-atlas/data/build.js:7,15,1036,1115,1261', 'flow-atlas/data/lifecycle.js:1171,1327', 'flow-atlas/data/journey.js:389,814,870', 'flow-atlas/data/subsystems.js:611,672,968,1379' ],
      steps: [ '1. Przenieś funkcje.', '2. typecheck, lint.' ],
      risks: 'Niskie: funkcje są już osobne, tylko w jednym pliku.'
    },
    {
      id: 'RF_ORCH_17',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'planning/session.ts: tekst tury, kompilacja planu, karta planu i odpowiedzi',
      why: 'planning/session.ts ma 786 linie, z czego 110 to importy. Poza runPlanningSession (242) mieści planTurnText (82, opisany w REPOMAP.md jako jedyny budowniczy promptu planu), compilePlan i checkFullPlan, runPlanApproval z applyPlanEdit (karta planu, 116 linii) oraz recordAnswers i settle.',
      before: [ { path: 'src/engine/orchestrator/planning/session.ts', lines: 786, note: 'buildSeat, earlierPlanning, planTurnText, discoveredValidation, runPlanningSession, recordAnswers, settle, compilePlan, checkFullPlan, applyPlanEdit, runPlanApproval' } ],
      after: [
        { path: 'src/engine/orchestrator/planning/session.ts', lines: 310, note: 'Terminal, buildSeat, runPlanningSession' },
        { path: 'src/engine/orchestrator/planning/turn-text.ts', lines: 125, note: 'earlierPlanning, PlanTurnText, planTurnText' },
        { path: 'src/engine/orchestrator/planning/compile.ts', lines: 85, note: 'discoveredValidation, compilePlan, PlanCheckContext, checkFullPlan' },
        { path: 'src/engine/orchestrator/planning/approval.ts', lines: 130, note: 'applyPlanEdit, runPlanApproval' },
        { path: 'src/engine/orchestrator/planning/answers.ts', lines: 95, note: 'recordAnswers, settle' }
      ],
      moves: [ 'linie 137-256 → turn-text.ts', 'linie 258-266, 600-658 → compile.ts', 'linie 664-786 → approval.ts', 'linie 518-597 → answers.ts' ],
      tests: 'session.test.ts dzieli się na turn-text.test.ts (czysty tekst promptu), compile.test.ts i approval.test.ts. Nowa testowalność: planTurnText bez sesji.',
      importers: 7,
      references: [ 'docs/TASK-CONTRACT.md:100', 'docs/CONCEPTS.md:202', 'docs/PLANNERS-AND-IMPLEMENTERS.md:65', 'docs/REPOMAP.md:118,122', 'docs/HOW-IT-WORKS.md:110,114', 'docs/ARCHITECTURE.md:866,868', 'docs/WORKFLOW.md:330,332', 'docs/STRUCTURE.md:643', 'flow-atlas/data/planning.js:401,413,437,449,473,690,705,744,755,771,783,798,933-941,1091' ],
      steps: [ '1. Przenieś funkcje.', '2. Popraw importy runPlanApproval (2 pliki produkcyjne) i checkFullPlan.', '3. typecheck, lint; zaktualizuj dokumenty, które wiążą planTurnText, checkFullPlan, runPlanApproval z session.ts.' ],
      risks: 'Niskie. CLAUDE.md nazywa session.ts jako sterownik sesji; ta rola zostaje w session.ts.'
    },
    {
      id: 'RF_ORCH_18',
      kind: 'folderize',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'approval/artifact-stage-* → folder approval/artifact-stage/ i podział manifestu',
      why: 'approval/artifact-stage-manifest.ts ma 637 linii i 31 funkcji: lease (prepare i create), parsowanie provenance, walidacja ścieżek i przodków, odczyt dzierżawionego pliku, paragon i odcisk, prymitywy uchwytów plików. Obok leży artifact-stage-capture.ts (287): grupa prefiksowa artifact-stage-*.',
      before: [
        { path: 'src/engine/orchestrator/approval/artifact-stage-manifest.ts', lines: 637, note: 'lease, provenance, ścieżki, receipt, uchwyty' },
        { path: 'src/engine/orchestrator/approval/artifact-stage-capture.ts', lines: 287, note: 'capture etapu artefaktu' }
      ],
      after: [
        { path: 'src/engine/orchestrator/approval/artifact-stage/capture.ts', lines: 287, note: 'z artifact-stage-capture.ts' },
        { path: 'src/engine/orchestrator/approval/artifact-stage/lease.ts', lines: 260, note: 'typy lease, prepareArtifactStageLease, createArtifactStageLease, normalizePreparation, readLeasedArtifact, assertPreparedArtifact' },
        { path: 'src/engine/orchestrator/approval/artifact-stage/provenance.ts', lines: 75, note: 'parseArtifactProvenance, parseNullableId, parseArtifactBound' },
        { path: 'src/engine/orchestrator/approval/artifact-stage/paths.ts', lines: 170, note: 'resolveDeclaredPath, validateRelativeArtifactPath, createFreshMetadataDirectories, createDirectory, assertStageRoot, captureArtifactAncestry, assertFinalArtifactPathBound, ancestryFingerprint, inodeIdentity' },
        { path: 'src/engine/orchestrator/approval/artifact-stage/receipt.ts', lines: 60, note: 'createArtifactLeaseReceipt, decodeCanonicalUtf8, rejectDeclaredValues, safeByteLength' },
        { path: 'src/engine/orchestrator/approval/artifact-stage/handles.ts', lines: 45, note: 'readHandleStat, artifactOpenFlags, writeAll, assertLeasedHandleStat' }
      ],
      moves: [ 'funkcje według listy after', 'digest i isAlreadyExists znikają przez RF_ORCH_08' ],
      tests: 'artifact-stage-manifest.test.ts → artifact-stage/lease.test.ts; provenance i paths dostają własne testy jednostkowe (czyste parsowanie i walidacja ścieżek).',
      importers: 3,
      references: [],
      steps: [ '1. git mv artifact-stage-capture.ts.', '2. Rozbij manifest; approval/planner-artifact.ts importuje prepareArtifactStageLease z artifact-stage/lease.js.', '3. typecheck, lint.' ],
      risks: 'Niskie: jeden importer produkcyjny. Kod dotyka bezpieczeństwa plików (O_NOFOLLOW, przodkowie), więc przeniesienie bez zmiany ciał.'
    },
    {
      id: 'RF_ORCH_19',
      kind: 'folderize',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'isolation/*-worktree → folder isolation/worktree/',
      why: 'W isolation/ (12 plików) cztery pliki dotyczą worktree: worktree.ts (301), create-worktree.ts (54), remove-worktree.ts (157), worktree-status.ts (63). Grupa sufiksowa i plik x.ts obok x-*.ts.',
      before: [
        { path: 'src/engine/orchestrator/isolation/worktree.ts', lines: 301, note: 'ensureIsolationWorktree, parseIsolationMarker, linkProjectNodeModules, removeNodeModulesExclude' },
        { path: 'src/engine/orchestrator/isolation/create-worktree.ts', lines: 54, note: 'createWorktree, initWorktreeSubmodules' },
        { path: 'src/engine/orchestrator/isolation/remove-worktree.ts', lines: 157, note: 'removeRunWorkspace, removeWorktree' },
        { path: 'src/engine/orchestrator/isolation/worktree-status.ts', lines: 63, note: 'findLiveWorktreeSession' }
      ],
      after: [
        { path: 'src/engine/orchestrator/isolation/worktree/ensure.ts', lines: 301, note: 'z worktree.ts' },
        { path: 'src/engine/orchestrator/isolation/worktree/create.ts', lines: 54, note: 'z create-worktree.ts' },
        { path: 'src/engine/orchestrator/isolation/worktree/remove.ts', lines: 157, note: 'z remove-worktree.ts' },
        { path: 'src/engine/orchestrator/isolation/worktree/status.ts', lines: 63, note: 'z worktree-status.ts' }
      ],
      moves: [ 'cztery pliki bez zmiany treści' ],
      tests: 'worktree.integration.test.ts, create-worktree.integration.test.ts, remove-worktree.integration.test.ts → worktree/*.integration.test.ts. Zmieniają import także isolation/confinement.integration.test.ts, isolation/create.integration.test.ts, run/close*.test.ts, approval/filesystem-boundaries.integration.test.ts i src/engine/runtime-hard-cut.integration.test.ts.',
      importers: 12,
      references: [ 'docs/IMPLEMENTER-DIRECTION.md:202', 'flow-atlas/data/lifecycle.js:1335,1336', 'flow-atlas/data/subsystems.js:1168' ],
      steps: [ '1. git mv cztery pliki z testami.', '2. Popraw importy (base-tree.ts, create.ts, run/close.ts i testy).', '3. typecheck, dangling-imports.' ],
      risks: 'Niskie.'
    },
    {
      id: 'RF_ORCH_20',
      kind: 'move',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'task/routing* → context-routing/',
      why: 'task/routing.ts (76), task/routing-fields.ts (39) i task/routing-selection.ts (95) to grupa prefiksowa w folderze task/ (26 plików), a temat routingu kontekstu ma już własny folder context-routing/ (8 plików), z którego te pliki importują typy i routeTaskToImplementerProfile.',
      before: [
        { path: 'src/engine/orchestrator/task/routing.ts', lines: 76, note: 'configForProfile, selectedProfileFromDecision, retryProfileForTask, routingBlockMessage' },
        { path: 'src/engine/orchestrator/task/routing-fields.ts', lines: 39, note: 'RoutingEventFields, pola zdarzeń routingu' },
        { path: 'src/engine/orchestrator/task/routing-selection.ts', lines: 95, note: 'wybór profilu dla briefu, halt context overflow' }
      ],
      after: [
        { path: 'src/engine/orchestrator/context-routing/profile.ts', lines: 76, note: 'z task/routing.ts' },
        { path: 'src/engine/orchestrator/context-routing/event-fields.ts', lines: 39, note: 'z task/routing-fields.ts' },
        { path: 'src/engine/orchestrator/context-routing/select.ts', lines: 95, note: 'z task/routing-selection.ts' }
      ],
      moves: [ 'trzy pliki bez zmiany treści' ],
      tests: 'routing.integration.test.ts, routing-configured-retry.integration.test.ts, routing-selection.integration.test.ts → context-routing/*.integration.test.ts.',
      importers: 8,
      references: [ 'docs/HOW-IT-WORKS.md:148', 'docs/PLANNERS-AND-IMPLEMENTERS.md:403', 'docs/STRUCTURE.md:662', 'flow-atlas/data/build.js:439,1120,1276' ],
      steps: [ '1. git mv z testami.', '2. Popraw importy w task/loop.ts i task/pre-task.ts.', '3. typecheck.' ],
      risks: 'Niskie.'
    },
    {
      id: 'RF_ORCH_21',
      kind: 'move',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'Generyczne moduły z korzenia orchestratora do utils i lib',
      why: 'serial-executor.ts (24 linie, createWriteSequencer) nie zna żadnego pojęcia SPLITBRIEF i importuje go też src/engine/snapshots/run/lifecycle.ts. signals.ts (34 linie, withSignalHandlers, SIGNAL_EXIT_CODE) owija sygnały procesu Node i importują go trzy pliki src/cli. Według docs/LAYERS.md pierwszy należy do utils (czysty prymityw), drugi do lib/process (adapter Node).',
      before: [
        { path: 'src/engine/orchestrator/serial-executor.ts', lines: 24, note: 'createWriteSequencer' },
        { path: 'src/engine/orchestrator/signals.ts', lines: 34, note: 'TerminationSignal, SIGNAL_EXIT_CODE, withSignalHandlers' }
      ],
      after: [
        { path: 'src/utils/serial-executor.ts', lines: 24, note: 'bez zmian' },
        { path: 'src/lib/process/signals.ts', lines: 34, note: 'bez zmian' }
      ],
      moves: [ 'serial-executor.ts → src/utils/', 'signals.ts → src/lib/process/' ],
      tests: 'serial-executor.test.ts i signals.test.ts przenoszą się razem z plikami.',
      importers: 16,
      references: [ 'docs/HOW-IT-WORKS.md:253', 'docs/ENGINE.md:275', 'flow-atlas/data/lifecycle.js:1332', 'flow-atlas/data/startup.js:1482' ],
      steps: [ '1. git mv z testami.', '2. Popraw importy: queue/clear.ts, queue/submit.ts, session-lifecycle/install-queue.ts, src/engine/snapshots/run/lifecycle.ts, src/cli/headless.ts, src/cli/render/app.ts, src/cli/render/process-lifecycle.ts, session-lifecycle/shutdown.ts.', '3. typecheck; npm run invariants (import-boundaries).' ],
      risks: 'Niskie. Pliki wchodzą do części innego właściciela (utils, lib); uzgodnić z właścicielem tej części.'
    },
    {
      id: 'RF_ORCH_22',
      kind: 'move',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'Porządek korzenia: resume-context do transcript/, karty artefaktów planu do plan-files/',
      why: 'resume-context.ts (149) składa transcript/rebuild.ts i transcript/compaction.ts w kontekst wznowienia plannera, więc należy do transcript/. artifact-card.ts (382) i artifact-write.ts (45) obsługują wyłącznie plan.md i tasks.md (zapis i kartę artifact_written); słowo artifact w korzeniu myli się z approval/artifact-stage (artefakty niestandardowego runnera). Po RF_ORCH_01, RF_ORCH_12, RF_ORCH_21 i tej zmianie w korzeniu zostają kontrakty wspólne: types.ts, state-ops/, publish/, continuation.ts, kept-work.ts, changed-files-baseline.ts, tokens.ts, cancellable-call.ts, planner-session.ts.',
      before: [
        { path: 'src/engine/orchestrator/resume-context.ts', lines: 149, note: 'autoCompactResumeContext, applyRebuiltContext, withFreshSessionReissue' },
        { path: 'src/engine/orchestrator/artifact-card.ts', lines: 382, note: 'buildArtifactExcerpt, publishArtifactWritten' },
        { path: 'src/engine/orchestrator/artifact-write.ts', lines: 45, note: 'writeTasksArtifact, writeAndPublishPlanArtifacts' }
      ],
      after: [
        { path: 'src/engine/orchestrator/transcript/resume-context.ts', lines: 149, note: 'bez zmian' },
        { path: 'src/engine/orchestrator/plan-files/card.ts', lines: 382, note: 'z artifact-card.ts' },
        { path: 'src/engine/orchestrator/plan-files/write.ts', lines: 45, note: 'z artifact-write.ts' }
      ],
      moves: [ 'resume-context.ts → transcript/resume-context.ts', 'artifact-card.ts → plan-files/card.ts', 'artifact-write.ts → plan-files/write.ts' ],
      tests: 'resume-context.test.ts, artifact-card.test.ts, artifact-write.test.ts przenoszą się razem z plikami; fikstury testing/visual/fixtures/workflow/artifact-card-projections.ts i projections.ts zmieniają import.',
      importers: 9,
      references: [ 'docs/HOW-IT-WORKS.md:294', 'docs/SUBSYSTEMS.md:97', 'docs/ARCHITECTURE.md:285,920', 'flow-atlas/data/lifecycle.js:1138', 'flow-atlas/data/planning.js:597,1103', 'flow-atlas/data/subsystems.js:28,802,859,887,1352' ],
      steps: [ '1. git mv z testami.', '2. Popraw importy: planner-session.ts, run/init.ts, planning/session.ts, triage.ts (lub review/triage.ts) i 2 fikstury.', '3. typecheck, dangling-imports.' ],
      risks: 'Niskie.'
    },
    {
      id: 'RF_ORCH_23',
      kind: 'folderize',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'task/*-gate.ts → folder task/gates/',
      why: 'task/ ma 26 plików produkcyjnych, w tym cztery bramki z sufiksem -gate: attempt-gate.ts (97), brief-gate.ts (162), dependency-gate.ts (53), pre-validation-gate.ts (64). Folder skraca listę task/ i nazywa wspólną rolę.',
      before: [
        { path: 'src/engine/orchestrator/task/attempt-gate.ts', lines: 97, note: 'gateAttemptChanges, denialMessage' },
        { path: 'src/engine/orchestrator/task/brief-gate.ts', lines: 162, note: 'runBriefGate, CORRECTION_AFTER_CHECKS' },
        { path: 'src/engine/orchestrator/task/dependency-gate.ts', lines: 53, note: 'checkDependencyGate' },
        { path: 'src/engine/orchestrator/task/pre-validation-gate.ts', lines: 64, note: 'runPreValidationGate' }
      ],
      after: [
        { path: 'src/engine/orchestrator/task/gates/attempt.ts', lines: 97, note: 'z attempt-gate.ts' },
        { path: 'src/engine/orchestrator/task/gates/brief.ts', lines: 162, note: 'z brief-gate.ts' },
        { path: 'src/engine/orchestrator/task/gates/dependency.ts', lines: 53, note: 'z dependency-gate.ts' },
        { path: 'src/engine/orchestrator/task/gates/pre-validation.ts', lines: 64, note: 'z pre-validation-gate.ts' }
      ],
      moves: [ 'cztery pliki bez zmiany treści' ],
      tests: 'Testy *-gate*.test.ts przenoszą się do task/gates/ (10 plików testów importuje te moduły).',
      importers: 16,
      references: [ 'docs/STRUCTURE.md:659,662,665', 'docs/HOW-IT-WORKS.md:158,159', 'docs/WORKFLOW.md:131', 'docs/PLANNERS-AND-IMPLEMENTERS.md:287', 'docs/ARCHITECTURE.md:454,1324', 'docs/DIRECTION.md:91', 'docs/APPROVAL-AND-RECOVERY.md:63,99', 'CONTRIBUTING.md:143', 'flow-atlas/data/build.js:413,604,668,698,713,725,1114,1128,1266,1267', 'flow-atlas/data/journey.js:871', 'flow-atlas/data/subsystems.js:493' ],
      steps: [ '1. git mv z testami.', '2. Popraw importy: escalation/retry-evidence.ts, escalation/step.ts, escalation/validate-and-commit.ts, consult/apply.ts, task/step.ts, task/loop.ts.', '3. typecheck; zaktualizuj STRUCTURE.md (kanoniczny przykład folderu task/).' ],
      risks: 'Niskie. Zmienia kanoniczny przykład w docs/STRUCTURE.md:654-662.'
    }
  ],
  keep: [
    { path: 'src/engine/orchestrator/isolation/create.ts', lines: 541, reason: 'Jedna fabryka createRunIsolation (475 linii) z cyklem życia jednego workspace: open, acquire, dispose dzielą ok. 20 zmiennych domknięcia (latchedStrategy, worktreeDir, pendingCleanup, inFlightOperations, disposed). Podział wymagałby jawnego obiektu stanu, czyli zmiany projektu. Opcjonalnie można wydzielić memo env sandboxa (linie 177-225) jako fabrykę.' },
    { path: 'src/engine/orchestrator/run/workflow.ts', lines: 472, reason: 'Korzeń kompozycji jednego runu: runWorkflow (375 linii) trzyma trackedState, workflowBus, workflowPhase, parkRun i isolation w domknięciach, z których korzysta blok finally. Poniżej 500 linii; RF_ORCH_07 zabiera z niego rozpisanie tożsamości.' },
    { path: 'src/engine/orchestrator/consult/apply.ts', lines: 476, reason: 'Jeden aplikator odpowiedzi konsultacji: guard i pięć akcji (rewrite, split, verify, ask-user, confirm) po 20-50 linii. Spójny; poniżej 500.' },
    { path: 'src/engine/orchestrator/run/review.ts', lines: 451, reason: 'Pętla review runu: haltFailedReview, haltVerdictlessReview, followReviewAnswer, runScheduledReview. Jeden temat.' },
    { path: 'src/engine/orchestrator/validation/run-checks.ts', lines: 474, reason: 'createCheckRunner z trzema rodzajami checków (test, command, render) i rejestrem. Spójny; runRenderCheck (102 linie) można wydzielić później.' },
    { path: 'src/engine/orchestrator/apply/run.ts', lines: 416, reason: 'Przepływ Apply jako jedna maszyna stanów applyRun (259 linii) z haltami Apply.' },
    { path: 'src/engine/orchestrator/consult/request.ts', lines: 441, reason: 'Jedno wywołanie konsultacji: kontrakty, diff briefu, prompt, requestConsult.' },
    { path: 'src/engine/orchestrator/approval/file-snapshots/entry.ts', lines: 411, reason: 'Prymitywy odczytu i zapisu wpisów w granicy projektu (lstat, symlinki, pliki tymczasowe); jedna granica bezpieczeństwa z 39 importerami. Po RF_ORCH_10 ok. 392 linie.' },
    { path: 'src/engine/orchestrator/evidence/task.ts', lines: 402, reason: 'Płaska lista małych zapisów do ledgera (po 10-30 linii) dla każdego wyniku briefu; jeden temat.' },
    { path: 'src/engine/orchestrator/tokens.ts', lines: 344, reason: 'Księgowanie tokenów według kategorii seatu z jedną tabelą categoryFields; spójne.' },
    { path: 'src/engine/orchestrator/continuation.ts', lines: 328, reason: 'Kontrakt kontynuacji (holder, seed, withContinuationLoop) używany przez 8 modułów; jeden mechanizm.' },
    { path: 'src/engine/orchestrator/types.ts', lines: 152, reason: 'Plik portu (OrchestratorCallbacks, WorkflowContext, WorkflowSinks) z 80 importerami; deklaruje typy, nie reeksportuje.' }
  ],
  conventions: [
    'Folder zamiast prefiksu także wewnątrz orchestratora: review/ (nie review-*.ts w korzeniu), run/init/ (nie init-*.ts), recovery/seat/ (nie seat-* i switch-seat-*), isolation/worktree/, approval/artifact-stage/, task/gates/, validation/plan-policy/ i validation/reviewer-policy/. Pliki w folderze nie powtarzają nazwy folderu: review/call.ts, nie review/review-call.ts.',
    'Nazwa folderu nie powiela nazwy z innej części engine: publish/ zamiast events.ts (src/engine/events/ to bus i schemat), state-ops/ zamiast state/ (src/core/state/ to maszyna stanów).',
    'Korzeń orchestratora trzyma tylko kontrakty używane przez wiele podfolderów: types.ts, state-ops/, publish/, continuation.ts, kept-work.ts, changed-files-baseline.ts, tokens.ts, cancellable-call.ts, planner-session.ts. Plik jednego tematu idzie do folderu tematu.',
    'Testy idą za plikiem i gubią prefiks razem z nim: final-review-renders.integration.test.ts → review/phase-renders.integration.test.ts.',
    'Funkcja ponad ok. 150 linii z kilkoma krokami (runFinalReviewPhase, runSingleTask, initializeWorkflow) dzieli się na kroki, które przyjmują i zwracają stan jawnie, a nie przez domknięcia; to warunek testów jednostkowych kroków.',
    'Do rozważenia: validation/run.ts eksportuje createValidator, a leży obok run-checks.ts; nazwa validation/validator.ts usunęłaby parę prefiksową run.ts i run-checks.ts. Podobnie context-routing/route.ts i route-input.ts oraz evidence/review-packet/sections.ts i sections-io.ts to pary x.ts i x-*.ts.',
    'Decyzja właściciela: dokumenty wysyłane w paczce (docs/CONCEPTS.md, CONFIGURATION.md, TROUBLESHOOTING.md, WORKFLOW.md są w package.json files) podają ścieżki src/engine/orchestrator/*.ts. Każde przeniesienie wymaga ich edycji. Reguła o tekście dla użytkownika zabrania szczegółów budowy; można zamiast aktualizacji usunąć z nich ścieżki plików.',
    'duplikat z UI i stores: domyślna odpowiedź pytania (boolean na Yes lub No, inaczej default) jest zapisana 4 razy: planning/plan-session.ts:52-55 i consult/apply.ts:349-352 (defaultAnswer) oraz src/stores/question-prompt/prompt.ts:32 i src/features/workflow/prompt-rows/question.ts:40. Dom: src/core/schemas/question.ts obok ClarificationQuestion.',
    'duplikat z engine (reszta): combineCoverage w tokens.ts:139-144 jest identyczna z src/engine/calls/usage.ts; isRunnerCallEvent w summary/call-usage.ts jest identyczna z src/engine/calls/interrupted.ts. Dom: src/engine/calls/ (właściciel tej części), orchestrator importuje.',
    'duplikat z lib: revisionsMatch w state-ops.ts:161-169 (eksportowana, bez zewnętrznych importerów) jest identyczna z prywatną revisionsMatch w src/lib/confined-fs-atomic.ts. Dom: lib/confined-fs-atomic.ts eksportuje, state-ops importuje. isAlreadyExists (EEXIST) istnieje prywatnie w lib/confined-fs-atomic.ts i w approval/artifact-stage-manifest.ts; jedno isEEXIST obok isENOENT w lib/process/errors.ts.',
    'duplikat z core: readPackageScripts w validation/run-checks.ts:129-138 to luźniejsza kopia readPackageScripts z src/core/readiness/collect.ts. Dom: core (jedna funkcja z trybem bez parseError).',
    'duplikat z core: getOrCreateLedger w evidence/persistence.ts:54-67 powtarza nazwę i logikę getOrCreateLedger z src/core/evidence/ledger-state.ts (existing ?? createEvidenceLedger); wersja engine może wywołać wersję core.',
    'duplikat z core: wykrywanie frontmattera SPLITBRIEF (regex --- … --- z generated_by:) jest w artifact-card.ts:16 i 121-125 (stripFrontmatter) oraz w src/core/paths-io.ts:65-68 (hasFileFrontmatter). Dom: core/paths-io.ts, które ten frontmatter pisze.',
    'Eksporty bez zewnętrznego użycia (tylko wewnątrz pliku): revisionsMatch (state-ops.ts), bindPlannerToProjectDir (transcript/compaction.ts), usageCategoryForRunnerCallRole (tokens.ts), movedInputFiles (task/stale-inputs.ts), plannerCallsSpent (recovery/builders/consult.ts), buildRecoveryIssueId (recovery/builders/issue.ts), profileProviderId (context-routing/context-length.ts), publishImplementerGenerateRunning i publishImplementerGenerateDone (events.ts). Słowo export można usunąć przy okazji podziałów.'
  ]
});
