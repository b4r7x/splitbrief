window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: 'planning',
  order: 3,
  title: 'Planowanie: sesja, pytania, sprawdzenia, karta planu',
  tagline:
    'Jedna typowana sesja plannera zamienia prośbę użytkownika w plan.json, który przechodzi deterministyczne sprawdzenia i (domyślnie) czeka na kartę planu.',
  summary: `Każdy run planuje w **jednej sesji planowania**. Nie ma trybów workflow ani łańcucha dokumentów (research → spec → plan). Planner odpowiada typowanym JSON-em \`{ result }\`: albo pytaniami (max 3 na rundę, max 2 rundy), albo planem (\`PlanProposalSchema\`).

Plan przechodzi \`checkFullPlan\`: \`checkPlan\` (27 kodów błędów) plus dopasowanie kontekstu każdego zadania do seat-a BUILD. Plan, który nie przechodzi, wraca do plannera **raz** z listą błędów. Drugie niepowodzenie zatrzymuje run haltem \`plan-checks-failed\`, chyba że zostały tylko błędy nieblokujące (\`render-check-unconfigured\`).

Plan, który przeszedł, staje się \`plan.json\`, a z niego SPLITBRIEF renderuje \`plan.md\` i \`tasks.md\` i dispatchuje \`PLAN_COMPILED\`. Z \`workflow.approve: plan\` (domyślne) otwiera się jedna karta planu: Approve, Request changes, Edit plan.json, End run. Zatwierdzenie potwierdza chronione zapisy wymienione w planie i polecenia \`npm run <script>\` z checków. Z \`approve: none\` build startuje od razu po sprawdzeniach.

Wywołanie plannera, które się nie powiedzie (limit konta, wylogowanie, za duży prompt, błąd protokołu), nigdy nie jest sukcesem: run dostaje halt i trafia do obszaru **recovery**. Stop użytkownika parkuje krok; run pozostaje otwarty i kontynuuje tę samą sesję. \`splitbrief spec\` uruchamia tę samą sesję bez builda i bez stanu runu.`,
  entry: [
    'src/engine/orchestrator/run/phases.ts:28',
    'src/engine/orchestrator/planning/run.ts:8',
    'src/cli/commands/spec.ts:111',
  ],
  links: [
    { to: 'startup', label: 'config (workflow.approve, klucze wycofane) i detekcja narzędzi wchodzą do sesji' },
    { to: 'runners', label: 'każda tura to jedno wywołanie typedCall plannera (requestTyped)' },
    { to: 'build', label: 'BEGIN_IMPLEMENTATION oddaje zadania pętli briefów' },
    { to: 'recovery', label: 'halty: plan-questions-exhausted, plan-checks-failed, seat-protocol-error, planner-call-failed, usage-limit, unauthenticated' },
    { to: 'lifecycle', label: 'resumeStep decyduje, czy run w ogóle wraca do planowania; stop parkuje krok planner/plan' },
    { to: 'ui', label: 'karta planu, QuestionPrompt i composer odpowiadają na onApprovalNeeded / onPlannerReply' },
    { to: 'subsystems', label: 'hook pre_planning, repo-map, evidence ledger (potwierdzenia planu, odrzucenia dla plannera)' },
  ],
  diagrams: [
    {
      id: 'planning-master',
      title: 'Od wejścia w planowanie do BEGIN_IMPLEMENTATION',
      caption:
        'Gdzie run wchodzi, co decyduje, czy planner w ogóle jest wołany, i jak wynik sesji staje się planem albo haltem.',
      mermaid: `flowchart TD
  A["runPlanningPhases (run/phases.ts)"] --> B["RESUME_STEP, gdy run stal:<br/>interruptedStep, awaitingContinue lub lastFailure"]
  B --> PL_ENTRY_RESUME{"resumeStep(state) i rewindPending?"}
  PL_ENTRY_RESUME -->|"apply"| C["runApply → zobacz lifecycle"]
  PL_ENTRY_RESUME -->|"brief lub review"| D["ready-for-tasks bez plannera → zobacz build / review"]
  PL_ENTRY_RESUME -->|"gate: reviewing-plan ze state.plan"| E["resumeParkedApproval:<br/>karta planu otwiera sie ponownie"]
  PL_ENTRY_RESUME -->|"inaczej, albo rewindPending ustawione"| F["runPlanningPhase (planning/run.ts)"]
  F --> PL_ATTACHMENTS{"zalaczniki i planner<br/>bez supportsImages?"}
  PL_ATTACHMENTS -->|"tak"| F1["planner_attachments_dropped"]
  PL_ATTACHMENTS -->|"nie"| F2["zalaczniki ida do pierwszej tury"]
  F1 --> PL_REWIND_LEAD{"rewindPending.comment niepusty?"}
  F2 --> PL_REWIND_LEAD
  PL_REWIND_LEAD -->|"tak"| G["lead = planRevisedTurn(plan.json, komentarz)"]
  PL_REWIND_LEAD -->|"nie"| H["lead = undefined"]
  G --> I["runPlanningSession (planning/session.ts)"]
  H --> I
  I --> PL_BEFORE_FIRST_CALL{"hook pre_planning pozwala?"}
  PL_BEFORE_FIRST_CALL -->|"nie"| J["terminal: cancelled"]
  PL_BEFORE_FIRST_CALL -->|"tak"| K["START lub BEGIN_PLANNING → phase planning;<br/>planner_status running"]
  K --> L["planTurnText: prompt sesji<br/>(Request, Project Context, Repository Map, Implementer, zasady)"]
  L --> M["runPlanSession: petla pytan, planu i jednej naprawy"]
  M --> PL_SETTLE{"wynik sesji?"}
  PL_SETTLE -->|"plan"| N["compilePlan: plan.json, plan.md, tasks.md,<br/>discoveredValidation, PLAN_COMPILED"]
  PL_SETTLE -->|"unanswered"| O["terminal: input-required (headless)"]
  PL_SETTLE -->|"questions-exhausted"| P["halt plan-questions-exhausted"]
  PL_SETTLE -->|"checks-failed"| Q["halt plan-checks-failed"]
  PL_SETTLE -->|"seat-protocol"| R["halt seat-protocol-error"]
  M -.->|"wyjatek"| S["handlePlanningFailure → diagram wywolania"]
  P --> PL_HALT_KIND{"haltOf(reason)?"}
  Q --> PL_HALT_KIND
  R --> PL_HALT_KIND
  PL_HALT_KIND -->|"needs-you"| X["Needs you · cause → zobacz recovery"]
  PL_HALT_KIND -->|"seat-down"| Y["Seat down · cause, fallback raz na run i seat → zobacz recovery"]
  N --> T["runPlanApproval"]
  E --> T
  T --> PL_APPROVE_LEVEL{"workflow.approve?"}
  PL_APPROVE_LEVEL -->|"none"| U["BEGIN_IMPLEMENTATION → build"]
  PL_APPROVE_LEVEL -->|"plan"| V["PLAN_DONE → reviewing-plan; karta planu"]
  V --> W["decyzja na karcie → diagram karty planu"]`,
    },
    {
      id: 'planning-questions',
      title: 'Rundy pytań: maszyna stanów runPlanSession',
      caption:
        'Czysta pętla (plan-session.ts). Pytania bez odpowiedzi czekają; puste ⏎ bierze domyślne odpowiedzi; trzecia runda pytań kończy sesję.',
      mermaid: `flowchart TD
  A["runPlanSession: rounds = odpowiedziane rundy,<br/>pending = pytania bez odpowiedzi"] --> PL_PENDING_REPLY{"pending !== undefined?"}
  PL_PENDING_REPLY -->|"tak"| B["io.answer(pending, rounds+1):<br/>SET_PLANNER_CONVERSATION,<br/>wiersz Questions before the plan · round n of 2"]
  B --> PL_REPLY_KIND{"jaka odpowiedz?"}
  PL_REPLY_KIND -->|"undefined: nikt nie odpowiada"| C["outcome unanswered"]
  PL_REPLY_KIND -->|"PlannerReplyAnswer z panelu pytan"| D["message i qa z panelu"]
  PL_REPLY_KIND -->|"tekst niepusty z composera"| E["message = tekst, qa = []"]
  PL_REPLY_KIND -->|"puste ⏎"| F["kazde pytanie bierze default<br/>(boolean → Yes / No)"]
  D --> G["rounds += 1; turn = answers; pending = undefined"]
  E --> G
  F --> G
  PL_PENDING_REPLY -->|"nie"| H["turn = open albo repair"]
  G --> I["io.ask(turn): jedno wywolanie plannera<br/>(recordAnswers zapisuje odpowiedz w stanie)"]
  H --> I
  I --> PL_TYPED_REPAIR{"odpowiedz zgodna ze schematem<br/>po max 1 naprawie transportowej?"}
  PL_TYPED_REPAIR -->|"nie"| K["outcome seat-protocol"]
  PL_TYPED_REPAIR -->|"tak"| PL_RESULT_KIND{"result.kind?"}
  PL_RESULT_KIND -->|"questions (1..3 pytan)"| PL_ROUNDS_EXHAUSTED{"rounds >= MAX_QUESTION_ROUNDS (2)?"}
  PL_ROUNDS_EXHAUSTED -->|"tak"| L["outcome questions-exhausted"]
  PL_ROUNDS_EXHAUSTED -->|"nie"| M["pending = pytania (choices → choice, inaczej input)"]
  M --> PL_PENDING_REPLY
  PL_RESULT_KIND -->|"plan"| N["io.check(plan) → diagram sprawdzen"]`,
    },
    {
      id: 'planning-checks',
      title: 'Sprawdzenia planu: checkFullPlan i jedna naprawa',
      caption:
        'Każdy kod błędu checkPlan w kolejności, w jakiej kod go wylicza. Lista błędów wraca do plannera raz; po naprawie tylko błędy nieblokujące przepuszczają plan.',
      mermaid: `flowchart TD
  A["checkFullPlan(wctx, plan)"] --> B["estimatePlanContextFits:<br/>pomija zadania ze sciezka poza projektem lub nie-plikiem;<br/>refreshCurrentCode + buildRoutingPreviewMetadata"]
  B --> C["checkPlan(plan, projectDir, taskFits,<br/>validation.render, approve === plan)"]
  C --> D["empty-plan: brak zadania lub brak kryterium"]
  D --> E["checkTaskIdentities: duplicate-task-id, batch-out-of-order,<br/>unknown-dependency, dependency-later-batch,<br/>dependency-later-task, dependency-cycle"]
  E --> F["duplicate-check-id, reserved-check-id (V1, V2 ...),<br/>duplicate-criterion-id"]
  F --> PL_CMD_REFUSAL{"refusedCheckErrors: kazdy check cmd i test<br/>przechodzi polityke tekstu polecenia?"}
  PL_CMD_REFUSAL -->|"nie"| G["refused-check-command"]
  PL_CMD_REFUSAL -->|"tak"| H["kryteria: criterion-without-check,<br/>unknown-check, uncovered-criterion"]
  G --> H
  H --> I["zadania: task-without-criterion, task-without-intent,<br/>unknown-criterion, task-without-check,<br/>path-outside-project, path-not-file, missing-context-file"]
  I --> PL_PROTECTED_CHECK{"protectedOperations zgodne<br/>z klasyfikatorem zapisow?"}
  PL_PROTECTED_CHECK -->|"sciezka nie jest jednym plikiem"| J["protected-path-not-file"]
  PL_PROTECTED_CHECK -->|"zapis o nic nie pyta"| K["unprotected-operation"]
  PL_PROTECTED_CHECK -->|"suggestedFile chroniony, nie wymieniony"| L["unlisted-protected-operation"]
  PL_PROTECTED_CHECK -->|"ok"| PL_CONTEXT_FIT{"taskFits.get(task.id)?"}
  J --> PL_CONTEXT_FIT
  K --> PL_CONTEXT_FIT
  L --> PL_CONTEXT_FIT
  PL_CONTEXT_FIT -->|"fit overflow"| M["context-overflow (z rozmiarami contextFiles)"]
  PL_CONTEXT_FIT -->|"blocked"| N["no-capable-worker"]
  PL_CONTEXT_FIT -->|"fits / tight / brak estymaty"| PL_RENDER_UNCONFIGURED{"check render bez validation.render?"}
  M --> PL_RENDER_UNCONFIGURED
  N --> PL_RENDER_UNCONFIGURED
  PL_RENDER_UNCONFIGURED -->|"tak"| P["render-check-unconfigured (nie blokuje)"]
  PL_RENDER_UNCONFIGURED -->|"nie"| Q["lista bledow"]
  P --> Q
  Q --> PL_CHECK_ERRORS{"errors.length === 0?"}
  PL_CHECK_ERRORS -->|"tak"| R["outcome plan"]
  PL_CHECK_ERRORS -->|"nie, pierwszy raz"| S["repaired = true; turn = repair;<br/>warning The plan failed N checks ..."]
  S --> T["kolejne wywolanie plannera z bledami i planem"]
  PL_CHECK_ERRORS -->|"nie, po naprawie"| PL_BLOCKS_PLAN{"kazdy blad to<br/>render-check-unconfigured?"}
  PL_BLOCKS_PLAN -->|"tak"| U["outcome plan; plan.md dostaje sekcje Before you approve"]
  PL_BLOCKS_PLAN -->|"nie"| V["outcome checks-failed → halt"]`,
    },
    {
      id: 'planning-card',
      title: 'Karta planu: cztery wiersze i to, co każdy robi',
      caption:
        'runPlanApproval kręci się w pętli, aż plan zostanie zatwierdzony, run zamknięty albo sesja zwróci terminal. Wiadomość w kolejce staje się korektą bez otwierania karty.',
      mermaid: `flowchart TD
  A["runPlanApproval: while approve === plan"] --> B["tasks_planned; PLAN_DONE → reviewing-plan (gdy faza inna)"]
  B --> C["drainAndFormat: kolejka wiadomosci seat-a plan"]
  C --> PL_CARD_QUEUED{"wiadomosc w kolejce?"}
  PL_CARD_QUEUED -->|"tak"| D["korekta bez otwierania karty"]
  PL_CARD_QUEUED -->|"nie"| E["planConfirmations → onApprovalNeeded(plan, plan.md, confirms)"]
  E --> PL_CARD_RESULT{"odpowiedz karty?"}
  PL_CARD_RESULT -->|"approved"| PL_UNATTENDED{"unattended?"}
  PL_UNATTENDED -->|"nie (TUI)"| F["persistApprovalEvidence:<br/>chronione zapisy i npm run potwierdzone w ledgerze"]
  PL_UNATTENDED -->|"tak (headless)"| G["bez potwierdzen"]
  F --> H["plan_approved → BEGIN_IMPLEMENTATION"]
  G --> H
  PL_CARD_RESULT -->|"end-run"| I["closeRunIfOpen (CLOSE_RUN), plan_rejected,<br/>terminal: closed"]
  PL_CARD_RESULT -->|"edit"| PL_EDIT_VALID{"plan.json po edycji?"}
  PL_EDIT_VALID -->|"bez zmian"| A
  PL_EDIT_VALID -->|"zly JSON, schema lub blokujacy check"| J["plan.json przywrocony;<br/>warning The edited plan was not applied: ..."]
  J --> A
  PL_EDIT_VALID -->|"poprawny"| K["plan_regenerated (edited plan.json);<br/>compilePlan bez wywolania plannera"]
  K --> A
  PL_CARD_RESULT -->|"revise z pustym tekstem, brak decyzji"| A
  PL_CARD_RESULT -->|"revise z tekstem"| L["recordUserMessage (gdy jeszcze nie zapisana)"]
  L --> D
  D --> M["plan_regenerated; CORRECT_PLAN → rewindPending"]
  M --> N["runPlanningSession z lead =<br/>planRevisedTurn(plan.json, korekta)"]
  N --> PL_REVISED_RESULT{"disposition?"}
  PL_REVISED_RESULT -->|"terminal"| P["zwroc terminal (halt, stop, closed)"]
  PL_REVISED_RESULT -->|"tasks-ready"| A`,
    },
    {
      id: 'planning-call',
      title: 'Jedno wywołanie plannera i co się dzieje, gdy zawiedzie',
      caption:
        'Od ask(turn) w sesji przez askPlannerSession i requestTyped do halta. Naprawa transportowa (zły JSON) i naprawa semantyczna (checkPlan) liczą się osobno.',
      mermaid: `flowchart TD
  A["ask(turn) w sesji"] --> B["recordAnswers lub warning naprawy;<br/>drainAndFormat kolejki; obrazy"]
  B --> C["withContinuationLoop: stop i steer w trakcie"]
  C --> D["startPlannerHeartbeat: po 5 s planner_heartbeat co 2 s"]
  D --> E["askPlannerSession"]
  E --> PL_ON_SESSION{"supportsSessionResume<br/>i plannerSessionId w stanie?"}
  PL_ON_SESSION -->|"tak"| F["krotka tura na watku:<br/>planAnswersTurn, planRepairTurn albo lead"]
  PL_ON_SESSION -->|"nie"| G["planFullTurn: pelny prompt +<br/>standing + historia rund + naprawa"]
  F --> H["requestTyped"]
  G --> H
  H --> PL_TYPED_TRANSPORT{"typedOutput narzedzia?"}
  PL_TYPED_TRANSPORT -->|"native"| I["schema JSON przekazana narzedziu"]
  PL_TYPED_TRANSPORT -->|"fallback"| J["instrukcja JSON doklejona do promptu"]
  I --> K["pierwsze wywolanie; checkAnswer(PlanAnswerSchema)"]
  J --> K
  K --> PL_TYPED_REPAIR_OK{"odpowiedz zgodna ze schematem?"}
  PL_TYPED_REPAIR_OK -->|"tak"| L["value; nativeSessionId → SET_PLANNER_SESSION_ID"]
  PL_TYPED_REPAIR_OK -->|"nie, pierwszy raz"| M["1 naprawa transportowa:<br/>na watku krotki resumeRepairPrompt,<br/>inaczej freshRepairPrompt"]
  M --> N["drugie sprawdzenie"]
  N -->|"ok"| L
  N -->|"nie"| O["SeatProtocolError (attempts 2) → outcome seat-protocol"]
  H -.->|"wyjatek"| PL_FRESH_REISSUE{"watek wznowiony i blad to<br/>expired lub input-too-large?"}
  PL_FRESH_REISSUE -->|"tak, raz"| P["warning planner_session_expired / planner_session_refused;<br/>SET_PLANNER_SESSION_ID null;<br/>ponowne wywolanie na swiezej sesji z transkryptem"]
  P --> H
  PL_FRESH_REISSUE -->|"nie"| Q["handlePlanningFailure (failure.ts)"]
  Q --> PL_FAILURE{"co sie stalo?"}
  PL_FAILURE -->|"abort uzytkownika"| R["parkStoppedRun → interrupted<br/>(End run → cancelled, bez parku)"]
  PL_FAILURE -->|"run juz closed"| S["publishError; terminal closed"]
  PL_FAILURE -->|"blad zapisu stanu"| T["throw dalej"]
  PL_FAILURE -->|"pakiet API nie miesci sie w kontekscie"| U["halt call-failed z faktami kontekstu<br/>i rada: wiekszy kontekst w /crew plan"]
  PL_FAILURE -->|"inny blad"| PL_DIAGNOSE{"diagnosePlannerCallFailure"}
  PL_DIAGNOSE -->|"usage-limit, unauthenticated"| V["Seat down → zobacz recovery"]
  PL_DIAGNOSE -->|"missing-model, input-too-large, call-failed"| W["halt planner-call-failed → zobacz recovery"]`,
    },
    {
      id: 'planning-prompt',
      title: 'Co wchodzi do promptu plannera i co wychodzi z planu',
      caption:
        'Od załadowanego configu, przez budowę promptu sesji (odrzucenia, repo-map, kontekst projektu), jedno wywołanie ze strażnikami, do compilePlan i tego, co zatwierdzenie karty potwierdza.',
      mermaid: `flowchart TD
  A["config.yaml zaladowany"] --> PL_RETIRED_VALUES{"klucz wycofany w configu?"}
  PL_RETIRED_VALUES -->|"workflow.mode, task_review, brief_review, speckit,<br/>approval.tiers, approve all/spec/default"| B["jedna notatka na klucz; wartosc ignorowana<br/>(approve → plan)"]
  PL_RETIRED_VALUES -->|"nie"| C["runPlanningSession"]
  B --> C
  C --> PL_PHASE_ENTRY{"state.phase?"}
  PL_PHASE_ENTRY -->|"idle"| D["START → planning"]
  PL_PHASE_ENTRY -->|"inna faza"| E["BEGIN_PLANNING → planning"]
  PL_PHASE_ENTRY -->|"planning"| F["bez akcji"]
  D --> PL_STEER_ANSWER{"continuation.steer<br/>przy czekajacych pytaniach?"}
  E --> PL_STEER_ANSWER
  F --> PL_STEER_ANSWER
  PL_STEER_ANSWER -->|"tak"| G["steer = odpowiedz na runde"]
  PL_STEER_ANSWER -->|"nie"| H["steer = standing (slyszany raz na watku)"]
  G --> I["planTurnText: budowa promptu sesji"]
  H --> I
  I --> PL_REJECTIONS{"approval.feedRejectionsToPlanner?"}
  PL_REJECTIONS -->|"true i ledger czytelny"| J["odrzucenia z ledgera na czele promptu"]
  PL_REJECTIONS -->|"false lub blad ledgera"| K["bez prefiksu"]
  J --> PL_REPO_MAP{"codebase.enabled?"}
  K --> PL_REPO_MAP
  PL_REPO_MAP -->|"true"| L["sekcja Repository Map (tokenBudget)"]
  PL_REPO_MAP -->|"false"| M["bez repo-mapy"]
  L --> PL_PLANNER_READS_FILES{"planner.resolvePlanningContext?"}
  M --> PL_PLANNER_READS_FILES
  PL_PLANNER_READS_FILES -->|"undefined: planner cli czyta sam"| N["Project Context z buildProjectContextMarkdown"]
  PL_PLANNER_READS_FILES -->|"zdefiniowane: planner api"| PL_API_PACKET_BUDGET{"pakiet miesci sie w kontekscie?"}
  PL_API_PACKET_BUDGET -->|"nie"| O["apiBudgetError / apiContextError → halt call-failed"]
  PL_API_PACKET_BUDGET -->|"tak"| P["pakiet: instrukcje, zrodla nazwanych sciezek,<br/>lista nieprzeczytanych"]
  N --> Q["wywolanie plannera"]
  P --> Q
  Q --> PL_HEARTBEAT{"wywolanie trwa ponad 5 s?"}
  PL_HEARTBEAT -->|"tak"| R["planner_heartbeat co 2 s"]
  PL_HEARTBEAT -->|"nie"| S["cisza: odpowiedz to JSON"]
  R --> PL_MUTATION_GUARD{"planner cli zmienil pliki projektu?"}
  S --> PL_MUTATION_GUARD
  PL_MUTATION_GUARD -->|"tak, poza internalStatePaths"| T["planningMutationError → halt call-failed"]
  PL_MUTATION_GUARD -->|"nie"| U["plan przeszedl sprawdzenia"]
  U --> PL_COMPILE{"compilePlan"}
  PL_COMPILE -->|"zawsze"| V["taskFromSpec; plan.json; plan.md; tasks.md;<br/>PLAN_COMPILED"]
  PL_COMPILE -->|"plan.validation !== null"| PL_DISCOVERED_VALIDATION{"sanitizeDiscoveredValidation:<br/>wzor i polecenie bezpieczne?"}
  PL_DISCOVERED_VALIDATION -->|"tak"| W["state.discoveredValidation"]
  PL_DISCOVERED_VALIDATION -->|"nie"| X["warning discovered_validation_refused;<br/>config, manifest lub stack"]
  V --> PL_PROTECTED_CONFIRM{"Approve na karcie: co potwierdza?"}
  PL_PROTECTED_CONFIRM -->|"protectedOperations z klasa chroniona"| Y["write path w ledgerze"]
  PL_PROTECTED_CONFIRM -->|"check cmd npm run script"| Z["polecenie w ledgerze (validation)"]`,
    },
    {
      id: 'planning-spec',
      title: 'splitbrief spec: ta sama sesja bez builda',
      caption:
        'Komenda CLI planuje bez stanu runu i bez karty planu. Pisze plan.json, plan.md i tasks.md i kończy proces.',
      mermaid: `flowchart TD
  A["splitbrief spec feature"] --> B["canonicalizeProjectDir, assertGitRepo,<br/>ensureHeadlessConfig, loadConfigOrExit"]
  B --> C["ensureHooksTrusted (--allow-hooks)"]
  C --> D["resolveEffectiveConfig; loadRememberedCatalog"]
  D --> PL_SPEC_INTERACTION{"process.stdin.isTTY?"}
  PL_SPEC_INTERACTION -->|"tak"| E["interactive: pytania czytane z jednej linii;<br/>disclosure runnerow przez prompt"]
  PL_SPEC_INTERACTION -->|"nie"| F["headless: kazde pytanie bierze default;<br/>artefakty runnerow zatwierdzane"]
  E --> G["prepareExecution (purpose spec)"]
  F --> G
  G --> H["createPlanner(execution.config)"]
  H --> I["planTurnText: ten sam prompt sesji co w runie"]
  I --> J["runPlanSession: rounds 0, bez stanu,<br/>planFullTurn na kazda ture"]
  J --> PL_SPEC_OUTCOME{"outcome.kind?"}
  PL_SPEC_OUTCOME -->|"plan"| K["writePlanJson; plan.md; tasks.md;<br/>druk Session, 3 sciezek i liczby zadan"]
  PL_SPEC_OUTCOME -->|"questions-exhausted"| L["cliError: third round of questions"]
  PL_SPEC_OUTCOME -->|"checks-failed"| M["cliError z lista bledow"]
  PL_SPEC_OUTCOME -->|"seat-protocol"| N["rzuca SeatProtocolError"]
  L --> O["rollbackPreparedExecutionOwnership; exit != 0"]
  M --> O
  N --> O`,
    },
    {
      id: 'planning-resume',
      title: 'Powrót do planowania: stare runy, wycofane fazy, zaparkowane pytania',
      caption:
        'Co run czyta ze stanu, gdy wraca: pytania bez odpowiedzi, kartę z zapisanym planem, albo stare dokumenty łańcucha planowania.',
      mermaid: `flowchart TD
  A["Otwarty run wraca (continueRun, resume)"] --> PL_RESUME_STEP{"resumeStep(state): pierwsze dopasowanie"}
  PL_RESUME_STEP -->|"pendingPlannerConversation"| B["krok planner/plan: sesja wznawia pytania"]
  PL_RESUME_STEP -->|"awaitsApply"| C["apply → zobacz lifecycle"]
  PL_RESUME_STEP -->|"reviewing-spec, reviewing-plan, reviewing-briefs"| PL_REOPENS_CARD{"reviewing-plan i state.plan?"}
  PL_REOPENS_CARD -->|"tak"| D["karta planu ponownie, bez wywolania plannera;<br/>steer z continuation = korekta"]
  PL_REOPENS_CARD -->|"nie: stara brama"| E["sesja planowania"]
  PL_RESUME_STEP -->|"implementing, validating-task, escalating"| F["brief → zobacz build"]
  PL_RESUME_STEP -->|"final-review, complete"| G["review → zobacz review"]
  PL_RESUME_STEP -->|"planning albo faza wycofana"| E
  B --> E
  E --> PL_OLD_CONVERSATION{"pendingPlannerConversation to<br/>pytania tej sesji (isSessionConversation)?"}
  PL_OLD_CONVERSATION -->|"tak"| H["pending = te pytania;<br/>steer przy wznowieniu = odpowiedz"]
  PL_OLD_CONVERSATION -->|"nie, lub brak"| I["CLEAR_PLANNER_CONVERSATION;<br/>stara rozmowa trafia do Earlier Planning"]
  H --> J["runPlanSession"]
  I --> PL_EARLIER_PLANNING{"plan.json juz istnieje?"}
  PL_EARLIER_PLANNING -->|"tak"| J
  PL_EARLIER_PLANNING -->|"nie"| K["sekcja Earlier Planning:<br/>research.md, spec.md, plan.md, tasks.md i rozmowa"]
  K --> J
  J --> L["BEGIN_PLANNING z kazdej wycofanej fazy → planning"]`,
    },
  ],
  decisions: [
    {
      id: 'PL_ENTRY_RESUME',
      title: 'Czy run w ogóle wraca do planowania',
      question: 'Gdzie run podejmuje pracę i czy planner jest potrzebny?',
      where: 'src/engine/orchestrator/run/phases.ts:48',
      inputs: ['resumeStep(state)', 'savedState.rewindPending'],
      branches: [
        { if: 'rewindPending !== undefined (korekta z karty, plan jeszcze nie skompilował)', then: 'pomija cały dispatch i uruchamia runPlanningPhase z rewindPending', next: 'PL_REWIND_LEAD' },
        { if: 'resume.kind === apply', then: 'runApply; applied → terminal closed, review → ready-for-tasks, needs-confirmation → input-required, halted/restored → halted' },
        { if: 'resume.kind === brief lub review', then: 'ready-for-tasks ze state.tasks, bez żadnego wywołania plannera' },
        { if: 'resume.kind === gate i reopensPlanCard(state)', then: 'resumeParkedApproval otwiera kartę ponownie', next: 'PL_REOPENS_CARD' },
      ],
      default: 'runPlanningPhase: pełna sesja planowania (także stara brama spec/briefs bez planu).',
      notes: 'Przed dispatchem isStopped(state) dispatchuje RESUME_STEP (phases.ts:38), więc nic dalej nie czyta runu jako zatrzymanego.',
    },
    {
      id: 'PL_RESUME_STEP',
      title: 'resumeStep: pierwszy pasujący krok',
      question: 'Jaki krok nazywa zapisany stan?',
      where: 'src/core/sessions/run-status.ts:94',
      inputs: ['state.pendingPlannerConversation', 'awaitsApply(state)', 'parkedGate(state)', 'state.phase'],
      branches: [
        { if: 'pendingPlannerConversation !== undefined', then: '{ kind: planner, call: plan } — sesja wznawia pytania' },
        { if: 'awaitsApply(state)', then: '{ kind: apply }' },
        { if: 'faza reviewing-spec / reviewing-plan / reviewing-briefs (parkedGate)', then: '{ kind: gate, gate }; reviewing-plan bez state.plan w runie, który nie otwierał bramy, nie jest bramą (run-status.ts:66)' },
        { if: 'implementing / validating-task / escalating', then: 'brief bieżącego zadania, albo review gdy indeks poza listą' },
        { if: 'final-review / complete', then: '{ kind: review, cycle: fixCycles.used }' },
      ],
      default: 'Krok planner/plan (planning i każda wycofana faza).',
    },
    {
      id: 'PL_REOPENS_CARD',
      title: 'Czy zaparkowana brama ma kartę do ponownego otwarcia',
      question: 'Czy run stoi na karcie typowanego planu?',
      where: 'src/core/sessions/run-status.ts:77',
      inputs: ['state.phase', 'state.plan'],
      branches: [
        { if: 'phase === reviewing-plan i state.plan !== undefined', then: 'resumeParkedApproval → runPlanApproval bez wywołania plannera; steer z continuation (take gate plan) zamienia pierwszy onApprovalNeeded w { action: revise, recorded: true } (resume-parked-approval.ts:24)', next: 'PL_CARD_RESULT' },
      ],
      default: 'null → runPlanningPhases idzie do sesji planowania (stara brama spec, briefs lub plan bez plan.json).',
    },
    {
      id: 'PL_REWIND_LEAD',
      title: 'Korekta z karty jako lead sesji',
      question: 'Czy stan niesie korektę, którą planner ma usłyszeć?',
      where: 'src/engine/orchestrator/planning/run.ts:51',
      inputs: ['rewindPending.comment', 'plan.json na dysku'],
      branches: [
        { if: 'comment po trim niepusty', then: 'lead = planRevisedTurn(plan.json lub pusty, komentarz): "The user asked for changes to the plan: … Return the corrected complete plan."' },
      ],
      default: 'lead undefined: zwykłe otwarcie sesji. Pole rewindPending.target nie jest czytane: spec i plan biegną tą samą sesją.',
    },
    {
      id: 'PL_ATTACHMENTS',
      title: 'Załączniki do plannera',
      question: 'Czy planner może zobaczyć obrazy z composera?',
      where: 'src/engine/orchestrator/planning/run.ts:20',
      inputs: ['wctx.drainPendingAttachments()', 'planner.capabilities.supportsImages'],
      branches: [
        { if: 'są załączniki i planner nie wspiera obrazów', then: 'planner_attachments_dropped (reason unsupported-backend); załączniki = []' },
        { if: 'są załączniki i planner je wspiera', then: 'trafiają jako images pierwszego wywołania (session.ts:307)' },
      ],
      default: 'Brak załączników: nic.',
    },
    {
      id: 'PL_BEFORE_FIRST_CALL',
      title: 'Hook pre_planning przed pierwszym wywołaniem',
      question: 'Czy hook pozwala na pierwsze wywołanie plannera w tym procesie?',
      where: 'src/engine/orchestrator/run/phases.ts:81',
      inputs: ['config.hooks', 'runPreHooks(pre_planning, workflow_started)'],
      branches: [
        { if: 'hook już biegł w tym procesie lub brak config.hooks', then: 'true' },
        { if: 'pre.allow === false', then: 'warning "pre_planning blocked: <reason>"; runPlanningSession zwraca terminal cancelled (session.ts:318)' },
      ],
      default: 'true: sesja idzie dalej. Hook biegnie raz na proces, tuż przed pierwszym realnym wywołaniem.',
    },
    {
      id: 'PL_PHASE_ENTRY',
      title: 'Wejście w fazę planning',
      question: 'Jaką akcją stan wchodzi w planning?',
      where: 'src/engine/orchestrator/planning/session.ts:321',
      inputs: ['state.phase'],
      branches: [
        { if: 'phase === idle', then: 'START → planning (machine.ts:323)' },
        { if: 'każda inna faza poza planning (reviewing-plan, wycofane fazy)', then: 'BEGIN_PLANNING → planning (machine.ts:326); phaseActions pozwala na nią z idle, researching, specifying, reviewing-spec, clarifying, constitution-check, reviewing-plan, reviewing-briefs, analyzing (machine.ts:79)' },
      ],
      default: 'phase już planning: bez akcji. Po wejściu publishPlannerStatus running z call: plan.',
    },
    {
      id: 'PL_STEER_ANSWER',
      title: 'Steer przy wznowieniu jako odpowiedź na pytania',
      question: 'Czy tekst, z którym użytkownik kontynuuje run, jest odpowiedzią na pytania plannera?',
      where: 'src/engine/orchestrator/planning/session.ts:285',
      inputs: ['wctx.continuation.take(resumeStep(state)).steer', 'state.pendingPlannerConversation.answered'],
      branches: [
        { if: 'rozmowa czeka (answered false) i steer niepusty', then: 'steerAnswer = steer; gdy to pytania tej sesji, resumedAnswer zwraca je z answer() bez czekania na UI (session.ts:493)' },
        { if: 'steer bez czekającej rozmowy', then: 'formatMessageInput(steer) dołącza do standing: planner słyszy go raz na wątku, a planner bez sesji na każdej pełnej turze' },
      ],
      default: 'Bez steer: sesja czeka na odpowiedź przez waitForPlannerReply.',
    },
    {
      id: 'PL_OLD_CONVERSATION',
      title: 'Czyje są zapisane pytania',
      question: 'Czy pendingPlannerConversation należy do tej sesji, czy do starego łańcucha?',
      where: 'src/core/state/planning-conversation.ts:25',
      inputs: ['conversation.call', 'conversation.questions', 'conversation.text === questionsText(questions)'],
      branches: [
        { if: 'call === plan, są pytania i text równa się questionsText(questions)', then: 'to pytania tej sesji: pending w runPlanSession, odpowiedzi liczą rundy (session.ts:347, 503)' },
        { if: 'inaczej (stary krok plan trzymał własną odpowiedź plannera)', then: 'CLEAR_PLANNER_CONVERSATION (session.ts:313); rozmowa idzie do Earlier Planning jako planHistory, otwarte pytanie z odpowiedzią steer albo "(not answered)" (session.ts:147)' },
      ],
      default: 'Brak rozmowy: nic.',
    },
    {
      id: 'PL_EARLIER_PLANNING',
      title: 'Dokumenty starego łańcucha jako kontekst',
      question: 'Czy prompt dostaje sekcję Earlier Planning?',
      where: 'src/engine/orchestrator/planning/session.ts:142',
      inputs: ['plan.json w folderze sesji', 'research.md, spec.md, plan.md, tasks.md', 'stara rozmowa'],
      branches: [
        { if: 'plan.json istnieje', then: 'undefined: run pisał własne dokumenty, nic nie dołącza' },
        { if: 'brak plan.json i są niepuste dokumenty lub stara rozmowa', then: 'sekcja "Earlier Planning: This run started under an older multi-step planner…" z każdym plikiem pod nagłówkiem ### <plik>' },
      ],
      default: 'Brak dokumentów: undefined.',
    },
    {
      id: 'PL_PLANNER_READS_FILES',
      title: 'Kontekst projektu zależy od rodzaju plannera',
      question: 'Czy planner sam czyta repozytorium?',
      where: 'src/engine/orchestrator/planning/session.ts:210',
      inputs: ['planner.resolvePlanningContext'],
      branches: [
        { if: 'resolvePlanningContext undefined (planner CLI czyta pliki sam)', then: 'buildProjectContextMarkdown(projectDir) raz; każda tura to turn(prompt)' },
        { if: 'resolvePlanningContext zdefiniowane (planner api bez dostępu do plików)', then: 'ścieżki absolutne z prośby i steer, które istnieją → warning "The plan seat reads no files, so it cannot open …" (session.ts:233); apiPlanningPacket mierzy cały pakiet w kontekście', next: 'PL_API_PACKET_BUDGET' },
      ],
      default: 'Zawsze: repo-map (gdy włączony), kontekst języka, Implementer (model i kontekst seat-a BUILD), zasady planRules z approvesPlan.',
    },
    {
      id: 'PL_API_PACKET_BUDGET',
      title: 'Pakiet plannera API mieści się w kontekście?',
      question: 'Czy wywołanie plannera api ma dość miejsca na prompt i odpowiedź?',
      where: 'src/engine/orchestrator/planning/api-packet.ts:43',
      inputs: ['measureApiBudget(context, messages, role plan)', 'buildApiPlanningContext(availableTokens)'],
      branches: [
        { if: 'minimum (pusty pakiet) insufficient z reason output', then: 'throw apiBudgetError.contextInsufficient(planner) przed wysłaniem' },
        { if: 'packet.kind === insufficient-context (brakuje wymaganej sekcji)', then: 'throw apiContextError(insufficient-context, seat plan, missingSections, required/available tokens)' },
      ],
      default: 'packet.text wchodzi do promptu. availableTokens = applicationContextTokens − BASE_OUTPUT_RESERVE − rezerwa na naprawę transportową (api-packet.ts:61). Błędy łapie handlePlanningFailure jako halt call-failed z faktami (failure.ts:63).',
    },
    {
      id: 'PL_REPO_MAP',
      title: 'Repo-map w prompcie',
      question: 'Czy planner dostaje Repository Map?',
      where: 'src/engine/orchestrator/planning/session.ts:186',
      inputs: ['config.codebase.enabled', 'config.codebase.tokenBudget', 'include / exclude'],
      branches: [
        { if: 'codebase.enabled === false', then: 'repoMap pusty: brak sekcji' },
        { if: 'buildRepoMap zwraca pusty tekst', then: 'brak sekcji' },
      ],
      default: 'Sekcja Repository Map z budżetem tokenBudget (domyślnie 4000). → zobacz subsystems.',
    },
    {
      id: 'PL_REJECTIONS',
      title: 'Odrzucenia z ledgera na czele promptu',
      question: 'Czy planner słyszy o wcześniejszych odrzuconych zapisach tego runu?',
      where: 'src/engine/orchestrator/planning/call-loop.ts:14',
      inputs: ['config.approval.feedRejectionsToPlanner', 'evidence ledger sesji'],
      branches: [
        { if: 'feedRejectionsToPlanner === false', then: 'pusty prefiks' },
        { if: 'ledger nieczytelny (wyjątek)', then: 'pusty prefiks; wywołanie nigdy nie pada przez ledger' },
      ],
      default: 'buildRejectionContext(ledger) jako pierwsze linie promptu sesji (session.ts:199).',
    },
    {
      id: 'PL_PENDING_REPLY',
      title: 'Czekające pytania przed kolejnym wywołaniem',
      question: 'Czy sesja ma pytania bez odpowiedzi?',
      where: 'src/engine/orchestrator/planning/plan-session.ts:92',
      inputs: ['pending (z io.pending lub z poprzedniej tury)', 'rounds'],
      branches: [
        { if: 'pending !== undefined', then: 'io.answer(pending, rounds + 1): zapis SET_PLANNER_CONVERSATION i wiersz "Questions before the plan · round n of 2" (session.ts:482), potem czekanie', next: 'PL_REPLY_KIND' },
      ],
      default: 'turn pozostaje open (pierwsza tura) albo repair; io.ask(turn).',
    },
    {
      id: 'PL_REPLY_KIND',
      title: 'Jak odpowiedź użytkownika staje się turą',
      question: 'Co użytkownik odpowiedział na rundę pytań?',
      where: 'src/engine/orchestrator/planning/plan-session.ts:58',
      inputs: ['reply z onPlannerReply lub steer', 'questions z defaults'],
      branches: [
        { if: 'reply === undefined (abort, headless bez odpowiedzi)', then: 'outcome unanswered → terminal input-required (session.ts:563)' },
        { if: 'reply ma pole message (PlannerReplyAnswer z panelu pytań)', then: 'idzie jak jest: message + qa z numerowanymi parami' },
        { if: 'tekst niepusty z composera', then: '{ message: tekst, qa: [] } — cały batch pytań zastąpiony instrukcją' },
        { if: 'puste ⏎', then: 'każde pytanie bierze default (boolean → Yes/No); tekst "1. <pytanie>\\n<default>" na pytanie' },
      ],
      default: 'rounds += 1, turn = answers; recordAnswers zapisuje odpowiedź w conversation.answers i jako user_message (session.ts:518).',
      notes: 'W TUI prompt-callbacks.ts:74: pusta odpowiedź zwraca pusty tekst, więc puste ⏎ z panelu i z composera bierze domyślne odpowiedzi.',
    },
    {
      id: 'PL_RESULT_KIND',
      title: 'Planner pyta czy planuje',
      question: 'Jaki jest result.kind typowanej odpowiedzi?',
      where: 'src/engine/orchestrator/planning/plan-session.ts:104',
      inputs: ['answered.value.result.kind', 'PlanQuestionsSchema (1..3 pytań, default niepusty i wśród choices)'],
      branches: [
        { if: 'questions', then: 'clarificationQuestions: choices niepuste → type choice, inaczej input', next: 'PL_ROUNDS_EXHAUSTED' },
        { if: 'plan', then: 'io.check(plan) → checkFullPlan', next: 'PL_CHECK_ERRORS' },
      ],
      default: 'Schema nie przepuszcza innego kind; zła odpowiedź to seat-protocol (PL_TYPED_REPAIR).',
    },
    {
      id: 'PL_ROUNDS_EXHAUSTED',
      title: 'Limit dwóch rund pytań',
      question: 'Czy planner pyta po raz trzeci?',
      where: 'src/engine/orchestrator/planning/plan-session.ts:106',
      inputs: ['rounds (odpowiedziane rundy)', 'MAX_QUESTION_ROUNDS = 2 (prompts/plan-session.ts:11)'],
      branches: [
        { if: 'rounds >= 2', then: 'outcome questions-exhausted → halt plan-questions-exhausted "The planner asked a third round of questions; a session takes 2." z pytaniami w details (session.ts:565); w spec: cliError' },
      ],
      default: 'pending = pytania; pętla czeka na odpowiedź. Po drugiej rundzie planAnswersTurn mówi plannerowi: "No question round remains: return the plan, and take the default of every question that is still open." (prompts/plan-session.ts:118).',
    },
    {
      id: 'PL_TYPED_REPAIR',
      title: 'Odpowiedź niezgodna ze schematem: naprawa transportowa',
      question: 'Czy JSON plannera przechodzi PlanAnswerSchema?',
      where: 'src/engine/runners/typed-output.ts:349',
      inputs: ['checkAnswer(schema, first)', 'seat', 'call.canResume', 'first.nativeSessionId'],
      branches: [
        { if: 'pierwsza odpowiedź ok', then: 'value + nativeSessionId + usage' },
        { if: 'seat === implementer i błąd', then: 'SeatProtocolError po 1 próbie (bez naprawy) — nie dotyczy plannera' },
        { if: 'planner, błąd, canResume i nativeSessionId', then: 'resumeRepairPrompt(errors) na wątku' },
        { if: 'planner, błąd, bez wątku', then: 'freshRepairPrompt(prompt, answer, errors): pełny prompt + zła odpowiedź + błędy' },
        { if: 'naprawa ok', then: 'value, usage zsumowane' },
      ],
      default: 'SeatProtocolError(seat, attempts 2, transport) → runPlanSession zwraca seat-protocol → halt seat-protocol-error z ofertą zmiany seat-a (session.ts:585). Prompt większy niż maxInputChars rzuca inputTooLargeRefusal przed wysłaniem (typed-output.ts:338, 372).',
      notes: 'Ta naprawa liczy się osobno od naprawy semantycznej checkPlan: plan może zużyć 1 naprawę JSON i 1 naprawę sprawdzeń.',
    },
    {
      id: 'PL_TYPED_REPAIR_OK',
      title: 'Drugie sprawdzenie po naprawie transportowej',
      question: 'Czy odpowiedź po naprawie jest zgodna ze schematem?',
      where: 'src/engine/runners/typed-output.ts:381',
      inputs: ['checkAnswer(schema, repair)'],
      branches: [
        { if: 'ok', then: 'value, nativeSessionId naprawy, usage = pierwsze + naprawa' },
      ],
      default: 'SeatProtocolError z attempts 2 i usage zsumowanym.',
    },
    {
      id: 'PL_TYPED_TRANSPORT',
      title: 'Jak schema dociera do narzędzia',
      question: 'Czy narzędzie przyjmuje schema natywnie?',
      where: 'src/engine/runners/typed-output.ts:314',
      inputs: ['call.typedOutput (native / fallback / strict-native)', 'isStrictJsonSchema(PLAN_ANSWER_JSON_SCHEMA)'],
      branches: [
        { if: 'native, albo strict-native ze schematem strict', then: 'schema { json, name: plan_result } idzie w wywołaniu (claude --json-schema, codex, api)' },
        { if: 'fallback, albo strict-native ze schematem nie-strict', then: 'fallbackInstruction(jsonSchema) doklejona do promptu; planner api mierzy ją w pakiecie (session.ts:246)' },
      ],
      default: 'PLAN_ANSWER_JSON_SCHEMA jest strict (klucze wymagane, opcje nullable, bez $schema) — plan.ts:91. → zobacz runners.',
    },
    {
      id: 'PL_ON_SESSION',
      title: 'Krótka tura na wątku czy pełny prompt',
      question: 'Czy planner kontynuuje własny wątek?',
      where: 'src/engine/orchestrator/planner-session.ts:81',
      inputs: ['rebuilt (po reissue)', 'planner.capabilities.supportsSessionResume', 'state.plannerSessionId'],
      branches: [
        { if: 'bez rebuilt, supportsSessionResume i plannerSessionId', then: 'onSession true: compose daje krótką turę — planAnswersTurn(odpowiedzi, runda), planRepairTurn(błędy), lead (karta) albo pusty prompt otwarcia gdy lead jest (session.ts:355)' },
        { if: 'inaczej', then: 'onSession false: planFullTurn(prompt, odpowiedziane rundy, naprawa, fullStanding) + priorMessages z transkryptu (session.ts:371)' },
      ],
      default: 'Po odpowiedzi nativeSessionId !== null → SET_PLANNER_SESSION_ID (planner-session.ts:108). standing (lead i steer) jest słyszany raz na wątku (standingHeard), na pełnej turze za każdym razem.',
    },
    {
      id: 'PL_FRESH_REISSUE',
      title: 'Wygasły lub odrzucony wątek plannera',
      question: 'Czy wywołanie na wznowionym wątku ma pójść raz jeszcze na świeżej sesji?',
      where: 'src/engine/orchestrator/resume-context.ts:126',
      inputs: ['resumed = supportsSessionResume i plannerSessionId', 'isSessionExpiredError(err)', 'typedRunnerCallErrorCode(err) === input-too-large', 'signal.aborted'],
      branches: [
        { if: 'nie wznawiał wątku, abort, albo błąd inny niż expired / input-too-large', then: 'throw err → handlePlanningFailure' },
        { if: 'expired', then: 'warning planner_session_expired; SET_PLANNER_SESSION_ID null (planner-session.ts:79); applyRebuiltContext z session.jsonl; issue(rebuilt) raz' },
        { if: 'input-too-large na wątku', then: 'warning planner_session_refused; to samo ponowienie na świeżej sesji' },
      ],
      default: 'Drugie niepowodzenie jest zwracane wołającemu: handlePlanningFailure robi halt.',
    },
    {
      id: 'PL_CHECK_ERRORS',
      title: 'Plan nie przechodzi sprawdzeń: jedna naprawa',
      question: 'Czy checkFullPlan zwrócił błędy, i czy to pierwszy raz?',
      where: 'src/engine/orchestrator/planning/plan-session.ts:111',
      inputs: ['errors z checkFullPlan', 'repaired'],
      branches: [
        { if: 'errors.length === 0', then: 'outcome plan (checksRepaired mówi, czy była naprawa → info "The revised plan passes its checks." session.ts:508)' },
        { if: 'błędy i repaired === false', then: 'repaired = true; turn = repair (błędy + plan); warning "The plan failed N checks. It goes back to the planner once to fix them: - …" (plan-checks.ts:49, session.ts:387)' },
        { if: 'błędy i repaired === true', then: 'decyzja o blokowaniu', next: 'PL_BLOCKS_PLAN' },
      ],
      default: 'Brak: wszystkie przypadki wyżej.',
    },
    {
      id: 'PL_BLOCKS_PLAN',
      title: 'Które błędy blokują po naprawie',
      question: 'Czy po jednej naprawie zostały tylko błędy nieblokujące?',
      where: 'src/engine/spec/plan-checks.ts:209',
      inputs: ['error.code'],
      branches: [
        { if: 'każdy błąd ma code render-check-unconfigured', then: 'outcome plan z checksRepaired false; plan.md dostaje "## Before you approve" z notatką renderCheckNotes: "Render checks V… need validation.render, which is not set. Add it to .splitbrief/config.yaml, or request changes to drop them; without it the run halts before its review." (plan-checks.ts:196)' },
        { if: 'jakikolwiek inny code', then: 'outcome checks-failed → halt plan-checks-failed "The plan failed its checks again after one repair." z komunikatami w details (session.ts:575)' },
      ],
      default: 'blocksPlan(error) = code !== render-check-unconfigured. Ta sama funkcja filtruje błędy edycji plan.json (session.ts:681) i zapisu w edytorze (plan-save.ts:13).',
    },
    {
      id: 'PL_CMD_REFUSAL',
      title: 'Polityka tekstu polecenia dla checków cmd i test',
      question: 'Czy check planu można w ogóle uruchomić?',
      where: 'src/engine/orchestrator/planning/sanitize-discovered-validation.ts:452',
      inputs: ['check.kind', 'check.value', 'npmScriptsApproved = resolveApproveLevel(config) === plan'],
      branches: [
        { if: 'kind test i parseShellCommand(value).length !== 1', then: 'refused-check-command: "a test check names one test file, and … is not one file" (plan-checks.ts:225)' },
        { if: 'cmd zaczyna się od npx', then: 'wymaga --no-install jako pierwszej opcji i narzędzia stacku zaraz po nim (NPX_STACK_TOOLS), inaczej odmowa' },
        { if: 'cmd to npm run i plan jest zatwierdzany', then: 'przechodzi, gdy ma nazwę skryptu i żaden token nie ma operatora shella; czy package.json definiuje skrypt sprawdza dopiero uruchomienie (checkCommandRefusal:471)' },
        { if: 'cmd to npm run i approve: none', then: 'wpada w unsafeCommandReason → odmowa (skrypt pakietu wymaga zatwierdzonego planu; packageScriptRule w prompcie mówi to plannerowi)' },
        { if: 'cmd to test -e/-f/-x/-L <plik w workspace>', then: 'przechodzi; inna forma test odmawia (fileTestRefusal:426)' },
        { if: 'program ze ścieżką, poza allowlistą (menedżery pakietów, make, just, narzędzia 5 stacków), z operatorem shella lub kodem inline', then: 'unsafeCommandReason zwraca powód (sanitize:402)' },
      ],
      default: 'null: check dopuszczony. refusedCheckErrors stosuje te same reguły do fix tasków review i do rewrite/split z konsultu (→ zobacz review, build).',
    },
    {
      id: 'PL_PROTECTED_CHECK',
      title: 'protectedOperations kontra klasyfikator zapisów',
      question: 'Czy plan poprawnie wymienia chronione zapisy?',
      where: 'src/engine/spec/plan-checks.ts:319',
      inputs: ['task.protectedOperations[].path', 'task.suggestedFiles', 'protectedWriteClass(path, projectDir)', 'isExactFilePath'],
      branches: [
        { if: 'ścieżka poza projektem', then: 'pominięta tu (path-outside-project zgłasza ją wcześniej, plan-checks.ts:300)' },
        { if: 'glob, końcowy /, istniejący katalog, albo inna wielkość liter niż na dysku', then: 'protected-path-not-file' },
        { if: 'protectedWriteClass === null (zapis o nic nie pyta)', then: 'unprotected-operation: "drop it from protectedOperations"' },
        { if: 'suggestedFile ma klasę chronioną i nie jest w protectedOperations', then: 'unlisted-protected-operation: "list { path, operation: write }"' },
      ],
      default: 'Brak błędów; po zatwierdzeniu karty planConfirmations zapisze każdy wymieniony zapis jako potwierdzony (PL_PROTECTED_CONFIRM).',
    },
    {
      id: 'PL_CONTEXT_FIT',
      title: 'Dopasowanie zadania do kontekstu seat-a BUILD',
      question: 'Czy zadanie zmieści się w implementerze i czy ktoś może je wziąć?',
      where: 'src/engine/spec/plan-checks.ts:348',
      inputs: ['taskFits z estimatePlanContextFits', 'TaskContextFit: fits / tight / overflow', 'routingBlockKind no-capable-worker'],
      branches: [
        { if: 'zadanie ma ścieżkę poza projektem lub nie-plik', then: 'bez estymaty (plan-context-fit.ts:17); checkPlan odrzuca je innym kodem' },
        { if: 'fit === overflow', then: 'context-overflow "Task T… does not fit the BUILD model’s context" + rozmiary contextFiles w znakach albo "; split it." (plan-checks.ts:101)' },
        { if: 'blocked (routingReason)', then: 'no-capable-worker "Task T… has no implementer that can take it: <reason>" (credentials, tryb zapisu, kontrakt jednego pliku)' },
      ],
      default: 'fits lub tight: bez błędu. Kontekst seat-a BUILD = resolveProfileContextLength domyślnego profilu implementera (session.ts:119); estymata używa buildRoutingPreviewMetadata (routing-preview.ts:86).',
    },
    {
      id: 'PL_RENDER_UNCONFIGURED',
      title: 'Check render bez polecenia renderu',
      question: 'Czy plan ma checki render, a run nie ma validation.render?',
      where: 'src/engine/spec/plan-checks.ts:363',
      inputs: ['plan.checks i task.checks z kind render', 'config.validation.render'],
      branches: [
        { if: 'validation.render ustawione', then: 'brak błędu' },
        { if: 'są checki render bez polecenia', then: 'render-check-unconfigured "Render checks … need validation.render, which is not set; drop them or ask the user." — nieblokujący' },
      ],
      default: 'Brak checków render: nic.',
    },
    {
      id: 'PL_SETTLE',
      title: 'Wynik sesji w dyspozycję fazy',
      question: 'Co orchestrator robi z wynikiem runPlanSession?',
      where: 'src/engine/orchestrator/planning/session.ts:560',
      inputs: ['outcome.kind'],
      branches: [
        { if: 'plan', then: 'compilePlan → disposition tasks-ready' },
        { if: 'unanswered', then: 'terminal input-required: headless zapisuje input_required z pytaniami i resumeCommand (headless.ts:82)' },
        { if: 'questions-exhausted', then: 'raisePendingRecovery z buildPlanSessionHaltRecoveryIssue(plan-questions-exhausted); akcje retry-same-worker, revise (rekomendowana), end-run (builders/planner.ts:172)' },
        { if: 'checks-failed', then: 'ten sam builder z plan-checks-failed; te same akcje' },
        { if: 'seat-protocol', then: 'buildSeatProtocolErrorRecoveryIssue z loadSeatSwapContext(seat plan): halt Seat down z ofertą switch-seat' },
      ],
      default: 'Każdy halt zostawia pendingPlannerConversation: korekta (revise) lub ponowienie kontynuuje tę samą sesję. → zobacz recovery.',
    },
    {
      id: 'PL_COMPILE',
      title: 'compilePlan: co powstaje z planu',
      question: 'Jakie pliki i akcje stanu produkuje plan, który przeszedł?',
      where: 'src/engine/orchestrator/planning/session.ts:606',
      inputs: ['PlanProposal', 'config.validation.render', 'detectStack(projectDir, validation.stack)', 'readManifestCommands'],
      branches: [
        { if: 'zawsze', then: 'tasks = taskFromSpec(spec) (action modify gdy pierwszy suggestedFile istnieje, inaczej create — plan-tasks.ts:18); writePlanJson; plan.md = formatPlanMarkdown(plan, renderCheckNotes); tasks.md = formatTasks; artifact_written ×2' },
        { if: 'plan.validation !== null', then: 'sanitizeDiscoveredValidation → state.discoveredValidation', next: 'PL_DISCOVERED_VALIDATION' },
        { if: 'pendingPlannerConversation !== undefined', then: 'CLEAR_PLANNER_CONVERSATION: odpowiedzi idą do userAnswers (machine.ts:781)' },
      ],
      default: 'PLAN_COMPILED { plan: PlanSchema.parse(plan), tasks } — zapisuje state.plan i state.tasks i czyści rewindPending (machine.ts:332).',
    },
    {
      id: 'PL_DISCOVERED_VALIDATION',
      title: 'Walidacja odkryta przez plannera',
      question: 'Czy language, test i testPattern z planu trafiają do stanu?',
      where: 'src/engine/orchestrator/planning/sanitize-discovered-validation.ts:512',
      inputs: ['plan.validation', 'isTestPatternSafe', 'unsafeCommandReason(testCommand)', 'resolveTestCommand bez discovered'],
      branches: [
        { if: 'testPattern ma / \\ lub ..', then: 'warning discovered_validation_refused "The test checks do not take the file pattern …"; wzór z configu lub stacku' },
        { if: 'testCommand przechodzi unsafeCommandReason', then: 'sanitized.testCommand = value' },
        { if: 'testCommand odmówiony, ale config/manifest/stack i tak dają to samo polecenie', then: 'cicho pominięty, bez ostrzeżenia (sanitize:545)' },
        { if: 'testCommand odmówiony i inne źródło daje inne polecenie', then: 'warning "The test checks do not take <cmd> from the plan: it <reason>. They use config, the manifest or the stack default."' },
      ],
      default: 'Pusty wynik → discoveredValidation bez zmian. Wynik zasila tylko checki test plannera (→ zobacz build).',
    },
    {
      id: 'PL_APPROVE_LEVEL',
      title: 'workflow.approve: karta czy od razu build',
      question: 'Czy plan czeka na zatwierdzenie?',
      where: 'src/core/config/runtime/resolve.ts:5',
      inputs: ['config.workflow.approve (plan | none, domyślnie plan)'],
      branches: [
        { if: 'plan', then: 'runPlanApproval: tasks_planned, PLAN_DONE → reviewing-plan, karta (session.ts:717)' },
        { if: 'none', then: 'pętla while nie wchodzi; BEGIN_IMPLEMENTATION od razu (session.ts:790); każdy chroniony zapis pyta dopiero w buildzie; checki npm run są odmawiane już w checkPlan' },
      ],
      default: 'Config decyduje za każdym razem; state.approve tylko zapisuje, co config powiedział (run.ts:14). Wartości all, spec, default ładują się jako plan z jedną notatką (RETIRED_APPROVE_LEVELS, enums.ts:201). Flaga --approve nie istnieje: "--approve was removed: set workflow.approve (plan or none) in the config" (unknown-command.ts:28).',
    },
    {
      id: 'PL_CARD_QUEUED',
      title: 'Wiadomość w kolejce przy karcie',
      question: 'Czy użytkownik zdążył coś wpisać, zanim karta się otworzyła?',
      where: 'src/engine/orchestrator/planning/session.ts:725',
      inputs: ['drainAndFormat(seat plan)'],
      branches: [
        { if: 'kolejka niepusta', then: 'correction = tekst; karta się nie otwiera; od razu plan_regenerated + CORRECT_PLAN + sesja z planRevisedTurn' },
      ],
      default: 'Kolejka pusta: planConfirmations i onApprovalNeeded(plan, ścieżka plan.md, opisy potwierdzeń).',
    },
    {
      id: 'PL_CARD_RESULT',
      title: 'Cztery wiersze karty planu',
      question: 'Co użytkownik wybrał na karcie?',
      where: 'src/engine/orchestrator/planning/session.ts:742',
      inputs: ['ApprovalReviewResult z onApprovalNeeded', 'signal.aborted'],
      branches: [
        { if: 'signal.aborted po powrocie', then: 'terminal cancelled' },
        { if: 'approved (Approve plan and start the build)', then: 'potwierdzenia do ledgera (gdy nie unattended), plan_approved, break → BEGIN_IMPLEMENTATION', next: 'PL_UNATTENDED' },
        { if: 'action end-run (End run)', then: 'closeRunIfOpen → CLOSE_RUN; planner_status done; plan_rejected; terminal closed; pliki zostają na dysku' },
        { if: 'action edit (Edit plan.json)', then: 'applyPlanEdit; continue → karta znów', next: 'PL_EDIT_VALID' },
        { if: 'action revise z pustym tekstem, albo brak decyzji', then: 'continue: karta otwiera się ponownie; nic nie jest odrzuceniem' },
        { if: 'action revise z tekstem (Request changes lub wpisany tekst)', then: 'recordUserMessage (chyba że recorded true z resume); plan_regenerated; CORRECT_PLAN; runPlanningSession z planRevisedTurn(reviewed plan.json, korekta)', next: 'PL_REVISED_RESULT' },
      ],
      default: 'Wyjątek w czekaniu → handlePlanningFailure (session.ts:770). Wiersze: reviewDocumentOptions (prompt-rows/approval.ts).',
    },
    {
      id: 'PL_UNATTENDED',
      title: 'Zatwierdzenie bez człowieka',
      question: 'Czy ktoś patrzył na plan przed zatwierdzeniem?',
      where: 'src/engine/orchestrator/planning/session.ts:743',
      inputs: ['result.unattended'],
      branches: [
        { if: 'unattended !== true (TUI)', then: 'persistApprovalEvidence z confirmApprovals = planConfirmations: każdy chroniony zapis i npm run w ledgerze; brama zapisu w buildzie nie zapyta ponownie (confirm.ts:19)' },
        { if: 'unattended === true (headless.ts:449)', then: 'zero potwierdzeń: chroniony zapis w buildzie headless jest odmówiony jako APPROVAL_REQUIRED, bo nikt nie odpowie na onTieredApproval' },
      ],
      default: 'W obu przypadkach plan_approved i BEGIN_IMPLEMENTATION.',
    },
    {
      id: 'PL_EDIT_VALID',
      title: 'Edycja plan.json na karcie',
      question: 'Czy edytowany plan.json można skompilować?',
      where: 'src/engine/orchestrator/planning/session.ts:676',
      inputs: ['readSpecFileOrEmpty(plan.json)', 'reviewed (tekst przed edycją)', 'parsePlanJson', 'checkFullPlan + blocksPlan'],
      branches: [
        { if: 'tekst identyczny z reviewed', then: 'bez zmian; karta znów' },
        { if: 'zły JSON', then: 'errors = ["plan.json is not valid JSON (…)"]; przywrócenie reviewed; warning "The edited plan was not applied: …"' },
        { if: 'nie przechodzi PlanProposalSchema', then: 'errors ze ścieżkami pól; przywrócenie i warning' },
        { if: 'blokujące błędy checkFullPlan', then: 'przywrócenie i warning z komunikatami' },
        { if: 'poprawny', then: 'plan_regenerated z comment "(edited plan.json)"; compilePlan bez wywołania plannera; karta znów' },
      ],
      default: 'Edytor w aplikacji sprawdza przed zapisem planSaveErrors: JSON, schema i checkPlan bez dopasowania kontekstu i z npmScriptsApproved true (plan-save.ts:10); odmowa zapisu "Not saved: <first> (+N more)". → zobacz ui.',
    },
    {
      id: 'PL_REVISED_RESULT',
      title: 'Wynik sesji po korekcie z karty',
      question: 'Co zwróciła sesja planowania uruchomiona z korektą?',
      where: 'src/engine/orchestrator/planning/session.ts:782',
      inputs: ['revised.disposition'],
      branches: [
        { if: 'terminal (halt, stop, closed, input-required)', then: 'zwracany w górę; CORRECT_PLAN zostawił rewindPending, więc kontynuacja wznowi sesję z tą korektą (rewindLead)' },
        { if: 'tasks-ready', then: 'current = revised.state; pętla otwiera kartę z nowym planem' },
      ],
      default: 'Sesja po korekcie startuje bez załączników i bez hooka (attachments undefined, beforeFirstCall undefined).',
    },
    {
      id: 'PL_PROTECTED_CONFIRM',
      title: 'Co zatwierdzenie karty potwierdza',
      question: 'Które operacje trafiają do ledgera jako potwierdzone przy Approve?',
      where: 'src/engine/orchestrator/approval/confirm.ts:54',
      inputs: ['tasks[].protectedOperations', 'protectedWriteClass(path)', 'checkRegistry({ tasks, plan }) — checki cmd npm run <script>'],
      branches: [
        { if: 'protectedWriteClass(path) === null', then: 'operacja pominięta (checkPlan i tak ją odrzucił jako unprotected-operation)' },
        { if: 'klasa chroniona (destructive, sensitive_change, package_change)', then: '{ tier confirm, actionClass, actionDescription "write <path>", reason "listed on the approved plan" }' },
        { if: 'check cmd o postaci npm run <script>', then: '{ actionClass validation, actionDescription = pełne polecenie, reason "check on the approved plan" } (confirm.ts:28)' },
      ],
      default: 'Duplikaty (ta sama klasa i opis) usuwane w kolejności pierwszego wystąpienia. Karta pokazuje je jako "Approving also confirms: …" (reviewConfirmsText) i w plan.md pod "## Protected operations".',
    },
    {
      id: 'PL_FAILURE',
      title: 'handlePlanningFailure: wyjątek w sesji',
      question: 'Dlaczego wywołanie plannera rzuciło?',
      where: 'src/engine/orchestrator/planning/failure.ts:40',
      inputs: ['err', 'wctx.signal.aborted', 'workflowCancelledReasonFromSignal', 'latest.closed', 'readApiContextDiagnostic(err)'],
      branches: [
        { if: 'isAbortError(err) lub signal.aborted, i to End run (reason na sygnale)', then: 'terminal cancelled bez parku (run zamknięty)' },
        { if: 'abort użytkownika (stop)', then: 'parkStoppedRun → INTERRUPT_STEP; terminal interrupted; run otwarty, kontynuuje tę samą sesję' },
        { if: 'latest.closed !== undefined (End run na karcie, zapis nie potwierdził)', then: 'publishError; terminal closed' },
        { if: 'sessionError.isLocalSaveFailure(err)', then: 'throw: błąd zapisu stanu idzie wyżej' },
        { if: 'readApiContextDiagnostic(err) !== null (pakiet API nie zmieścił się)', then: 'publishError "Planning failed: …"; plannerCallHaltIssue(call-failed) z details "Missing: …" i "Pick a plan seat with a larger context in /crew plan, then choose Retry"; facts z estymatami; terminal halted' },
      ],
      default: 'diagnosePlannerCallFailure → plannerCallHaltIssue → publishError(plannerHaltRow, resetAt) → raisePendingRecovery; terminal halted.',
      notes: 'Timeout runnera nigdy nie jest abortem użytkownika: decyduje sygnał workflow, nie błąd wywołania.',
    },
    {
      id: 'PL_DIAGNOSE',
      title: 'Klasyfikacja nieudanego wywołania plannera',
      question: 'Co nieudane wywołanie mówi o seat-cie plan?',
      where: 'src/engine/orchestrator/recovery/planner-call-failure.ts:64',
      inputs: ['typedRunnerCallErrorCode(err)', 'thrownSeatFailure(err).classification', 'słowa narzędzia'],
      branches: [
        { if: 'code missing-model', then: 'failure missing-model → halt planner-call-failed; builder pyta route o credential (seatRouteRefusal): signed-out → Seat down, inaczej model refusal z ofertą switch-seat' },
        { if: 'code input-too-large', then: 'failure input-too-large → halt planner-call-failed bez retry-same-worker ("A retry sends the same prompt."), rekomendacja switch-seat' },
        { if: 'classification rate-limited, albo account z cause ≠ auth', then: 'failure usage-limit z resetsAt → buildSeatDownIssue (runner-usage-limit); limit ma pierwszeństwo przed auth' },
        { if: 'classification account z cause auth', then: 'failure unauthenticated → Seat down (runner-unauthenticated) z instrukcją logowania' },
      ],
      default: 'failure call-failed → halt planner-call-failed z akcjami retry-same-worker, switch-seat (gdy jest oferta), end-run. Przełączenie na fallback, zegar resetu i menu → zobacz recovery i runners.',
    },
    {
      id: 'PL_HALT_KIND',
      title: 'Halt planowania: Needs you czy Seat down',
      question: 'Jak haltOf tytułuje halt z planowania?',
      where: 'src/core/recovery/halt.ts:56',
      inputs: ['issue.reason'],
      branches: [
        { if: 'plan-questions-exhausted, plan-checks-failed', then: 'needs-you: "Needs you · <cause>"; akcje retry-same-worker, revise, end-run' },
        { if: 'planner-call-failed, seat-protocol-error, runner-usage-limit, runner-unauthenticated', then: 'seat-down: "Seat down · <cause>"; automatyczny fallback raz na run i seat, gdy to odmowa konta lub długi reset' },
      ],
      default: '→ zobacz recovery. Retry na halcie seat-a plan bez zadania idzie przez resolveSeatIssueWithoutTask (actions.ts:576, 886) i ponawia sesję z zachowaną rozmową.',
    },
    {
      id: 'PL_MUTATION_GUARD',
      title: 'Planner CLI zapisał pliki',
      question: 'Czy planner, który ma tylko czytać, zmienił coś w projekcie?',
      where: 'src/engine/planners/cli.ts:209',
      inputs: ['captureChangedFilesBaseline przed wywołaniem', 'changedFilesSinceBaseline po', 'adapter.descriptor.internalStatePaths'],
      branches: [
        { if: 'zmienione pliki poza internalStatePaths narzędzia (np. .opencode/package-lock.json)', then: 'throw planningMutationError.unexpectedMutations "CLI planner produced unexpected filesystem mutations: a, b" → handlePlanningFailure → halt call-failed' },
      ],
      default: 'Wynik wywołania wraca. Strażnik żyje tylko w plannerze cli (jedyne miejsce importu mutation-guard.ts); planner api nie ma dostępu do plików.',
    },
    {
      id: 'PL_HEARTBEAT',
      title: 'Oznaka życia podczas cichego wywołania',
      question: 'Kiedy UI dostaje planner_heartbeat?',
      where: 'src/engine/orchestrator/planning/heartbeat.ts:38',
      inputs: ['HEARTBEAT_THRESHOLD_MS = 5000', 'PLANNER_KEEPALIVE_INTERVAL_MS = 2000', 'call_started → updateCallId'],
      branches: [
        { if: 'wywołanie trwa ponad 5 s', then: 'pierwszy planner_heartbeat, potem co 2 s z elapsedMs od startu okna i callId' },
        { if: 'call_started', then: 'callId zapisany, okno liczone od nowa' },
      ],
      default: 'stop() w finally przerywa oba timery. Sesja nie strumieniuje narracji: odpowiedź to JSON, więc byline i heartbeat są jedynym znakiem życia.',
    },
    {
      id: 'PL_RETIRED_VALUES',
      title: 'Wycofane klucze configu planowania',
      question: 'Co robi stary klucz w .splitbrief/config.yaml?',
      where: 'src/core/config/load/validation/config.ts:121',
      inputs: ['surowy config', 'RETIRED_CONFIG_VALUES', 'RETIRED_APPROVE_LEVELS'],
      branches: [
        { if: 'workflow.mode (quick, standard, speckit, instant)', then: 'ignorowany, notatka "workflow.mode was retired and is ignored: every run plans in one session." Flaga --mode: "--mode was removed: every run plans in one session" (unknown-command.ts:27)' },
        { if: 'workflow.approve = all | spec | default', then: 'ładuje się jako plan z notatką "workflow.approve "<v>" was retired; using "plan"…"' },
        { if: 'workflow.task_review, workflow.brief_review, workflow.speckit', then: 'ignorowane, po jednej notatce' },
        { if: 'approval.tiers, approval.enabled', then: 'ignorowane: zapis na chronioną ścieżkę zawsze pyta, inny nigdy' },
        { if: 'workflow.max_retries, workflow.drift_chain_threshold, validation.typecheck/lint/test(_command), escalation', then: 'ignorowane z notatką (poza obszarem planowania, ta sama lista)' },
      ],
      default: 'retiredValueNotices zwraca jedną notatkę na trafiony klucz; ładowanie się nie zatrzymuje. → zobacz startup. /mode, /revise-spec, /revise-plan to usunięte komendy z wskazówką (REMOVED_COMMANDS).',
    },
    {
      id: 'PL_SPEC_INTERACTION',
      title: 'splitbrief spec: terminal czy nie',
      question: 'Kto odpowiada na pytania plannera w komendzie spec?',
      where: 'src/cli/commands/spec.ts:136',
      inputs: ['process.stdin.isTTY'],
      branches: [
        { if: 'TTY', then: 'interaction interactive: "The planner asks:" + pytania; promptForLine("Your answer (⏎ takes the defaults): "); disclosure runnerów i artefaktów przez prompt' },
        { if: 'bez TTY', then: 'interaction headless: odpowiedź to pusty tekst → każde pytanie bierze default; artefakty runnerów zatwierdzane automatycznie (spec.ts:159)' },
      ],
      default: 'Obie ścieżki: runPlanSession z rounds 0 i planFullTurn na każdą turę (brak wątku i stanu); check = checkFullPlan z modelCacheStore.',
    },
    {
      id: 'PL_SPEC_OUTCOME',
      title: 'splitbrief spec: wynik sesji',
      question: 'Jak komenda kończy po runPlanSession?',
      where: 'src/cli/commands/spec.ts:237',
      inputs: ['outcome.kind'],
      branches: [
        { if: 'plan', then: 'releasePreparedExecutionOwnership; writePlanJson, plan.md (formatPlanMarkdown + renderCheckNotes), tasks.md; druk "Planning complete." z Session i trzema ścieżkami i liczbą zadań' },
        { if: 'questions-exhausted', then: 'cliError "The planner asked a third round of questions; a session takes 2."' },
        { if: 'checks-failed', then: 'cliError "The plan failed its checks again after one repair:" + lista' },
        { if: 'seat-protocol', then: 'rzuca outcome.error' },
      ],
      default: 'Każdy błąd: rollbackPreparedExecutionOwnership i wyjście niezerowe. Bez karty planu, bez state.json, bez BEGIN_IMPLEMENTATION.',
    },
  ],
  config: [
    { key: 'workflow.approve', values: 'plan | none', default: 'plan', effect: 'plan: karta planu po sprawdzeniach i npm run w checkach dozwolone; none: build od razu, npm run odmawiane w checkPlan, chronione zapisy pytają w buildzie.', where: 'src/core/config/runtime/resolve.ts:5' },
    { key: 'workflow.mode', values: 'quick | standard | speckit | instant (wycofane)', default: 'brak', effect: 'Ignorowany; jedna notatka. Nie ma trybów workflow.', where: 'src/core/config/load/validation/config.ts:126' },
    { key: 'workflow.approve (all | spec | default)', values: 'wartości wycofane', default: 'brak', effect: 'Ładują się jako plan z jedną notatką.', where: 'src/core/schemas/enums.ts:201' },
    { key: 'workflow.task_review / workflow.brief_review / workflow.speckit', values: 'dowolne (wycofane)', default: 'brak', effect: 'Ignorowane z jedną notatką każdy; briefy ogląda się na karcie planu.', where: 'src/core/config/load/validation/config.ts:136' },
    { key: 'approval.tiers / approval.enabled', values: 'dowolne (wycofane)', default: 'brak', effect: 'Ignorowane; zapis na chronioną ścieżkę zawsze pyta.', where: 'src/core/config/load/validation/config.ts:151' },
    { key: 'approval.feed_rejections_to_planner', values: 'true | false', default: 'true', effect: 'Odrzucenia z evidence ledgera jako pierwsze linie promptu sesji.', where: 'src/engine/orchestrator/planning/call-loop.ts:14' },
    { key: 'codebase.enabled', values: 'true | false', default: 'true', effect: 'false wyłącza sekcję Repository Map w prompcie plannera.', where: 'src/engine/orchestrator/planning/session.ts:186' },
    { key: 'codebase.token_budget', values: 'int ≤ 50000', default: '4000', effect: 'Budżet tokenów repo-mapy w prompcie.', where: 'src/engine/orchestrator/planning/session.ts:191' },
    { key: 'codebase.include / codebase.exclude', values: 'globy', default: 'brak', effect: 'Zawężają repo-mapę.', where: 'src/engine/orchestrator/planning/session.ts:193' },
    { key: 'validation.render', values: 'polecenie renderu', default: 'brak', effect: 'Bez niego każdy check render daje nieblokujący błąd render-check-unconfigured i notatkę "Before you approve" na karcie.', where: 'src/engine/spec/plan-checks.ts:180' },
    { key: 'validation.stack', values: 'typescript | javascript | python | go | rust', default: 'detekcja', effect: 'Stack używany, gdy sanitizer sprawdza, czy odrzucone polecenie test z planu i tak wynika z configu/manifestu/stacku.', where: 'src/engine/orchestrator/planning/session.ts:625' },
    { key: 'validation.test_command', values: 'polecenie', default: 'brak', effect: 'Wyższy szczebel niż walidacja odkryta przez plannera; plannerowy test command wypełnia tylko lukę.', where: 'src/engine/orchestrator/planning/sanitize-discovered-validation.ts:541' },
    { key: 'hooks.pre_planning', values: 'hook', default: 'brak', effect: 'Biegnie raz na proces przed pierwszym wywołaniem plannera; odmowa = terminal cancelled.', where: 'src/engine/orchestrator/run/phases.ts:81' },
    { key: 'planner (seat)', values: 'cli | api | shell | agent', default: 'wymagany', effect: 'Rodzaj decyduje o kontekście (czyta pliki sam vs pakiet API), o wątku sesji (supportsSessionResume) i o transporcie schematu.', where: 'src/engine/orchestrator/planning/session.ts:210' },
    { key: 'implementer (domyślny profil)', values: 'seat', default: 'wymagany', effect: 'Jego model i zmierzony kontekst to sekcja Implementer promptu i granica context-overflow.', where: 'src/engine/orchestrator/planning/session.ts:119' },
    { key: '--approve / --mode (flagi CLI)', values: 'usunięte', default: '—', effect: 'Błąd: "--approve was removed: set workflow.approve (plan or none) in the config", "--mode was removed: every run plans in one session".', where: 'src/cli/unknown-command.ts:27' },
    { key: 'spec --allow-hooks / --allow-repo-runners / --project', values: 'flagi', default: 'false / false / cwd', effect: 'Zaufanie hookom bez pytania (CI), dopuszczenie runnerów z repo, katalog projektu.', where: 'src/cli/commands/spec.ts:106' },
  ],
  states: [
    { name: 'idle', meaning: 'Tylko przed START; nic nie wraca do idle.', where: 'src/core/state/machine.ts:323' },
    { name: 'planning', meaning: 'Sesja planowania trwa: pytania, plan, naprawa. Faza live i cancellable.', where: 'src/core/state/machine.ts:326' },
    { name: 'reviewing-plan', meaning: 'Karta planu otwarta (PLAN_DONE). Z state.plan: run wraca na kartę; bez niego: stara brama → sesja.', where: 'src/core/state/machine.ts:329' },
    { name: 'researching, specifying, reviewing-spec, clarifying, constitution-check, reviewing-briefs, analyzing', meaning: 'Fazy wycofane: żaden nowy run w nie nie wchodzi; stary run kontynuuje jedną sesją przez BEGIN_PLANNING.', where: 'src/core/state/machine.ts:79' },
    { name: 'pendingPlannerConversation', meaning: 'Pytania sesji (call plan, text = questionsText) i odpowiedzi rund; answered false = run czeka na odpowiedź (status waiting-for-you · question).', where: 'src/core/state/planning-conversation.ts:25' },
    { name: 'rewindPending { target: plan, comment }', meaning: 'Korekta z karty; stoi do PLAN_COMPILED. Wznowienie czyta ją jako lead sesji.', where: 'src/core/state/machine.ts:336' },
    { name: 'plannerSessionId', meaning: 'Natywny wątek plannera (claude --resume, codex resume); null po wygaśnięciu.', where: 'src/engine/orchestrator/planner-session.ts:108' },
    { name: 'PlanTurn: open | answers | repair', meaning: 'Co niesie następne wywołanie: otwarcie, odpowiedzi na rundę, naprawa z błędami i planem.', where: 'src/engine/orchestrator/planning/plan-session.ts:9' },
    { name: 'PlanSessionOutcome: plan | questions-exhausted | checks-failed | seat-protocol (+ unanswered)', meaning: 'Jedyne zakończenia czystej pętli sesji.', where: 'src/engine/orchestrator/planning/plan-session.ts:14' },
    { name: 'PlanningProducerResult: tasks-ready | terminal', meaning: 'Sesja daje tasks-ready; dopiero karta zamienia to w ready-for-tasks.', where: 'src/engine/orchestrator/planning/types.ts:43' },
    { name: 'PlanningTerminalOutcome: cancelled | closed | failed | interrupted | halted | input-required', meaning: 'Jak faza planowania się zatrzymała; żaden terminal nie wchodzi do builda.', where: 'src/engine/orchestrator/planning/types.ts:27' },
    { name: 'TaskContextFit: fits | tight | overflow', meaning: 'Dopasowanie zadania do kontekstu BUILD; tylko overflow blokuje plan.', where: 'src/core/schemas/enums.ts:177' },
  ],
  scenarios: [
    {
      title: 'Szczęśliwa ścieżka: jedna runda pytań, plan, karta, Approve',
      steps: [
        '1. splitbrief start "feature": runPlanningPhases, resumeStep → planner/plan, hook pre_planning pozwala, START → planning.',
        '2. Planner (claude-code, wątek) odpowiada { kind: questions } z 2 pytaniami. rounds 0 < 2 → pending; SET_PLANNER_CONVERSATION; wiersz "Questions before the plan · round 1 of 2"; byline "Waiting for your answer · Plan".',
        '3. Użytkownik naciska ⏎ w QuestionPrompt → każde pytanie bierze default; rounds = 1; recordAnswers; planAnswersTurn na wątku.',
        '4. Planner zwraca plan. checkFullPlan: 0 błędów → outcome plan.',
        '5. compilePlan: plan.json, plan.md, tasks.md, PLAN_COMPILED; discoveredValidation z plan.validation.',
        '6. approve = plan: PLAN_DONE → reviewing-plan; karta z plan.md i "Approving also confirms: write package.json".',
        '7. Approve: persistApprovalEvidence zapisuje write package.json; plan_approved; BEGIN_IMPLEMENTATION.',
      ],
      outcome: 'Build startuje; zapis package.json w buildzie nie pyta ponownie, bo ledger ma potwierdzenie z karty.',
    },
    {
      title: 'workflow.approve: none',
      steps: [
        '1. Sesja jak wyżej; plan przechodzi sprawdzenia.',
        '2. runPlanApproval: while (approve === plan) nie wchodzi; BEGIN_IMPLEMENTATION natychmiast.',
        '3. Check cmd "npm run lint" w planie byłby odmówiony już w checkPlan (refused-check-command), bo npmScriptsApproved = false; prompt mówi plannerowi, że ten run nie zatwierdza planu.',
      ],
      outcome: 'Bez karty; każdy chroniony zapis pyta dopiero, gdy implementer go zrobi.',
    },
    {
      title: 'Planner pyta trzeci raz',
      steps: [
        '1. Runda 1 i 2 odpowiedziane (rounds = 2). planAnswersTurn mówi: "No question round remains: return the plan…".',
        '2. Planner mimo to zwraca { kind: questions }.',
        '3. rounds >= 2 → outcome questions-exhausted.',
        '4. settle: halt plan-questions-exhausted, "Needs you · …", details = teksty pytań; akcje retry-same-worker, revise (rekomendowana), end-run.',
      ],
      outcome: 'Run otwarty, waiting-for-you na halcie. revise z tekstem kolejkuje korektę i ponawia tę samą sesję (rozmowa zachowana).',
    },
    {
      title: 'Plan dwa razy nie przechodzi sprawdzeń',
      steps: [
        '1. Plan ma T002 zależne od T005 w batch 2 (dependency-later-batch) i kryterium C3 bez checka.',
        '2. repaired = false → warning "The plan failed 2 checks. It goes back to the planner once to fix them:" + lista; turn = repair z planem i błędami.',
        '3. Planner zwraca plan z T002 naprawionym, ale C3 nadal bez checka.',
        '4. repaired = true, błąd blokujący → outcome checks-failed.',
        '5. Halt plan-checks-failed "The plan failed its checks again after one repair." z komunikatami.',
      ],
      outcome: 'Needs you. Naprawa JSON (requestTyped) liczona osobno: plan mógł zużyć też jedną naprawę transportową.',
    },
    {
      title: 'Check render bez validation.render',
      steps: [
        '1. Plan ma check render V-podobny "workflow-x"; config bez validation.render.',
        '2. render-check-unconfigured wraca do plannera jako jedyny błąd ("drop them or ask the user").',
        '3. Planner zostawia check. Po naprawie blocksPlan false dla każdego błędu → outcome plan (checksRepaired false).',
        '4. plan.md zaczyna się od "## Before you approve: Render checks … need validation.render, which is not set. Add it to .splitbrief/config.yaml, or request changes to drop them; without it the run halts before its review."',
      ],
      outcome: 'Karta otwiera się; decyzja należy do użytkownika. Bez polecenia run zatrzyma się przed review (→ review).',
    },
    {
      title: 'Request changes na karcie, potem stop i Continue',
      steps: [
        '1. Użytkownik wpisuje "split T001 into two tasks" na karcie → action revise.',
        '2. recordUserMessage; plan_regenerated; CORRECT_PLAN → rewindPending { target plan, comment }.',
        '3. runPlanningSession z lead = planRevisedTurn(plan.json, korekta); BEGIN_PLANNING → planning.',
        '4. Użytkownik naciska esc esc w trakcie wywołania: abort → handlePlanningFailure → parkStoppedRun; terminal interrupted. rewindPending nadal w stanie.',
        '5. Continue: runPlanningPhases widzi savedState.rewindPending → omija dispatch resumeStep; rewindLead buduje ten sam planRevisedTurn; sesja biegnie na wątku lub pełnym promptem.',
        '6. Plan kompiluje → PLAN_COMPILED czyści rewindPending; karta otwiera się z nowym planem.',
      ],
      outcome: 'Korekta nie ginie przez stop; po PLAN_COMPILED run wraca na kartę.',
    },
    {
      title: 'Edycja plan.json, która łamie schemat',
      steps: [
        '1. Edit plan.json (e, Ctrl+E) → edytor w aplikacji; użytkownik usuwa suggestedFiles z T003 i wymusza zapis zewnętrznym edytorem (Ctrl+O).',
        '2. applyPlanEdit: tekst różny od reviewed; parsePlanJson → błąd schematu "tasks.2.suggestedFiles: Too small…".',
        '3. writeSpecFile przywraca reviewed; warning "The edited plan was not applied: …".',
        '4. continue → karta znów z poprzednim planem.',
      ],
      outcome: 'Nieprawidłowa edycja nigdy nie trafia do stanu; plan.json wraca do poprzedniej treści.',
    },
    {
      title: 'Wątek plannera wygasł między rundami',
      steps: [
        '1. Run wznowiony po dniach; plannerSessionId zapisany; planner wspiera resume.',
        '2. askPlannerSession → issue() rzuca sessionResumeExpiredError.',
        '3. withFreshSessionReissue: resumed, expired → warning planner_session_expired; SET_PLANNER_SESSION_ID null; applyRebuiltContext z session.jsonl.',
        '4. issue(rebuilt): onSession false → planFullTurn z historią rund i priorMessages.',
        '5. Odpowiedź ok → nowy nativeSessionId zapisany.',
      ],
      outcome: 'Jedno ponowienie bez halta. Drugi błąd poszedłby do handlePlanningFailure jako halt.',
    },
    {
      title: 'Limit konta plannera w trakcie planowania',
      steps: [
        '1. Wywołanie kończy się błędem z tekstem limitu (rate-limited, resetAt za 3 h).',
        '2. Nie abort, run otwarty, nie local save, nie diagnostyka kontekstu → diagnosePlannerCallFailure.',
        '3. classification rate-limited → failure usage-limit, resetsAt ustawione, message z usageLimitAdvice.',
        '4. plannerCallHaltIssue → buildSeatDownIssue (runner-usage-limit); publishError z resetAt; raisePendingRecovery.',
      ],
      outcome: 'Seat down · usage limit. Co dalej (fallback raz na run i seat, retry-later, switch-seat) → zobacz recovery.',
    },
    {
      title: 'Headless run: pytania i karta bez człowieka',
      steps: [
        '1. splitbrief start --headless: onPlannerReply nie istnieje → waitForPlannerReply zwraca undefined → outcome unanswered → terminal input-required.',
        '2. headless.ts pisze rekord input_required z pytaniami i resumeCommand; proces kończy niezerowo; pendingPlannerConversation zostaje w state.json.',
        '3. Po odpowiedzi (continue z tekstem) steerAnswer odpowiada na rundę; plan przechodzi.',
        '4. Karta: onApprovalNeeded zwraca { approved: true, unattended: true } → bez potwierdzeń w ledgerze; plan_approved.',
      ],
      outcome: 'Build startuje, ale każdy chroniony zapis zostanie odmówiony jako APPROVAL_REQUIRED, bo nikt nie potwierdzi.',
    },
    {
      title: 'splitbrief spec bez TTY (CI)',
      steps: [
        '1. isTTY false → interaction headless.',
        '2. Planner pyta: konsola drukuje "The planner asks:" + pytania; odpowiedź pusta → defaults.',
        '3. Plan przechodzi checkFullPlan → writePlanJson, plan.md, tasks.md w .splitbrief/sessions/<id>/.',
        '4. Druk "Planning complete." z trzema ścieżkami i liczbą zadań; exit 0.',
      ],
      outcome: 'Pliki planu bez state.json i bez builda. Błąd sesji = cliError i exit ≠ 0.',
    },
    {
      title: 'Stary run zaparkowany w reviewing-spec',
      steps: [
        '1. state.json z fazą reviewing-spec, bez plan.json, z pendingPlannerConversation starego kroku (text ≠ questionsText).',
        '2. resumeStep → gate spec; reopensPlanCard false → resumeParkedApproval null → runPlanningPhase.',
        '3. isSessionConversation false → CLEAR_PLANNER_CONVERSATION; earlierPlanning zbiera research.md, spec.md, plan.md, tasks.md i rozmowę (odpowiedź = steer albo "(not answered)").',
        '4. BEGIN_PLANNING → planning; prompt z sekcją Earlier Planning; jedna sesja zwraca plan.',
      ],
      outcome: 'Stary run kończy planowanie w jednej sesji i otwiera kartę planu; spec rewind i plan rewind to ta sama ścieżka.',
    },
  ],
  files: [
    { path: 'src/engine/orchestrator/run/phases.ts', role: 'runPlanningPhases: dispatch po resumeStep, hook pre_planning, wejście do runPlanningPhase' },
    { path: 'src/engine/orchestrator/run/resume-parked-approval.ts', role: 'ponowne otwarcie karty planu bez wywołania plannera; steer jako korekta' },
    { path: 'src/engine/orchestrator/planning/run.ts', role: 'runPlanningPhase: approve do stanu, załączniki, rewindLead, sesja → karta' },
    { path: 'src/engine/orchestrator/planning/session.ts', role: 'runPlanningSession, planTurnText, settle, compilePlan, checkFullPlan, applyPlanEdit, runPlanApproval' },
    { path: 'src/engine/orchestrator/planning/plan-session.ts', role: 'runPlanSession: czysta pętla pytań, planu i jednej naprawy; replyFor z defaults' },
    { path: 'src/engine/orchestrator/planning/call-loop.ts', role: 'plannerRejectionContext (ledger) i waitForPlannerReply (abort)' },
    { path: 'src/engine/orchestrator/planning/failure.ts', role: 'handlePlanningFailure: abort → park, closed, local save, kontekst API, diagnoza → halt' },
    { path: 'src/engine/orchestrator/planning/heartbeat.ts', role: 'planner_heartbeat po 5 s, co 2 s' },
    { path: 'src/engine/orchestrator/planning/mutation-guard.ts', role: 'baseline i wykrycie zapisów plannera CLI (użyte w planners/cli.ts)' },
    { path: 'src/engine/orchestrator/planning/plan-context-fit.ts', role: 'estimatePlanContextFits: fit i blokada routingu per zadanie' },
    { path: 'src/engine/orchestrator/planning/queue-drain.ts', role: 'drainAndFormat: kolejka wiadomości seat-a plan' },
    { path: 'src/engine/orchestrator/planning/sanitize-discovered-validation.ts', role: 'commandTextRefusal, unsafeCommandReason, FILE_TESTS, sanitizeDiscoveredValidation' },
    { path: 'src/engine/orchestrator/planning/api-packet.ts', role: 'pakiet kontekstu plannera api mierzony w jego kontekście' },
    { path: 'src/engine/orchestrator/planning/types.ts', role: 'PlanningPhaseOptions, PlanningPhaseResult, PlanningProducerResult, PlanningTerminalOutcome' },
    { path: 'src/engine/orchestrator/planner-session.ts', role: 'askPlannerSession: wątek vs pełna tura, SET_PLANNER_SESSION_ID' },
    { path: 'src/engine/orchestrator/resume-context.ts', role: 'withFreshSessionReissue: jedno ponowienie po expired / input-too-large' },
    { path: 'src/engine/runners/typed-output.ts', role: 'requestTyped: transport schematu, 1 naprawa transportowa, SeatProtocolError' },
    { path: 'src/core/schemas/plan.ts', role: 'PlanAnswerSchema, PlanProposalSchema, TaskSpecSchema, PlanSchema, PLAN_ANSWER_JSON_SCHEMA' },
    { path: 'src/engine/spec/plan-checks.ts', role: 'checkPlan (27 kodów), checkTaskIdentities, refusedCheckErrors, blocksPlan, renderCheckNotes, planRepairWarning' },
    { path: 'src/engine/spec/prompts/plan-session.ts', role: 'MAX_QUESTION_ROUNDS, buildPlanSessionPrompt, planRules, planFullTurn, planAnswersTurn, planRepairTurn, planRevisedTurn' },
    { path: 'src/engine/spec/plan-markdown.ts', role: 'formatPlanMarkdown: Before you approve, Protected operations, Decisions, Criteria, Run checks, Tasks per batch' },
    { path: 'src/engine/spec/plan-tasks.ts', role: 'taskFromSpec: TaskSpec → Task (action modify/create, evidence, inputHashes)' },
    { path: 'src/core/sessions/plan-file.ts', role: 'writePlanJson, parsePlanJson' },
    { path: 'src/core/state/planning-conversation.ts', role: 'questionsText, isSessionConversation, sessionConversation' },
    { path: 'src/core/state/machine.ts', role: 'START, BEGIN_PLANNING, PLAN_DONE, PLAN_COMPILED, CORRECT_PLAN, BEGIN_IMPLEMENTATION, SET/CLEAR_PLANNER_CONVERSATION' },
    { path: 'src/core/sessions/run-status.ts', role: 'resumeStep, reopensPlanCard, parkedGate' },
    { path: 'src/core/config/runtime/resolve.ts', role: 'resolveApproveLevel' },
    { path: 'src/core/config/load/validation/config.ts', role: 'RETIRED_CONFIG_VALUES, retiredValueNotices' },
    { path: 'src/engine/orchestrator/approval/confirm.ts', role: 'planConfirmations, npmScriptConfirmations, confirmedEarlierInRun' },
    { path: 'src/core/approval/types.ts', role: 'ApprovalReviewResult: approved/unattended, edit, revise, end-run, brak decyzji' },
    { path: 'src/engine/orchestrator/recovery/builders/planner.ts', role: 'buildPlanSessionHaltRecoveryIssue, buildPlannerCallFailedRecoveryIssue' },
    { path: 'src/engine/orchestrator/recovery/planner-call-failure.ts', role: 'diagnosePlannerCallFailure, plannerCallHaltIssue, plannerHaltRow' },
    { path: 'src/features/workflow/prompt-rows/approval.ts', role: 'reviewDocumentOptions (4 wiersze karty), reviewConfirmsText' },
    { path: 'src/features/workflow/prompt-callbacks.ts', role: 'onApprovalNeeded i onPlannerReply w TUI' },
    { path: 'src/features/editor/plan-save.ts', role: 'planSaveErrors: sprawdzenie zapisu plan.json w edytorze' },
    { path: 'src/cli/commands/spec.ts', role: 'splitbrief spec: sesja bez builda i stanu' },
    { path: 'src/cli/headless.ts', role: 'unattended approve; rekord input_required' },
  ],
  gotchas: [
    'Docs TASK-CONTRACT.md piszą "checkPlan(plan, projectDir, taskFits)"; kod ma 5 argumentów: + renderCommand i npmScriptsApproved (plan-checks.ts:253). Kod wygrywa.',
    'Docs WORKFLOW.md §3 mówią "a second failure halts with plan-checks-failed"; kod przepuszcza plan po naprawie, gdy KAŻDY pozostały błąd to render-check-unconfigured (plan-session.ts:114). TASK-CONTRACT opisuje to poprawnie.',
    'Z workflow.approve: none check cmd "npm run <script>" jest odmawiany już przez checkPlan (refused-check-command), bo skrypt pakietu wymaga zatwierdzonego planu. Planner dostaje tę regułę w prompcie (packageScriptRule).',
    'Naprawa transportowa (zły JSON, requestTyped) i naprawa semantyczna (checkPlan) są liczone osobno: plan może zużyć jedną i drugą. Implementer nie ma naprawy transportowej wcale.',
    'Wiadomość w kolejce w momencie otwarcia karty staje się korektą i karta w ogóle się nie otwiera (session.ts:732).',
    'Strażnik mutacji plannera (planningMutationError) żyje tylko w plannerze cli (planners/cli.ts:209). Planner api nie ma dostępu do plików; planner shell/agent nie jest nim objęty.',
    'Edytor w aplikacji sprawdza zapis plan.json bez dopasowania kontekstu i zawsze z npmScriptsApproved = true (plan-save.ts:13); dopasowanie sprawdza dopiero engine po zapisie (applyPlanEdit).',
    'Headless zatwierdza kartę jako unattended: zero potwierdzeń w ledgerze, więc chroniony zapis w buildzie headless kończy się APPROVAL_REQUIRED.',
    'rewindPending.target nie jest czytane: rewind spec i rewind plan biegną tą samą sesją (run.ts:51). CORRECT_PLAN zostawia komentarz do PLAN_COMPILED, więc stop w trakcie replanu nie gubi korekty.',
    'state.approve tylko zapisuje poziom z configu; decyduje zawsze resolveApproveLevel(config) (run.ts:14, session.ts:717).',
    'Odrzucony test command z planu nie daje ostrzeżenia, gdy config/manifest/stack i tak dają identyczne polecenie (sanitize:545).',
    'isSessionConversation porównuje text z questionsText(questions): rozmowa starego kroku plan jest czyszczona i trafia do Earlier Planning, nigdy do pending.',
    'Abort użytkownika zawsze parkuje (interrupted), chyba że sygnał niesie powód End run — wtedy cancelled bez parku. Timeout runnera nie jest abortem.',
    'Po drugiej rundzie planAnswersTurn każe plannerowi wziąć defaults otwartych pytań; mimo to trzecia runda pytań jest możliwa i zatrzymuje run.',
    'Komunikaty checków idą do użytkownika bez kodów; kody (PlanCheckCode) widzi tylko planner w planRepairTurn.',
    'Pytanie planu wymaga niepustego default będącego jednym z choices (PlanQuestionSchema refine); inaczej odpowiedź to błąd schematu i naprawa transportowa.',
  ],
});
