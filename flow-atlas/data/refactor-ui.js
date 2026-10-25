window.ATLAS_REFACTOR = window.ATLAS_REFACTOR || [];
window.ATLAS_REFACTOR.push({
  part: 'ui',
  title: 'src/features, src/components, src/app, src/stores, src/hooks',
  summary: `Warstwa UI ma 351 plików produkcyjnych i 54 222 linie. Reguły warstw są czyste: feature nie importuje innego feature, strony nie importują siebie nawzajem, brak barreli i memoizacji. Problemy są trzy. Po pierwsze 17 plików ma ponad 500 linii, a 13 z nich miesza kilka odpowiedzialności (dispatch.ts 845, usage-details-model.ts 761, picker-format.ts 694, recovery-prompt.ts 658, transcript-walk.ts 558, prompt-rows/approval.ts 556). Po drugie korzeń features/workflow ma 23 pliki z prefiksami recovery-, review-, usage-, resume-, prompt-, a conversation-rows ma 26 płaskich plików z grupami activity-, row-, *-block i dwoma parami plik+folder. Po trzecie wspólne kawałki mieszkają u przypadkowego właściciela: stopMenuLayout w stop/options.ts używają result i review-checks, KeyHint i formatKeyHints siedzą w prompt-rows/approval.ts, a ponad 20 legend klawiszy jest pisanych ręcznie. Kolejność: najpierw podziały plików o 1-9 importerach i wspólny układ menu (RF_UI_01, 02, 03, 08, 13, 21), potem foldery w features/workflow i runners (RF_UI_04, 05, 06, 07, 22), potem jeden dom legend klawiszy (RF_UI_14), na końcu przenosiny w stores o dużym zasięgu (RF_UI_17, 18) i trudny podział use-run-loop (RF_UI_16). Strony app/screens i composer.tsx zostawiam części react.`,
  stats: { files: 351, prodLines: 54222, over300: 54, over500: 17, prefixGroups: 27, duplicates: 7 },
  proposals: [
    {
      id: 'RF_UI_01',
      kind: 'split',
      priority: 1,
      effort: 'M',
      risk: 'low',
      title: 'Podział event-rows/dispatch.ts na pliki per rodzina eventów',
      why: 'dispatch.ts ma 845 linii. eventRowBlock to switch na 488 linii (71-558) z ciałami case o długości do 60 linii (seat_switched 252-311, drift_report 154-192, message_queued/message_injected_native 394-434). Pod switchem leżą trzy niezależne grupy: drift (559-579), consult (606-687) i recovery (688-845, 158 linii). Folder event-rows ma już wzorzec plik per rodzina (execution.ts, planner-text.ts, artifact-card.ts), więc dispatch łamie własną konwencję. Test dispatch.test.ts ma 3608 linii.',
      before: [ { path: 'src/features/workflow/conversation-rows/event-rows/dispatch.ts', lines: 845, note: 'eventRowBlock (switch), drift, implementer failure, consult, recovery row block' } ],
      after: [
        { path: 'src/features/workflow/conversation-rows/event-rows/dispatch.ts', lines: 350, note: 'eventRowBlock: switch, który deleguje do plików rodzin' },
        { path: 'src/features/workflow/conversation-rows/event-rows/recovery.ts', lines: 185, note: 'recoveryRowBlock, recoveryCardBlock, recoveryActionSegments, recoveryHeadlineSegments, recoveryOutcomeWords, recoveryResolvedTone' },
        { path: 'src/features/workflow/conversation-rows/event-rows/consult.ts', lines: 95, note: 'consultAnsweredSegments, consultAnsweredAction, case consult_answered' },
        { path: 'src/features/workflow/conversation-rows/event-rows/drift.ts', lines: 75, note: 'COLLAPSED_DRIFT_FINDING_LIMIT, driftHeadlineSegments, orderedDriftFindings, driftReportRowBlock (ciało case drift_report)' },
        { path: 'src/features/workflow/conversation-rows/event-rows/implementer-failure.ts', lines: 55, note: 'implementerFailureCause, implementerFailureCard, ciało case implementer_generate_failed' },
        { path: 'src/features/workflow/conversation-rows/event-rows/seat-switched.ts', lines: 75, note: 'seatSwitchedRowBlock (ciało case seat_switched)' },
        { path: 'src/features/workflow/conversation-rows/event-rows/queue.ts', lines: 120, note: 'ciała case message_queued, message_injected_native, queue_drained, queue_cleared, user_message' }
      ],
      moves: [
        'recoveryRowBlock, recoveryCardBlock, recoveryActionSegments, recoveryHeadlineSegments, recoveryOutcomeWords, recoveryResolvedTone → event-rows/recovery.ts',
        'consultAnsweredSegments, consultAnsweredAction → event-rows/consult.ts',
        'COLLAPSED_DRIFT_FINDING_LIMIT, driftHeadlineSegments, orderedDriftFindings + nowa driftReportRowBlock → event-rows/drift.ts',
        'implementerFailureCause, implementerFailureCard → event-rows/implementer-failure.ts',
        'ciało case seat_switched → seatSwitchedRowBlock w event-rows/seat-switched.ts',
        'ciała case kolejki i user_message → queueRowBlock, userMessageRowBlock w event-rows/queue.ts'
      ],
      tests: 'dispatch.test.ts (3608 linii) dzieli się po blokach describe na recovery.test.ts, consult.test.ts, drift.test.ts, seat-switched.test.ts i queue.test.ts obok nowych plików. Każdą rodzinę wierszy można wtedy testować bez switcha i bez pełnego RowBuildContext dla innych typów.',
      importers: 2,
      references: [ 'docs/STORES-AND-UI.md:205', 'docs/WORKFLOW-CONVERSATION-SCROLL.md:27', 'docs/EXTENDING.md:47', 'docs/EXTENDING.md:171', 'docs/ARCHITECTURE.md:976' ],
      steps: [
        '1. Utwórz event-rows/recovery.ts i przenieś funkcje recovery (688-845) z ich importami.',
        '2. Utwórz consult.ts, drift.ts, implementer-failure.ts i przenieś funkcje pomocnicze.',
        '3. Wyciągnij ciała case seat_switched, drift_report i kolejki do nazwanych funkcji w seat-switched.ts, drift.ts i queue.ts.',
        '4. W dispatch.ts zostaw tylko switch z wywołaniami nowych funkcji i assertNever.',
        '5. Zmień importy w conversation-rows/build.ts i conversation-rows/row-actions.ts (recoveryRowBlock, orderedDriftFindings, implementerFailureCard, COLLAPSED_DRIFT_FINDING_LIMIT).',
        '6. Podziel dispatch.test.ts po describe na pliki obok nowych modułów.',
        '7. Zaktualizuj docs/WORKFLOW-CONVERSATION-SCROLL.md:27 i docs/STORES-AND-UI.md:205 (recoveryRowBlock mieszka w recovery.ts).',
        '8. Uruchom typecheck, lint, node scripts/dangling-imports.mjs, potem testy conversation-rows.'
      ],
      risks: 'Ryzyko niskie: tylko 2 produkcyjne importery, oba w tym samym folderze. Zmiana kolejności case może zmienić tekst wiersza tylko wtedy, gdy ciało case czyta zmienne z innych case; typecheck to wykryje. Brak zmian w tekście UI.'
    },
    {
      id: 'RF_UI_02',
      kind: 'split',
      priority: 1,
      effort: 'M',
      risk: 'low',
      title: 'usage-details-model.ts → folder features/workflow/usage/ z czterema modułami',
      why: 'usage-details-model.ts ma 761 linii i cztery odpowiedzialności: odczyt recovery context (34-180), derywację liczników, pieniędzy, stawek i billingu (181-446), formatowanie kwot i tokenów (447-549) oraz wiersze widoku /usage (550-761). Obok leży usage-details.tsx (159) i spend-text.ts (82), czyli grupa prefiksu usage- bez folderu. Importują go: app/overlays/usage.tsx (deriveUsageDetails), conversation-rows/event-format.ts (formatUsageTokens), recovery-prompt.ts (readRecoveryContext), spend-text.ts i usage-details.tsx.',
      before: [
        { path: 'src/features/workflow/usage-details-model.ts', lines: 761, note: 'recovery context, derywacja, formatowanie, wiersze' },
        { path: 'src/features/workflow/usage-details.tsx', lines: 159, note: 'widok /usage' },
        { path: 'src/features/workflow/spend-text.ts', lines: 82, note: 'jeden formatter spend' }
      ],
      after: [
        { path: 'src/features/workflow/usage/recovery-context.ts', lines: 160, note: 'RecoveryContextDetails, readRecoveryContext, recoveryContextCauseWords, recoveryContextSeatLabel i stałe RECOVERY_CONTEXT_*' },
        { path: 'src/features/workflow/usage/derive.ts', lines: 280, note: 'typy UsageDetailsView/Input, channelCounters, deriveCounters, deriveMoney, deriveRates, deriveBilling, deriveUsageDetails' },
        { path: 'src/features/workflow/usage/format.ts', lines: 115, note: 'mapy słów, formatUsageTokens, formatUsageAmount, formatUsageMoney, statesAmount' },
        { path: 'src/features/workflow/usage/rows.ts', lines: 225, note: 'UsageTone, UsageDetailRow, rateFacts, billingFacts, measuredFacts, contextRows, usageDetailRows' },
        { path: 'src/features/workflow/usage/details.tsx', lines: 159, note: 'dawny usage-details.tsx' },
        { path: 'src/features/workflow/usage/spend-text.ts', lines: 82, note: 'dawny spend-text.ts' }
      ],
      moves: [
        'linie 34-180 (RECOVERY_CONTEXT_*, contextSeat … recoveryContextSeatLabel) → usage/recovery-context.ts',
        'linie 181-446 (UsageAmount … deriveUsageDetails) → usage/derive.ts',
        'linie 447-549 (COUNTER_LABELS … statesAmount) → usage/format.ts',
        'linie 550-761 (rateFacts … usageDetailRows) → usage/rows.ts',
        'usage-details.tsx → usage/details.tsx; spend-text.ts → usage/spend-text.ts'
      ],
      tests: 'usage-details-model.test.ts (648) dzieli się na derive.test.ts, format.test.ts i rows.test.ts; usage-details.test.tsx → usage/details.test.tsx; spend-text.test.ts → usage/spend-text.test.ts. Formatowanie kwot i odczyt recovery context dostają własne testy bez budowania całego widoku.',
      importers: 8,
      references: [ 'docs/ARCHITECTURE.md:781', 'docs/ARCHITECTURE.md:782', 'docs/HOOKS.md:80', 'docs/HOOKS.md:82', 'docs/SLASH-COMMANDS-REFERENCE.md:260', 'docs/STORES-AND-UI.md:285', 'docs/STRUCTURE.md:307', 'docs/STRUCTURE.md:583' ],
      steps: [
        '1. Utwórz folder features/workflow/usage/.',
        '2. Przenieś usage-details.tsx i spend-text.ts z testami (git mv przez właściciela, nie przez agenta).',
        '3. Rozetnij usage-details-model.ts według zakresów linii z moves; derive.ts importuje format.ts tylko dla typów, rows.ts importuje format.ts i recovery-context.ts.',
        '4. Zmień importy: app/overlays/usage.tsx, conversation-rows/event-format.ts, recovery-prompt.ts, copy/resolve.ts.',
        '5. Podziel usage-details-model.test.ts.',
        '6. Zaktualizuj 8 miejsc w docs z listy references.',
        '7. Typecheck, lint, dangling-imports, testy usage.'
      ],
      risks: 'Niskie. Brak zmian tekstu. Możliwy cykl importów derive.ts ↔ rows.ts, jeśli typy zostaną w złym pliku; typecheck i dependency-cruiser go wykryją.'
    },
    {
      id: 'RF_UI_03',
      kind: 'split',
      priority: 1,
      effort: 'M',
      risk: 'low',
      title: 'recovery-prompt.ts i recovery-driver.ts → folder features/workflow/recovery/',
      why: 'recovery-prompt.ts ma 658 linii i pięć grup: klucze i aliasy akcji, wiersze switch-seat, etykiety menu, tekst promptu (PromptRow, promptRowsToString) i nagłówek (recoveryCauseParts, recoveryHeadlineParts). Konsumenci biorą rozłączne części: closed/byline.ts bierze tylko nagłówek i etykietę, prompt-body.tsx tylko FACT_INDENT i PromptRow, recovery-driver.ts tylko parsowanie odpowiedzi. recovery-driver.ts (476) to sąsiad z tym samym prefiksem.',
      before: [
        { path: 'src/features/workflow/recovery-prompt.ts', lines: 658, note: 'akcje, switch-seat, menu, tekst promptu, nagłówek' },
        { path: 'src/features/workflow/recovery-driver.ts', lines: 476, note: 'createRecoveryDriver i pickSwappedSeat' }
      ],
      after: [
        { path: 'src/features/workflow/recovery/actions.ts', lines: 140, note: 'ACTION_ORDER, ACTION_KEYS, ACTION_ALIASES, recoveryActionKey, getRecoveryPromptActions, correctionActionFor, recoveryComposerHint, recommendedRecoveryAction, parseRecoveryActionAnswer, findAliasedActionAmong, resolveRecommendedAction' },
        { path: 'src/features/workflow/recovery/switch-seat.ts', lines: 120, note: 'OFFERED_SEAT_SWAP_CANDIDATES, offeredSeatSwapCandidates, switchSeatRowKey, switchSeatRowText, switchSeatRows, switchSeatCandidateForAnswer, numberedSwitchSeatAction, seatLevelRetrySeat' },
        { path: 'src/features/workflow/recovery/menu-label.ts', lines: 135, note: 'recoveryMenuLabel, recoveryMenuActionLabel, recoveryMenuParts, recoveryMenuContext, recoveryMenuConsequence, formatRecoveryActionText, applyRecoveryConsequence, formatRecoveryActionChoice' },
        { path: 'src/features/workflow/recovery/prompt-text.ts', lines: 235, note: 'PromptRow, FACT_INDENT, FAILED_REVIEW_MARKER, recommendedRowPrefix, passHeadlinePrefix, formatActionRow, isActionRowLine, buildRecoveryPromptRows, promptRowsToString, formatRecoveryPrompt, recoveryPromptSummaryRows, formatMiddotList, formatSubjectLines, fitFileList, formatDetailLines' },
        { path: 'src/features/workflow/recovery/headline.ts', lines: 75, note: 'formatRecoveryHeaderParts, recoveryCauseParts, recoveryHeadlineParts' },
        { path: 'src/features/workflow/recovery/driver.ts', lines: 476, note: 'dawny recovery-driver.ts bez zmian (jedna fabryka, patrz keep)' }
      ],
      moves: [
        'linie 45, 101-164, 488-537 → recovery/actions.ts',
        'linie 131-132, 219-239, 296-363, 401-411, 509-519 → recovery/switch-seat.ts',
        'linie 165-218, 240-295, 364-370 → recovery/menu-label.ts',
        'linie 46-100, 371-487, 600-658 → recovery/prompt-text.ts',
        'linie 538-599 → recovery/headline.ts',
        'recovery-driver.ts → recovery/driver.ts'
      ],
      tests: 'recovery-prompt.test.ts (1034) dzieli się na actions.test.ts, switch-seat.test.ts, menu-label.test.ts i prompt-text.test.ts. recovery-driver.test.ts (1731) i recovery-driver-composer.test.tsx (209) idą do recovery/ jako driver.test.ts i driver-composer.test.tsx. Parsowanie odpowiedzi i aliasy akcji można testować bez budowania promptu.',
      importers: 9,
      references: [ 'docs/APPROVAL-AND-RECOVERY.md:247', 'docs/APPROVAL-AND-RECOVERY.md:302', 'docs/APPROVAL-AND-RECOVERY.md:365', 'docs/EXTENDING.md:307', 'docs/TESTING.md:164', 'docs/ARCHITECTURE.md:778', 'skills/splitbrief-babysit/SKILL.md:51' ],
      steps: [
        '1. Utwórz features/workflow/recovery/ i przenieś recovery-driver.ts jako driver.ts z testami.',
        '2. Rozetnij recovery-prompt.ts według moves; prompt-text.ts importuje actions.ts, switch-seat.ts i menu-label.ts.',
        '3. Zmień importy w 8 plikach produkcyjnych: app/screens/workflow.tsx, closed/byline.ts, components/prompt-body.tsx, components/recovery-menu.tsx, layout/snapshot.ts, prompt-body-rows.ts, prompt-rows/recovery.ts, hooks/use-run-loop.ts.',
        '4. Zmień importy testów: src/engine/orchestrator/task/implementation-failure.integration.test.ts, testing/visual/fixtures/workflow/projections.ts, testing/integration/ui/halt-picker-profile.test.tsx.',
        '5. Zaktualizuj docs i skills/splitbrief-babysit/SKILL.md:51, potem uruchom npm run skills:check.',
        '6. Typecheck, lint, dangling-imports, testy recovery.'
      ],
      risks: 'Niskie. Skill babysit jest wewnętrzny (metadata.internal: true), ale skills:check sprawdza mirror; trzeba go uruchomić. Test w src/engine importuje features (tylko test), więc przeniesienie musi go objąć, inaczej padnie typecheck.'
    },
    {
      id: 'RF_UI_04',
      kind: 'folderize',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'review-* i editor-command.ts → review-gate/ i external-editor/',
      why: 'review-parser.ts (375) nie parsuje niczego: ma runEditor i spawnEditorProcess (uruchomienie edytora), openReviewFileExternally (edycja zewnętrzna pliku review) i createReviewInputHandler (obsługa wejścia bramki). docs/ARCHITECTURE.md:783 opisuje go błędnie jako parser. Obok leżą review-commands.ts (85) i review-editor.ts (38) z tym samym prefiksem oraz editor-command.ts (193), którego używają review-parser.ts i result/show-diff.ts. Nazwa review- koliduje z folderem review-checks/, który dotyczy innej rzeczy (karta Run all / Skip all).',
      before: [
        { path: 'src/features/workflow/review-parser.ts', lines: 375, note: 'spawn edytora, edycja zewnętrzna, input handler bramki' },
        { path: 'src/features/workflow/review-commands.ts', lines: 85, note: 'komendy approve / comment / end-run / edit' },
        { path: 'src/features/workflow/review-editor.ts', lines: 38, note: 'otwarcie plan.json w overlayu edytora' },
        { path: 'src/features/workflow/editor-command.ts', lines: 193, note: 'resolveEditorArgv, resolveViewerArgv' }
      ],
      after: [
        { path: 'src/features/workflow/external-editor/command.ts', lines: 193, note: 'dawny editor-command.ts' },
        { path: 'src/features/workflow/external-editor/spawn.ts', lines: 95, note: 'EditorExit, EditorProcess, SpawnEditor, spawnEditorProcess, runEditor, OPENING_SIGNAL_PAINT_MS' },
        { path: 'src/features/workflow/review-gate/external-edit.ts', lines: 160, note: 'readReviewSnapshot, setPostEditorFeedback, applyExternalEdit, externalEditorOpen, openReviewFileExternally' },
        { path: 'src/features/workflow/review-gate/input-handler.ts', lines: 125, note: 'ReviewInputHandler, ReviewInputEffects, productionReviewInputEffects, createReviewInputHandler' },
        { path: 'src/features/workflow/review-gate/commands.ts', lines: 85, note: 'dawny review-commands.ts' },
        { path: 'src/features/workflow/review-gate/plan-editor.ts', lines: 38, note: 'dawny review-editor.ts' }
      ],
      moves: [
        'editor-command.ts → external-editor/command.ts',
        'review-parser.ts:43-95 → external-editor/spawn.ts',
        'review-parser.ts:96-251 → review-gate/external-edit.ts',
        'review-parser.ts:252-375 → review-gate/input-handler.ts',
        'review-commands.ts → review-gate/commands.ts; review-editor.ts → review-gate/plan-editor.ts'
      ],
      tests: 'review-parser.test.ts (685) dzieli się na review-gate/external-edit.test.ts i review-gate/input-handler.test.ts; review-commands.test.ts, review-editor.test.tsx i editor-command.test.ts idą za plikami. Spawn edytora dostaje test bez stores bramki.',
      importers: 7,
      references: [ 'docs/ARCHITECTURE.md:783', 'docs/CONFIGURATION.md:1112', 'docs/TYPES.md:247', 'docs/TYPES.md:248', 'docs/SLASH-COMMANDS-REFERENCE.md:426', 'docs/SLASH-COMMANDS-REFERENCE.md:438', 'docs/SLASH-COMMANDS-REFERENCE.md:463', 'docs/TESTING.md:143', 'docs/STORES-AND-UI.md:239', 'docs/STRUCTURE.md:602' ],
      steps: [
        '1. Utwórz external-editor/ i review-gate/.',
        '2. Przenieś editor-command.ts, review-commands.ts, review-editor.ts z testami.',
        '3. Rozetnij review-parser.ts według moves i usuń stary plik.',
        '4. Zmień importy: hooks/workflow-screen/use-inline-edit.ts, hooks/workflow-screen/use-model.ts, result/show-diff.ts oraz testy components/composer/refused-send.test.tsx, components/composer/review-keys.test.tsx, components/feedback-row.test.tsx, testing/e2e/scenarios/end-run-headless.test.ts, testing/integration/ui/review-input.test.ts, testing/visual/fixtures/workflow/setup.ts.',
        '5. Popraw opis w docs/ARCHITECTURE.md:783 (to nie jest parser) i pozostałe referencje.',
        '6. Typecheck, lint, dangling-imports, testy review-gate i result.'
      ],
      risks: 'Niskie. Moduł ma stan modułowy externalEditorOpen; musi zostać w jednym pliku (external-edit.ts), inaczej dwa moduły będą miały dwa flagi. Testy integracyjne review-input to wykryją.'
    },
    {
      id: 'RF_UI_05',
      kind: 'folderize',
      priority: 2,
      effort: 'M',
      risk: 'medium',
      title: 'conversation-rows: 26 płaskich plików → activity/, blocks/, cache/, row-actions/',
      why: 'conversation-rows ma 26 plików produkcyjnych w korzeniu obok trzech podfolderów. Grupy prefiksu: activity- (3), row- (3) i siedem plików z sufiksem -block. Dwie pary plik+folder: markdown-rows.ts obok markdown-rows/ oraz event-format.ts obok event-rows/. row-markers.ts (15 importerów) to gramatyka wierszy, a leży poza row-format/.',
      before: [
        { path: 'src/features/workflow/conversation-rows/activity-batch-key.ts', lines: 3, note: 'klucz batcha' },
        { path: 'src/features/workflow/conversation-rows/activity-batch-model.ts', lines: 309, note: 'model batcha aktywności' },
        { path: 'src/features/workflow/conversation-rows/activity-rows.ts', lines: 274, note: 'wiersze batcha' },
        { path: 'src/features/workflow/conversation-rows/bordered-card-block.ts', lines: 45, note: 'blok karty z ramką' },
        { path: 'src/features/workflow/conversation-rows/callout-block.ts', lines: 46, note: 'blok callout' },
        { path: 'src/features/workflow/conversation-rows/implementer-diff-card-block.ts', lines: 119, note: 'karta diffu' },
        { path: 'src/features/workflow/conversation-rows/planner-markdown-row-block.ts', lines: 87, note: 'blok markdownu plannera' },
        { path: 'src/features/workflow/conversation-rows/settled-row-block.tsx', lines: 58, note: 'blok sekcji zamkniętej' },
        { path: 'src/features/workflow/conversation-rows/task-started-row-block.ts', lines: 144, note: 'blok startu briefu' },
        { path: 'src/features/workflow/conversation-rows/row-block-compose.ts', lines: 316, note: 'kompozytory bloków' },
        { path: 'src/features/workflow/conversation-rows/block-cache.ts', lines: 95, note: 'cache bloków' },
        { path: 'src/features/workflow/conversation-rows/projection-cache.ts', lines: 122, note: 'cache projekcji' },
        { path: 'src/features/workflow/conversation-rows/markdown-rows.ts', lines: 72, note: 'plik obok folderu markdown-rows/' },
        { path: 'src/features/workflow/conversation-rows/event-format.ts', lines: 345, note: 'plik obok folderu event-rows/' },
        { path: 'src/features/workflow/conversation-rows/row-actions.ts', lines: 110, note: 'akcje wierszy' },
        { path: 'src/features/workflow/conversation-rows/read-row-actions.ts', lines: 18, note: 'odczyt akcji' },
        { path: 'src/features/workflow/conversation-rows/row-markers.ts', lines: 35, note: 'znaczniki i szerokości wierszy' }
      ],
      after: [
        { path: 'src/features/workflow/conversation-rows/activity/batch-key.ts', lines: 3, note: '' },
        { path: 'src/features/workflow/conversation-rows/activity/batch-model.ts', lines: 309, note: '' },
        { path: 'src/features/workflow/conversation-rows/activity/rows.ts', lines: 274, note: '' },
        { path: 'src/features/workflow/conversation-rows/blocks/bordered-card.ts', lines: 45, note: '' },
        { path: 'src/features/workflow/conversation-rows/blocks/callout.ts', lines: 46, note: '' },
        { path: 'src/features/workflow/conversation-rows/blocks/implementer-diff-card.ts', lines: 119, note: '' },
        { path: 'src/features/workflow/conversation-rows/blocks/planner-markdown.ts', lines: 87, note: '' },
        { path: 'src/features/workflow/conversation-rows/blocks/settled-row.tsx', lines: 58, note: '' },
        { path: 'src/features/workflow/conversation-rows/blocks/task-started.ts', lines: 144, note: '' },
        { path: 'src/features/workflow/conversation-rows/blocks/compose.ts', lines: 316, note: '' },
        { path: 'src/features/workflow/conversation-rows/cache/block.ts', lines: 95, note: '' },
        { path: 'src/features/workflow/conversation-rows/cache/projection.ts', lines: 122, note: '' },
        { path: 'src/features/workflow/conversation-rows/markdown-rows/build.ts', lines: 72, note: '' },
        { path: 'src/features/workflow/conversation-rows/event-rows/format.ts', lines: 345, note: '' },
        { path: 'src/features/workflow/conversation-rows/row-actions/build.ts', lines: 110, note: '' },
        { path: 'src/features/workflow/conversation-rows/row-actions/read.ts', lines: 18, note: '' },
        { path: 'src/features/workflow/conversation-rows/row-format/markers.ts', lines: 35, note: '' }
      ],
      moves: [
        'activity-*.ts → activity/*.ts (prefiks odpada)',
        '*-block.ts(x) i row-block-compose.ts → blocks/ (sufiks -block odpada)',
        'block-cache.ts, projection-cache.ts → cache/block.ts, cache/projection.ts',
        'markdown-rows.ts → markdown-rows/build.ts; event-format.ts → event-rows/format.ts',
        'row-actions.ts, read-row-actions.ts → row-actions/build.ts, row-actions/read.ts',
        'row-markers.ts → row-format/markers.ts'
      ],
      tests: 'Testy idą za plikami: activity-batch-key/model/rows, block-cache, callout-block, markdown-rows, planner-markdown-row-block, projection-cache, read-row-actions, row-actions, row-block-compose, row-markers, event-format (.test.ts obok nowych nazw). Bez zmian w treści testów.',
      importers: 59,
      references: [ 'docs/WORKFLOW-CONVERSATION-SCROLL.md:29', 'docs/WORKFLOW-CONVERSATION-SCROLL.md:45', 'docs/WORKFLOW-CONVERSATION-SCROLL.md:156', 'docs/WORKFLOW-CONVERSATION-SCROLL.md:181', 'docs/STORES-AND-UI.md:221', 'docs/STORES-AND-UI.md:233', 'src/components/row-leading.ts:5' ],
      steps: [
        '1. Zrób to po RF_UI_01 i RF_UI_06, żeby nie przenosić plików, które się dzielą.',
        '2. Przenieś pliki grupami (activity, blocks, cache, row-actions, row-format/markers, markdown-rows/build, event-rows/format) razem z testami.',
        '3. Popraw względne importy w folderze i u 59 produkcyjnych importerów (row-markers.ts ma 15, row-block-compose.ts ma 9).',
        '4. Popraw komentarz w src/components/row-leading.ts:5 i docs z listy.',
        '5. Typecheck, node scripts/dangling-imports.mjs, knip, lint.'
      ],
      risks: 'Średnie z powodu liczby importów (59 produkcyjnych, 41 testowych), nie z powodu logiki. Każdy zły import łapie typecheck i dangling-imports. Brak zmian w zachowaniu.'
    },
    {
      id: 'RF_UI_06',
      kind: 'split',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'transcript-walk.ts → walk, ended-calls, recovery-folds',
      why: 'transcript-walk.ts ma 558 linii i trzy odpowiedzialności: generator walkTranscript (91-280), wykrywanie zakończonych prób i wywołań (endedImplementerAttempts, endedCallActivity, isCallError 281-375) oraz składanie automatycznych recovery (automaticRecoveryFolds, sameHeader, joinsRecovery, restatesHalt 367-558). Składanie recovery to osobny algorytm, który dziś testuje się tylko przez cały walk.',
      before: [ { path: 'src/features/workflow/conversation-rows/transcript-walk.ts', lines: 558, note: 'walk + ended calls + recovery folds' } ],
      after: [
        { path: 'src/features/workflow/conversation-rows/transcript-walk/walk.ts', lines: 255, note: 'RunnerActivityBatch, TranscriptWalkStep, SettledTranscriptSection, settledTaskStartedEvent, walkTranscript' },
        { path: 'src/features/workflow/conversation-rows/transcript-walk/ended-calls.ts', lines: 105, note: 'endedImplementerAttempts, endedCallActivity, isCallError' },
        { path: 'src/features/workflow/conversation-rows/transcript-walk/recovery-folds.ts', lines: 215, note: 'RecoveryFoldEvents, RecoveryFold, RecoveryChain, automaticRecoveryFolds, sameHeader, joinsRecovery, restatesHalt' }
      ],
      moves: [ 'linie 15-22, 44-280 → transcript-walk/walk.ts', 'linie 281-366 → transcript-walk/ended-calls.ts', 'linie 23-43, 367-558 → transcript-walk/recovery-folds.ts' ],
      tests: 'transcript-walk.test.ts (792) zostaje jako walk.test.ts; nowy recovery-folds.test.ts testuje automaticRecoveryFolds na samych sekcjach, bez generatora.',
      importers: 4,
      references: [ 'docs/STORES-AND-UI.md:179', 'docs/WORKFLOW-CONVERSATION-SCROLL.md:194' ],
      steps: [
        '1. Utwórz conversation-rows/transcript-walk/ i rozetnij plik według moves.',
        '2. Zmień importy: build.ts, row-actions.ts, event-rows/dispatch.ts (RecoveryFold z recovery-folds.ts), settled-row-block.tsx.',
        '3. Przenieś test jako walk.test.ts i dopisz recovery-folds.test.ts.',
        '4. Zaktualizuj docs/WORKFLOW-CONVERSATION-SCROLL.md:194.',
        '5. Typecheck, lint, testy conversation-rows.'
      ],
      risks: 'Niskie. Wewnętrzne typy RecoveryFold są eksportowane do dispatch.ts; muszą przejść do recovery-folds.ts, a nie zostać zdublowane.'
    },
    {
      id: 'RF_UI_07',
      kind: 'folderize',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'features/runners: picker-*, use-picker-*, contract-* → picker/, contract/',
      why: 'Korzeń features/runners ma 15 plików i trzy grupy prefiksu: picker- (picker-format, picker-profile, picker-view), use-picker- (use-picker-actions, use-picker-catalog) i contract- (contract-chip, contract-choice-overlay). model-row-plan.ts planuje wiersze modeli i należy do model-catalog/. CLAUDE.md mówi, że ToolModelPicker jest nazwą komponentu, a nie granicą folderu tool-picker; propozycja tworzy folder picker/ z wnętrzem tego jednego pickera i nie tworzy drugiego pickera, więc reguła zostaje spełniona, ale zdanie w CLAUDE.md:158 warto doprecyzować.',
      before: [
        { path: 'src/features/runners/picker-format.ts', lines: 694, note: 'patrz RF_UI_08' },
        { path: 'src/features/runners/picker-profile.ts', lines: 29, note: '' },
        { path: 'src/features/runners/picker-view.tsx', lines: 473, note: '' },
        { path: 'src/features/runners/use-picker-actions.ts', lines: 671, note: 'patrz RF_UI_09' },
        { path: 'src/features/runners/use-picker-catalog.ts', lines: 397, note: '' },
        { path: 'src/features/runners/contract-chip.tsx', lines: 59, note: '' },
        { path: 'src/features/runners/contract-choice-overlay.tsx', lines: 151, note: '' },
        { path: 'src/features/runners/model-row-plan.ts', lines: 402, note: '' }
      ],
      after: [
        { path: 'src/features/runners/picker/profile.ts', lines: 29, note: '' },
        { path: 'src/features/runners/picker/view.tsx', lines: 473, note: 'szczegóły komponentów: część react' },
        { path: 'src/features/runners/picker/use-actions.ts', lines: 671, note: 'przed RF_UI_09' },
        { path: 'src/features/runners/picker/use-catalog.ts', lines: 397, note: '' },
        { path: 'src/features/runners/contract/chip.tsx', lines: 59, note: '' },
        { path: 'src/features/runners/contract/choice-overlay.tsx', lines: 151, note: '' },
        { path: 'src/features/runners/model-catalog/row-plan.ts', lines: 402, note: '' }
      ],
      moves: [ 'picker-profile.ts → picker/profile.ts', 'picker-view.tsx → picker/view.tsx', 'use-picker-actions.ts → picker/use-actions.ts', 'use-picker-catalog.ts → picker/use-catalog.ts', 'contract-chip.tsx → contract/chip.tsx', 'contract-choice-overlay.tsx → contract/choice-overlay.tsx', 'model-row-plan.ts → model-catalog/row-plan.ts' ],
      tests: 'Idą za plikami: picker-view.test.tsx, picker-view.browsed-marker/launcher/provider-axis.test.tsx, use-picker-actions.test.tsx, use-picker-catalog.test.tsx, use-picker-catalog.diagnostic.test.tsx, contract-choice-overlay.test.tsx, model-row-plan.test.ts.',
      importers: 16,
      references: [ 'CLAUDE.md:158', 'docs/ARCHITECTURE.md:739', 'docs/ARCHITECTURE.md:741', 'docs/ARCHITECTURE.md:742', 'docs/ARCHITECTURE.md:743', 'docs/FEATURES.md:548', 'scripts/invariants/gates.ts:242', 'scripts/invariants/gates.ts:276' ],
      steps: [
        '1. Utwórz picker/ i contract/; przenieś pliki z testami.',
        '2. Przenieś model-row-plan.ts do model-catalog/row-plan.ts.',
        '3. Popraw importy w app/overlays/runners.tsx, tool-row.tsx, right-column-policy.ts, two-column-picker/picker.tsx i testing/helpers/runner-picker.ts, testing/integration/ui/runner-picker-semantics.test.tsx, testing/integration/cli/render-path-repaint.test.ts.',
        '4. Gates 31 i 46 skanują cały katalog src/features/runners, więc działają bez zmian; sprawdź to uruchomieniem npm run invariants.',
        '5. Zaktualizuj docs i zdanie w CLAUDE.md:158.',
        '6. Typecheck, lint, dangling-imports.'
      ],
      risks: 'Niskie. Brak zmian logiki. Ryzyko interpretacji reguły CLAUDE.md o tool-picker: decyzja właściciela.'
    },
    {
      id: 'RF_UI_08',
      kind: 'split',
      priority: 1,
      effort: 'M',
      risk: 'low',
      title: 'picker-format.ts → pięć modułów tekstów pickera',
      why: 'picker-format.ts ma 694 linie i pięć rozłącznych grup tekstów. Konsumenci biorą rozłączne części: tool-row.tsx bierze formatPickerStatusLabel i formatRouteAuth, two-column-picker/picker.tsx bierze tylko wrapOnWords, use-picker-actions.ts tylko formatNeedsSignInSaveFeedback, use-picker-catalog.ts tylko typ ModelCatalogDiagnostic. Test picker-format.test.ts ma 1085 linii.',
      before: [ { path: 'src/features/runners/picker-format.ts', lines: 694, note: 'etykiety, diagnostyka katalogu, auth trasy, źródła listy, byline' } ],
      after: [
        { path: 'src/features/runners/picker/labels.ts', lines: 105, note: 'CUSTOM_COMMAND_PANE_*, fallbackInheritanceNotice, isPickerItemDisabled, formatPickerStatusLabel, formatPermissionLabels, formatNeedsSignInSaveFeedback' },
        { path: 'src/features/runners/picker/catalog-guidance.ts', lines: 165, note: 'ModelCatalogDiagnostic, formatCatalogDiagnostic, formatModelCatalogGuidance, readyModelGuidance, zeroConfirmedGuidance i pomocnicze' },
        { path: 'src/features/runners/picker/route-auth.ts', lines: 100, note: 'formatRouteAuth, credentialSourceWord, formatRouteRemedy' },
        { path: 'src/features/runners/picker/listing-source.ts', lines: 130, note: 'ListingSource, LISTING_SOURCES, pickerListingSource, customModelEntryCopy, wrapOnWords' },
        { path: 'src/features/runners/picker/byline.ts', lines: 205, note: 'laneStatus, fitToolsByline, bylineDiagnostic, formatToolsByline, formatModelsByline, modelBylineAxes' }
      ],
      moves: [ 'linie 39-126 i 689-694 → picker/labels.ts', 'linie 127-277 → picker/catalog-guidance.ts', 'linie 278-363 → picker/route-auth.ts', 'linie 364-500 → picker/listing-source.ts', 'linie 501-688 → picker/byline.ts' ],
      tests: 'picker-format.test.ts (1085) dzieli się po describe na labels/catalog-guidance/route-auth/listing-source/byline.test.ts.',
      importers: 6,
      references: [ 'docs/ARCHITECTURE.md:739' ],
      steps: [
        '1. Zrób to po RF_UI_07 (folder picker/ istnieje).',
        '2. Rozetnij plik według moves.',
        '3. Zmień importy: app/overlays/runners.tsx, picker/view.tsx, tool-row.tsx, two-column-picker/picker.tsx, picker/use-actions.ts, picker/use-catalog.ts i 13 plików testów.',
        '4. Podziel test.',
        '5. Typecheck, lint, testy runners.'
      ],
      risks: 'Niskie. Brak zmian tekstu UI. wrapOnWords ma duplikat w utils (patrz conventions); tu go nie ruszamy.'
    },
    {
      id: 'RF_UI_09',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'medium',
      title: 'use-picker-actions.ts: czyste funkcje i useLocalConnectionActions do osobnych plików',
      why: 'use-picker-actions.ts ma 671 linii: 165 linii czystych funkcji zapisu seat-u (147-313), hook usePickerActions (293 linie) i drugi hook useLocalConnectionActions (607-671) z własnym typem i probe. Czyste funkcje (writeSeatAuthChannel, savedSeatIdentity, runningSeatChangePoint) testuje się dziś tylko przez hook (use-picker-actions.test.tsx, 1746 linii). Szczegóły komponentów i hooka: część react.',
      before: [ { path: 'src/features/runners/use-picker-actions.ts', lines: 671, note: 'czyste funkcje seat-u + dwa hooki' } ],
      after: [
        { path: 'src/features/runners/picker/use-actions.ts', lines: 360, note: 'PickerActions, PickerEffectDeps, defaultPickerEffectDeps, reportFailure, usePickerActions' },
        { path: 'src/features/runners/picker/seat-writes.ts', lines: 90, note: 'seatOwnRunner, dropClearedPlannerToken, dropClearedImplementerToken, writeSeatAuthChannel' },
        { path: 'src/features/runners/picker/seat-identity.ts', lines: 105, note: 'runningSeatChangePoint, savedSeatIdentity, runnerItemOf, needsSignInVariantNote, rowEffortLadder' },
        { path: 'src/features/runners/picker/use-local-connection-actions.ts', lines: 100, note: 'LocalConnectionActions, probeLocalConnection, useLocalConnectionActions' }
      ],
      moves: [ 'linie 147-219 → picker/seat-writes.ts', 'linie 220-313 → picker/seat-identity.ts', 'linie 113-135 i 607-671 → picker/use-local-connection-actions.ts' ],
      tests: 'Nowe seat-writes.test.ts i seat-identity.test.ts testują czyste funkcje bez renderu Ink. use-picker-actions.test.tsx zostaje jako use-actions.test.tsx; testy local connection przechodzą do use-local-connection-actions.test.tsx.',
      importers: 4,
      references: [ 'docs/ARCHITECTURE.md:741' ],
      steps: [ '1. Zrób to po RF_UI_07.', '2. Przenieś czyste funkcje według moves.', '3. Przenieś useLocalConnectionActions; zmień import w local-connection-form.tsx i app/overlays/runners.tsx.', '4. Podziel test.', '5. Typecheck, lint, testy runners.' ],
      risks: 'Średnie: hook ma 10 plików testów, a część testów może wywoływać czyste funkcje przez skutki hooka. Brak zmian w zachowaniu; testy runners to wykryją.'
    },
    {
      id: 'RF_UI_10',
      kind: 'split',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'local-connection-form.tsx → local-connection/model.ts + form.tsx',
      why: 'local-connection-form.tsx ma 545 linii. Linie 44-293 to czysty model formularza (localConnectionModelRows, normalizeAddress, tokenError, runtimeOf, connectionStatus), linie 294-545 to komponenty (DimLine, FieldRow, LocalConnectionForm, 201 linii). Model można testować bez Ink. Podział komponentu: część react.',
      before: [ { path: 'src/features/runners/local-connection-form.tsx', lines: 545, note: 'model + komponenty' } ],
      after: [
        { path: 'src/features/runners/local-connection/model.ts', lines: 265, note: 'LocalConnectionSeat, LocalConnectionSave, LocalConnectionModelRow, listedState, localConnectionModelRows, normalizeAddress, tokenError, runtimeOf, ConnectionStatus, connectionStatus' },
        { path: 'src/features/runners/local-connection/form.tsx', lines: 280, note: 'DimLine, FieldRow, LocalConnectionForm' }
      ],
      moves: [ 'linie 44-293 → local-connection/model.ts', 'linie 294-545 → local-connection/form.tsx' ],
      tests: 'local-connection-form.test.tsx (420) → form.test.tsx; nowy model.test.ts dla connectionStatus i normalizeAddress.',
      importers: 3,
      references: [],
      steps: [ '1. Utwórz features/runners/local-connection/.', '2. Rozetnij plik.', '3. Zmień importy: app/overlays/runners.tsx, picker/view.tsx, picker/use-actions.ts.', '4. Typecheck, lint, testy.' ],
      risks: 'Niskie. Jeden plik, trzy importery.'
    },
    {
      id: 'RF_UI_11',
      kind: 'split',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'two-column-picker/picker.tsx: hint i prawa kolumna do czystych modułów',
      why: 'picker.tsx ma 506 linii. getHint (64 linie) i bylineLines liczą legendę, wrapValueLine i buildRightDisplay liczą prawą kolumnę; to czyste funkcje w pliku komponentu. TerminalPaneCard to osobny komponent. Pięć plików testów renderuje cały picker, żeby sprawdzić legendę. Podział komponentów: część react.',
      before: [ { path: 'src/features/runners/two-column-picker/picker.tsx', lines: 506, note: 'legenda, prawa kolumna, TerminalPaneCard, TwoColumnPicker' } ],
      after: [
        { path: 'src/features/runners/two-column-picker/hint.ts', lines: 110, note: 'bylineLines, getHint' },
        { path: 'src/features/runners/two-column-picker/right-display.ts', lines: 65, note: 'wrapValueLine, buildRightDisplay' },
        { path: 'src/features/runners/two-column-picker/picker.tsx', lines: 330, note: 'TerminalPaneCard, TwoColumnPicker' }
      ],
      moves: [ 'linie 69-167 → hint.ts', 'linie 168-187 i 237-267 → right-display.ts' ],
      tests: 'Nowy hint.test.ts testuje legendę bez renderu. Testy picker.*.test.tsx zostają.',
      importers: 1,
      references: [],
      steps: [ '1. Przenieś funkcje.', '2. buildRightDisplay jest eksportowane: sprawdź importery testów.', '3. Typecheck, lint, testy.' ],
      risks: 'Niskie.'
    },
    {
      id: 'RF_UI_12',
      kind: 'split',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'model-catalog/rows.ts: auth i osie effort do osobnych plików',
      why: 'rows.ts ma 508 linii. buildRightRows (156 linii) składa wiersze z trzech źródeł: oferty auth (authMethodOffer, authMethodChoices, authRowFor), drabinki effort i osi (offersEffortLadder, effortLadderFor, axisRowsFor) oraz provenance. Auth i osie mają własne reguły i własne testy w rows.test.ts (843 linie).',
      before: [ { path: 'src/features/runners/model-catalog/rows.ts', lines: 508, note: 'RightRow, auth, osie, buildRightRows' } ],
      after: [
        { path: 'src/features/runners/model-catalog/auth-rows.ts', lines: 85, note: 'AuthMethodOffer, authMethodOffer, authMethodChoices, authRowFor' },
        { path: 'src/features/runners/model-catalog/axis-rows.ts', lines: 95, note: 'offersEffortLadder, effortLadderFor, axisRowsFor' },
        { path: 'src/features/runners/model-catalog/rows.ts', lines: 345, note: 'RightRow, provenanceFor, groupRank, buildRightRows, rightRowKey' }
      ],
      moves: [ 'linie 103-139, 255-285 → auth-rows.ts', 'linie 177-254 → axis-rows.ts' ],
      tests: 'rows.test.ts dzieli się: auth-rows.test.ts, axis-rows.test.ts, rows.test.ts.',
      importers: 7,
      references: [ 'docs/PLANNERS-AND-IMPLEMENTERS.md:418', 'docs/CONFIGURATION.md:1453' ],
      steps: [ '1. Przenieś funkcje.', '2. Zmień importy u 7 importerów, które biorą authMethodOffer lub effortLadderFor.', '3. Referencje w docs nazywają buildRightRows, który zostaje w rows.ts: bez zmian.', '4. Typecheck, lint, testy.' ],
      risks: 'Niskie.'
    },
    {
      id: 'RF_UI_13',
      kind: 'split',
      priority: 1,
      effort: 'M',
      risk: 'low',
      title: 'prompt-rows/approval.ts → approval, review-document, confirm-panel',
      why: 'approval.ts ma 556 linii i trzy obszary: opcje karty approval (approvalTitle, getConfirmOptions, etykiety), dokument review planu (ReviewArtifact, reviewDocumentForm, getReviewDocumentPromptRows) i dopasowanie panelu confirm (fitConfirmPanel, 85 linii, confirmPanelMinRows, confirmCardFits). Dodatkowo eksportuje KeyHint, formatKeyHints i SELECT_HINT, których używają planner-question.tsx i recovery-menu.tsx; to nie jest approval (patrz RF_UI_14).',
      before: [ { path: 'src/features/workflow/prompt-rows/approval.ts', lines: 556, note: 'approval, review document, confirm panel, key hints' } ],
      after: [
        { path: 'src/features/workflow/prompt-rows/approval.ts', lines: 130, note: 'approvalTitle, ApprovalOption, stałe CONFIRM_*, getApprovalConfirmLabel, getConfirmOptions, approvalOptionLabelLines, approvalOptionLabelText' },
        { path: 'src/features/workflow/prompt-rows/review-document.ts', lines: 170, note: 'ReviewArtifact, reviewArtifactForPhase, ReviewDocumentRow, reviewDocumentOptions, REVIEW_CONFIRMS_INDENT, reviewConfirmsText, ReviewDocumentForm, reviewDocumentForm, getReviewDocumentPromptRows' },
        { path: 'src/features/workflow/prompt-rows/confirm-panel.ts', lines: 255, note: 'ConfirmPanelRows, confirmPanelRows, ConfirmFrame, cardRows, ConfirmPanelFit, fitConfirmPanel, confirmPanelMinRows, confirmCardFits, getConfirmPanelRows' }
      ],
      moves: [ 'linie 84-239 → review-document.ts', 'linie 316-556 → confirm-panel.ts', 'linie 41-63 (KeyHint, formatKeyHints, *_HINT) → src/components/key-legend.ts w RF_UI_14' ],
      tests: 'approval.test.ts (493) dzieli się na approval.test.ts, review-document.test.ts, confirm-panel.test.ts. fitConfirmPanel dostaje własny test bez opcji approval.',
      importers: 9,
      references: [ 'docs/STORES-AND-UI.md:317', 'docs/APPROVAL-AND-RECOVERY.md:24' ],
      steps: [ '1. Rozetnij plik według moves.', '2. Zmień importy: app/screens/workflow.tsx, components/approval-prompt.tsx, approval-prompt/confirm.tsx, approval-prompt/document.tsx, layout/snapshot.ts, prompt-rows/workflow.ts, review-editor.ts.', '3. docs/STORES-AND-UI.md:317 (fitConfirmPanel) i docs/APPROVAL-AND-RECOVERY.md:24 (reviewDocumentForm) wskażą nowe pliki.', '4. Typecheck, lint, testy prompt-rows.' ],
      risks: 'Niskie. Brak zmian tekstu.'
    },
    {
      id: 'RF_UI_14',
      kind: 'extract-shared',
      priority: 2,
      effort: 'M',
      risk: 'medium',
      title: 'Jeden dom legend klawiszy: src/components/key-legend.ts',
      why: 'Legenda klawiszy ma dziś trzy domy. src/core/key-legend.ts (KEY_LEGEND_LEADING, fitKeyLegend) ma 11 importerów i wszystkie są w UI (components/overlays, features/workflow), więc to nie jest logika domeny. KeyHint i formatKeyHints mieszkają w prompt-rows/approval.ts. Ponad 20 miejsc składa legendę ręcznie z tych samych słów: stop/options.ts:38-39, result/options.ts:24, review-checks/options.ts:16, app/overlays/palette.tsx:175-176, app/overlays/settings.tsx:153-156, app/overlays/skills.tsx:146-147, app/screens/setup.tsx:403, home/components/recent-sessions-list.tsx:17, runners/local-connection-form.tsx:488, runners/contract-choice-overlay.tsx:135, runners/two-column-picker/picker.tsx:125, runners/right-column-policy.ts:170-176, components/composer/completion/command/menu.tsx:39-40, completion/reference/menu.tsx:25-26. Cztery z nich wpisują separator jako literał zamiast SOFT_SEP.',
      before: [
        { path: 'src/core/key-legend.ts', lines: 22, note: 'KEY_LEGEND_LEADING, fitKeyLegend' },
        { path: 'src/features/workflow/prompt-rows/approval.ts', lines: 23, note: 'KeyHint, formatKeyHints, DENY_HINT, CONFIRM_HINT, SELECT_HINT (linie 41-63)' }
      ],
      after: [ { path: 'src/components/key-legend.ts', lines: 80, note: 'KEY_LEGEND_LEADING, fitKeyLegend, KeyHint, formatKeyHints, SELECT_HINT, CONFIRM_HINT, DENY_HINT, CLOSE_HINT (esc close) i inne wspólne tokeny' } ],
      moves: [ 'src/core/key-legend.ts → src/components/key-legend.ts', 'KeyHint, formatKeyHints, *_HINT z prompt-rows/approval.ts → src/components/key-legend.ts', 'ręczne legendy w 14 kolejnych plikach → formatKeyHints([...]) z tymi samymi słowami' ],
      tests: 'core/key-legend.test.ts idzie do components/key-legend.test.ts. Nowy test: każda legenda z listy daje ten sam tekst co dziś (snapshot stringów przed i po).',
      importers: 11,
      references: [ 'docs/STRUCTURE.md:434' ],
      steps: [
        '1. Przenieś core/key-legend.ts do components/key-legend.ts; zmień 11 importów.',
        '2. Dołóż KeyHint, formatKeyHints i stałe z approval.ts; zmień importy w planner-question.tsx i recovery-menu.tsx.',
        '3. Zamień ręczne legendy na formatKeyHints bez zmiany słów; zapisz przed zmianą listę obecnych stringów i porównaj.',
        '4. Uruchom npm run tui-shots dla scenariuszy overlay-*-picker*, overlay-settings*, setup-initial oraz workflow stop/result i obejrzyj PNG (wymóg Look-and-logic z CLAUDE.md).',
        '5. Dopisz components/key-legend.ts do listy w docs/STRUCTURE.md:434.',
        '6. Typecheck, lint, invariants (gate 57 dotyczy tylko theme.tsx), testy.'
      ],
      risks: 'Średnie: zmiana dotyka tekstu widocznego dla użytkownika w 14 plikach. Zasada: zero zmian słów, tylko jedno źródło. Przeniesienie z core do components zmienia warstwę pliku, ale żaden plik w core, engine ani lib go nie importuje, więc kierunek warstw zostaje poprawny.'
    },
    {
      id: 'RF_UI_15',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'app/command-context.ts: komendy runu i przewijania do features/workflow',
      why: 'command-context.ts ma 506 linii. Poza złożeniem kontekstu (buildCommandContext, useRuntimeCommands) ma logikę Apply/Discard z komendy (runCommandState, isRunAtRest, closedRunMessage, acceptRun, rejectRun, 119-247) i komendy transkryptu (scrollConversation, toggleLatestActivityBatch, toggleLatestDiff, 249-312). To logika workflow, nie powłoka. Test command-context-run.integration.test.ts (593) testuje acceptRun przez cały kontekst.',
      before: [ { path: 'src/app/command-context.ts', lines: 506, note: 'kontekst komend + Apply/Discard + przewijanie' } ],
      after: [
        { path: 'src/app/command-context.ts', lines: 300, note: 'listSkills, toggleSkill, buildCommandContext, useRuntimeCommands' },
        { path: 'src/features/workflow/result/run-commands.ts', lines: 150, note: 'runCommandState, isRunAtRest, closedRunMessage, acceptRun, rejectRun' },
        { path: 'src/features/workflow/layout/scroll-commands.ts', lines: 80, note: 'scrollConversation, toggleLatestActivityBatch, toggleLatestDiff' }
      ],
      moves: [ 'linie 119-247 → features/workflow/result/run-commands.ts', 'linie 249-312 → features/workflow/layout/scroll-commands.ts' ],
      tests: 'command-context-run.integration.test.ts → features/workflow/result/run-commands.integration.test.ts i woła acceptRun bez budowy kontekstu. command-context.test.ts (1095) traci testy przewijania na rzecz scroll-commands.test.ts.',
      importers: 1,
      references: [ 'CLAUDE.md:154', 'docs/STRUCTURE.md:30', 'docs/SLASH-COMMANDS-REFERENCE.md:95', 'docs/SLASH-COMMANDS-REFERENCE.md:105', 'docs/SLASH-COMMANDS-REFERENCE.md:205' ],
      steps: [ '1. Przenieś funkcje i wyeksportuj je z nowych plików.', '2. command-context.ts importuje je z ../features/workflow/... (app może importować features).', '3. Sprawdź wpisy docs/SLASH-COMMANDS-REFERENCE.md, które opisują implementację Apply/Discard i scroll w command-context.ts.', '4. Typecheck, lint, invariants (gate 9: strona nie importuje powłoki — nowe pliki są w features, więc bez konfliktu).', '5. Testy app i result.' ],
      risks: 'Niskie. command-context.ts zostaje w powłoce pod tą samą nazwą, więc CLAUDE.md:154 jest dalej prawdziwy.'
    },
    {
      id: 'RF_UI_16',
      kind: 'split',
      priority: 3,
      effort: 'L',
      risk: 'high',
      title: 'use-run-loop.ts: ciało runu jako funkcja async poza hookiem',
      why: 'use-run-loop.ts ma 665 linii, a useRunLoop ma 518. Prawie całość to startWorkflow, jeden useEffectEvent (166-620), który hydratuje resume, buduje sinks, uruchamia runWorkflow i pętlę recovery między turami. Hook nie ma testów jednostkowych, tylko integracyjne (use-run-loop.integration.test.tsx 3182, use-run-loop-stop 793, use-run-loop-abort-race 206). prompt-callbacks.ts (95) ma jednego importera: ten hook. Szczegóły hooka: część react.',
      before: [
        { path: 'src/features/workflow/hooks/use-run-loop.ts', lines: 665, note: 'swapBaseConfig, pinnedSeatSaved, useRunLoop ze startWorkflow' },
        { path: 'src/features/workflow/prompt-callbacks.ts', lines: 95, note: 'callbacki promptów dla orkiestratora' }
      ],
      after: [
        { path: 'src/features/workflow/run-loop/start.ts', lines: 420, note: 'runTuiWorkflow(prepared, options, refs): ciało startWorkflow z jawnymi parametrami' },
        { path: 'src/features/workflow/run-loop/seat-config.ts', lines: 45, note: 'swapBaseConfig, pinnedSeatSaved' },
        { path: 'src/features/workflow/run-loop/prompt-callbacks.ts', lines: 95, note: 'dawny prompt-callbacks.ts' },
        { path: 'src/features/workflow/hooks/use-run-loop.ts', lines: 200, note: 'cykl życia React: efekty, abort, settleRun' }
      ],
      moves: [ 'linie 86-124 → run-loop/seat-config.ts', 'ciało startWorkflow (166-620) → run-loop/start.ts', 'prompt-callbacks.ts → run-loop/prompt-callbacks.ts' ],
      tests: 'Nowy start.test.ts testuje runTuiWorkflow z fałszywym runWorkflow bez renderu Ink. Testy integracyjne zostają przy hooku.',
      importers: 1,
      references: [ 'docs/STORES-AND-UI.md:56', 'docs/STORES-AND-UI.md:163', 'docs/WORKFLOW.md:570', 'docs/ARCHITECTURE.md:161', 'docs/HOW-IT-WORKS.md:63' ],
      steps: [ '1. Zacznij od seat-config.ts i prompt-callbacks.ts (bez ryzyka).', '2. Wyciągnij ciało startWorkflow do funkcji z parametrami zamiast domknięć (abortedRef, retentionNoticeHandled, continuation).', '3. Hook woła runTuiWorkflow wewnątrz useEffectEvent.', '4. Uruchom wszystkie trzy testy integracyjne hooka oraz testing/e2e stop-continue.', '5. Sprawdź referencje useRunLoop w docs (nazwa zostaje).' ],
      risks: 'Wysokie: kod obsługuje wyścigi abort, wznowienie inline i recovery między turami. Kolejność odczytu refów i stores musi zostać ta sama. Łapią to use-run-loop-abort-race i use-run-loop-stop; przy pierwszym czerwonym teście cofnąć krok 2.'
    },
    {
      id: 'RF_UI_17',
      kind: 'merge',
      priority: 3,
      effort: 'M',
      risk: 'low',
      title: 'Trzy jednoplikowe foldery promptów w stores → stores/prompts/',
      why: 'stores/approval-prompt/, stores/question-prompt/ i stores/review-checks-prompt/ mają po jednym pliku prompt.ts. Folder z jednym plikiem i nazwa pliku powtarzająca nazwę folderu to podwójny szum. Wszystkie trzy to stores promptów, dwa z nich używają createPromptChannel z channels/prompt.ts.',
      before: [
        { path: 'src/stores/approval-prompt/prompt.ts', lines: 54, note: 'approvalPromptStore' },
        { path: 'src/stores/question-prompt/prompt.ts', lines: 186, note: 'questionPromptStore' },
        { path: 'src/stores/review-checks-prompt/prompt.ts', lines: 59, note: 'reviewChecksPromptStore' }
      ],
      after: [
        { path: 'src/stores/prompts/approval.ts', lines: 54, note: '' },
        { path: 'src/stores/prompts/question.ts', lines: 186, note: '' },
        { path: 'src/stores/prompts/review-checks.ts', lines: 59, note: '' }
      ],
      moves: [ 'approval-prompt/prompt.ts → prompts/approval.ts', 'question-prompt/prompt.ts → prompts/question.ts', 'review-checks-prompt/prompt.ts → prompts/review-checks.ts' ],
      tests: 'Testy idą za plikami (approval-prompt/prompt.test.ts itd.). Bez zmian treści.',
      importers: 36,
      references: [ 'docs/STORES.md:245', 'docs/STORES.md:246', 'docs/STORES.md:247', 'docs/STORES-AND-UI.md:64', 'docs/STORES-AND-UI.md:121', 'docs/STORES-AND-UI.md:125', 'docs/STORES-AND-UI.md:235' ],
      steps: [ '1. Utwórz stores/prompts/ i przenieś pliki z testami.', '2. Popraw 36 importów produkcyjnych i 38 testowych (approval-prompt ma 22 produkcyjne).', '3. channels/ zostaje bez zmian (2 pliki).', '4. Zaktualizuj docs.', '5. Typecheck, dangling-imports, lint.' ],
      risks: 'Niskie co do logiki, duży zasięg importów. Mechaniczne; typecheck łapie każdy błąd.'
    },
    {
      id: 'RF_UI_18',
      kind: 'move',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'stores/project/detection.ts → stores/discovery/detection.ts',
      why: 'detectionStore nie ma własnego stanu: get, subscribe, use i reset delegują do modelCacheStore z stores/discovery/model-cache/state.ts. Plik leży w project/, a jego jedyne źródło jest w discovery/, więc odczyt wymaga skakania między folderami. stores/discovery/detection-adapter.ts już importuje go z ../project/.',
      before: [ { path: 'src/stores/project/detection.ts', lines: 45, note: 'widok na model-cache' } ],
      after: [ { path: 'src/stores/discovery/detection.ts', lines: 45, note: 'ten sam plik' } ],
      moves: [ 'stores/project/detection.ts → stores/discovery/detection.ts' ],
      tests: 'detection.test.ts idzie za plikiem.',
      importers: 12,
      references: [ 'docs/STORES.md:99', 'docs/STORES.md:254', 'docs/TYPES.md:250' ],
      steps: [ '1. Przenieś plik i test.', '2. Popraw 12 importów produkcyjnych i 32 testowe.', '3. Zaktualizuj docs.', '4. Typecheck, lint.' ],
      risks: 'Niskie. Duża liczba importów testowych (32).'
    },
    {
      id: 'RF_UI_19',
      kind: 'rename',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'stores/ui/persistence.ts → stores/ui/input-history-persistence.ts',
      why: 'persistence.ts w stores/ui obsługuje tylko zapis inputHistoryStore. Nazwa sugeruje persystencję całego UI, a w stores/project leży config-persistence.ts z pełną nazwą. Jeden produkcyjny importer: cli/bootstrap/project.ts.',
      before: [ { path: 'src/stores/ui/persistence.ts', lines: 134, note: 'hydrate + debounced save historii' } ],
      after: [ { path: 'src/stores/ui/input-history-persistence.ts', lines: 134, note: '' } ],
      moves: [ 'stores/ui/persistence.ts → stores/ui/input-history-persistence.ts' ],
      tests: 'persistence.test.ts → input-history-persistence.test.ts.',
      importers: 1,
      references: [ 'docs/BOOTSTRAP.md:136', 'docs/BOOTSTRAP.md:139', 'docs/LAYERS.md:291', 'docs/STORES.md:50', 'docs/STORES.md:63', 'docs/STORES.md:219', 'docs/STRUCTURE.md:101', 'docs/STRUCTURE.md:125', 'docs/STRUCTURE.md:128', 'docs/TESTING.md:145' ],
      steps: [ '1. Zmień nazwę pliku i testu.', '2. Popraw import w cli/bootstrap/project.ts.', '3. Zaktualizuj 10 miejsc w docs.', '4. Typecheck.' ],
      risks: 'Niskie.'
    },
    {
      id: 'RF_UI_20',
      kind: 'move',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'Degradacja komponentów z jednym konsumentem (reguła 1-consumer z LAYERS.md)',
      why: 'docs/LAYERS.md każe przenieść plik z src/components do feature, gdy ma jednego konsumenta. Pomiar importerów produkcyjnych: components/task-summary.tsx (424) — tylko features/workflow (closed/copy.ts, closed/rows/briefs.tsx, conversation-flow/stage-summary.ts, conversation-rows/settled-row-block.tsx); components/markdown.tsx (299) — tylko features/workflow (review-rows-cache.ts, markdown-rows/review-segments.ts, markdown-rows/window.ts); components/pickers/single-column.tsx (259) — tylko runners/two-column-picker/picker.tsx; components/pickers/aligned-option-row.tsx (111) — tylko components/composer/completion/command/menu.tsx.',
      before: [
        { path: 'src/components/task-summary.tsx', lines: 424, note: '1 feature' },
        { path: 'src/components/markdown.tsx', lines: 299, note: '1 feature' },
        { path: 'src/components/pickers/single-column.tsx', lines: 259, note: '1 feature' },
        { path: 'src/components/pickers/aligned-option-row.tsx', lines: 111, note: '1 konsument w composer' }
      ],
      after: [
        { path: 'src/features/workflow/components/task-summary.tsx', lines: 424, note: '' },
        { path: 'src/features/workflow/components/markdown.tsx', lines: 299, note: '' },
        { path: 'src/features/runners/two-column-picker/single-column.tsx', lines: 259, note: '' },
        { path: 'src/components/composer/completion/aligned-option-row.tsx', lines: 111, note: '' }
      ],
      moves: [ 'task-summary.tsx → features/workflow/components/', 'markdown.tsx → features/workflow/components/', 'pickers/single-column.tsx → features/runners/two-column-picker/', 'pickers/aligned-option-row.tsx → components/composer/completion/' ],
      tests: 'task-summary.test.tsx, markdown.test.tsx, single-column.test.tsx, aligned-option-row.test.tsx idą za plikami.',
      importers: 9,
      references: [ 'docs/STRUCTURE.md:434', 'docs/STRUCTURE.md:437', 'docs/INVARIANTS.md:77', 'docs/STORES-AND-UI.md:231', 'docs/ARCHITECTURE.md:796', 'docs/ARCHITECTURE.md:801' ],
      steps: [ '1. Przenieś cztery pliki z testami.', '2. Popraw 9 importów produkcyjnych.', '3. Zaktualizuj docs/INVARIANTS.md:77 (tekst reguły markdown wskazuje src/components/markdown.tsx) i listy w STRUCTURE.md, ARCHITECTURE.md.', '4. Typecheck, invariants, lint.' ],
      risks: 'Niskie. task-summary.tsx ma 424 linie i po przeniesieniu warto go rozważyć w części react.'
    },
    {
      id: 'RF_UI_21',
      kind: 'extract-shared',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'stopMenuLayout i słowa kroku: wspólne domy zamiast stop/',
      why: 'stopMenuLayout z stop/options.ts to ogólny układ menu inline nad composerem (szerokość, zawijanie konsekwencji, wysokość). Importują go result/options.ts, result/menu.tsx, review-checks/options.ts i layout/snapshot.ts, czyli trzy menu, z których dwa nie są stop. stopPoint i stepWord z stop/copy.ts nazywają krok runu; importują je closed/byline.ts, closed/outcome.ts i conversation-rows/event-rows/dispatch.ts.',
      before: [
        { path: 'src/features/workflow/stop/options.ts', lines: 266, note: 'stop rows + wrapClauses + stopMenuLayout (60-105)' },
        { path: 'src/features/workflow/stop/copy.ts', lines: 258, note: 'stop byline + stepWord + stopPoint (65-134)' }
      ],
      after: [
        { path: 'src/features/workflow/layout/inline-menu.ts', lines: 75, note: 'CONSEQUENCE_HANG, wrapClauses, inlineMenuLayout (dawny stopMenuLayout)' },
        { path: 'src/features/workflow/display/step-words.ts', lines: 80, note: 'stepWord, stopPoint' },
        { path: 'src/features/workflow/stop/options.ts', lines: 200, note: 'tylko wiersze stop sheet' },
        { path: 'src/features/workflow/stop/copy.ts', lines: 190, note: 'tylko byline stop' }
      ],
      moves: [ 'stop/options.ts: CONSEQUENCE_HANG, wrapClauses, stopMenuLayout → layout/inline-menu.ts jako inlineMenuLayout', 'stop/copy.ts: stepWord, stopPoint → display/step-words.ts' ],
      tests: 'Nowy inline-menu.test.ts testuje układ bez wierszy stop. Testy stop/options.test.ts i stop/copy.test.ts tracą przypadki układu i słów kroku.',
      importers: 8,
      references: [ 'docs/ARCHITECTURE.md:896', 'docs/SLASH-COMMANDS-REFERENCE.md:148' ],
      steps: [ '1. Przenieś funkcje, zmień nazwę stopMenuLayout na inlineMenuLayout.', '2. Zmień importy: result/options.ts, result/menu.tsx, review-checks/options.ts, layout/snapshot.ts, closed/byline.ts, closed/outcome.ts, event-rows/dispatch.ts, app/screens/workflow.tsx.', '3. docs/ARCHITECTURE.md:896 wskaże display/step-words.ts.', '4. Typecheck, lint, testy stop, result, review-checks.' ],
      risks: 'Niskie. testing/visual/fixtures/overlay-fixtures.ts:1898 i dalsze zawierają ścieżkę stop/options.ts jako dane fixture (tekst na obrazku), nie import; nie trzeba ich zmieniać.'
    },
    {
      id: 'RF_UI_22',
      kind: 'folderize',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'Drobne porządki w korzeniu features/workflow',
      why: 'Korzeń features/workflow ma 23 pliki. Po RF_UI_02, 03, 04 zostają jeszcze: para resume- (resume-hydration.ts 27, resume-policy.ts 54); prompt-body-rows.ts (281) obok folderu prompt-rows/; components/approval-prompt.tsx obok folderu components/approval-prompt/; copy/resolve.ts, jedyny plik w folderze copy/, który rozwiązuje cel komendy /copy (schowek), podczas gdy stop/copy.ts, closed/copy.ts i queue-copy.ts to słowa UI.',
      before: [
        { path: 'src/features/workflow/resume-hydration.ts', lines: 27, note: '' },
        { path: 'src/features/workflow/resume-policy.ts', lines: 54, note: '' },
        { path: 'src/features/workflow/prompt-body-rows.ts', lines: 281, note: 'plik obok prompt-rows/' },
        { path: 'src/features/workflow/components/approval-prompt.tsx', lines: 89, note: 'plik obok approval-prompt/' },
        { path: 'src/features/workflow/copy/resolve.ts', lines: 60, note: 'jednoplikowy folder, dwuznaczna nazwa' }
      ],
      after: [
        { path: 'src/features/workflow/resume/hydration.ts', lines: 27, note: '' },
        { path: 'src/features/workflow/resume/policy.ts', lines: 54, note: '' },
        { path: 'src/features/workflow/prompt-rows/body.ts', lines: 281, note: '' },
        { path: 'src/features/workflow/components/approval-prompt/prompt.tsx', lines: 89, note: '' },
        { path: 'src/features/workflow/copy-target.ts', lines: 60, note: 'resolveCopyValue' }
      ],
      moves: [ 'resume-*.ts → resume/*.ts', 'prompt-body-rows.ts → prompt-rows/body.ts', 'components/approval-prompt.tsx → components/approval-prompt/prompt.tsx', 'copy/resolve.ts → copy-target.ts (folder copy/ znika)' ],
      tests: 'resume-hydration.integration.test.ts, resume-policy.test.ts, prompt-body-rows.test.ts, approval-prompt.test.tsx, copy/resolve.test.ts idą za plikami.',
      importers: 17,
      references: [ 'docs/SLASH-COMMANDS-REFERENCE.md:293', 'docs/design/tui-concepts/README.md:36', 'docs/ARCHITECTURE.md:755' ],
      steps: [ '1. Przenieś pliki z testami.', '2. Popraw 17 importów produkcyjnych (approval-prompt.tsx 5, resume-hydration 4, prompt-body-rows 4, resume-policy 3, copy/resolve 1, w tym app/prepare-resume.ts i app/command-context.ts).', '3. Zaktualizuj docs.', '4. Typecheck, dangling-imports, lint.' ],
      risks: 'Niskie.'
    },
    {
      id: 'RF_UI_23',
      kind: 'folderize',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'features/editor i features/home: prefiks powtarza nazwę folderu',
      why: 'W features/editor trzy pliki powtarzają nazwę folderu: editor-buffer-view.tsx, editor-line-segments.ts, editor-viewport.ts. W features/home/components są trzy pliki recent-sessions*, a features/home/use-recent-sessions-focus.ts leży piętro wyżej; po ich wyjęciu w home/components zostaje jeden plik seat-block.tsx.',
      before: [
        { path: 'src/features/editor/editor-buffer-view.tsx', lines: 71, note: '' },
        { path: 'src/features/editor/editor-line-segments.ts', lines: 56, note: '' },
        { path: 'src/features/editor/editor-viewport.ts', lines: 27, note: '' },
        { path: 'src/features/home/components/recent-sessions.tsx', lines: 70, note: '' },
        { path: 'src/features/home/components/recent-sessions-list.tsx', lines: 97, note: '' },
        { path: 'src/features/home/components/recent-sessions-shell.tsx', lines: 19, note: '' },
        { path: 'src/features/home/use-recent-sessions-focus.ts', lines: 22, note: '' },
        { path: 'src/features/home/components/seat-block.tsx', lines: 129, note: '' }
      ],
      after: [
        { path: 'src/features/editor/buffer-view.tsx', lines: 71, note: '' },
        { path: 'src/features/editor/line-segments.ts', lines: 56, note: '' },
        { path: 'src/features/editor/viewport.ts', lines: 27, note: '' },
        { path: 'src/features/home/recent-sessions/panel.tsx', lines: 70, note: '' },
        { path: 'src/features/home/recent-sessions/list.tsx', lines: 97, note: '' },
        { path: 'src/features/home/recent-sessions/shell.tsx', lines: 19, note: '' },
        { path: 'src/features/home/recent-sessions/use-focus.ts', lines: 22, note: '' },
        { path: 'src/features/home/seat-block.tsx', lines: 129, note: 'folder components/ znika' }
      ],
      moves: [ 'editor-*.ts(x) → bez prefiksu', 'recent-sessions*.tsx + use-recent-sessions-focus.ts → home/recent-sessions/', 'home/components/seat-block.tsx → home/seat-block.tsx' ],
      tests: 'editor-buffer-view.test.tsx, editor-line-segments.test.ts, recent-sessions*.test.tsx, use-recent-sessions-focus.test.ts, seat-block.test.tsx idą za plikami.',
      importers: 10,
      references: [ 'vitest.config.ts:43', 'docs/ARCHITECTURE.md:117', 'docs/ARCHITECTURE.md:732', 'docs/ARCHITECTURE.md:733', 'docs/ARCHITECTURE.md:734', 'docs/ARCHITECTURE.md:736', 'docs/STRUCTURE.md:596', 'docs/STRUCTURE.md:598', 'docs/STRUCTURE.md:599', 'docs/STRUCTURE.md:616', 'docs/LAYERS.md:211', 'docs/SLASH-COMMANDS-REFERENCE.md:382' ],
      steps: [ '1. Przenieś pliki z testami.', '2. Zmień wpis coverage exclude w vitest.config.ts:43 (editor-buffer-view.tsx).', '3. Popraw importy w app/overlays/editor.tsx, app/screens/home.tsx i wewnątrz folderów.', '4. Zaktualizuj docs.', '5. Typecheck, lint, test vitest-config-exclude (scripts/vitest-config-exclude.test.ts sprawdza listę exclude).' ],
      risks: 'Niskie. scripts/vitest-config-exclude.test.ts może wymagać, żeby wpis exclude wskazywał istniejący plik.'
    },
    {
      id: 'RF_UI_24',
      kind: 'split',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'closed/projections.ts → seat-views, brief-rows, projections',
      why: 'projections.ts ma 517 linii i trzy projekcje rekordu runu: widoki seat-ów (41-194), wiersze briefów (195-399) oraz review, scope, pliki i czasy faz (400-517). view-model.ts importuje 10 funkcji z trzech grup naraz.',
      before: [ { path: 'src/features/workflow/closed/projections.ts', lines: 517, note: 'seat, brief, review/files' } ],
      after: [
        { path: 'src/features/workflow/closed/seat-views.ts', lines: 175, note: 'seatView, recordedSeatKind, plannerSeatView, buildSeatView, movedBuildSeat, eachRunsOneStretch, reviewSeatView' },
        { path: 'src/features/workflow/closed/brief-rows.ts', lines: 220, note: 'briefRows, foldBriefSpend, stoppedAtForCurrentPlan, briefRow, rowMethod, briefRowState' },
        { path: 'src/features/workflow/closed/projections.ts', lines: 140, note: 'reviewView, failedReviewViews, scopeView, filesView, changedFileCount, phaseTimings' }
      ],
      moves: [ 'linie 41-194 → seat-views.ts', 'linie 195-399 → brief-rows.ts' ],
      tests: 'projections.test.ts dzieli się na seat-views.test.ts i brief-rows.test.ts.',
      importers: 3,
      references: [],
      steps: [ '1. Rozetnij plik.', '2. Zmień importy w closed/view-model.ts; changedFileCount zostaje w projections.ts (app/screens/workflow.tsx, stop/options.ts bez zmian).', '3. Typecheck, lint, testy closed.' ],
      risks: 'Niskie.'
    },
    {
      id: 'RF_UI_25',
      kind: 'split',
      priority: 3,
      effort: 'M',
      risk: 'medium',
      title: 'Strony app/screens i composer.tsx ponad 500 linii (krótko)',
      why: 'setup.tsx 729 (SetupScreen 230, CrewStep 199, DiscoveryPanel 59 i czyste funkcje unavailableSetupSeats, planStage, sectionOf, crewKeysHint), workflow.tsx 679 (jeden WorkflowScreen na 567 linii), components/composer/composer.tsx 787 (ComposerInput na 600 linii), home.tsx 448 (HomeScreen 276, drugi DiscoveryPanel 72). Szczegóły komponentów: część react. Z mojej części: czyste funkcje setup.tsx (linie 86-196, około 90 linii) nie mają domu, bo setup jest stroną rozpuszczoną (CLAUDE.md: help, sessions, setup, skills nie mają folderu features). Propozycja: features/crew/setup-plan.ts, bo crew jest już feature konsumowanym przez setup. Nowy folder features/setup zmieniłby regułę z CLAUDE.md; nie proponuję go.',
      before: [
        { path: 'src/app/screens/setup.tsx', lines: 729, note: 'strona + czyste funkcje planu setup' },
        { path: 'src/app/screens/workflow.tsx', lines: 679, note: 'jeden komponent' },
        { path: 'src/components/composer/composer.tsx', lines: 787, note: 'Composer + ComposerInput' }
      ],
      after: [
        { path: 'src/features/crew/setup-plan.ts', lines: 100, note: 'unavailableSetupSeats, SetupItem, planStage, sectionOf, crewKeysHint' },
        { path: 'src/app/screens/setup.tsx', lines: 630, note: 'dalszy podział: część react' }
      ],
      moves: [ 'setup.tsx: unavailableSetupSeats, SetupItem, planStage, sectionOf, crewKeysHint → features/crew/setup-plan.ts' ],
      tests: 'Nowy setup-plan.test.ts dla planStage i sectionOf bez renderu (setup.test.tsx ma 1677 linii).',
      importers: 2,
      references: [ 'scripts/invariants/gates.ts:242', 'scripts/invariants/gates.ts:276' ],
      steps: [ '1. Przenieś czyste funkcje do features/crew/setup-plan.ts.', '2. Gate 31 skanuje src/features/crew i app/screens/setup.tsx w plikach .tsx; nowy plik .ts nie zmienia wyniku.', '3. Resztę podziału zostaw części react.' ],
      risks: 'Średnie dla całej strony (część react). Mój krok jest niski: czyste funkcje, jeden importer.'
    },
    {
      id: 'RF_UI_26',
      kind: 'rename',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'features/settings/hooks: nazwy plików hooków z prefiksem use-',
      why: 'W całej warstwie UI plik hooka ma prefiks use- (workflow/hooks/use-keys.ts, hooks/use-filterable-list.ts). W features/settings/hooks pliki buffer.ts (useEditBuffer) i editor.ts (useSettingsEditor) go nie mają. editor.ts eksportuje też czystą funkcję hintFor, a docs/STRUCTURE.md:556 zabrania czystych funkcji w podfolderze hooks/.',
      before: [ { path: 'src/features/settings/hooks/buffer.ts', lines: 88, note: 'useEditBuffer' }, { path: 'src/features/settings/hooks/editor.ts', lines: 181, note: 'useSettingsEditor + hintFor' } ],
      after: [ { path: 'src/features/settings/hooks/use-edit-buffer.ts', lines: 88, note: '' }, { path: 'src/features/settings/hooks/use-settings-editor.ts', lines: 140, note: '' }, { path: 'src/features/settings/presentation.ts', lines: 92, note: '+ hintFor, CrewSettingsItem, FallbackSettingsItem' } ],
      moves: [ 'hooks/buffer.ts → hooks/use-edit-buffer.ts', 'hooks/editor.ts → hooks/use-settings-editor.ts', 'hintFor → presentation.ts' ],
      tests: 'buffer.test.ts, editor.test.ts idą za plikami; hintFor dostaje test w presentation.test.ts.',
      importers: 2,
      references: [ 'docs/ARCHITECTURE.md:751' ],
      steps: [ '1. Zmień nazwy.', '2. Przenieś hintFor.', '3. Popraw importy w app/overlays/settings.tsx.', '4. Typecheck.' ],
      risks: 'Niskie.'
    }
  ],
  keep: [
    { path: 'src/stores/workflow/lifecycle.ts', lines: 615, reason: 'Jedna maszyna stanu: unia LifecycleState (idle, running, interrupted, paused, complete, cancelled) i jej przejścia (updatePhase, markLifecycle*, lifecycleStateFromReset). 37 produkcyjnych importerów. Wydzielenie typów (126 linii) jest możliwe, ale rozdzieliłoby unię od jedynych funkcji, które ją budują.' },
    { path: 'src/features/workflow/recovery-driver.ts', lines: 476, reason: 'Po RF_UI_03: recovery/driver.ts. createRecoveryDriver to jedna fabryka (285 linii) z domkniętym stanem pending recovery; pickSwappedSeat i pomocnicze są jej prywatne. Tylko przeniesienie w RF_UI_03.' },
    { path: 'src/stores/discovery/model-cache/state.ts', lines: 430, reason: 'Jeden store (modelCacheStore, 307 linii). Pomocnicze funkcje reconcile i lanes są już w osobnych plikach folderu model-cache/.' },
    { path: 'src/features/workflow/display/build-progress.ts', lines: 431, reason: 'Jedna derywacja (deriveBuildProgress) z jej wierszami; CLAUDE.md nazywa ten plik jako dom bloku Build progress. Poniżej 500 linii.' },
    { path: 'src/features/workflow/handlers.ts', lines: 425, reason: 'Poniżej 500 linii, jedna rodzina żądań runu (stop, resume, steer, end, departure). Ma 8 produkcyjnych i 25 testowych importerów; zmiana nazwy tylko w conventions.' },
    { path: 'src/features/runners/config-transforms.ts', lines: 453, reason: 'Poniżej 500. Dwie warstwy (decideEffort/decideVariant 93-180 i commit* 181-453), ale commit* zawsze woła decide*. Podział na effort-decision.ts możliwy później, gdy plik urośnie.' },
    { path: 'src/features/runners/model-row-plan.ts', lines: 402, reason: 'Po RF_UI_07: model-catalog/row-plan.ts. Jeden algorytm planModelRows (cięcie etykiet, kolizje bliźniaków); funkcje pomocnicze są prywatne. Tylko przeniesienie w RF_UI_07.' },
    { path: 'src/stores/workflow/events.ts', lines: 406, reason: 'Jedna projekcja logu eventów dla TUI (mergeEventLog, eviction, settleStoppedCommands). Spójna.' },
    { path: 'src/hooks/use-filterable-list.ts', lines: 398, reason: 'Poniżej 500: reducer (reduceKey, reduceListAction) i hook. Reducer można wydzielić do testów bez Ink, ale to nie jest pilne.' }
  ],
  conventions: [
    'Prefiks do folderu: gdy 2 lub więcej plików w jednym folderze ma wspólny prefiks domeny, utwórz folder o nazwie prefiksu i usuń prefiks z nazw (recovery-prompt.ts → recovery/prompt-text.ts, usage-details.tsx → usage/details.tsx). Wyjątek: prefiks use- dla hooków zostaje (use-run-loop.ts, use-run-continue.ts).',
    'Sufiks też jest prefiksem: siedem plików *-block.ts w conversation-rows idzie do blocks/ bez sufiksu (callout-block.ts → blocks/callout.ts).',
    'Plik x.ts obok folderu x/ wchodzi do folderu: markdown-rows.ts → markdown-rows/build.ts, event-format.ts → event-rows/format.ts, components/approval-prompt.tsx → components/approval-prompt/prompt.tsx, prompt-body-rows.ts → prompt-rows/body.ts.',
    'Nazwa pliku nie powtarza nazwy folderu: features/editor/editor-viewport.ts → features/editor/viewport.ts, stores/approval-prompt/prompt.ts → stores/prompts/approval.ts, stores/workflow/operations/operation-text.ts → operations/text.ts (3 importery, ruch opcjonalny).',
    'Folder z jednym plikiem to sygnał: stores/approval-prompt, stores/question-prompt, stores/review-checks-prompt (RF_UI_17), features/workflow/copy (RF_UI_22). components/overlays/overlay-panel.tsx zostaje, bo gate 46 (scripts/invariants/gates.ts:276) nazywa ścieżkę src/components/overlays.',
    'Słowo copy ma dwa znaczenia: teksty UI (stop/copy.ts, closed/copy.ts, queue-copy.ts) i komenda schowka /copy. Dla schowka używaj copy-target.',
    'handlers.ts w features/workflow ma nazwę technicznej warstwy, której STRUCTURE.md (Screaming folders) zabrania dla folderów; lepsza nazwa: run-requests.ts (8 produkcyjnych, 25 testowych importerów, ruch opcjonalny).',
    'stores/ui: pary composer-draft/composer-live, terminal-size/terminal-background, input-height/input-history zostają płaskie. terminal-size.ts ma 38 produkcyjnych i 104 testowe importery; koszt ruchu jest większy niż zysk.',
    'duplikat z utils: normalizacja liczby wierszy Math.max(0, Math.floor(v)) w components/scrollbar.ts:4, components/pickers/scroll-window.ts:4 (normalizeCount ×2, identyczne), features/workflow/layout/scroll-window.ts:9 (normalizeScrollRows), features/workflow/layout/chrome-rows.ts:34, features/workflow/layout/rect.ts:91-92, a w engine src/engine/calls/output-limit.ts:229. Dom: src/utils/math.ts obok clamp.',
    'duplikat z utils: zawijanie po słowach w features/runners/picker-format.ts:439 (wrapOnWords) i features/start-preparation/panel.tsx (wrapText) obok src/utils/wrap.ts (wrapHard, wrapPathAware). Dom: src/utils/wrap.ts.',
    'duplikat z engine: isRunnerCallEvent w features/workflow/conversation-rows/runner-call-classification.ts (lista typów) oraz w src/engine/calls/interrupted.ts i src/engine/orchestrator/summary/call-usage.ts (startsWith runner_call_). Dom: src/engine/calls.',
    'duplikat z lib: wyszukiwanie pliku wykonywalnego w PATH w features/workflow/editor-command.ts:95-141 (isExecutableFile, resolveExecutableInPath) obok src/lib/process/command-path.ts (resolveBareCommandOnPath). Różnice do uzgodnienia: pusty segment PATH (cwd czy pominięcie) i wstrzykiwane env/platform.',
    'duplikat z core: lokalne toneColor w features/start-preparation/panel.tsx i features/workflow/usage-details.tsx mapują własne tony na kolory motywu obok src/core/theme/tone-color.ts (colorForTone). Dom: core/theme/tone-color.ts.',
    'Kolizja nazw: uniqueInOrder w features/runners/model-catalog/option-axis.ts filtruje kolejność po zbiorze i robi co innego niż uniqueInOrder w src/utils/collections.ts; zmień nazwę na presentInOrder.',
    'Część react: cztery menu inline nad composerem (stop/sheet.tsx, result/menu.tsx, review-checks/card.tsx, components/recovery-menu.tsx) i dwa różne komponenty DiscoveryPanel w app/screens/home.tsx i app/screens/setup.tsx. Logikę układu menu porządkuje RF_UI_21.',
    'Wyciek warstwy tylko w teście: src/engine/orchestrator/task/implementation-failure.integration.test.ts importuje features/workflow/recovery-prompt.ts. Każde przeniesienie recovery-prompt musi go objąć.',
    'scripts/: scripts/invariants/ ma jeden plik gates.ts, a jego runner check-invariants.ts leży w korzeniu scripts/; scripts/tui-shots.ts leży obok folderu scripts/tui-shots/ (output-root.ts, selection.ts) — oba przypadki to para plik+folder lub folder z jednym plikiem. skill-blocks.ts ma 664 linie.',
    'scripts/: płaski folder miesza skrypty gate (check-brand, import-boundaries, recovery-producers, testing-helper-imports, unit-test-launches, user-facing-text — wołane z scripts/invariants/gates.ts), narzędzia release (pack-contents.mjs, pack-install-smoke.mjs, coverage-run.ts) i narzędzia dev (tui-preview.ts, tui-shots.ts). Podział na gates/, release/, dev/ wymaga zmian w package.json i gates.ts.',
    'testing/: największe pliki repo są fixture-ami: testing/visual/fixtures/workflow/projections.ts 7079 linii, testing/visual/catalog.ts 5285, testing/visual/fixtures/overlay-fixtures.ts 3080, testing/visual/fixtures/workflow/at-rest-projections.ts 2794. Podział po grupach scenariuszy da największy zysk w testing/.',
    'testing/: testing/helpers ma 76 płaskich wpisów z grupami prefiksu orchestrator-* (4), *-shim (5: claude-cli-shim, claude-steering-shim, compatible-cli-shim, command-shim, opencode-steering-shim), runner-* (4), planner-* (2), hermetic-env* (2); obok jest drugi dom helperów testing/e2e/helpers (live-harness.ts 810 linii).',
    'testing/: testing/visual w korzeniu trzyma testy modułów z podfolderów (contracts.test.ts, contracts-cells.test.ts, contracts-manifest.test.ts, contracts-selection-profile.test.ts obok folderu contracts/), a testing/architecture ma jeden plik testu. To łamie zasadę testu obok kodu z docs/TESTING.md.'
  ]
});
