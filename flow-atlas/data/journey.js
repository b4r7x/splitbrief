window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: 'journey',
  order: 0,
  title: 'Cała podróż: od start do zamknięcia runu',
  tagline: 'Jedna strona: co dzieje się od `splitbrief start "feature"` do zamkniętego runu, z każdym wyjściem bocznym.',
  summary: `SPLITBRIEF prowadzi jeden **run** przez cztery etapy: start, planowanie, build, review. Potem run jest **ready-to-apply** (worktree lub staged copy) albo od razu **closed** (checkout). Apply, Discard albo End run zamyka go.

Każdy run jest trwałym rekordem w katalogu '.splitbrief/sessions/<id>/'. Plik 'state.json' mówi, gdzie run stoi. Plik 'session.jsonl' mówi, co się wydarzyło. Status runu (running, open, ready-to-apply, closed) liczy jedna funkcja: 'deriveRunStatus'.

Trzy seaty wykonują pracę: **PLAN** (planner) planuje i konsultuje, **BUILD** (implementer) pisze pliki w workspace runu, **REVIEW** (reviewer, domyślnie ten sam runner co planner) wybiera reviewer checks i wydaje werdykt. Silnik nigdy nie pisze kodu sam.

Wyjścia boczne są trzy. **Stop** (esc, ctrl+c, Pause after this brief) parkuje krok; run jest 'open · stopped' i ⏎ go kontynuuje. **Halt** zapisuje 'pendingRecovery'; run jest 'open · waiting-for-you' i pokazuje panel 'Needs you · <cause>' lub 'Seat down · <cause>'. **Crash** nie zapisuje nic; run czyta się jako 'interrupted' i startuje od 'resumeStep'.

Limit konta albo wylogowanie seatu to halt 'Seat down'. Gdy seat deklaruje 'fallback', a run nie przełączał jeszcze tego seatu automatycznie, TUI (albo pętla headless) przełącza seat sam i wchodzi do silnika ponownie. Bez fallbacku run czeka na twój wybór w panelu.

Ta strona pokazuje całość. Szczegóły każdego etapu są w obszarach, do których prowadzą węzły '(→ obszar)'.`,
  entry: [
    'src/cli.ts:38',
    'src/cli/commands/start/register.ts:27',
    'src/cli/commands/start/interactive.ts:20',
    'src/engine/orchestrator/run/workflow.ts:98',
  ],
  links: [
    { to: 'startup', label: 'CLI, bootstrap, config, readiness i ekran Setup' },
    { to: 'runners', label: 'jak jeden call seatu działa, jak wykrywa się limit i jak czyta się fallback' },
    { to: 'planning', label: 'sesja planowania: pytania, typed plan, checkPlan, karta planu' },
    { to: 'build', label: 'pętla briefów: implementer, bramka, retry, konsultacja, ścieżki chronione' },
    { to: 'review', label: 'final review: plan call, reviewer checks, verdict, fix cycles, Accept as is' },
    { to: 'recovery', label: 'halty Needs you / Seat down, automatyczny switch na fallback, panel recovery' },
    { to: 'lifecycle', label: 'status runu, state.json, stop i continue, izolacja, Apply / Discard / End run' },
    { to: 'ui', label: 'ekran runu, composer, byline, rail, panel recovery, menu wyniku' },
    { to: 'subsystems', label: 'EventBus i sinki, snapshoty, repo-map, hooki, ledger dowodów' },
  ],
  diagrams: [
    {
      id: 'journey-master',
      title: 'Cały run na jednej mapie: start → plan → build → review → apply → closed',
      caption:
        'Czytaj z góry. Romby to decyzje najwyższego poziomu; każdy ma kartę o tym samym id. Węzły z "(→ obszar)" są rozwinięte w innym obszarze atlasu. Węzeł "Wyjścia boczne" prowadzi do diagramu journey-exits.',
      mermaid: `flowchart TD
  A["splitbrief start 'feature' (→ startup)"] --> JR_HEADLESS{"--json lub --plain?"}
  JR_HEADLESS -->|"tak"| HL["runHeadless: NDJSON lub tekst na stdout, karta planu zatwierdzana bez pytania (→ startup)"]
  JR_HEADLESS -->|"nie"| SETUP["setupWorkflow + initStoresForTuiMount: config, sesje, hook trust, discovery (→ startup)"]
  SETUP --> JR_NEEDS_SETUP{"Jest .splitbrief/config.yaml?"}
  JR_NEEDS_SETUP -->|"nie"| SU["Ekran Setup: wybór seatów (→ startup, ui)"]
  SU --> PREP
  JR_NEEDS_SETUP -->|"tak"| PREP["prepareExecution: readiness, admisja seatów, katalog sesji, .splitbrief/active (→ startup, runners)"]
  HL --> PREP
  PREP --> RW["runWorkflow: lockfile + heartbeat, izolacja, EventBus + sinki, seaty, workflow_started (→ lifecycle, subsystems)"]
  RW --> JR_RESUME_STEP{"Gdzie run zaczyna? resumeStep"}
  JR_RESUME_STEP -->|"nowy run: START → planning"| PL["Sesja planowania: typed JSON, repo map, pre_planning hook (→ planning)"]
  PL --> JR_PLAN_TURN{"Co odpowiedział planner?"}
  JR_PLAN_TURN -->|"pytania, runda 1 lub 2"| Q["Pytania (max 3, każde z domyślną odpowiedzią); ⏎ bierze domyślne"]
  Q --> PL
  JR_PLAN_TURN -->|"pytania, runda 3"| HALT1["Halt plan-questions-exhausted · Needs you (→ recovery)"]
  JR_PLAN_TURN -->|"plan"| JR_PLAN_CHECKS{"checkPlan + context fit OK?"}
  JR_PLAN_CHECKS -->|"nie, pierwszy raz"| PL
  JR_PLAN_CHECKS -->|"nie, drugi raz"| HALT2["Halt plan-checks-failed · Needs you (→ recovery)"]
  JR_PLAN_CHECKS -->|"tak"| COMP["PLAN_COMPILED: plan.json, plan.md, tasks.md"]
  COMP --> JR_APPROVE{"workflow.approve?"}
  JR_APPROVE -->|"plan (domyślnie): PLAN_DONE → reviewing-plan"| JR_CARD{"Karta planu: co wybierasz?"}
  JR_CARD -->|"Request changes: CORRECT_PLAN"| PL
  JR_CARD -->|"Edit plan.json: re-walidacja"| JR_CARD
  JR_CARD -->|"End run: CLOSE_RUN"| CLOSED
  JR_CARD -->|"Approve: plan_approved"| BI
  JR_APPROVE -->|"none"| BI["BEGIN_IMPLEMENTATION → implementing"]
  BI --> JR_WORKSPACE{"workflow.isolation?"}
  JR_WORKSPACE -->|"worktree (domyślnie)"| WS["Workspace runu + snapshot workspace-base, RECORD_WORKSPACE (→ lifecycle)"]
  JR_WORKSPACE -->|"staged-copy, lub worktree niedostępny"| WS
  JR_WORKSPACE -->|"none: checkout"| WS
  WS --> BUILD["Pętla briefów: brief → implementer → bramka → retry → konsultacja (→ build)"]
  BUILD --> JR_TASKS_DONE{"Jak skończyła się pętla?"}
  JR_TASKS_DONE -->|"stopped: stop lub halt"| EXIT["Wyjścia boczne → diagram journey-exits"]
  JR_TASKS_DONE -->|"paused: Pause after this brief"| PARK["Park na granicy briefu; ⏎ wraca"]
  PARK --> BUILD
  JR_TASKS_DONE -->|"complete: ALL_DONE → final-review"| REV["Final review: plan checks, plan call, reviewer checks V1…, verdict (→ review)"]
  REV --> JR_REVIEW_VERDICT{"Reviewer dał werdykt?"}
  JR_REVIEW_VERDICT -->|"nie: Seat down lub review-failed"| EXIT
  JR_REVIEW_VERDICT -->|"tak"| JR_REVIEW_PASS{"reviewPassed?"}
  JR_REVIEW_PASS -->|"nie"| JR_FIX_CAP{"Są fix tasks i cykl < allowance?"}
  JR_FIX_CAP -->|"tak: START_FIX_CYCLE → implementing"| BUILD
  JR_FIX_CAP -->|"nie"| HALT3["Halt review-failed · Needs you: revise / Accept as is / End run (→ recovery)"]
  JR_REVIEW_PASS -->|"tak: REVIEW_DONE passed → complete, workflow_complete"| JR_READY_OR_CLOSE{"Rodzaj workspace?"}
  JR_READY_OR_CLOSE -->|"checkout, lub stary run bez workspace"| CLOSED["Run zamknięty: closed (complete / applied / discarded / ended)"]
  JR_READY_OR_CLOSE -->|"worktree lub staged-copy"| READY["ready-to-apply: Apply · Show diff · Discard (→ ui, lifecycle)"]
  READY --> JR_RESULT_MENU{"Co wybierasz?"}
  JR_RESULT_MENU -->|"Discard lub End run: run.patch, CLOSE_RUN discarded"| CLOSED
  JR_RESULT_MENU -->|"Apply: /run accept"| APPLY["runApply: merge base/ours/theirs, backup, zapis do checkoutu (→ lifecycle)"]
  APPLY --> JR_APPLY_OUTCOME{"Wynik Apply?"}
  JR_APPLY_OUTCOME -->|"applied: APPLY_DONE"| CLOSED
  JR_APPLY_OUTCOME -->|"review: merge zmienił kandydata, APPLY_REVIEW_START"| REV
  JR_APPLY_OUTCOME -->|"halted: apply-conflict / apply-partial"| EXIT`,
    },
    {
      id: 'journey-exits',
      title: 'Wyjścia boczne i powroty: stop, halt, fallback, crash, End run',
      caption:
        'Każda droga w dół kończy się na ekranie runu at rest albo na zamknięciu. Z at rest wraca się jedną drogą: continueRun → runWorkflow → resumeStep. Halt wraca przez panel recovery lub automatyczny switch na fallback.',
      mermaid: `flowchart TD
  RUN["Run żyje: lockfile + heartbeat, status running"] --> JR_EXIT_KIND{"Co przerywa run?"}
  JR_EXIT_KIND -->|"esc, ctrl+c, stop sheet"| JR_STOP_KIND{"Który wiersz stop sheet?"}
  JR_STOP_KIND -->|"Stop now (lub ctrl+c)"| INT["INTERRUPT_STEP cut: mid-step; partial zostaje w session.jsonl i w workspace"]
  JR_STOP_KIND -->|"Pause after this brief"| BND["INTERRUPT_STEP cut: boundary po bieżącym briefie"]
  JR_STOP_KIND -->|"End run"| ENDRUN["closeRunIfOpen: run.patch, CLOSE_RUN ended, workspace usunięty (→ lifecycle)"]
  INT --> OPENP["open · stopped · paused"]
  BND --> OPENP
  JR_EXIT_KIND -->|"seat nie może działać, lub decyzja tylko twoja"| HALT["SET_PENDING_RECOVERY: faza bez zmian, krok zapamiętany"]
  HALT --> JR_HALT_KIND{"haltOf(reason)?"}
  JR_HALT_KIND -->|"needs-you"| NY["Needs you · cause: continue / revise / accept-as-is / restore-backup / skip / end-run (→ recovery)"]
  JR_HALT_KIND -->|"seat-down"| SD["Seat down · cause: switch-seat / retry-later / retry-same-worker / skip / end-run (→ recovery)"]
  SD --> JR_AUTO_SWITCH{"switchSeat.auto? fallback zadeklarowany, konto lub długi reset, pierwszy raz dla seatu"}
  JR_AUTO_SWITCH -->|"tak"| AUTO["applyOfferedSeatSwap: prepare → zapis seatu do config.yaml → RECORD_SEAT_SWITCH, seat_switched"]
  AUTO --> REENTER
  JR_AUTO_SWITCH -->|"nie"| PANEL["Panel recovery nad composerem (→ ui)"]
  NY --> PANEL
  PANEL --> JR_RECOVERY_ACTION{"Jaką akcję bierzesz?"}
  JR_RECOVERY_ACTION -->|"end-run"| ENDRUN
  JR_RECOVERY_ACTION -->|"switch-seat: picker seatu"| AUTO
  JR_RECOVERY_ACTION -->|"retry / continue / revise / skip / retry-later / accept-as-is / restore-backup"| REENTER["Ponowne wejście: runWorkflow na zapisanym stanie, RESUME_STEP"]
  JR_EXIT_KIND -->|"SIGINT / SIGTERM / SIGHUP"| SIG["shutdownWorkflow: kill procesów, zapis state.json"]
  SIG --> OPENP
  JR_EXIT_KIND -->|"turn umarł na błędzie"| FAIL["lastFailure zapisany → open · stopped · failed"]
  FAIL --> ATREST
  JR_EXIT_KIND -->|"crash, kill -9, prąd"| CRASH["Nic nie zapisane → open · stopped · interrupted; brief in_progress startuje od snapshotu"]
  CRASH --> ATREST
  OPENP --> ATREST["Ekran runu at rest: hydrateRun z session.jsonl; ⏎ lub tekst kontynuuje (→ lifecycle, ui)"]
  ATREST --> JR_CONTINUE_GUARD{"continueRun: jaki status runu?"}
  JR_CONTINUE_GUARD -->|"closed"| REFUSE["Odmowa z powodem zamknięcia"]
  JR_CONTINUE_GUARD -->|"ready-to-apply"| REFUSE2["Odmowa: weź Apply lub Discard"]
  JR_CONTINUE_GUARD -->|"open"| REENTER
  REENTER --> RES["resumeStep: pytanie plannera / apply / karta planu / brief / review / sesja planowania"]
  RES --> RUN
  ENDRUN --> CLOSED["closed"]`,
    },
    {
      id: 'journey-actors',
      title: 'Kto z kim rozmawia: użytkownik, TUI, silnik, EventBus, stores, seaty, workspace, dysk',
      caption:
        'Silnik nie importuje React. TUI daje mu callbacki (pytania, karta planu, zgody) i sink zdarzeń. Zdarzenia idą jednym EventBusem do stores, do session.jsonl, do loggera, do hooków i (headless) na stdout. Seaty rozmawiają z narzędziami; BUILD pisze w workspace runu; Apply raz zapisuje wynik do checkoutu.',
      mermaid: `flowchart LR
  U["Użytkownik: klawiatura, mysz"] --> TUI["TUI: app shell, ekrany, overlaye, composer (→ ui)"]
  TUI -->|"useRunLoop: runWorkflow(prepared, callbacks, tuiSink)"| ENG["Silnik: orchestrator (→ lifecycle, planning, build, review)"]
  ENG -->|"await callbacks: onPlannerReply, onApprovalNeeded, onTieredApproval, onReviewChecksApproval, onComplete"| TUI
  ENG -->|"bus.publish(event)"| BUS["EventBus: synchroniczny fan-out (→ subsystems)"]
  BUS -->|"tuiSink → addTuiEvent → addEvent"| ST["Stores: events, tasks, tokens, lifecycle, operations (→ ui)"]
  ST -->|"store.use(selector)"| TUI
  BUS -->|"jsonl sink"| LOG["session.jsonl"]
  BUS -->|"logger sink"| LOGGER["logger procesu"]
  BUS -->|"hook sink"| HOOKS["Hooki użytkownika z config.yaml (→ subsystems)"]
  BUS -->|"stdout sink, tylko headless"| STDOUT["stdout: NDJSON lub tekst"]
  ENG -->|"requestTyped: plan, pytania, konsultacja plan-taska"| PLAN["Seat PLAN: planner (→ runners)"]
  ENG -->|"implement(brief) w workspace"| BUILD["Seat BUILD: implementer, profile (→ runners)"]
  ENG -->|"requestTyped: plan call, verdict, konsultacja fix-taska"| REVIEW["Seat REVIEW: reviewer, lub planner gdy brak bloku reviewer (→ runners)"]
  PLAN --> TOOLS["Narzędzia: claude-code, codex, opencode, copilot, kilo-code, cursor, command-code, antigravity, API, shell, agent"]
  BUILD --> TOOLS
  REVIEW --> TOOLS
  BUILD -->|"pisze pliki (cli, agent) lub zwraca kod, który zapisuje silnik (api, shell)"| WS["Workspace runu: worktree pod XDG_STATE_HOME/splitbrief/trees/<repo-key>/<session-id>, staged copy, lub checkout"]
  ENG -->|"checks, review diff, Apply merge"| WS
  ENG -->|"transitionAndSave (CAS po stateRevision)"| STATE["state.json: faza, taski, pendingRecovery, interruptedStep, workspace, closed, seatSwitches"]
  ENG --> FILES[".splitbrief/sessions/<id>/: plan.json, plan.md, tasks.md, review.json, review.md, evidence.json, review-packet.json, summary.json, lockfile.json, seats.json, readiness.json, run.patch, snapshots/, entries/, apply/, renders/, reverted/"]
  TUI -->|"draft.json: niewysłany tekst composera"| FILES
  ENG -->|"Apply: jeden zapis strzeżony hashem"| CO["Checkout użytkownika"]
  CO -->|"workspace-base i theirs do merge"| WS
  PLAN -->|"cwd = checkout, tylko czyta"| CO
  CFG[".splitbrief/config.yaml (version: 3) + .splitbrief/active"] --> ENG
  CFG --> TUI`,
    },
    {
      id: 'journey-sequence',
      title: 'Jeden udany run krok po kroku: realne akcje stanu i zdarzenia',
      caption:
        'Strzałki pełne to wywołania; przerywane to zdarzenia na EventBusie. Nazwy akcji (START, PLAN_DONE, …) to akcje reducera w src/core/state/machine.ts. Nazwy zdarzeń (workflow_started, task_completed, …) to typy EngineEvent.',
      mermaid: `sequenceDiagram
  participant U as Użytkownik
  participant T as TUI
  participant E as Silnik
  participant P as Seat PLAN
  participant B as Seat BUILD
  participant R as Seat REVIEW
  participant D as Dysk .splitbrief
  U->>T: splitbrief start "feature"
  T->>E: runWorkflow(prepared, callbacks, tuiSink)
  E->>D: lockfile.json, state.json: START → planning
  E-->>T: workflow_started
  E->>P: requestTyped(plan prompt + repo map)
  P-->>E: kind: questions (max 3)
  E->>D: pendingPlannerConversation w state.json
  E->>T: await onPlannerReply
  T->>U: QuestionPrompt: runda 1 z 2
  U->>T: odpowiedzi (⏎ = domyślne)
  E->>P: odpowiedzi na tej samej sesji natywnej
  P-->>E: kind: plan
  E->>E: checkPlan + estimatePlanContextFits
  E->>D: plan.json, plan.md, tasks.md, PLAN_COMPILED, PLAN_DONE → reviewing-plan
  E-->>T: artifact_written, tasks_planned
  E->>T: await onApprovalNeeded('plan', plan.md, chronione operacje)
  T->>U: karta planu
  U->>T: Approve
  E-->>T: plan_approved
  E->>D: BEGIN_IMPLEMENTATION → implementing, snapshot workspace-base, RECORD_WORKSPACE
  loop każdy brief T001, T002, …
    E->>D: START_TASK
    E-->>T: task_started
    E->>B: implement(brief) w workspace runu
    B-->>E: zmienione pliki
    E->>E: gateAttemptChanges (ścieżki chronione), TASK_SENT → validating-task, runBriefGate
    E->>D: VALIDATION_PASS → implementing
    E-->>T: task_completed
  end
  E->>D: ALL_DONE → final-review
  E-->>T: review_started
  E->>E: runPreReviewChecks: plan i task checks
  E->>R: plan call: wybór reviewer checks V1…
  E->>E: runReviewChecks w workspace, czerwony check powtórzony na run base
  E-->>T: review_checks, full_suite
  E->>R: verdict call: diff, briefy, wyniki checków
  R-->>E: ReviewAnswer: pass, zero fix tasks
  E->>D: REVIEW_DONE passed → complete, review.json, review.md
  E-->>T: review_completed, workflow_complete
  E->>D: summary.json, review-packet.json
  T->>U: ready-to-apply: Apply · Show diff · Discard
  U->>T: Apply (/run accept)
  T->>E: runWorkflow ponownie: resumeStep = apply
  E->>E: runApply: merge base / ours / theirs, backup w apply/<id>/
  E->>D: APPLY_START, zapis do checkoutu, APPLY_DONE → closed applied
  E-->>T: workspace_closed
  T->>U: blok Closed ─ na końcu transkryptu`,
    },
    {
      id: 'journey-status',
      title: 'Status runu: running, open, ready-to-apply, closed',
      caption:
        'To nie faza. deriveRunStatus liczy status z state.json i z tego, czy jakiś proces trzyma lockfile. Użytkownik widzi pięć stanów: running, waiting for you, stopped, ready to apply, closed.',
      mermaid: `stateDiagram-v2
  [*] --> running : proces trzyma lockfile.json
  running --> open : stop, halt, błąd, crash
  running --> ready_to_apply : REVIEW_DONE passed, workspace worktree lub staged copy
  running --> closed : REVIEW_DONE passed na checkout, APPLY_DONE, End run
  open --> running : continueRun, akcja recovery, automatyczny switch
  open --> closed : End run (CLOSE_RUN ended)
  ready_to_apply --> running : Apply
  ready_to_apply --> closed : Discard lub End run (discarded)
  closed --> [*]
  state open {
    [*] --> waiting_for_you
    [*] --> stopped
    waiting_for_you : halt (pendingRecovery) · question · gate (karta planu)
    stopped : paused (mid-step lub boundary) · seat-wait · failed · interrupted
  }`,
    },
    {
      id: 'journey-seat-failure',
      title: 'Limit lub błąd seatu, gdziekolwiek w runie: co robi silnik',
      caption:
        'Jedna klasyfikacja dla każdego seatu. Tylko wywołania BUILD i konsultacje mają retry transientów i czekanie na reset do 10 minut. Wywołania planowania i oba wywołania review (plan call, verdict) halthują od razu. Switch na fallback stosuje host (TUI lub pętla headless), nie silnik.',
      mermaid: `flowchart TD
  CALL["Wywołanie seatu kończy się błędem"] --> JR_SEAT_CLASS{"classifySeatFailure: jaka klasa?"}
  JR_SEAT_CLASS -->|"transient: sieć, 5xx, 408, gołe 429"| JR_SEAT_RUNG{"Który seat i który krok?"}
  JR_SEAT_CLASS -->|"rate-limited z datą resetu"| JR_RESET_WAIT{"reset ≤ 10 min i krok ma runSeatCall?"}
  JR_SEAT_CLASS -->|"account: balance / billing / quota / auth"| SD["Seat down: runner-usage-limit lub runner-unauthenticated; brief dostaje INTERRUPT_STEP source: seat"]
  JR_SEAT_CLASS -->|"other, authoritative"| OTHER["Halt własny kroku: planner-call-failed (Seat down), retry-exhausted, seat-protocol-error, … (→ recovery)"]
  JR_SEAT_RUNG -->|"BUILD attempt, BUILD retry, konsultacja"| RETRY["withSeatRetry: do 3 powtórzeń, backoff 2s 4s 8s"]
  RETRY --> JR_RESET_WAIT
  JR_SEAT_RUNG -->|"plan call sesji planowania, review plan call, verdict"| OTHER
  JR_RESET_WAIT -->|"tak"| WAIT["SET_SEAT_WAIT, seat_wait_started; po resecie to samo wywołanie jeszcze raz"]
  WAIT --> CALL
  JR_RESET_WAIT -->|"nie: reset dalej niż 10 min, brak daty, lub krok bez runSeatCall"| SD
  SD --> JR_AUTO_SWITCH{"switchSeat.auto?"}
  JR_AUTO_SWITCH -->|"tak"| AUTO["Automatyczny switch na fallback; seatSwitches dostaje wpis auto: true; stary seat CLI staje się fallbackiem"]
  JR_AUTO_SWITCH -->|"nie"| PANEL["Seat down · cause: panel z switch-seat (picker), retry-later (gdy reset znany), retry-same-worker, skip, end-run"]`,
    },
  ],
  decisions: [
    {
      id: 'JR_HEADLESS',
      title: 'Tryb startu: interaktywny czy headless',
      question: 'Czy komenda start ma --json albo --plain?',
      where: 'src/cli/commands/start/register.ts:33',
      inputs: ['opts.json', 'opts.plain', 'argument feature'],
      branches: [
        { if: '--json', then: 'runHeadlessStart: zdarzenia jako NDJSON na stdout; karta planu zatwierdzona bez pytania (unattended), zgody na ścieżki chronione odmówione APPROVAL_REQUIRED', next: 'JR_RESUME_STEP' },
        { if: '--plain', then: 'ten sam run headless, tekstowe linie phase:, task <id>:, review:, done:', next: 'JR_RESUME_STEP' },
        { if: 'oba naraz', then: 'exit 2 (assertOutputModeExclusive w hooku preAction)' },
        { if: 'headless bez feature', then: 'błąd "--<mode> requires a feature argument"' },
      ],
      default: 'runInteractiveStart: TUI (Ink), Setup lub home, potem ekran workflow.',
      notes: 'Pełny opis argumentów, @plików i kodów wyjścia: → startup.',
    },
    {
      id: 'JR_NEEDS_SETUP',
      title: 'Pierwszy start: ekran Setup czy od razu run',
      question: 'Czy projekt ma .splitbrief/config.yaml (albo nadpisania z CLI)?',
      where: 'src/cli/commands/start/interactive.ts:41',
      inputs: ['setupWorkflow(...).needsSetup', 'argument feature'],
      branches: [
        { if: 'needsSetup', then: 'routerStore.init({ screen: setup, onComplete: workflow gdy jest feature, inaczej home })', next: 'JR_RESUME_STEP' },
        { if: 'config jest i jest feature', then: 'home montuje się od razu; preparationStore.submit → prepareExecution; gdy prepared, navigate({ to: workflow, execution: local })', next: 'JR_RESUME_STEP' },
      ],
      default: 'Config jest, feature brak: ekran home; run startuje z composera home.',
      notes: 'prepareExecution (src/engine/runners/prepare-execution/prepare-execution.ts:250) może zwrócić kind: blocked z raportem readiness; wtedy run nie startuje. → startup, runners.',
    },
    {
      id: 'JR_RESUME_STEP',
      title: 'Gdzie run zaczyna lub podejmuje pracę',
      question: 'Co mówi resumeStep(state) o zapisanym stanie?',
      where: 'src/engine/orchestrator/run/phases.ts:48',
      inputs: ['state.pendingPlannerConversation', 'awaitsApply(state)', 'faza i state.plan (parkedGate)', 'state.tasks[currentTaskIndex]', 'savedState.rewindPending'],
      branches: [
        { if: 'stan ma interruptedStep, awaitingContinue lub lastFailure', then: 'najpierw RESUME_STEP (phases.ts:38); park i błąd są wyczyszczone' },
        { if: 'kind: apply (workspace z passed review lub acceptedAsIs, bez applied i closed)', then: 'runApply (phases.ts:51)', next: 'JR_APPLY_OUTCOME' },
        { if: 'kind: brief lub review', then: 'planowanie jest za runem: od razu runTasksAndReview (phases.ts:68)', next: 'JR_TASKS_DONE' },
        { if: 'kind: gate (reviewing-plan ze state.plan)', then: 'resumeParkedApproval otwiera kartę bez nowego wywołania plannera (phases.ts:71)', next: 'JR_CARD' },
        { if: 'rewindPending (Request changes zapisane, plan jeszcze nie skompilowany)', then: 'sesja planowania z korektą (planRevisedTurn)', next: 'JR_PLAN_TURN' },
      ],
      default: 'Nowy run (phase idle) i każda faza planowania, także wycofane fazy starych runów: runPlanningPhase (phases.ts:104). Pierwszy raz w procesie uruchamia hook pre_planning tuż przed pierwszym wywołaniem plannera.',
      notes: 'resumeStep: src/core/sessions/run-status.ts:95. Pierwsze dopasowanie wygrywa: pytanie plannera, apply, gate, brief, review, plan.',
    },
    {
      id: 'JR_PLAN_TURN',
      title: 'Tura planowania: pytania czy plan',
      question: 'Czy planner odpowiedział kind: questions, czy kind: plan?',
      where: 'src/engine/orchestrator/planning/plan-session.ts:104',
      inputs: ['PlanResultSchema.kind', 'licznik rund rounds', 'MAX_QUESTION_ROUNDS = 2 (src/engine/spec/prompts/plan-session.ts:11)'],
      branches: [
        { if: 'questions i rounds < 2', then: 'pytania idą do użytkownika (QuestionPrompt w TUI; headless: input_required i exit ≠ 0); odpowiedzi wracają na tej samej sesji natywnej', next: 'JR_PLAN_TURN' },
        { if: 'questions i rounds ≥ 2', then: 'questions-exhausted → halt plan-questions-exhausted · Needs you (session.ts:565)', next: 'JR_HALT_KIND' },
        { if: 'plan', then: 'checkFullPlan: checkPlan + context fit', next: 'JR_PLAN_CHECKS' },
      ],
      default: 'Każde pytanie ma odpowiedź domyślną; puste ⏎ je bierze. Max 3 pytania na rundę. → planning.',
    },
    {
      id: 'JR_PLAN_CHECKS',
      title: 'Plan przechodzi checkPlan i context fit?',
      question: 'Czy lista błędów planu jest pusta, i czy to pierwsza czy druga porażka?',
      where: 'src/engine/orchestrator/planning/plan-session.ts:112',
      inputs: ['checkPlan (src/engine/spec/plan-checks.ts)', 'estimatePlanContextFits', 'flaga repaired'],
      branches: [
        { if: 'brak błędów', then: 'compilePlan: taskFromSpec, plan.json, plan.md, tasks.md, PLAN_COMPILED (session.ts:636)', next: 'JR_APPROVE' },
        { if: 'błędy, repaired = false', then: 'tura repair: plan wraca do plannera z błędami, repaired = true', next: 'JR_PLAN_TURN' },
        { if: 'błędy, repaired = true', then: 'checks-failed → halt plan-checks-failed · Needs you', next: 'JR_HALT_KIND' },
      ],
      default: 'Jedna naprawa semantyczna. Naprawa transportu wewnątrz requestTyped liczy się osobno.',
    },
    {
      id: 'JR_APPROVE',
      title: 'Karta planu czy od razu build',
      question: 'Jaki jest workflow.approve?',
      where: 'src/engine/orchestrator/planning/session.ts:711',
      inputs: ['resolveApproveLevel(config) (src/core/config/runtime/resolve.ts:6)'],
      branches: [
        { if: 'plan (domyślnie)', then: 'tasks_planned, PLAN_DONE → reviewing-plan, callbacks.onApprovalNeeded', next: 'JR_CARD' },
        { if: 'none', then: 'od razu BEGIN_IMPLEMENTATION → implementing (session.ts:790)', next: 'JR_WORKSPACE' },
      ],
      default: 'Wycofane wartości all, spec, default ładują się jako plan z jedną notą. Nie ma flagi --approve.',
    },
    {
      id: 'JR_CARD',
      title: 'Karta planu: Approve, Request changes, Edit, End run',
      question: 'Co zwrócił callbacks.onApprovalNeeded?',
      where: 'src/engine/orchestrator/planning/session.ts:729',
      inputs: ['result.approved', 'result.action', 'wiadomości w kolejce (drainAndFormat, session.ts:725)', 'result.unattended'],
      branches: [
        { if: 'approved', then: 'chronione operacje z planu zapisane jako potwierdzone w ledgerze (nie przy unattended), plan_approved, wyjście z pętli → BEGIN_IMPLEMENTATION', next: 'JR_WORKSPACE' },
        { if: 'action: end-run', then: 'closeRunIfOpen, plan_rejected, disposition terminal outcome closed; pliki zostają na dysku' },
        { if: 'action: edit', then: 'applyPlanEdit: plan.json czytany ponownie, walidowany (JSON, PlanProposalSchema, checkPlan, context fit); zły edit nie jest stosowany, jedno ostrzeżenie "The edited plan was not applied: "; karta znowu', next: 'JR_CARD' },
        { if: 'action: revise z tekstem, lub wiadomość w kolejce', then: 'plan_regenerated, CORRECT_PLAN (rewindPending), runPlanningSession z planRevisedTurn; karta znowu', next: 'JR_PLAN_TURN' },
      ],
      default: 'Run headless zatwierdza kartę bez pytania ({ approved: true, unattended: true }) i nie zapisuje żadnego potwierdzenia.',
    },
    {
      id: 'JR_WORKSPACE',
      title: 'Gdzie pracuje implementer: worktree, staged copy, checkout',
      question: 'Jaka strategia izolacji i czy git worktree się udał?',
      where: 'src/engine/orchestrator/isolation/create.ts:269',
      inputs: ['getIsolationStrategy(config) (src/core/config/accessors/values.ts:9, domyślnie worktree)', 'state.workspace.kind zapisane wcześniej', 'wynik ensureIsolationWorktree'],
      branches: [
        { if: 'none, lub zapisane checkout', then: 'kind: checkout; brak osobnego katalogu; nie ma Apply; revert zapisuje bajty w reverted/<stamp>/', next: 'JR_TASKS_DONE' },
        { if: 'worktree i git worktree się udał', then: 'katalog pod XDG_STATE_HOME/splitbrief/trees/<sha256(git-common-dir)[0:12]>/<session-id> (src/core/paths.ts:157)', next: 'JR_TASKS_DONE' },
        { if: 'worktree niedostępny', then: 'reportFallback (create.ts:120): ostrzeżenie "Isolation worktree unavailable; falling back to a staged copy: <reason>" (workflow.ts:227), latchedStrategy = staged-copy', next: 'JR_TASKS_DONE' },
        { if: 'staged-copy', then: 'createStagedProject: kopia projektu stage-<hex> (create.ts:313)', next: 'JR_TASKS_DONE' },
      ],
      default: 'Przed otwarciem workspace: snapshot workspace-base (task-execution.ts:312); potem RECORD_WORKSPACE (task-execution.ts:333) zapisuje kind, path i base raz. Późniejsza zmiana configu nie przenosi runu.',
    },
    {
      id: 'JR_TASKS_DONE',
      title: 'Jak skończyła się pętla briefów',
      question: 'Jaki status zwrócił runTaskLoop, i czy faza pozwala na final review?',
      where: 'src/engine/orchestrator/run/task-execution.ts:390',
      inputs: ['taskResult.status: complete | paused | stopped (loop.ts:287, 291)', 'state.phase', 'wctx.signal.aborted'],
      branches: [
        { if: 'paused (Pause after this brief)', then: 'parkAtBoundary (task-execution.ts:62): INTERRUPT_STEP cut boundary; po ⏎ pętla rusza dalej (task-execution.ts:367)', next: 'JR_TASKS_DONE' },
        { if: 'stopped (stop użytkownika, halt, odmowa routingu, seat niedostępny)', then: 'summary budowane, completed: false; run zostaje open', next: 'JR_EXIT_KIND' },
        { if: 'complete i faza implementing lub final-review', then: 'snapshot runu, potem pętla review (task-execution.ts:449)', next: 'JR_REVIEW_VERDICT' },
      ],
      default: 'Każdy brief: dependency gate (loop.ts:136), routing profilu (loop.ts:157), isAvailable implementera, runSingleTask (loop.ts:224). Brief już done lub skipped jest pomijany. → build.',
    },
    {
      id: 'JR_REVIEW_VERDICT',
      title: 'Review bez werdyktu: jaki halt',
      question: 'Czy wywołanie reviewera dało werdykt; jeśli nie, dlaczego?',
      where: 'src/engine/orchestrator/run/review.ts:149',
      inputs: ['FinalReviewResult.failure.kind', 'resolveReviewerRunner(config).source', 'state.seatSwitches'],
      branches: [
        { if: 'input-too-large', then: 'halt review-input-too-large · Needs you; Skip review przy final review lub task review (review.ts:162)', next: 'JR_HALT_KIND' },
        { if: 'seat-protocol-error (odpowiedź nie parsuje po naprawie)', then: 'halt seat-protocol-error · Seat down (review.ts:173)', next: 'JR_HALT_KIND' },
        { if: 'seat-blocked (limit, wylogowanie, inny błąd wywołania)', then: 'plannerCallHaltIssue na seacie review: runner-usage-limit / runner-unauthenticated / planner-call-failed · Seat down; retry i switch-seat uruchamiają review ponownie (review.ts:175)', next: 'JR_AUTO_SWITCH' },
        { if: 'call-failed bez diagnozy seatu', then: 'halt review-failed · Needs you (review.ts:193)', next: 'JR_HALT_KIND' },
      ],
      default: 'Jest werdykt: reviewPassed decyduje dalej. Nieudany plan call (wybór reviewer checks) halthuje tak samo jak nieudany verdict; nigdy nie jest passem (final-review.ts:494).',
      notes: 'Reviewer nie oddaje review plannerowi "za plecami": z blokiem reviewer przełącza się ten blok; bez bloku REVIEW dziedziczy narzędzie i fallback PLAN, a switch zapisuje nowy blok reviewer.',
    },
    {
      id: 'JR_REVIEW_PASS',
      title: 'Czy review przeszło',
      question: 'reviewPassed: werdykt nie jest fail, zero fix tasks, zero verify, brak pytania, zero blokujących czerwonych wejść, zero porażek recheck?',
      where: 'src/engine/orchestrator/run/review.ts:210',
      inputs: ['review.verdict.outcome.kind (pass | pass-with-notes | fail)', 'fixWork.fixTasks, verify, ask', 'state.pendingTriage.inputs', 'recheck.failures po merge Apply'],
      branches: [
        { if: 'wszystko spełnione', then: 'REVIEW_DONE reviewStatus passed → complete (task-execution.ts:538), workflow_complete, callbacks.onComplete', next: 'JR_READY_OR_CLOSE' },
        { if: 'cokolwiek nie', then: 'followReviewAnswer (review.ts:227)', next: 'JR_FIX_CAP' },
      ],
      default: 'Kryterium unverified blokuje pass. Czerwony check, którego porażki są czerwone też na run base, nie blokuje (pre-existing). → review.',
    },
    {
      id: 'JR_FIX_CAP',
      title: 'Po nieudanym review: fix cycle, pytanie czy halt',
      question: 'Czy odpowiedź reviewera ma pytanie, czy są fix tasks i czy cykl mieści się w allowance?',
      where: 'src/engine/orchestrator/run/review.ts:300',
      inputs: ['fixWork.ask', 'fixCyclesOf(state).used i allowance (REVIEW_CYCLE_CAP = 2, src/core/pipeline-spec/review.ts:3)', 'fixWork.fixTasks, fixWork.verify'],
      branches: [
        { if: 'fixWork.ask ≠ null', then: 'QUEUE_TRIAGE, pytanie do użytkownika przez onPlannerReply; odpowiedź zapisana jako wejście A<n>; re-review tego samego kandydata bez nowych reviewer checks (review.ts:248)', next: 'JR_REVIEW_VERDICT' },
        { if: 'used ≥ allowance', then: 'haltFailedReview: halt review-failed · Needs you z revise (+1 cykl), Accept as is (gdy nic czerwonego nie blokuje), end-run (review.ts:300)', next: 'JR_HALT_KIND' },
        { if: 'zero fixTasks i zero verify', then: 'haltFailedReview z detalem: porażki recheck lub kryteria unverified (review.ts:312)', next: 'JR_HALT_KIND' },
      ],
      default: 'applyTriage dodaje fix tasks (INSERT_TASKS, nowe id T###, batch = najwyższy + cykl), startFixCycle → START_FIX_CYCLE → implementing (review.ts:341). Fix tasks biegną w pętli briefów; ich konsultacje odpowiada seat REVIEW.',
    },
    {
      id: 'JR_READY_OR_CLOSE',
      title: 'Po passed review: ready-to-apply czy closed',
      question: 'Jaki rodzaj workspace ma run?',
      where: 'src/core/sessions/run-status.ts:192',
      inputs: ['state.phase = complete', 'state.reviewStatus = passed lub state.acceptedAsIs', 'state.workspace.kind', 'state.pendingRecovery', 'liveness'],
      branches: [
        { if: 'brak workspace (stary run) lub kind: checkout', then: 'closed as complete; zmiany już są w checkoucie; nie ma run.patch', next: 'JR_RUN_STATUS' },
        { if: 'worktree lub staged-copy, proces żyje', then: 'running (proces może właśnie robić Apply)', next: 'JR_RUN_STATUS' },
        { if: 'worktree lub staged-copy, nikt nie trzyma, bez pendingRecovery, interruptedStep i applying', then: 'ready-to-apply; override = reviewStatus ≠ passed (Accept as is) (run-status.ts:187)', next: 'JR_RESULT_MENU' },
      ],
      default: 'awaitsApply (run-status.ts:118) jest jednym źródłem dla resumeStep i deriveRunStatus.',
    },
    {
      id: 'JR_RESULT_MENU',
      title: 'Menu wyniku: Apply, Show diff, Discard',
      question: 'Który wiersz menu bierzesz na runie ready-to-apply?',
      where: 'src/features/workflow/result/options.ts:8',
      inputs: ['ResultRowId: apply | show-diff | discard | confirm-apply | back', 'state.acceptedAsIs'],
      branches: [
        { if: 'Apply (/run accept, options.ts:118)', then: 'ponowne wejście do runWorkflow; resumeStep = apply → runApply (phases.ts:51). Override pyta raz: Apply as is (/run accept confirm)', next: 'JR_APPLY_OUTCOME' },
        { if: 'Show diff', then: 'zapis run.patch (src/core/paths.ts:87) i podgląd; run zostaje ready' },
        { if: 'Discard (/run reject confirm, options.ts:120)', then: 'closeRunIfOpen as discarded: run.patch, CLOSE_RUN, workspace usunięty, workspace_closed (close.ts:125)', next: 'JR_RUN_STATUS' },
        { if: 'End run na runie ready', then: 'to Discard: closed discarded, run.patch zachowany, bez workflow_cancelled' },
      ],
      default: 'Run ready nie jest kontynuowany: continueRun odmawia z reason ready-to-apply (continue.ts:82). → lifecycle, ui.',
    },
    {
      id: 'JR_APPLY_OUTCOME',
      title: 'Wynik Apply',
      question: 'Co zwrócił runApply?',
      where: 'src/engine/orchestrator/run/phases.ts:52',
      inputs: ['ApplyResult.outcome: applied | review | needs-confirmation | halted | restored (apply/run.ts:45)'],
      branches: [
        { if: 'applied', then: 'APPLY_DONE: pliki zapisane, closed as applied; worktree i branch usunięte; disposition terminal outcome closed', next: 'JR_RUN_STATUS' },
        { if: 'review (merge zmienił recenzowanego kandydata)', then: 'APPLY_REVIEW_START → final-review z zaznaczonymi hunkami checkoutu; liczy się jako fix cycle; disposition ready-for-tasks → pętla review (apply/run.ts:333)', next: 'JR_REVIEW_VERDICT' },
        { if: 'needs-confirmation (Accept as is bez potwierdzenia)', then: 'ostrzeżenie apply_override_unconfirmed; outcome input-required; nic nie zapisane (apply/run.ts:155)' },
        { if: 'halted: apply-conflict lub apply-partial', then: 'halt · Needs you; End run odmawia póki applying trwa: Restore lub Retry najpierw (close.ts:108)', next: 'JR_HALT_KIND' },
        { if: 'restored', then: 'APPLY_RESTORED: backup przywrócony; run może znowu być ready-to-apply' },
      ],
      default: 'Apply nie jest atomowy; przed pierwszym zapisem backup w .splitbrief/sessions/<id>/apply/<backup-id>/ (src/engine/orchestrator/apply/backup.ts:73). Zapis strzeżony hashem bajtów, które Apply czytał do merge.',
    },
    {
      id: 'JR_EXIT_KIND',
      title: 'Jak run przestaje biec',
      question: 'Co kończy turn runWorkflow: sygnał End run, abort, błąd, halt czy sygnał systemu?',
      where: 'src/engine/orchestrator/run/workflow.ts:364',
      inputs: ['opts.signal.aborted i workflowCancelledReasonFromSignal', 'wyjątek z ciała runu', 'trackedState.pendingRecovery', 'SIGINT / SIGTERM / SIGHUP (shutdown.ts:87)'],
      branches: [
        { if: 'abort z powodem End run', then: 'closeRunIfOpen → CLOSE_RUN ended, workflow_cancelled (workflow.ts:396)', next: 'JR_RUN_STATUS' },
        { if: 'abort bez powodu (Stop now, ctrl+c, ctrl+⏎, /steer)', then: 'parkRun → parkStoppedRun: INTERRUPT_STEP, turn_interrupted; run open · paused (workflow.ts:406). Stan zamknięty, complete, już sparkowany lub z halt zostaje bez zmian', next: 'JR_STOP_KIND' },
        { if: 'wyjątek', then: 'killAllProcesses, publishError, recordLastFailure(step: resumeStep) → open · failed (workflow.ts:364-378)', next: 'JR_CONTINUE_GUARD' },
        { if: 'halt (raisePendingRecovery w dowolnym kroku)', then: 'SET_PENDING_RECOVERY, recovery_prompted; runWorkflow kończy się normalnie; TUI pokazuje panel', next: 'JR_HALT_KIND' },
        { if: 'SIGINT / SIGTERM / SIGHUP', then: 'shutdownWorkflow: kill procesów potomnych, zapis state.json; .splitbrief/active zostaje (shutdown.ts:33)', next: 'JR_CONTINUE_GUARD' },
      ],
      default: 'Każda droga wyjścia: killAllProcesses, saveFinalSession (summary.json, czas aktywny), isolation.dispose, snapshot checkoutu, releaseLiveness (workflow.ts:390-470). Crash bez tej ścieżki czyta się jako interrupted.',
    },
    {
      id: 'JR_STOP_KIND',
      title: 'Stop sheet: Stop now, Pause after this brief, End run',
      question: 'Który intent ustawia stopStore?',
      where: 'src/stores/workflow/stop.ts:6',
      inputs: ['StopIntent: none | stop-now | pause-after-brief | end-run | quit', 'handlers.ts:123, 174'],
      branches: [
        { if: 'stop-now (drugi esc, ctrl+c, Stop now)', then: 'AbortController.abort(); bieżące wywołanie kończy się; INTERRUPT_STEP cut mid-step z partialRef; częściowe zmiany zostają w workspace', next: 'JR_CONTINUE_GUARD' },
        { if: 'pause-after-brief', then: 'nic nie jest zabijane; brief kończy bramkę; pętla zwraca paused; INTERRUPT_STEP cut boundary na brief, przed którym stanął', next: 'JR_TASKS_DONE' },
        { if: 'end-run', then: 'endRun → closeRunIfOpen: run.patch, CLOSE_RUN ended; na runie ready to Discard (close.ts:125)', next: 'JR_RUN_STATUS' },
        { if: 'quit (ctrl+c drugi raz, ctrl+q, /quit)', then: 'stop-now, potem wyjście z procesu po zapisie' },
      ],
      default: 'Esc na runie parked wraca na home; esc esc esc działa szybko. Nieudany cleanup lub zapis oferuje Retry stop. → lifecycle, ui.',
    },
    {
      id: 'JR_HALT_KIND',
      title: 'Halt: Needs you czy Seat down',
      question: 'Na który z dwóch haltów mapuje się przyczyna (RecoveryReason)?',
      where: 'src/core/recovery/halt.ts:80',
      inputs: ['pendingRecovery.reason', 'REASON_HALT (halt.ts:44)'],
      branches: [
        { if: 'needs-you: retry-exhausted, consult-bound-spent, planner-calls-spent, dependency-blocked, review-failed, review-input-too-large, required-checks-unrunnable, approval-denied, plan-questions-exhausted, plan-checks-failed, apply-conflict, apply-partial, implementation-error, checkout-changed, snapshot-failed', then: 'tytuł "Needs you · <cause>"; dozwolone akcje: continue, retry-same-worker, revise, accept-as-is, restore-backup, skip-current-task, end-run (halt.ts:16)', next: 'JR_RECOVERY_ACTION' },
        { if: 'seat-down: runner-unauthenticated, runner-usage-limit, runner-timeout-repeated, implementer-recipe-invalid, implementer-left-isolation, context-overflow, planner-call-failed, seat-protocol-error', then: 'tytuł "Seat down · <cause>"; dozwolone: switch-seat, retry-later, retry-same-worker, skip-current-task, end-run (halt.ts:26)', next: 'JR_AUTO_SWITCH' },
      ],
      default: 'Każda przyczyna oferuje podzbiór akcji swojego haltu. Wycofane przyczyny (RETIRED_RECOVERY_REASONS) rozwiązują się przy continue jedną notą. → recovery.',
    },
    {
      id: 'JR_AUTO_SWITCH',
      title: 'Automatyczny switch na fallback',
      question: 'Czy halt Seat down niesie intencję switchSeat.auto?',
      where: 'src/engine/orchestrator/recovery/builders/task.ts:313',
      inputs: ['seatSwap.fallback z config.yaml of record (loadSeatSwapContext, seat-swap-context.ts:197)', 'seatSwap.configRevision', 'state.seatSwitches', 'classification: account | rate-limited z resetAt', 'offer.candidates[0]', 'BOUNDS.rateLimitResetWaitMs = 600 000 (bounds.ts:13)'],
      branches: [
        { if: 'brak fallbacku lub brak configRevision', then: 'bez intencji; panel' , next: 'JR_RECOVERY_ACTION' },
        { if: 'seatSwitches ma już wpis tego seatu z auto: true', then: 'bez intencji; wiersz "fallback: <identity> · automatic switch already used in this run" (task.ts:277)', next: 'JR_RECOVERY_ACTION' },
        { if: 'klasa nie jest account i nie jest rate-limited z resetem > 10 min', then: 'bez intencji (np. planner-call-failed, protokół, timeout)', next: 'JR_RECOVERY_ACTION' },
        { if: 'pierwszy kandydat oferty ≠ fallback (fallback niezainstalowany, needs sign-in, już na nim)', then: 'bez intencji', next: 'JR_RECOVERY_ACTION' },
        { if: 'wszystkie cztery warunki', then: 'intencja { candidate: fallback, configRevision }. TUI stosuje ją od razu (use-run-loop.ts:395 applyOfferedSeatSwap), headless też (headless.ts:382) chyba że --on-seat-down halt. Udany switch: zapis seatu do config.yaml, RESTART_ATTEMPT_ON_SEAT lub RESOLVE_PENDING_RECOVERY, RECORD_SEAT_SWITCH auto: true, seat_switched; ponowne wejście', next: 'JR_RESUME_STEP' },
      ],
      default: 'Switch, który nie zapisał configu (przerwany, nieadmitowany, config zmieniony "config changed meanwhile · the halt stays"), zostawia halt; spędzona intencja znika z pamięci i następne wejście pokazuje panel (use-run-loop.ts:422). Ręczny switch z pickera zapisuje auto: false i nie zużywa automatycznego. Stary seat CLI staje się fallbackiem nowego; stary api/shell/agent nie.',
    },
    {
      id: 'JR_RECOVERY_ACTION',
      title: 'Panel recovery: co dalej po twoim wyborze',
      question: 'Czy wybrana akcja wraca do silnika, czy zamyka run?',
      where: 'src/features/workflow/hooks/use-run-loop.ts:346',
      inputs: ['recovery.shouldRun', 'recovery.state', 'recovery.switchSeat', 'recovery.steer / correctionTaken', 'createRecoveryDriver (src/features/workflow/recovery-driver.ts:197)'],
      branches: [
        { if: 'end-run', then: 'shouldRun false: finalizeEndedRun, settleRun; run closed; silnik nie wchodzi ponownie', next: 'JR_RUN_STATUS' },
        { if: 'switch-seat (picker otwarty na pierwszym kandydacie)', then: 'applyOfferedSeatSwap przed re-entry (use-run-loop.ts:395); seat, który padł, nie jest admitowany ponownie', next: 'JR_RESUME_STEP' },
        { if: 'retry-same-worker, continue, revise, skip-current-task, retry-later, accept-as-is, restore-backup', then: 'akcja zapisuje stan (MARK_RECOVERY_APPLYING → RESOLVE_PENDING_RECOVERY, GRANT_ALLOWANCE, SET_SEAT_WAIT, ACCEPT_AS_IS, …), potem prepareExecution jako resume i runWorkflow na tym stanie', next: 'JR_RESUME_STEP' },
      ],
      default: 'Pętla w use-run-loop kręci się tylko dla haltów: każde inne zakończenie runWorkflow to settleRun → ekran at rest (use-run-loop.ts:539). Headless: splitbrief continue <id> --action skip|retry|restore|switch-seat:<tool>|end-run.',
    },
    {
      id: 'JR_CONTINUE_GUARD',
      title: 'Kontynuacja: jedna droga, cztery odmowy',
      question: 'Co continueRun robi z runem przy ⏎, tekście lub /resume?',
      where: 'src/engine/orchestrator/run/continue.ts:52',
      inputs: ['deps.resumeParked (park trzymany w tym procesie)', 'hydrateResume(ref)', 'deriveRunStatus(state, not-alive)', 'steer.text'],
      branches: [
        { if: 'ten proces trzyma park', then: 'resumeParked(steer): continued-in-place; bez nowego runWorkflow (continue.ts:65)' },
        { if: 'brak state.json lub nie parsuje', then: 'refused missing / invalid' },
        { if: 'status closed', then: 'refused closed z komunikatem zamknięcia (continue.ts:79)' },
        { if: 'status ready-to-apply', then: 'refused ready-to-apply: Apply lub Discard (continue.ts:82)' },
        { if: 'tekst, a krok nie czyta słów', then: 'refused takes-no-words' },
      ],
      default: 'restart({ state, steer }): nowy runWorkflow z RunWorkflowOptions.steer; steer dokleja się do promptu kroku (composeContinuation), nigdy go nie zastępuje; zapisany raz jako user_message. Planner z sesją natywną dostaje jedną turę; bez sesji transkrypt odbudowany z session.jsonl.',
    },
    {
      id: 'JR_SEAT_CLASS',
      title: 'Klasyfikacja błędu seatu',
      question: 'classifySeatFailure: do jakiej klasy należy porażka wywołania?',
      where: 'src/engine/runners/seat-failure.ts:175',
      inputs: ['message (słowa narzędzia)', 'outcome / code wywołania', 'status HTTP w tekście', 'parseUsageLimitReset (src/engine/runners/usage-limit.ts:315)'],
      branches: [
        { if: 'outcome lub code w AUTHORITATIVE_OUTCOMES', then: 'authoritative: własny werdykt wywołania, bez retry' },
        { if: 'konto: balance / billing / quota / auth (401, 403, "sign in", wyczerpane saldo)', then: 'account → Seat down: runner-unauthenticated (auth) lub runner-usage-limit (reszta)', next: 'JR_AUTO_SWITCH' },
        { if: 'limit z parsowalną datą resetu', then: 'rate-limited { resetAt }', next: 'JR_RESET_WAIT' },
        { if: 'sieć, DNS, reset połączenia, 5xx, 408, gołe 429 bez resetu', then: 'transient', next: 'JR_SEAT_RUNG' },
      ],
      default: 'other: krok nadaje własny halt (planner-call-failed, retry-exhausted, …). Pierwszeństwo: authoritative, account, rate-limited, transient, other. → runners.',
    },
    {
      id: 'JR_SEAT_RUNG',
      title: 'Które wywołania mają retry transientów i czekanie na reset',
      question: 'Czy ten krok przechodzi przez runSeatCall?',
      where: 'src/engine/orchestrator/escalation/seat-wait.ts:199',
      inputs: ['miejsce wywołania: run-implementation.ts:286 (BUILD attempt), make-implementer-retry-invoker.ts:125 (BUILD retry), consult/request.ts:339 (konsultacja PLAN lub REVIEW)'],
      branches: [
        { if: 'BUILD attempt, BUILD retry, konsultacja', then: 'withSeatRetry: transient powtarzany do BOUNDS.transientRetries = 3 z backoffem 2s, 4s, 8s (transient.ts:91); potem seatResetWaitDeadline', next: 'JR_RESET_WAIT' },
        { if: 'plan call sesji planowania', then: 'brak runSeatCall: handlePlanningFailure → diagnosePlannerCallFailure → halt od razu (planning/failure.ts:96)', next: 'JR_HALT_KIND' },
        { if: 'review plan call lub verdict call', then: 'brak runSeatCall: diagnosePlannerCallFailure seat review → haltVerdictlessReview (final-review.ts:1004, review.ts:175)', next: 'JR_REVIEW_VERDICT' },
      ],
      default: 'Na PLAN i REVIEW limit z resetem halthuje jako runner-usage-limit · Seat down z akcją retry-later (czeka do resetu), nie czeka sam. Dokumentacja (APPROVAL-AND-RECOVERY.md:111) opisuje czekanie ogólnie jako "a seat call"; w kodzie czekanie jest tylko tam, gdzie jest runSeatCall.',
    },
    {
      id: 'JR_RESET_WAIT',
      title: 'Czekać na reset czy halthować',
      question: 'Czy reset limitu jest w przyszłości i nie dalej niż 10 minut?',
      where: 'src/engine/orchestrator/escalation/seat-wait.ts:76',
      inputs: ['classifySeatFailure.class = rate-limited', 'parseUsageLimitReset(message, now)', 'BOUNDS.rateLimitResetWaitMs = 600 000'],
      branches: [
        { if: '0 < wait ≤ 10 min (tylko krok z runSeatCall)', then: 'waitForSeatReset (seat-wait.ts:91): SET_SEAT_WAIT w state.json, seat_wait_started; status open · stopped · seat-wait; po deadline to samo wywołanie; resume w init.ts:331 czeka dalej', next: 'JR_SEAT_CLASS' },
        { if: 'reset > 10 min, brak daty, reset w przeszłości', then: 'Seat down runner-usage-limit z resetAt; retry-later oferowane gdy data znana; klasa rate-limited z resetem > 10 min kwalifikuje auto switch', next: 'JR_AUTO_SWITCH' },
      ],
      default: 'Abort w trakcie czekania zostawia state.seatWait; kontynuacja czyta deadline i czeka resztę.',
    },
    {
      id: 'JR_BUILD_SEAT_DOWN',
      title: 'Implementer wylogowany lub bez limitu: halt bez retry i bez konsultacji',
      question: 'Czy wynik implementera to unauthenticated lub usage-limit?',
      where: 'src/engine/orchestrator/task/implementation-failure.ts:67',
      inputs: ['implResult.outcome', 'loadSeatSwapContext(seat: build, profil implementera)', 'state.seatSwitches'],
      branches: [
        { if: 'unauthenticated', then: 'buildSeatDownIssue(auth) → runner-unauthenticated; INTERRUPT_STEP source: seat, cut: mid-step (implementation-failure.ts:93); raisePendingRecovery', next: 'JR_AUTO_SWITCH' },
        { if: 'usage-limit', then: 'classifySeatFailure(outcome usage-limit) → runner-usage-limit z resetAt; INTERRUPT_STEP source: seat (implementation-failure.ts:143)', next: 'JR_AUTO_SWITCH' },
        { if: 'to samo na szczeblu retry (drabina)', then: 'seatDownHalt w escalation/handle.ts:82: ten sam halt, bez konsultacji' , next: 'JR_AUTO_SWITCH' },
      ],
      default: 'Inne porażki idą drabiną: jeden retry lokalny z błędem, konsultacja seatu (plan task → PLAN, fix task → REVIEW), halt przy wyczerpanym limicie (handle.ts:270). Brief jest sparkowany jak po stopie, więc switch-seat wznawia tę samą próbę na nowym seacie. → build, recovery.',
    },
    {
      id: 'JR_CONSULT_FAILURE',
      title: 'Nieudane wywołanie konsultacji: na którym seacie halt',
      question: 'Jaka diagnoza i który seat odpowiadał?',
      where: 'src/engine/orchestrator/task/retry.ts:144',
      inputs: ['typedOutputError.isSeatProtocol(err)', 'diagnosePlannerCallFailure(seat: plan | review)', 'consultSeat (plan task → plan, fix task → review)'],
      branches: [
        { if: 'odpowiedź nie parsuje po naprawie', then: 'seatProtocolHaltIssue → seat-protocol-error · Seat down', next: 'JR_HALT_KIND' },
        { if: 'call-failed i seat nieznany', then: 'buildRetryExhaustedRecoveryIssue → retry-exhausted · Needs you z override retry (retry.ts:199)', next: 'JR_HALT_KIND' },
        { if: 'limit, wylogowanie lub inny błąd na znanym seacie', then: 'plannerCallHaltIssue na tym seacie, halt nazywa brief; retry i switch-seat odgrywają brief od początku; skip-current-task oferowane (retry.ts:203)', next: 'JR_AUTO_SWITCH' },
      ],
      default: 'Gdy pendingRecovery już istnieje, tylko wiersz błędu jest publikowany (retry.ts:183). Abort użytkownika nie jest porażką.',
    },
    {
      id: 'JR_PLANNING_FAILURE',
      title: 'Błąd w sesji planowania',
      question: 'Czym jest wyjątek z sesji planowania?',
      where: 'src/engine/orchestrator/planning/failure.ts:25',
      inputs: ['isAbortError(err) / signal.aborted', 'workflowCancelledReasonFromSignal', 'latest.closed', 'readApiContextDiagnostic(err)', 'diagnosePlannerCallFailure(seat: plan)'],
      branches: [
        { if: 'abort użytkownika, nie End run', then: 'parkStoppedRun; terminal outcome interrupted; run open · paused (failure.ts:39)', next: 'JR_CONTINUE_GUARD' },
        { if: 'abort z End run', then: 'terminal outcome cancelled; stan zamknięty już przez closeRunIfOpen' },
        { if: 'run już closed (End run na karcie, potem błąd zapisu)', then: 'tylko publishError; terminal closed' },
        { if: 'pakiet API nie zmieścił się w kontekście', then: 'planner-call-failed z radą "Pick a plan seat with a larger context in /crew plan" (failure.ts:60)', next: 'JR_HALT_KIND' },
        { if: 'każdy inny błąd', then: 'diagnoza: limit → runner-usage-limit, wylogowanie → runner-unauthenticated, reszta → planner-call-failed; wszystkie Seat down na seacie plan (failure.ts:96)', next: 'JR_AUTO_SWITCH' },
      ],
      default: 'Lokalny błąd zapisu (sessionError.isLocalSaveFailure) jest rzucany dalej: run czyta się jako failed.',
    },
    {
      id: 'JR_LIVENESS',
      title: 'Drugi proces na tym samym runie',
      question: 'Czy lockfile.json runu jest żywy (heartbeat)?',
      where: 'src/engine/orchestrator/run/liveness.ts:69',
      inputs: ['.splitbrief/sessions/<id>/lockfile.json (src/core/paths.ts:98)', 'heartbeat procesu'],
      branches: [
        { if: 'alive', then: 'odmowa równoległego runu / continue; deriveRunStatus czyta running' },
        { if: 'nie żyje', then: 'zapis własnego lockfile + heartbeat; releaseLiveness w finally runWorkflow (workflow.ts:470)' },
      ],
      default: 'Problem z odczytem lub zapisem locka jest ostrzeżeniem, nie blokadą ("another SPLITBRIEF process can open this run at the same time"). .splitbrief/active wskazuje bieżącą sesję; wskaźnik na nieżywy run jest czyszczony przy starcie.',
    },
    {
      id: 'JR_RUN_STATUS',
      title: 'Jak run stoi: deriveRunStatus',
      question: 'Jaki status i jaki powód zatrzymania ma zapisany stan?',
      where: 'src/core/sessions/run-status.ts:181',
      inputs: ['state.closed, applied.undone', 'phase, reviewStatus, acceptedAsIs, workspace.kind', 'liveness', 'pendingRecovery, seatWait, pendingPlannerConversation, interruptedStep, awaitingContinue, parkedGate, lastFailure'],
      branches: [
        { if: 'closed', then: 'closed as applied | discarded | ended; applied z undone → undone (run-status.ts:174)' },
        { if: 'complete, passed lub acceptedAsIs, bez pendingRecovery, bez workspace lub checkout', then: 'closed as complete (run-status.ts:178)' },
        { if: 'liveness alive', then: 'running (run-status.ts:186)' },
        { if: 'awaitsApply bez pendingRecovery, interruptedStep, applying', then: 'ready-to-apply, override gdy reviewStatus ≠ passed (run-status.ts:187)' },
        { if: 'pendingRecovery', then: 'open · waiting-for-you · halt (run-status.ts:207)' },
        { if: 'seatWait', then: 'open · stopped · seat-wait z resetAt (run-status.ts:210)' },
        { if: 'pendingPlannerConversation bez odpowiedzi', then: 'open · waiting-for-you · question (run-status.ts:218)' },
        { if: 'interruptedStep lub awaitingContinue', then: 'open · stopped · paused at mid-step | boundary, z kept (run-status.ts:226)' },
        { if: 'parkedGate (reviewing-plan ze state.plan, stare gate)', then: 'open · waiting-for-you · gate (run-status.ts:236)' },
        { if: 'lastFailure', then: 'open · stopped · failed (run-status.ts:240)' },
      ],
      default: 'open · stopped · interrupted: proces zniknął nie zapisując nic (run-status.ts:243). Pierwsze dopasowanie wygrywa, w tej kolejności.',
    },
  ],
  config: [
    { key: 'version', values: '3', default: 'wymagane', effect: 'Jedyna akceptowana wersja configu; inna wartość nie ładuje się.', where: 'src/core/schemas/config.ts:58' },
    { key: 'workflow.approve', values: 'plan | none', default: 'plan', effect: 'plan otwiera kartę planu po checkPlan; none startuje build od razu. Wycofane all, spec, default ładują się jako plan z notą.', where: 'src/core/config/runtime/resolve.ts:6' },
    { key: 'workflow.review', values: 'end | task', default: 'end', effect: 'end: reviewer checks i review tylko na końcu; task: po każdym briefie też jego checks, due checks i review zakresu taska.', where: 'src/core/schemas/config.ts:87' },
    { key: 'workflow.isolation', values: 'worktree | staged-copy | none', default: 'worktree', effect: 'Gdzie pisze implementer. worktree spada na staged-copy z ostrzeżeniem, gdy git worktree się nie uda. none = checkout: brak Apply, passed review zamyka run.', where: 'src/core/config/accessors/values.ts:9' },
    { key: 'validation.end_checks', values: 'true | false', default: 'true', effect: 'false: reviewer nie wybiera i nie uruchamia reviewer checks; plan i task checks nadal biegną.', where: 'src/core/config/runtime/resolve.ts:11' },
    { key: 'validation.approve_checks', values: 'auto | ask', default: 'auto', effect: 'ask: jedna karta Run all / Skip all przed reviewer checks; Skip all nigdy nie jest passem. Headless bez ekranu: pominięte z powodem.', where: 'src/core/config/runtime/resolve.ts:16' },
    { key: 'planner.fallback / implementer.fallback / reviewer.fallback', values: '{ tool, model?, effort?, variant? } runnera CLI', default: 'brak (pauza i pytanie)', effect: 'Jedyna autoryzacja automatycznego switchu Seat down, raz na run i seat. REVIEW bez bloku reviewer dziedziczy fallback PLAN.', where: 'src/core/schemas/runner-fields.ts:402' },
    { key: 'reviewer (blok)', values: 'runner kind cli | api | shell | agent', default: 'brak: planner trzyma seat REVIEW', effect: 'resolveReviewerRunner to jedyne miejsce, które patrzy na config.reviewer.', where: 'src/core/config/accessors/reviewer-runner.ts:9' },
    { key: '--json / --plain', values: 'flagi CLI', default: 'brak: TUI', effect: 'Run headless: NDJSON lub tekst; karta planu bez pytania; pytania plannera → input_required i exit ≠ 0.', where: 'src/cli/commands/start/register.ts:33' },
    { key: '--on-seat-down', values: 'halt | switch', default: 'brak: stosuje zadeklarowaną intencję jak TUI', effect: 'halt: nigdy nie przełącza. switch bez fallbacku w configu: exit 2.', where: 'src/cli/options.ts:333' },
    { key: 'XDG_STATE_HOME', values: 'ścieżka absolutna', default: '~/.local/state', effect: 'Korzeń worktree izolacji: <root>/splitbrief/trees/<repo-key>/<session-id> i run base: <root>/splitbrief/bases.', where: 'src/core/paths.ts:141' },
  ],
  states: [
    { name: 'idle', meaning: 'Faza przed START. Nic nigdy do niej nie wraca. Rail: żaden etap aktywny.', where: 'src/core/schemas/enums.ts:48' },
    { name: 'planning', meaning: 'Sesja planowania: pytania, typed plan, checkPlan. Live (Stop now przerywa wywołanie). Rail: Plan.', where: 'src/core/schemas/enums.ts:53' },
    { name: 'reviewing-plan', meaning: 'Karta planu czeka (approve: plan). Nie live. Rail: Plan. Status: waiting-for-you · gate.', where: 'src/core/schemas/enums.ts:54' },
    { name: 'researching, specifying, reviewing-spec, clarifying, constitution-check, reviewing-briefs, analyzing', meaning: 'Wycofane fazy starego łańcucha planowania. Zostają w enumie, żeby stary state.json się ładował. Stary run w nich kontynuuje jako jedna sesja planowania. Rail: Plan.', where: 'src/core/schemas/enums.ts:49' },
    { name: 'implementing', meaning: 'Brief w toku lub między briefami. Live. Rail: Build. phaseRole: implementer.', where: 'src/core/schemas/enums.ts:57' },
    { name: 'validating-task', meaning: 'Po TASK_SENT: bramka briefu (checks). Nie live. Rail: Build.', where: 'src/core/schemas/enums.ts:58' },
    { name: 'escalating', meaning: 'Retry wyczerpany: konsultacja seatu (PLAN lub REVIEW). Live. Rail: Build.', where: 'src/core/schemas/enums.ts:59' },
    { name: 'final-review', meaning: 'Plan call, reviewer checks, verdict. Live. Rail: Review. phaseRole planner, phaseTokenRole implementer.', where: 'src/core/schemas/enums.ts:60' },
    { name: 'complete', meaning: 'REVIEW_DONE zapisane. Jedyna faza terminalna (isTerminalPhase). Workspace run: ready-to-apply; checkout: closed complete.', where: 'src/core/phases.ts:58' },
    { name: 'rail: plan · build · review (· apply)', meaning: 'getRailActiveIndex: każda faza przed buildem → Plan; implementing/validating-task/escalating → Build; final-review → Review; complete → wszystko done. Apply dochodzi tylko na runie ready lub w trakcie Apply.', where: 'src/core/rail-stages.ts:53' },
    { name: 'running', meaning: 'Proces trzyma lockfile (także Apply w toku).', where: 'src/core/sessions/run-status.ts:200' },
    { name: 'open · waiting-for-you · halt | question | gate', meaning: 'Run nie pójdzie dalej bez ciebie: panel recovery, pytanie plannera, karta planu.', where: 'src/core/sessions/run-status.ts:221' },
    { name: 'open · stopped · paused | seat-wait | failed | interrupted', meaning: 'Run może iść dalej jak stoi: ⏎ kontynuuje. paused ma at: mid-step lub boundary i listę kept.', where: 'src/core/sessions/run-status.ts:240' },
    { name: 'ready-to-apply', meaning: 'Worktree lub staged copy z passed review lub Accept as is. Czeka na Apply lub Discard. Nie jest kontynuowany.', where: 'src/core/sessions/run-status.ts:201' },
    { name: 'closed · complete | applied | undone | discarded | ended', meaning: 'Koniec runu. Bierze tylko /komendy; ⏎ wraca na home; blok Closed ─ na końcu transkryptu.', where: 'src/core/sessions/run-status.ts:188' },
    { name: 'overlaye stanu: closed, workspace, applying, applied, acceptedAsIs, interruptedStep, awaitingContinue, lastFailure, rewindPending, pendingRecovery, seatWait, seatSwitches', meaning: 'Leżą na dowolnej fazie i nie zmieniają phase. deriveRunStatus czyta je w ustalonej kolejności.', where: 'src/core/schemas/workflow.ts:389' },
  ],
  scenarios: [
    {
      title: 'Happy path: start, dwie rundy pytań, plan, karta, 3 briefy, review pass, Apply',
      steps: [
        '1. splitbrief start "add email validation". Jest config.yaml; TUI montuje home; prepareExecution admituje PLAN, BUILD, REVIEW; katalog .splitbrief/sessions/<id>/ i .splitbrief/active powstają.',
        '2. runWorkflow: lockfile.json + heartbeat, createRunIsolation(worktree), EventBus z sinkami tui/jsonl/logger/hook, seaty z fabryki, START → planning, workflow_started.',
        '3. Planner odpowiada kind: questions (2 pytania). QuestionPrompt; ⏎ bierze domyślne. Druga runda: 1 pytanie. Odpowiedzi idą na tej samej sesji natywnej (plannerSessionId w state.json).',
        '4. Planner odpowiada kind: plan. checkPlan + context fit OK. PLAN_COMPILED: plan.json, plan.md, tasks.md. PLAN_DONE → reviewing-plan. Karta planu z listą chronionych operacji.',
        '5. Approve: plan_approved, potwierdzenia w ledgerze, BEGIN_IMPLEMENTATION → implementing. Snapshot workspace-base, worktree pod XDG_STATE_HOME/splitbrief/trees/…, RECORD_WORKSPACE.',
        '6. T001, T002, T003: START_TASK → implement() → gateAttemptChanges → TASK_SENT → runBriefGate (review: end → brak checków) → VALIDATION_PASS → task_completed.',
        '7. ALL_DONE → final-review. runPreReviewChecks (plan i task checks). Plan call: reviewer wybiera V1 npm test, V2 npm run typecheck. Oba zielone. Verdict: pass, zero fix tasks.',
        '8. REVIEW_DONE passed → complete; workflow_complete; summary.json. Nikt nie trzyma locka, workspace to worktree → ready-to-apply. Menu Apply · Show diff · Discard.',
        '9. Apply: nowy runWorkflow z resumeStep apply. Merge base/ours/theirs bez konfliktu, backup w apply/<id>/, APPLY_START, zapis strzeżony hashem, APPLY_DONE → closed applied. Worktree i branch usunięte, workspace_closed.',
      ],
      outcome: 'Run closed · applied. Checkout ma wynik. Blok Closed ─ na końcu transkryptu wymienia briefy, pliki, czas i koszt.',
    },
    {
      title: 'Limit trafia w planowanie: fallback zadeklarowany vs nie',
      steps: [
        '1. Plan call sesji planowania kończy się limitem konta (quota). Nie ma runSeatCall: handlePlanningFailure → diagnosePlannerCallFailure → runner-usage-limit · Seat down na seacie plan. Sesja planowania (pytania, odpowiedzi) zostaje w stanie.',
        '2. Z fallbackiem (planner.fallback: codex) i bez wcześniejszego auto switchu PLAN: halt niesie switchSeat.auto. TUI przełącza od razu: zapis planner do config.yaml, RESOLVE_PENDING_RECOVERY, RECORD_SEAT_SWITCH auto: true, seat_switched; runWorkflow ponownie; sesja planowania wysyła plan prompt na codex z odbudowanym transkryptem. Transkrypt: "Recovery · <cause> → continued on fallback" i "PLAN · <from> → <to> · automatic fallback".',
        '3. Bez fallbacku: panel "Seat down · Quota spent on Claude Code": Change PLAN tool (picker na innym wykrytym narzędziu), retry-later gdy reset znany, Try again, End run. Run czyta się open · waiting-for-you · halt także po restarcie procesu.',
      ],
      outcome: 'Z fallbackiem run idzie dalej bez pytania; seatSwitches ma jeden wpis plan/auto. Bez fallbacku run czeka na ciebie. → recovery, planning.',
    },
    {
      title: 'Limit trafia w brief (BUILD): reset krótki, reset długi, fallback',
      steps: [
        '1. implement() zwraca outcome usage-limit z resetem za 6 minut. runSeatCall: klasa rate-limited, reset ≤ 10 min → SET_SEAT_WAIT, seat_wait_started, status open · stopped · seat-wait. Po resecie ta sama próba biegnie znowu. Kill w trakcie: kontynuacja czyta seatWait i czeka resztę (init.ts:331).',
        '2. Reset za 3 godziny: brak czekania. handleFailedImplementation → runner-usage-limit · Seat down, INTERRUPT_STEP source: seat cut: mid-step na briefie T002 attempt 0. Brief jest sparkowany; częściowe pliki zostają w workspace.',
        '3. Z fallbackiem BUILD (implementer.fallback) i pierwszym auto switchem: switch od razu; RESTART_ATTEMPT_ON_SEAT wznawia T002 na nowym implementerze od tej samej próby; stary seat CLI zapisany jako nowy fallback.',
        '4. Bez fallbacku, lub gdy BUILD był już raz przełączony automatycznie: panel Seat down z wierszem "fallback: … · automatic switch already used in this run"; akcje: Change BUILD tool, retry-later (reset znany), Try again, Skip this brief, End run.',
        '5. Wylogowanie (unauthenticated) zachowuje się jak limit konta: halt od razu, bez retry i bez konsultacji, bo kolejna próba nie może się udać.',
      ],
      outcome: 'Krótki reset: run czeka sam. Długi reset lub konto: Seat down; fallback przełącza raz na run i seat; inaczej panel. → build, recovery, runners.',
    },
    {
      title: 'Limit trafia w review: plan call, reviewer checks, verdict, fix tasks, Apply',
      steps: [
        '1. Review plan call (wybór reviewer checks) dostaje limit: brak runSeatCall → diagnosePlannerCallFailure seat review → haltVerdictlessReview → runner-usage-limit · Seat down na seacie review. review_completed z verdict no-verdict. Nigdy nie jest passem.',
        '2. Reviewer checks (V1…) to komendy projektu, nie wywołania modelu: limit konta ich nie dotyczy. Timeout lub czerwony check to wejście triage dla reviewera, nie halt seatu.',
        '3. Verdict call dostaje limit: ten sam halt Seat down na review. Z fallbackiem: bez bloku reviewer REVIEW dziedziczy fallback PLAN i switch zapisuje nowy blok reviewer, planner zostaje; z blokiem reviewer: przełącza się ten blok z własnym fallbackiem. Retry lub switch uruchamia review od nowa (pełny, bezstanowy prompt).',
        '4. Fix task (brief z task.fix) biegnie na BUILD: limit zachowuje się jak w scenariuszu BUILD. Konsultacja fix taska idzie do REVIEW przez runSeatCall: 3 retry transientów, czekanie ≤ 10 min, inaczej Seat down na seacie review z nazwą briefu; skip-current-task oferowane.',
        '5. Apply nie wywołuje seatu. Dopiero gdy merge zmieni kandydata, APPLY_REVIEW_START wraca do final-review i re-review zachowuje się jak punkt 3; liczy się jako fix cycle.',
      ],
      outcome: 'W każdym punkcie review limit kończy się haltem Seat down na seacie review, a fallback przełącza go raz; checks i Apply nie mają seatu, więc nie mają limitu. → review, recovery.',
    },
    {
      title: 'Stop w połowie briefu, zamknięcie terminala, powrót dzień później',
      steps: [
        '1. W trakcie T002 esc esc: AbortController.abort(). Implementer ubity, runner_call_error z kodem runner_interrupted, INTERRUPT_STEP { step: brief T002 attempt 0, source: user, cut: mid-step, kept: [pliki zmienione] }, turn_interrupted. Workspace zachowany ("Workspace kept at … for Continue").',
        '2. Trzeci esc: home. draft.json zapisuje niewysłany tekst composera. ctrl+c ctrl+c kończy proces; saveFinalSession zapisał summary.json; .splitbrief/active zostaje.',
        '3. Następnego dnia: splitbrief resume (lub /sessions). deriveRunStatus: open · stopped · paused at mid-step, kept. Ekran runu at rest: hydrateRun odtwarza transkrypt z session.jsonl; rail pokazuje Build z markerem ×; composer odzyskuje draft.',
        '4. ⏎ lub tekst: continueRun → status open → restart({ state, steer }). RESUME_STEP czyści park. resumeStep = brief T002: brief rusza na własnym prompcie z partialem i listą plików już zmienionych; licznik prób bez zmian. Pierwsze wywołanie może nic nie zmienić ("verified · kept the interrupted attempt\'s work").',
      ],
      outcome: 'Run idzie dalej od T002 z zachowaną pracą. Nic nie jest powtarzane z planowania. → lifecycle.',
    },
    {
      title: 'Crash (kill -9) w trakcie briefu',
      steps: [
        '1. Proces znika w trakcie implement() T003. Żaden kod zapisu nie biegnie: brak INTERRUPT_STEP, brak lastFailure. Lock przestaje bić.',
        '2. Następny start czyta stan: brief T003 in_progress bez interruptedStep → open · stopped · interrupted. Pierwszy pisarz zapisuje otwarte wywołania jako interrupted (runner_call_error runner_interrupted, endUnknown); transkrypt: "current turn interrupted: SPLITBRIEF exited".',
        '3. Kontynuacja: jeśli session.jsonl dowodzi, że brief nie biegł ponownie, RESTORE_BRIEF_PARK przywraca park (init.ts:721); inaczej pliki T003 wracają ze snapshotu task-start i brief startuje od attempt 0. Wcześniejsze briefy zostają w workspace.',
        '4. Katalog sesji, który nigdy nie wystartował (tylko readiness.json lub pusty), jest "collectable" i znika przy pruneOrphanSessions na następnym runWorkflow.',
      ],
      outcome: 'Crash traci strumień, nie run. Park trzyma częściowe edycje; crash ich nie trzyma, bo nikt nie wybrał, żeby je zachować. → lifecycle.',
    },
    {
      title: 'Review nie przechodzi dwa razy, potem Accept as is',
      steps: [
        '1. Verdict: fail z 2 blokującymi findings i 2 fix tasks. fixCycles.used 0 < allowance 2 → applyTriage: INSERT_TASKS T004, T005 (batch = max + 1), START_FIX_CYCLE → implementing. Fix tasks biegną; ich bramka uruchamia niesione checks; konsultacje idą do REVIEW.',
        '2. Druga review: plan call, reviewer checks, verdict: fail z 1 finding. used 1 < 2 → drugi cykl.',
        '3. Trzecia review: fail. used 2 ≥ allowance → haltFailedReview → review-failed · Needs you. Akcje: revise (nota + 1 cykl, REVIEW_CORRECTION), Accept as is (gdy nic czerwonego nie blokuje), End run.',
        '4. Accept as is: ACCEPT_AS_IS zapisuje override, open findings i notę; workspace run → ready-to-apply z override: true. Menu pokazuje "Apply as is"; pierwszy Apply zwraca needs-confirmation z ostrzeżeniem apply_override_unconfirmed; /run accept confirm wykonuje Apply.',
      ],
      outcome: 'Run closed · applied z zachowanym nieudanym werdyktem; blok Closed ─ mówi needs attention. Na checkout: Accept as is zamyka run od razu jako complete. → review, recovery.',
    },
    {
      title: 'End run na runie ready-to-apply i odzyskanie pracy',
      steps: [
        '1. Run ready-to-apply. Wybierasz End run (lub Discard). closeRunIfOpen: reapOrphanRunners, writeRunPatch do .splitbrief/sessions/<id>/run.patch, CLOSE_RUN as discarded (ready → discarded), workspace usunięty, workspace_closed.',
        '2. Nie ma workflow_cancelled i nie ma wiersza "Stopped by you", bo nic nie biegło.',
        '3. Blok Closed ─ ma wiersz Patch z nazwą pliku. Praca wraca przez git apply run.patch w checkoucie.',
        '4. End run na runie w trakcie Apply (applying zapisane) jest odmówiony: Restore lub Retry Apply najpierw (assertCanCloseRun).',
      ],
      outcome: 'Run closed · discarded; run.patch trzyma całą niezastosowaną pracę. → lifecycle.',
    },
    {
      title: 'Headless --json z limitem na BUILD i --on-seat-down',
      steps: [
        '1. splitbrief start --json "feature". Karta planu zatwierdzona bez pytania (unattended); zapis na ścieżkę chronioną odmówiony APPROVAL_REQUIRED.',
        '2. BUILD dostaje limit konta. Halt zapisany z switchSeat.auto, gdy implementer.fallback jest i to pierwszy raz. Pętla headless (headless.ts:382) stosuje intencję przez applyOfferedSeatSwap, chyba że --on-seat-down halt; potem runWorkflow ponownie.',
        '3. Bez intencji lub po nieudanym switchu: rekord recovery_required z cause, providerMessage, requestId, fallback i resumeCommand "splitbrief continue <id> --action …"; exit 1.',
        '4. --on-seat-down switch bez fallbacku w configu: exit 2 przed startem.',
      ],
      outcome: 'Headless przełącza tylko to, co zadeklarowałeś; każde inne pytanie kończy proces z kodem ≠ 0 i komendą do kontynuacji. → startup, recovery.',
    },
  ],
  files: [
    { path: 'src/cli.ts', role: 'Rejestracja komend start (domyślna), doctor, spec, init, status, resume, review, continue' },
    { path: 'src/cli/commands/start/register.ts', role: 'start: argumenty, @pliki, wybór headless vs interaktywny' },
    { path: 'src/cli/commands/start/interactive.ts', role: 'Setup vs home vs workflow; prepareExecution przez preparationStore' },
    { path: 'src/cli/headless.ts', role: 'Pętla headless: stdout sink, --on-seat-down, recovery_required, ready_to_apply' },
    { path: 'src/engine/orchestrator/run/workflow.ts', role: 'runWorkflow: liveness, izolacja, shutdown handlers, init, planowanie, taski i review, park / close / failure, saveFinalSession' },
    { path: 'src/engine/orchestrator/run/init.ts', role: 'initializeWorkflow: EventBus i sinki, seaty, resume context, seatWait, START, workflow_started / workflow_resumed, RESTORE_BRIEF_PARK' },
    { path: 'src/engine/orchestrator/run/phases.ts', role: 'resumeStep → Apply, pętla briefów, karta, lub sesja planowania; hook pre_planning' },
    { path: 'src/engine/orchestrator/run/task-execution.ts', role: 'runTasksAndReview: workspace-base, RECORD_WORKSPACE, pętla briefów, parkAtBoundary, pętla review, REVIEW_DONE, workflow_complete, fix tasks' },
    { path: 'src/engine/orchestrator/run/review.ts', role: 'haltVerdictlessReview, reviewPassed, followReviewAnswer (ask, cap, START_FIX_CYCLE)' },
    { path: 'src/engine/orchestrator/run/close.ts', role: 'closeRunIfOpen: run.patch, CLOSE_RUN, workspace_closed; endRun; odmowa przy applying' },
    { path: 'src/engine/orchestrator/run/continue.ts', role: 'continueRun: jedna droga kontynuacji i jej odmowy' },
    { path: 'src/engine/orchestrator/run/seat-swap.ts', role: 'applyOfferedSeatSwap: switch seatu przed ponownym wejściem (TUI i headless)' },
    { path: 'src/engine/orchestrator/run/liveness.ts', role: 'lockfile.json + heartbeat; odmowa równoległego procesu' },
    { path: 'src/engine/orchestrator/planning/plan-session.ts', role: 'Czysta pętla: pytania (max 2 rundy), plan, jedna naprawa checkPlan' },
    { path: 'src/engine/orchestrator/planning/session.ts', role: 'Sesja planowania, PLAN_COMPILED, karta planu (runPlanApproval), BEGIN_IMPLEMENTATION' },
    { path: 'src/engine/orchestrator/planning/failure.ts', role: 'Błąd planowania → park, closed, lub halt Seat down na seacie plan' },
    { path: 'src/engine/orchestrator/task/loop.ts', role: 'Pętla briefów: dependency gate, routing profilu, dostępność implementera, runSingleTask' },
    { path: 'src/engine/orchestrator/task/implementation-failure.ts', role: 'BUILD unauthenticated / usage-limit → Seat down z INTERRUPT_STEP source: seat' },
    { path: 'src/engine/orchestrator/task/retry.ts', role: 'Nieudana konsultacja → halt na seacie, który odpowiadał' },
    { path: 'src/engine/orchestrator/escalation/seat-wait.ts', role: 'runSeatCall: retry transientów, czekanie na reset ≤ 10 min, SET_SEAT_WAIT' },
    { path: 'src/engine/orchestrator/recovery/builders/task.ts', role: 'buildSeatDownIssue, autoSwitchIntent, wiersz fallback' },
    { path: 'src/engine/orchestrator/recovery/switch-seat-resume.ts', role: 'Prepare → zapis config.yaml → RESTART_ATTEMPT_ON_SEAT / RECORD_SEAT_SWITCH' },
    { path: 'src/engine/orchestrator/apply/run.ts', role: 'runApply: override confirmation, apply-partial retry/restore, merge, backup, APPLY_DONE lub review' },
    { path: 'src/engine/orchestrator/isolation/create.ts', role: 'createRunIsolation: worktree → staged-copy fallback; checkout; retencja workspace' },
    { path: 'src/engine/runners/seat-failure.ts', role: 'classifySeatFailure: authoritative / account / rate-limited / transient / other' },
    { path: 'src/core/sessions/run-status.ts', role: 'deriveRunStatus, resumeStep, awaitsApply: jedna odpowiedź dla każdej listy, guarda i ekranu' },
    { path: 'src/core/recovery/halt.ts', role: 'haltOf: przyczyna → Needs you | Seat down; dozwolone akcje' },
    { path: 'src/core/state/machine.ts', role: 'Reducer transition: START, PLAN_DONE, BEGIN_IMPLEMENTATION, ALL_DONE, REVIEW_DONE, START_FIX_CYCLE, CLOSE_RUN, INTERRUPT_STEP, APPLY_DONE, RECORD_SEAT_SWITCH, …' },
    { path: 'src/core/schemas/enums.ts', role: 'PHASES (15 faz), RECOVERY_REASONS, TaskStatus' },
    { path: 'src/core/rail-stages.ts', role: 'Faza → etap raila plan / build / review (/ apply)' },
    { path: 'src/core/paths.ts', role: 'Wszystkie ścieżki: .splitbrief, active, sessions/<id>/ i jego pliki, worktree izolacji pod XDG_STATE_HOME' },
    { path: 'src/core/sessions/draft.ts', role: 'draft.json: niewysłany tekst composera per sesja' },
    { path: 'src/features/workflow/hooks/use-run-loop.ts', role: 'TUI: runWorkflow per turn, panel recovery między turami, automatyczny switch, settleRun → at rest' },
    { path: 'src/features/workflow/recovery-driver.ts', role: 'createRecoveryDriver: panel recovery i zastosowanie intencji auto' },
    { path: 'src/features/workflow/tui-sink.ts', role: 'addTuiEvent → addEvent: most EventBus → stores' },
    { path: 'src/stores/workflow/actions/event.ts', role: 'addEvent: events, tasks, tokens, lifecycle, operations w jednej synchronicznej kolejności; fast path cost_update' },
    { path: 'src/features/workflow/result/options.ts', role: 'Menu wyniku: Apply (/run accept), Show diff, Discard (/run reject confirm)' },
    { path: 'src/core/pipeline-spec/bounds.ts', role: 'BOUNDS: 2 konsultacje, 8 prób, 10 planner calls, reset wait 10 min, 3 retry transientów' },
  ],
  gotchas: [
    'Apply nie jest wywoływany przez UI wprost. /run accept wchodzi ponownie do runWorkflow; resumeStep mówi apply i runPlanningPhases (phases.ts:51) uruchamia runApply. Funkcja o nazwie "planning phases" robi Apply.',
    'Automatyczny switch na fallback nie dzieje się w silniku. Silnik zapisuje tylko intencję (pendingRecovery.switchSeat.auto). Host (use-run-loop.ts:395 lub headless.ts:382) stosuje ją przed ponownym wejściem. Proces ubity między haltem a switchem: intencja zostaje w state.json i następny continue ją stosuje.',
    'Raz na run i seat: autoSwitchIntent odmawia, gdy seatSwitches ma wpis tego seatu z auto: true. Ręczny switch (picker, continue --action switch-seat) zapisuje auto: false i nie zużywa automatycznego.',
    'Czekanie na krótki reset (≤ 10 min) i retry transientów istnieją tylko w runSeatCall: próba BUILD, retry BUILD i konsultacja. Plan call sesji planowania, review plan call i verdict call halthują od razu jako Seat down z retry-later. APPROVAL-AND-RECOVERY.md:111 opisuje czekanie ogólnie jako "a seat call"; kod jest węższy.',
    'HOW-IT-WORKS.md:269 mówi, że nieudane wywołanie reviewera zapisuje reviewStatus failed i buduje summary. Kod (review.ts:149 haltVerdictlessReview) nie zapisuje REVIEW_DONE: run halthuje (Seat down na seacie review lub review-failed · Needs you) i zostaje w final-review. WORKFLOW.md:276 opisuje to zgodnie z kodem.',
    'MENTAL-MODEL.md:96 mówi, że summary.json jest pisany raz na końcu. Kod pisze go na końcu każdego przebiegu runWorkflow (workflow.ts:416), także po stopie i halcie.',
    'Seat down na BUILD parkuje brief jak stop użytkownika: INTERRUPT_STEP source: seat, cut: mid-step. Dzięki temu switch-seat wznawia tę samą próbę (RESTART_ATTEMPT_ON_SEAT), a WORKFLOW.md §9 (interruptedStep.source: user | watchdog) nie wymienia wartości seat, choć §1 ją opisuje.',
    'Zdarzenie ready_to_apply publikuje tylko headless (headless.ts:155). TUI nie czeka na zdarzenie: settleRun czyta RunRecord z dysku i deriveRunStatus mówi ready-to-apply.',
    'Faza complete nie znaczy "zamknięty". Workspace run w complete z passed review jest ready-to-apply; dopiero closed (applied / discarded / ended) albo checkout / stary run zamyka go. Faza nigdy nie cofa się do idle.',
    'Stop sheet: End run jest jedyną drogą zamknięcia z klawiatury; esc esc esc parkuje i wraca na home, nie zamyka. End run na runie ready to Discard (closed discarded, run.patch zostaje).',
    'Z workflow.isolation: none (checkout) nie ma Apply ani run.patch; passed review lub Accept as is zamyka run jako complete, a zmiany już są w twoim checkoucie. Revert zapisuje bajty w reverted/<stamp>/.',
    'Worktree, który się nie uda (np. brak git), spada na staged-copy z jednym ostrzeżeniem i run zapisuje ten rodzaj raz w RECORD_WORKSPACE. Zmiana configu później nie przenosi runu.',
    'Jedna sesja aktywna na projekt (.splitbrief/active). Równoległe runy wymagają osobnych git worktree projektu, bo każdy ma własny .splitbrief/.',
    'Każda planner-tier porażka halthuje na własnym seacie: konsultacja fix taska halthuje na review, konsultacja plan taska na plan, review na review. Bez bloku reviewer REVIEW dziedziczy narzędzie i fallback PLAN; jego switch pisze nowy blok reviewer i nie rusza planner.',
    'Headless zatwierdza kartę planu bez pytania, ale zapis na ścieżkę chronioną zawsze pyta, więc headless go odmawia (APPROVAL_REQUIRED). Pytania plannera kończą headless z input_required i kodem ≠ 0.',
  ],
  glossary: [
    { term: 'run', meaning: 'Jedna praca od "splitbrief start" do zamknięcia. Trwały rekord w .splitbrief/sessions/<id>/ (state.json, session.jsonl, …). Status: running, open, ready-to-apply, closed.', where: 'src/core/sessions/run-status.ts:35' },
    { term: 'seat', meaning: 'Jedna z trzech ról: PLAN (planner), BUILD (implementer), REVIEW (reviewer; domyślnie runner plannera). Każdy seat ma narzędzie, model, osie (effort, thinking, fast) i opcjonalny fallback.', where: 'src/core/crew/identity.ts' },
    { term: 'brief (Task Brief)', meaning: 'Kontrakt na jeden wycinek pracy: pliki, sygnatury, kroki, testy, zakres. Implementer widzi tylko swój brief. Z planu kompiluje je taskFromSpec; render w tasks.md.', where: 'src/core/schemas/task.ts' },
    { term: 'sesja planowania', meaning: 'Jedna typowana rozmowa z plannerem: do 2 rund po max 3 pytania, potem plan sprawdzany checkPlan z jedną naprawą. Nie ma trybów workflow.', where: 'src/engine/orchestrator/planning/plan-session.ts:83' },
    { term: 'karta planu', meaning: 'Jedna bramka zgody przed buildem (workflow.approve: plan): Approve, Request changes, Edit plan.json, End run. Approve potwierdza chronione zapisy z planu.', where: 'src/engine/orchestrator/planning/session.ts:729' },
    { term: 'workspace runu', meaning: 'Katalog, w którym pisze implementer i biegną checks: git worktree poza projektem (domyślnie), staged copy (fallback lub config), albo checkout (isolation: none). Zapisany raz w state.workspace.', where: 'src/engine/orchestrator/isolation/create.ts:63' },
    { term: 'workspace-base', meaning: 'Snapshot checkoutu z chwili utworzenia workspace, z nieskomitowanymi plikami. Baza merge dla Apply i punkt odniesienia "zmian runu".', where: 'src/engine/orchestrator/run/task-execution.ts:312' },
    { term: 'bramka briefu (brief gate)', meaning: 'Checks po hand-backu implementera: przy review: end nic dla zwykłego briefu; przy task: checks taska i due checks; fix task zawsze uruchamia niesione checks. Pass → VALIDATION_PASS; fail → retry → konsultacja.', where: 'src/engine/orchestrator/task/brief-gate.ts' },
    { term: 'konsultacja (consult)', meaning: 'Po nieudanym retry: jedno typowane wywołanie seatu (PLAN dla plan taska, REVIEW dla fix taska) z jedną akcją: guidance, rewrite-task, split-task, verify, ask-user. Limity: 2 na lineage, 8 prób, 10 planner calls na run.', where: 'src/engine/orchestrator/consult/request.ts' },
    { term: 'reviewer checks i end checks', meaning: 'Komendy, które reviewer wybiera przed review (V1, V2, …, max 6) i które SPLITBRIEF uruchamia pod polityką komend reviewera. validation.end_checks (End-of-run checks) włącza je; approve_checks: ask pyta Run all / Skip all. Czerwony check powtarza się na run base; porażki czerwone też tam są pre-existing.', where: 'src/engine/orchestrator/review-checks.ts:462' },
    { term: 'halt', meaning: 'pendingRecovery zapisane na fazie; run jest open · waiting-for-you. Dwa rodzaje: Needs you (decyzja tylko twoja) i Seat down (seat nie może działać). Każda przyczyna mapuje się na jeden.', where: 'src/core/recovery/halt.ts:14' },
    { term: 'fallback', meaning: 'Runner CLI, który seat autoryzuje do jednego automatycznego switchu na run i seat przy odmowie konta lub długim resecie. Ustawiany w Settings › Fallback lub config.yaml. REVIEW bez bloku reviewer dziedziczy fallback PLAN.', where: 'src/core/crew/fallback.ts:19' },
    { term: 'seat wait', meaning: 'Czekanie na reset limitu ≤ 10 min (BOUNDS.rateLimitResetWaitMs) zapisane w state.seatWait; status open · stopped · seat-wait. Tylko dla wywołań przez runSeatCall.', where: 'src/engine/orchestrator/escalation/seat-wait.ts:103' },
    { term: 'ready-to-apply', meaning: 'Workspace run z passed review lub Accept as is, bez halt, parku i Apply w toku. Czeka na Apply lub Discard; nie jest kontynuowany.', where: 'src/core/sessions/run-status.ts:119' },
    { term: 'Apply / Discard / End run', meaning: 'Apply merguje checkout do workspace (base/ours/theirs), robi backup i raz zapisuje wynik do checkoutu (closed applied). Discard i End run zapisują run.patch i zamykają (discarded / ended). Na checkout nie ma Apply.', where: 'src/engine/orchestrator/apply/run.ts:116' },
    { term: 'override (Accept as is)', meaning: 'Akcja na review-failed po wyczerpanym limicie cykli: zapisuje otwarte findings i notę, robi workspace run ready-to-apply z override: true; Apply pyta raz (Apply as is). Werdykt failed zostaje.', where: 'src/core/state/machine.ts:548' },
    { term: 'fix cycle', meaning: 'Jedna runda fix tasks po nieudanym review. REVIEW_CYCLE_CAP = 2; revise daje +1. Re-review po merge Apply też liczy się jako cykl.', where: 'src/core/pipeline-spec/review.ts:3' },
    { term: 'resumeStep / continueRun', meaning: 'resumeStep mówi, gdzie run podejmuje pracę (pytanie, apply, karta, brief, review, plan). continueRun to jedna droga kontynuacji; twój tekst to steer doklejony do promptu kroku.', where: 'src/engine/orchestrator/run/continue.ts:52' },
    { term: 'EventBus i sinki', meaning: 'Synchroniczny fan-out zdarzeń silnika do TUI (stores), session.jsonl, loggera, hooków i stdout (headless). Osobne od callbacków, które blokują silnik na decyzji użytkownika.', where: 'src/engine/orchestrator/run/init-sinks.ts:27' },
    { term: 'interruptedStep / park', meaning: 'Krok, który przeciął stop: step, source (user, watchdog, seat), cut (mid-step, boundary), kept. Run zostaje open i podejmuje ten krok; faza bez zmian.', where: 'src/core/schemas/workflow.ts:419' },
  ],
});
