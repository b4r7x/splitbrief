window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: 'build',
  order: 4,
  title: 'Build: pętla briefów',
  tagline: 'Jak SPLITBRIEF wykonuje każdy Task Brief: dispatch, próba, walidacja, retry, konsultacja plannera, rollback i halt.',
  summary: `Po zatwierdzeniu planu run wchodzi w \`runTasksAndReview\` (\`src/engine/orchestrator/run/task-execution.ts\`). Otwiera jeden run workspace (worktree, staged-copy albo checkout) i uruchamia \`runTaskLoop\` (\`task/loop.ts\`). Pętla idzie po \`state.tasks\` w kolejności z \`plan.json\`, od \`currentTaskIndex\`. Każdy brief przechodzi bramkę zależności, odświeżenie kodu, routing do profilu implementera i jedną próbę (\`runSingleTask\`, \`task/step.ts\`).

Jedna próba to: snapshot task-start, wywołanie implementera w attempt workspace, bramka chronionych ścieżek na zmienionych plikach, opcjonalne potwierdzenie decyzji przez plannera, \`TASK_SENT\`, brief gate (formatter + checks wg \`workflow.review\`) i \`VALIDATION_PASS\`. **Commit** w tym obszarze nie jest commitem gita. To przejście stanu plus zapis evidence (\`validateCommitAndAdvance\`, \`task/commit.ts\`). Git należy do użytkownika; \`workflow.git.commitStrategy\` jest wycofane.

Porażka wchodzi w drabinę (\`escalation/handle.ts\`): jeden lokalny retry z dokładnym błędem (\`DEFAULT_LOCAL_RETRIES = 1\`), potem konsultacja seat-a. Fix task konsultuje reviewera, każdy inny brief plannera. Seat odpowiada jedną akcją: \`guidance\`, \`rewrite-task\`, \`split-task\`, \`verify\`, \`ask-user\` albo \`confirm\`. Limity: 8 prób i 2 konsultacje na lineage, 10 planner calls na run (\`BOUNDS\`). Wyczerpany limit, wylogowany seat, limit konta, defekt runnera, odmowa zatwierdzenia i zablokowana zależność kończą się \`raisePendingRecovery\` → obszar **recovery**. Po ostatnim briefie \`ALL_DONE\` oddaje run do obszaru **review**.

Korekty użytkownika wpisane w trakcie buildu trafiają do \`state.messageQueue\`. Dostarcza je albo działające wywołanie (mid-call), albo następny prompt implementera jako \`continuation.steer\`. Korekta czekająca po zielonych checks wymusza jeszcze jedną próbę, która ją dostarcza.`,
  entry: [
    'src/engine/orchestrator/run/task-execution.ts:276',
    'src/engine/orchestrator/task/loop.ts:50',
    'src/engine/orchestrator/task/step.ts:252',
  ],
  links: [
    { to: 'planning', label: 'wejście: planning.disposition = ready-for-tasks (state.tasks z plan.json)' },
    { to: 'review', label: 'po ostatnim briefie: ALL_DONE → runFinalReviewPhase; z workflow.review=task także runScheduledReview po każdym briefie' },
    { to: 'recovery', label: 'każdy halt: raisePendingRecovery → Needs you / Seat down; Retry wraca przez RESET_TASK, Skip przez SKIP_TASK, Continue przez GRANT_ALLOWANCE' },
    { to: 'lifecycle', label: 'run workspace, attempt workspace (acquire/retain/cleanup), park przy stopie, Apply po review' },
    { to: 'runners', label: 'implementer.implement()/retry(), klasyfikacja wyniku (usage-limit, unauthenticated, timeout), seat retry/wait' },
    { to: 'ui', label: 'composer → enqueueUserMessage; karta potwierdzenia chronionej ścieżki (onTieredApproval); QuestionPrompt dla ask-user' },
    { to: 'subsystems', label: 'hooki pre_task / pre_validation / pre_escalation, snapshoty, evidence ledger, drift-report.json' },
  ],
  diagrams: [
    {
      id: 'build-master',
      title: 'Pętla briefów: od planu do final review',
      caption: 'Jedno przejście pętli dla jednego briefu. Każdy czerwony koniec to halt (recovery) albo stop. Zielony koniec listy oddaje run do review.',
      mermaid: `flowchart TD
  START["runTasksAndReview: baseline snapshot, workspace-base, isolation.open, RECORD_WORKSPACE"] --> LOOP["runTaskLoop: for i = currentTaskIndex .. tasks.length (długość czytana co obieg)"]
  LOOP --> BD_PENDING_RECOVERY{"state.pendingRecovery ustawione?"}
  BD_PENDING_RECOVERY -->|"tak"| STOP1["status stopped: żadna praca nie startuje"]
  BD_PENDING_RECOVERY -->|"nie"| BD_SCHEDULED_REVIEW{"pendingScheduledReview zapisane?"}
  BD_SCHEDULED_REVIEW -->|"tak"| RV1["runScheduledReview → zobacz review"]
  BD_SCHEDULED_REVIEW -->|"nie"| NEXT["task = tasks[i]"]
  RV1 --> NEXT
  NEXT --> BD_TASK_SETTLED{"status done / escalated / skipped?"}
  BD_TASK_SETTLED -->|"tak"| LOOP
  BD_TASK_SETTLED -->|"nie"| BD_DEP_GATE{"któraś zależność z dependsOn failed lub skipped?"}
  BD_DEP_GATE -->|"tak"| HALT_DEP["halt dependency-blocked → recovery"]
  BD_DEP_GATE -->|"nie"| REFRESH["refreshAndPersistCode: kod plików z workspace, akcja kotwicy, UPDATE_TASK_CODE"]
  REFRESH --> BD_ROUTING_PIN{"recovery przypięło profil (state.retryProfile)?"}
  BD_ROUTING_PIN -->|"tak, ale brak w konfiguracji"| HALT_PIN["halt context-overflow"]
  BD_ROUTING_PIN -->|"nie / jest"| BD_ROUTING_FIT{"jest profil, który mieści brief i ma uprawnienia?"}
  BD_ROUTING_FIT -->|"nie"| HALT_CTX["halt context-overflow"]
  BD_ROUTING_FIT -->|"tak"| BD_IMPL_AVAILABLE{"implementer.isAvailable()?"}
  BD_IMPL_AVAILABLE -->|"nie"| HALT_AV["halt implementation-error"]
  BD_IMPL_AVAILABLE -->|"tak"| SINGLE["runSingleTask → diagram: jedna próba"]
  SINGLE --> POST["absorbAcceptedFiles, persistTaskBreakdowns, recordCheckoutRunSnapshot"]
  POST --> ADV["brak abortu i currentTaskIndex > i?"]
  ADV -->|"nie"| STOP2["status stopped: halt, stop użytkownika albo park"]
  ADV -->|"tak"| BD_CADENCE_REVIEW{"workflow.review == task?"}
  BD_CADENCE_REVIEW -->|"tak"| RV2["runScheduledReview(afterTaskId) → zobacz review"]
  BD_CADENCE_REVIEW -->|"nie"| BD_BOUNDARY_PAUSE{"użytkownik wybrał Pause after this brief?"}
  RV2 -->|"ok"| BD_BOUNDARY_PAUSE
  RV2 -->|"stopped"| STOP2
  BD_BOUNDARY_PAUSE -->|"tak"| PAUSED["status paused → parkAtBoundary: INTERRUPT_STEP boundary"]
  BD_BOUNDARY_PAUSE -->|"nie"| LOOP
  PAUSED -->|"⏎ / resume"| LOOP
  LOOP -->|"koniec listy"| COMPLETE["status complete"]
  COMPLETE --> BD_LOOP_END{"phase implementing lub final-review?"}
  BD_LOOP_END -->|"tak"| REVIEW["recordRunSnapshotForRun → ALL_DONE → final review → zobacz review"]
  BD_LOOP_END -->|"nie"| SUMMARY["buildSummary, completed=false"]`,
    },
    {
      id: 'build-attempt',
      title: 'Jedna próba briefu (runSingleTask)',
      caption: 'Od START_TASK do VALIDATION_PASS. Każde odgałęzienie w prawo to wejście do drabiny retry albo halt.',
      mermaid: `flowchart TD
  A["START_TASK: task in_progress, currentTaskIndex = i"] --> BD_STALE_INPUTS{"inputHashes briefu ruszyły się nieoczekiwanie?"}
  BD_STALE_INPUTS -->|"tak"| STALE["requestConsult reason=stale (nie liczy się do consultAllowance)"]
  BD_STALE_INPUTS -->|"nie"| BD_PRE_TASK_HOOK{"hook pre_task pozwala?"}
  STALE --> BD_STALE_ANSWER{"odpowiedź seat-a?"}
  BD_STALE_ANSWER -->|"guidance"| HASH["SET_TASK_INPUT_HASHES; guidance = błąd pierwszej próby"]
  BD_STALE_ANSWER -->|"rewrite-task"| RERUN["rerunReplacedTask: nowa rewizja od START_TASK"]
  BD_STALE_ANSWER -->|"inna / błąd"| PCF["handleTaskPlannerCallFailure → halt na seat-cie"]
  HASH --> BD_PRE_TASK_HOOK
  BD_PRE_TASK_HOOK -->|"nie"| SKIP1["skipBrief(pre_task) → SKIP_TASK"]
  BD_PRE_TASK_HOOK -->|"tak"| BD_SNAPSHOT_OK{"snapshot task-start zapisany?"}
  BD_SNAPSHOT_OK -->|"nie"| HALT_SNAP["halt snapshot-failed"]
  BD_SNAPSHOT_OK -->|"tak"| DISPATCH["task_started; RECORD_DISPATCH; isolation.acquire (attempt workspace)"]
  DISPATCH --> CALL["runImplementation: implement() albo retry() z carriedFailure / guidance"]
  CALL --> BD_IMPL_OUTCOME{"wynik wywołania implementera?"}
  BD_IMPL_OUTCOME -->|"wyjątek"| RETRY1["retryAndRecord → diagram: drabina"]
  BD_IMPL_OUTCOME -->|"abort (stop użytkownika)"| KEEP["retain albo cleanup workspace; return"]
  BD_IMPL_OUTCOME -->|"success=false"| BD_FAIL_KIND{"rodzaj porażki?"}
  BD_IMPL_OUTCOME -->|"success=true"| BD_ATTEMPT_GATE{"gateAttemptChanges na zmienionych plikach"}
  BD_FAIL_KIND -->|"approval denied w trakcie zapisu"| CLEAN["cleanup; recovery już podniesione"]
  BD_FAIL_KIND -->|"bundle partial / write-uncertain"| HALT_API["halt implementation-error (API apply)"]
  BD_FAIL_KIND -->|"unauthenticated / usage-limit"| HALT_SEAT["INTERRUPT_STEP mid-step + Seat down → recovery"]
  BD_FAIL_KIND -->|"defekt runnera"| HALT_DEF["halt bez drabiny (recipe, isolation, checkout-changed, model, input-too-large)"]
  BD_FAIL_KIND -->|"inna porażka / blocked"| RETRY1
  BD_ATTEMPT_GATE -->|"cancelled"| PARK["parkStoppedRun"]
  BD_ATTEMPT_GATE -->|"denied: nic nie zostało"| HALT_APR["halt approval-denied"]
  BD_ATTEMPT_GATE -->|"allow (odrzucone pliki cofnięte)"| BD_DECISION_CONFIRM{"raport done zgłasza nowe decisions?"}
  BD_DECISION_CONFIRM -->|"nie / confirm wszystkich"| SENT["TASK_SENT → validating-task; task_validating"]
  BD_DECISION_CONFIRM -->|"odrzucone / guidance / odpowiedź użytkownika"| RETRY2["retryAndRecord z odpowiedzią → drabina"]
  BD_DECISION_CONFIRM -->|"błąd wywołania plannera"| PCF2["COUNT_ATTEMPT; handleTaskPlannerCallFailure"]
  SENT --> GATE["runBriefGate: formatter na zmienionych plikach, pre_validation, checks"]
  GATE --> BD_CHECK_VERDICT{"każdy wymagany check pass?"}
  BD_CHECK_VERDICT -->|"skipped przez pre_validation"| SKIP2["SKIP_TASK"]
  BD_CHECK_VERDICT -->|"pass, kolejka pusta"| COMMIT["validateCommitAndAdvance: VALIDATION_PASS, task_completed, evidence"]
  BD_CHECK_VERDICT -->|"pass, czeka korekta"| CORR["RESUME_TASK; retryAndRecord(initialAnswer) → próba dostarczająca"]
  BD_CHECK_VERDICT -->|"fail"| RETRY3["retryAndRecord(initialError = tekst błędów, diagnosis = check X failed)"]
  COMMIT --> DONE["task done; następny brief"]
  RETRY3 --> BD_RESTORE_ON_HALT{"halt i powód nie jest consult-bound?"}
  BD_RESTORE_ON_HALT -->|"tak"| RESTORE["restoreExhaustedTaskFiles: pliki briefu wracają do task-start"]
  BD_RESTORE_ON_HALT -->|"nie"| KEEPFILES["pliki zostają; Continue / Skip decyduje"]`,
    },
    {
      id: 'build-ladder',
      title: 'Drabina: retry lokalny → konsultacja → halt',
      caption: 'handleRetryAndEscalation. Jeden lokalny rung z dokładnym błędem, potem pętla konsultacji ograniczona licznikami lineage i runu.',
      mermaid: `flowchart TD
  IN["Pierwsza próba nieudana: błąd, checks fail albo blocked"] --> COUNT0["COUNT_ATTEMPT: lineage.attempts + 1, attemptFailures += pierwsza linia"]
  COUNT0 --> BD_BLOCKED{"implementer zgłosił blocked?"}
  BD_BLOCKED -->|"tak"| ESC
  BD_BLOCKED -->|"nie"| BD_LOCAL_PRECHECK{"jak skończyła się pierwsza próba?"}
  BD_LOCAL_PRECHECK -->|"Aborted"| STOPPED["failedRetry; run parkuje"]
  BD_LOCAL_PRECHECK -->|"tool-use-limit / input-too-large"| BD_RUNNER_HALT
  BD_LOCAL_PRECHECK -->|"zwykły błąd"| BD_ATTEMPT_BOUND{"attempts >= attemptAllowance (8)?"}
  BD_ATTEMPT_BOUND -->|"tak"| CB["halt consult-bound-spent → recovery"]
  BD_ATTEMPT_BOUND -->|"nie"| RUNG["VALIDATION_FAIL: attempt + 1; task_retry; runRetryStep z dokładnym błędem"]
  RUNG --> BD_LOCAL_RUNG{"wynik lokalnego retry?"}
  BD_LOCAL_RUNG -->|"pass"| DONE["VALIDATION_PASS method=local"]
  BD_LOCAL_RUNG -->|"unauthenticated / usage-limit / defekt"| BD_RUNNER_HALT{"runnerHalt: seat down czy defekt?"}
  BD_LOCAL_RUNG -->|"blocked"| ESC
  BD_LOCAL_RUNG -->|"no-staged-change"| ESC
  BD_LOCAL_RUNG -->|"drugi timeout / cut z rzędu"| BD_RUNNER_HALT
  BD_LOCAL_RUNG -->|"fail, rung wyczerpany"| ESC["phase escalating"]
  BD_RUNNER_HALT -->|"seat down"| SD["INTERRUPT_STEP + Seat down → recovery"]
  BD_RUNNER_HALT -->|"defekt"| RD["halt defektu → recovery"]
  ESC --> BD_PRE_ESCALATION_HOOK{"hook pre_escalation pozwala?"}
  BD_PRE_ESCALATION_HOOK -->|"nie"| RX["halt retry-exhausted"]
  BD_PRE_ESCALATION_HOOK -->|"tak"| CLOOP["task_escalating; pętla konsultacji"]
  CLOOP --> BD_ANSWER_PENDING{"czeka odpowiedź użytkownika do dostarczenia?"}
  BD_ANSWER_PENDING -->|"tak"| ATT["attempt(answer): bez konsultacji, bez rungu"]
  BD_ANSWER_PENDING -->|"nie"| BD_CONSULT_BOUND{"consults >= 2 lub attempts >= 8 lub plannerCalls >= 10?"}
  BD_CONSULT_BOUND -->|"tak"| CB
  BD_CONSULT_BOUND -->|"nie"| BD_CONSULT_SEAT{"task.fix ustawione?"}
  BD_CONSULT_SEAT -->|"tak"| RVC["requestConsult seat=review (jedno wywołanie reviewera)"]
  BD_CONSULT_SEAT -->|"nie"| PLC["requestConsult seat=plan (sesja plannera)"]
  RVC --> APPLY["RECORD_CONSULT; COUNT_PLANNER_CALL; applyConsultAnswer → diagram: odpowiedź"]
  PLC --> APPLY
  APPLY -->|"guidance / confirm"| ATT2["attempt(błąd + Guidance from the planner/reviewer)"]
  APPLY -->|"rewrite / split"| BD_HANDED_BACK{"consultHandedBackToLoop: nowa rewizja albo pierwsze dziecko?"}
  BD_HANDED_BACK -->|"tak"| BACK["RESET_TASK; rerunReplacedTask dispatchuje nowy brief"]
  BD_HANDED_BACK -->|"nie"| RX
  APPLY -->|"completed (verify)"| DONE2["method=consulted"]
  APPLY -->|"skipped"| SK["SKIP_TASK"]
  APPLY -->|"correction / failed"| CLOOP
  ATT --> STEP2
  ATT2 --> ATTB["attemptBoundSpent? → jak wyżej"]
  ATTB -->|"nie"| STEP2["runRetryStep method=consulted; COUNT_ATTEMPT"]
  ATTB -->|"tak"| CB
  STEP2 -->|"pass"| DONE2
  STEP2 -->|"fail"| CLOOP
  STEP2 -->|"seat down / defekt"| BD_RUNNER_HALT`,
    },
    {
      id: 'build-gate',
      title: 'Brief gate i commit: od TASK_SENT do VALIDATION_PASS',
      caption: 'Co biegnie po udanej próbie: formatter, hook pre_validation, wybór checks wg cadence, status każdego checku, werdykt i księgowanie plików. Commit to przejście stanu, nie git.',
      mermaid: `flowchart TD
  A["Dispatch: refreshAndPersistCode"] --> BD_ANCHOR_ACTION{"akcja kotwicy przy dispatchu?"}
  BD_ANCHOR_ACTION -->|"kontynuacja przeciętej próby"| K1["task bez zmian"]
  BD_ANCHOR_ACTION -->|"retry / własne pliki"| K2["akcja z dispatchu zostaje"]
  BD_ANCHOR_ACTION -->|"plik absent w workspace lub w startSnapshot lineage"| K3["create"]
  BD_ANCHOR_ACTION -->|"inaczej"| K4["modify"]
  K1 --> P["próba implementera, attempt gate, decision confirm"]
  K2 --> P
  K3 --> P
  K4 --> P
  P --> S["TASK_SENT → validating-task"]
  S --> F["validator.formatChangedFiles: formatter projektu na zmienionych plikach"]
  F --> BD_BRIEF_GATE_CHECKS{"które checks wg workflow.review?"}
  BD_BRIEF_GATE_CHECKS -->|"end, brief zwykły"| NONE["checkIds puste: bez komend"]
  BD_BRIEF_GATE_CHECKS -->|"task"| TC["task.checks + checks due kryteriów"]
  BD_BRIEF_GATE_CHECKS -->|"fix task"| FC["+ checks z findings (judgeFixCheck);<br/>same testy: tylko pliki własnych failures"]
  BD_BRIEF_GATE_CHECKS -->|"verify z konsultacji"| VC["dokładnie wybrane checkIds"]
  TC --> BD_PRE_VALIDATION_HOOK{"hook pre_validation pozwala?"}
  FC --> BD_PRE_VALIDATION_HOOK
  VC --> BD_PRE_VALIDATION_HOOK
  BD_PRE_VALIDATION_HOOK -->|"nie"| SKIP["skipBrief: rollback do task-start; SKIP_TASK"]
  BD_PRE_VALIDATION_HOOK -->|"tak"| RUN["runTaskChecks → runChecks"]
  RUN --> BD_CHECK_POLICY{"status każdego checku?"}
  BD_CHECK_POLICY -->|"polityka odrzuca komendę"| ST1["refused"]
  BD_CHECK_POLICY -->|"brak programu / brak komendy testowej"| ST2["not-runnable"]
  BD_CHECK_POLICY -->|"exit != 0 / timeout"| ST3["fail + failureKeys"]
  BD_CHECK_POLICY -->|"brak pliku testu, skryptu npm<br/>albo test cargo nie biegł"| ST5["fail z placeholderem:<br/>builder albo reviewer to naprawia"]
  ST5 --> REC
  BD_CHECK_POLICY -->|"exit 0"| ST4["pass"]
  ST1 --> REC["RECORD_CHECK_RESULTS; checks_run; evidence"]
  ST2 --> REC
  ST3 --> REC
  ST4 --> REC
  NONE --> V
  REC --> V["werdykt BD_CHECK_VERDICT (diagram: jedna próba)"]
  V -->|"accepted"| BD_COMMIT_COMPLETE{"applyResult applied i acceptance.accepted?"}
  BD_COMMIT_COMPLETE -->|"nie"| NC["completed=false → retryAndRecord"]
  BD_COMMIT_COMPLETE -->|"tak"| BD_LINEAGE_BOOKING{"brief zamyka lineage?"}
  BD_LINEAGE_BOOKING -->|"inny brief lineage otwarty"| B1["księguje własne pliki + nazwane z reszty"]
  BD_LINEAGE_BOOKING -->|"ostatni"| B2["księguje własne pliki + całą resztę lineage"]
  B1 --> DONE["VALIDATION_PASS; task_completed; review-changes.json; evidence done"]
  B2 --> DONE`,
    },
    {
      id: 'build-seat-call',
      title: 'Wokół jednego wywołania seat-a: retry przejściowe, czekanie na reset, błąd konsultacji, drift',
      caption: 'Każde wywołanie implementera i każda konsultacja biegną przez runSeatCall. Nieudana konsultacja haluje na seat-cie, który odpowiadał. Przed final review liczony jest drift.',
      mermaid: `flowchart TD
  C["wywołanie seat-a: implement / retry / requestConsult"] --> BD_SEAT_RETRY{"wynik wywołania?"}
  BD_SEAT_RETRY -->|"ok"| OK["wynik do wołającego"]
  BD_SEAT_RETRY -->|"błąd przejściowy, próba < 3"| R["seat_retry z backoff; usage odrzuconej próby doliczone"]
  R --> C
  BD_SEAT_RETRY -->|"rate-limited, reset ≤ 10 min"| W["SET_SEAT_WAIT; seat_wait_started; czeka; CLEAR_SEAT_WAIT"]
  W --> C
  BD_SEAT_RETRY -->|"reset dalszy / nieznany / inny błąd"| FAIL["porażka wraca do wołającego"]
  FAIL -->|"implementer"| IMPL["BD_FAIL_KIND / drabina (inne diagramy)"]
  FAIL -->|"konsultacja: wyjątek"| BD_PLANNER_CALL_FAILURE{"handleTaskPlannerCallFailure: co się stało?"}
  BD_PLANNER_CALL_FAILURE -->|"retention / zapis sesji"| THROW["rethrow: run pada"]
  BD_PLANNER_CALL_FAILURE -->|"abort"| ST["loadState; return bez haltu"]
  BD_PLANNER_CALL_FAILURE -->|"recovery już w stanie"| ROW["tylko error row"]
  BD_PLANNER_CALL_FAILURE -->|"seat protocol error"| SP["halt seat-protocol-error"]
  BD_PLANNER_CALL_FAILURE -->|"call-failed bez seat-a"| RX["halt retry-exhausted (retry override)"]
  BD_PLANNER_CALL_FAILURE -->|"inaczej"| PH["plannerCallHaltIssue na seat-cie plan / review; evidence failed"]
  OK -->|"ostatni brief done"| ALLDONE["runTasksAndReview: ALL_DONE → final-review.ts"]
  ALLDONE --> BD_DRIFT_FINDINGS{"analyzeBriefDrift: findings?"}
  BD_DRIFT_FINDINGS -->|"plik poza declared set"| D1["info out_of_scope_file"]
  BD_DRIFT_FINDINGS -->|"task done bez zmiany swoich plików"| D2["warning missing_expected_file"]
  BD_DRIFT_FINDINGS -->|"task failed z diffem"| D3["error failed_task_with_diff"]
  BD_DRIFT_FINDINGS -->|"diff, a wszystko failed/skipped"| D4["error orphan_diff"]
  D1 --> OUT["drift-report.json; drift_report; sekcja promptu reviewera → review"]
  D2 --> OUT
  D3 --> OUT
  D4 --> OUT`,
    },
    {
      id: 'build-consult-answer',
      title: 'Co może zdecydować konsultowany seat (applyConsultAnswer)',
      caption: 'Planner (lub reviewer dla fix taska) odpowiada jedną akcją. Rewrite i split cofają tylko pliki bieżącej próby.',
      mermaid: `flowchart TD
  A["ResolvedConsultAnswer od seat-a"] --> BD_CONSULT_ACTION{"answer.action?"}
  BD_CONSULT_ACTION -->|"guidance"| G["instructions + context → blok błędu następnej próby"]
  BD_CONSULT_ACTION -->|"rewrite-task"| BD_GUARD_VIOLATION{"zmienia criteria albo gubi check kryterium?"}
  BD_CONSULT_ACTION -->|"split-task"| BD_GUARD_VIOLATION
  BD_GUARD_VIOLATION -->|"tak"| ASK["applyAskUser: pytanie do użytkownika z powodem"]
  BD_GUARD_VIOLATION -->|"nie, rewrite"| RW["restoreAttemptFiles; REPLACE_TASK: ten sam id, revision + 1, status pending"]
  BD_GUARD_VIOLATION -->|"nie, split"| SP["restoreAttemptFiles; INSERT_TASKS: nowe id, parentId, dependsOn przepięte na dzieci"]
  BD_CONSULT_ACTION -->|"verify"| BD_VERIFY_SELECTION{"checkIds znane i pokrywają due criteria taska?"}
  BD_VERIFY_SELECTION -->|"nie"| F1["failed: powód trafia do następnej konsultacji"]
  BD_VERIFY_SELECTION -->|"tak"| VG["runBriefGate z wybranymi checks"]
  VG -->|"pass"| VC["validateCommitAndAdvance method=consulted → completed"]
  VG -->|"skipped (pre_validation)"| VS["skipped"]
  VG -->|"korekta w kolejce"| VCOR["correction: próba dostarcza odpowiedź"]
  VG -->|"fail"| F1
  BD_CONSULT_ACTION -->|"ask-user"| ASK
  BD_CONSULT_ACTION -->|"confirm"| CF["CONFIRM_DECISIONS: zaakceptowane decyzje do ledgera planu"]
  ASK --> BD_ASK_REPLY{"użytkownik odpowiedział albo pytanie ma default?"}
  BD_ASK_REPLY -->|"nie"| F2["failed: pytanie bez odpowiedzi"]
  BD_ASK_REPLY -->|"tak"| REC["RECORD_CORRECTION: Q/A dołącza do instrukcji briefu → guidance"]
  RW --> HB["consultHandedBackToLoop → RESET_TASK → pętla dispatchuje"]
  SP --> HB`,
    },
    {
      id: 'build-protected',
      title: 'Chroniona ścieżka: od zapisu do karty potwierdzenia',
      caption: 'Każdy zmieniony plik jest klasyfikowany osobno. Tylko klasy destructive, sensitive_change i package_change pytają. Odmowa cofa ten jeden plik.',
      mermaid: `flowchart TD
  W["Plik zmieniony przez implementera"] --> SRC["kto zapisuje?"]
  SRC -->|"extracted-code / bundle: approveWrite PRZED zapisem"| CL
  SRC -->|"direct writer: gateAttemptChanges PO wywołaniu"| CL["classifyAction(write path)"]
  CL --> BD_CLASSIFY_WRITE{"klasa akcji?"}
  BD_CLASSIFY_WRITE -->|".git / .splitbrief"| D["destructive → confirm"]
  BD_CLASSIFY_WRITE -->|".github, .env, *.pem, *.key, .npmrc, CI"| S["sensitive_change → confirm"]
  BD_CLASSIFY_WRITE -->|"package.json, lockfile, go.mod, pyproject ..."| P["package_change → confirm"]
  BD_CLASSIFY_WRITE -->|"w suggestedFiles / dependsOn / scope / allowedPaths"| IN["write_in_scope → auto"]
  BD_CLASSIFY_WRITE -->|"poza zakresem"| OUT["write_out_of_scope → auto (task_touched_not_suggested)"]
  IN --> ALLOW["allow"]
  OUT --> ALLOW
  D --> BD_CONFIRMED_EARLIER{"ta sama operacja już potwierdzona w runie?"}
  S --> BD_CONFIRMED_EARLIER
  P --> BD_CONFIRMED_EARLIER
  BD_CONFIRMED_EARLIER -->|"tak (evidence.json, plan card)"| GR["approval_granted scope=session → allow"]
  BD_CONFIRMED_EARLIER -->|"nie"| BD_APPROVAL_CALLBACK{"callbacks.onTieredApproval istnieje?"}
  BD_APPROVAL_CALLBACK -->|"nie (headless)"| DENY1["deny APPROVAL_REQUIRED"]
  BD_APPROVAL_CALLBACK -->|"tak"| PROMPT["approval_prompted: karta Change a package manifest: ..."]
  PROMPT --> BD_CONFIRM_RESPONSE{"odpowiedź użytkownika?"}
  BD_CONFIRM_RESPONSE -->|"confirm + fraza + powód"| GR2["approval_granted scope=once; zapis do evidence"]
  BD_CONFIRM_RESPONSE -->|"confirm bez frazy / powodu"| DENY2["deny invalid_confirm_phrase"]
  BD_CONFIRM_RESPONSE -->|"reject"| DENY3["deny z powodem"]
  BD_CONFIRM_RESPONSE -->|"anulowane (stop)"| CANCEL["cancelled → retain workspace; parkStoppedRun"]
  DENY1 --> REV["workspace.revert(deniedFiles): tylko te pliki wracają"]
  DENY2 --> REV
  DENY3 --> REV
  REV --> BD_DENIAL_SCOPE{"zostały zaakceptowane pliki?"}
  BD_DENIAL_SCOPE -->|"nie"| HALT["halt approval-denied: retry / skip / end run"]
  BD_DENIAL_SCOPE -->|"tak"| CONT["allow z denial: reszta idzie do walidacji"]`,
    },
    {
      id: 'build-queue',
      title: 'Korekty użytkownika w trakcie buildu',
      caption: 'Wiadomość z composera trafia do kolejki stanu. Trzy drogi dostarczenia: mid-call, native (planner) albo następny prompt implementera.',
      mermaid: `flowchart TD
  U["Użytkownik pisze w composerze podczas runu"] --> BD_QUEUE_PHASE{"faza live i mniej niż 50 wiadomości?"}
  BD_QUEUE_PHASE -->|"nie"| REJ["rejected: phase-unavailable / queue-full"]
  BD_QUEUE_PHASE -->|"tak"| ENQ["ENQUEUE_USER_MSG; message_queued (seat wg fazy)"]
  ENQ --> BD_QUEUE_ROUTE{"trwa sterowalne wywołanie seat-a tej fazy?"}
  BD_QUEUE_ROUTE -->|"tak"| MID["deliverToRunningCall (mid-call)"]
  BD_QUEUE_ROUTE -->|"nie, seat=plan"| NAT["dispatchNativeInjection: planner.injectUserTurn"]
  BD_QUEUE_ROUTE -->|"nie, seat=build / review"| WAIT["czeka w kolejce na następny prompt"]
  MID --> BD_MIDCALL_OUTCOME{"wynik dostarczenia?"}
  BD_MIDCALL_OUTCOME -->|"delivered, build"| ABS1["absorbBuildCorrectionsById via=mid-call → RECORD_CORRECTION"]
  BD_MIDCALL_OUTCOME -->|"delivered, plan"| MD["MARK_DELIVERED_NATIVE via=mid-call"]
  BD_MIDCALL_OUTCOME -->|"deferred"| WAIT
  BD_MIDCALL_OUTCOME -->|"uncertain"| DUP["MARK_POSSIBLE_DUPLICATE: dostarczona jeszcze raz z prefiksem"]
  WAIT --> NEXT["następne wywołanie BUILD: settleMidCallDeliveries; absorb()"]
  NEXT --> DRAIN["DRAIN_QUEUE → RECORD_CORRECTION (lineage.corrections)"]
  DRAIN --> PROMPT["continuation.steer = wszystkie korekty briefu; obrazy tylko gdy seat je czyta"]
  PROMPT --> CALL["implement() / retry()"]
  CALL --> BD_CORRECTION_PASSES{"po sukcesie: nowe wiadomości w kolejce?"}
  BD_CORRECTION_PASSES -->|"tak"| PASS["pass(): implement z allowNoChange=true"]
  PASS --> BD_CORRECTION_PASSES
  BD_CORRECTION_PASSES -->|"nie"| GATE["attempt gate, brief gate"]
  GATE --> BD_CHECK_VERDICT{"checks pass, ale wiadomość czeka?"}
  BD_CHECK_VERDICT -->|"tak"| ANS["CORRECTION_AFTER_CHECKS → próba dostarczająca (bez rungu), checks jeszcze raz"]
  BD_CHECK_VERDICT -->|"nie"| OK["VALIDATION_PASS"]
  STEER["/steer albo ctrl+⏎: stop teraz plus tekst"] --> BD_CONTINUATION_CUT{"wywołanie przerwane w tej próbie / idle cut?"}
  BD_CONTINUATION_CUT -->|"tak"| CUT["INTERRUPT_STEP mid-step z kept files; onContinuationNeeded"]
  CUT --> RES["RESUME_STEP; steer → continuation.steer, partial → kontekst"]
  RES --> CALL`,
    },
    {
      id: 'build-routing',
      title: 'Context routing: który profil implementera dostaje brief',
      caption: 'routeTaskToImplementerProfile ocenia każdy profil. Wygrywa najmniejsze okno kontekstu, które mieści prompt, ma dane logowania i właściwy tryb zapisu.',
      mermaid: `flowchart TD
  T["Brief gotowy do dispatchu"] --> BD_ROUTING_PIN{"state.retryProfile wskazuje ten task?"}
  BD_ROUTING_PIN -->|"tak"| ONLY["tylko przypięty profil"]
  BD_ROUTING_PIN -->|"nie"| ALLP["wszystkie profile (implementer + implementerProfiles)"]
  ONLY --> EACH["dla każdego profilu: assessProfile"]
  ALLP --> EACH
  EACH --> BD_CONTEXT_LENGTH{"skąd długość kontekstu profilu?"}
  BD_CONTEXT_LENGTH -->|"profile.contextLength"| EXPL["explicit"]
  BD_CONTEXT_LENGTH -->|"default profile + detected"| DET["detected"]
  BD_CONTEXT_LENGTH -->|"katalog modeli / runtime"| CAT["models-dev / known-catalog"]
  BD_CONTEXT_LENGTH -->|"nic"| CONS["conservative-fallback 32768"]
  EXPL --> EST["formatTaskPrompt + preamble → estimateTokens (z i bez truncation)"]
  DET --> EST
  CAT --> EST
  CONS --> EST
  EST --> BD_CONTEXT_FIT{"estimate × 1.15 vs budżet (minus rezerwa bundle)?"}
  BD_CONTEXT_FIT -->|"> budżet"| OVER["overflow"]
  BD_CONTEXT_FIT -->|"> 80% budżetu"| TIGHT["tight"]
  BD_CONTEXT_FIT -->|"mieści się"| FITS["fits"]
  EST --> BD_REQUIRED_WRITE_MODE{"brief wymaga direct writera?"}
  BD_REQUIRED_WRITE_MODE -->|"tak, a profil extracted-code"| CAPF["capabilityFailure"]
  BD_REQUIRED_WRITE_MODE -->|"legacy-code i > 1 plik"| CAPF
  BD_REQUIRED_WRITE_MODE -->|"nie"| CRED["missingRunnerCredential: brak API key profilu?"]
  CRED -->|"tak"| CREDF["credentialFailure"]
  CRED -->|"nie"| OKP["profil zdolny"]
  OVER --> BD_ROUTING_FIT{"jest profil zdolny bez overflow?"}
  TIGHT --> BD_ROUTING_FIT
  FITS --> BD_ROUTING_FIT
  CAPF --> BD_ROUTING_FIT
  CREDF --> BD_ROUTING_FIT
  OKP --> BD_ROUTING_FIT
  BD_ROUTING_FIT -->|"tak"| SEL["wybór: najmniejsze contextLength, potem nazwa; configForProfile kopiuje contextLength"]
  BD_ROUTING_FIT -->|"nie"| HALT["halt context-overflow z listą odrzuconych profili"]`,
    },
  ],
  decisions: [
    {
      id: 'BD_PENDING_RECOVERY',
      title: 'Wejście do pętli: czy run stoi na halcie?',
      question: 'Czy state.pendingRecovery jest ustawione przy wejściu do runTaskLoop?',
      where: 'src/engine/orchestrator/task/loop.ts:92',
      inputs: ['state.pendingRecovery'],
      branches: [
        { if: 'pendingRecovery ustawione', then: 'warning recovery_pending_unresolved; status stopped, żaden brief nie startuje', next: 'recovery' },
      ],
      default: 'Pętla idzie dalej do pendingScheduledReview i do briefów.',
      notes: 'Dlatego Retry / Skip / Continue w recovery muszą najpierw zdjąć pendingRecovery (RESOLVE_PENDING_RECOVERY, RESET_TASK, SKIP_TASK). Bez tego pętla od razu wraca stopped.',
    },
    {
      id: 'BD_SCHEDULED_REVIEW',
      title: 'Zaległy task review przed briefami',
      question: 'Czy po poprzednim briefie został zaplanowany task review (pendingScheduledReview), którego run nie dokończył?',
      where: 'src/engine/orchestrator/task/loop.ts:102',
      inputs: ['state.pendingScheduledReview'],
      branches: [
        { if: 'zapisany', then: 'runScheduledReview najpierw; stopped → pętla kończy status stopped', next: 'review' },
      ],
      default: 'Brak zaległego review; start od currentTaskIndex.',
    },
    {
      id: 'BD_TASK_SETTLED',
      title: 'Pomijanie zakończonych briefów',
      question: 'Czy task ma status done, escalated albo skipped?',
      where: 'src/engine/orchestrator/task/loop.ts:135',
      inputs: ['task.status', 'isTaskSettled (src/core/schemas/task.ts:37)'],
      branches: [
        { if: 'settled', then: 'continue: brief nie jest uruchamiany ponownie (resume, fix cycle, split)' },
      ],
      default: 'pending, in_progress i failed wchodzą do bramki zależności. Failed przechodzi tylko po RESET_TASK z recovery (status pending).',
    },
    {
      id: 'BD_DEP_GATE',
      title: 'Bramka zależności',
      question: 'Czy któryś id z task.dependsOn jest na liście failed albo skipped?',
      where: 'src/engine/orchestrator/task/dependency-gate.ts:27',
      inputs: ['task.dependsOn', 'getFailedTaskIds(state)', 'getSkippedTaskIds(state)'],
      branches: [
        { if: 'zależność failed/skipped', then: 'buildDependencyBlockedRecoveryIssue; affectedTaskIds obejmuje każdy dalszy brief z tą samą zablokowaną zależnością; raisePendingRecovery; status stopped', next: 'recovery' },
      ],
      default: 'Brief idzie do odświeżenia kodu.',
      notes: 'Halt dependency-blocked oferuje tylko skip-current-task i end-run (builders/task.ts:644). Kolejność buildu = kolejność plan.json; checkPlan odrzuca plan z zależnością późniejszą niż task (obszar planning).',
    },
    {
      id: 'BD_ANCHOR_ACTION',
      title: 'Akcja kotwicy: create czy modify',
      question: 'Jaką akcję (create/modify) dostaje brief przy dispatchu dla pierwszego pliku (kotwicy)?',
      where: 'src/engine/orchestrator/task/refresh-code.ts:122',
      inputs: ['task.suggestedFiles[0] w workspace', 'state.lineages[id].startSnapshot', 'runsOnOwnFiles', 'entry dispatch/retry'],
      branches: [
        { if: 'continuation.resumesAttempt (kontynuacja przeciętej próby)', then: 'task bez zmian: kod z pierwszego dispatchu' },
        { if: 'entry=retry albo runsOnOwnFiles', then: 'akcja z dispatchu zostaje: plik, który sam stworzył, nadal jest create' },
        { if: 'plik nie istnieje w workspace', then: 'create' },
        { if: 'plik był absent w startSnapshot lineage', then: 'create (także dla rewrite i split children)' },
      ],
      default: 'modify. Odświeżony kod (currentCode, currentCodeByFile, contextCodeByFile do 40 000 znaków) zapisuje UPDATE_TASK_CODE.',
    },
    {
      id: 'BD_ROUTING_PIN',
      title: 'Profil przypięty przez recovery',
      question: 'Czy state.retryProfile wskazuje ten task i czy profil istnieje w konfiguracji?',
      where: 'src/engine/orchestrator/task/routing-selection.ts:41',
      inputs: ['state.retryProfile', 'resolveImplementerProfiles(config)'],
      branches: [
        { if: 'przypięty i skonfigurowany', then: 'routing widzi tylko ten profil' },
        { if: 'przypięty, ale nieskonfigurowany', then: 'error row; halt context-overflow z routingReason', next: 'recovery' },
      ],
      default: 'Brak przypięcia: routing po wszystkich profilach.',
    },
    {
      id: 'BD_CONTEXT_LENGTH',
      title: 'Skąd długość kontekstu profilu',
      question: 'Jak routing ustala okno kontekstu dla profilu implementera?',
      where: 'src/engine/orchestrator/context-routing/context-length.ts:55',
      inputs: ['profile.config.kind', 'profile.config.contextLength', 'detectedContextLength', 'modelCache'],
      branches: [
        { if: 'kind=api', then: 'resolveApplicationContextTokens: configured → observed-active (default profile) → application-default; source explicit / detected / conservative-fallback' },
        { if: 'contextLength w profilu', then: 'explicit (detected, gdy równe wykrytemu)' },
        { if: 'profil domyślny i detectedContextLength', then: 'detected' },
        { if: 'resolveRunnerContextWindow zna model', then: 'models-dev / runtime / known-catalog' },
      ],
      default: 'conservative-fallback: DEFAULT_UNKNOWN_CONTEXT_LENGTH = 32768 (src/core/tokens/context-length.ts:8), usedConservativeContextLength=true (widoczne w routingReason).',
    },
    {
      id: 'BD_CONTEXT_FIT',
      title: 'Klasyfikacja dopasowania promptu',
      question: 'Czy oszacowany prompt mieści się w budżecie profilu?',
      where: 'src/engine/orchestrator/context-routing/estimation.ts:38',
      inputs: ['estimatedTokens (preamble + formatTaskPrompt)', 'contextLength − rezerwa na bundle output (api)', 'DEFAULT_SAFETY_MARGIN 0.15', 'DEFAULT_TIGHT_THRESHOLD 0.8'],
      branches: [
        { if: 'estimate × 1.15 > budżet', then: 'overflow' },
        { if: 'estimate × 1.15 > 80% budżetu', then: 'tight' },
        { if: 'kod przycięty (truncated) i nieprzycięty szacunek overflow', then: 'overflow (determineFit, assessment.ts:16)' },
        { if: 'fits po przycięciu, ale nie whole-file', then: 'tight' },
      ],
      default: 'fits.',
    },
    {
      id: 'BD_REQUIRED_WRITE_MODE',
      title: 'Czy brief wymaga direct writera',
      question: 'Czy brief może iść do implementera extracted-code (API/shell), czy tylko do direct writera (cli/agent)?',
      where: 'src/engine/orchestrator/context-routing/decision.ts:12',
      inputs: ['task.action', 'task.suggestedFiles', 'FILE_BUNDLE_MAX_FILES = 32', 'taskDeclaredPatterns(task)'],
      branches: [
        { if: 'action inne niż create/modify', then: 'direct' },
        { if: 'więcej niż 32 plików', then: 'direct' },
        { if: 'ścieżka zagnieżdżona w innej zadeklarowanej (declaredPathProblem)', then: 'direct' },
        { if: 'scope wymienia ścieżkę poza suggestedFiles', then: 'direct' },
        { if: 'profil legacy-code-v1 i > 1 plik', then: 'capabilityFailure (assessment.ts:97)' },
      ],
      default: 'extracted-code; profil extracted-code przy wymaganym direct dostaje capabilityFailure i jest odrzucony.',
    },
    {
      id: 'BD_ROUTING_FIT',
      title: 'Wybór profilu',
      question: 'Czy istnieje profil bez overflow, bez credentialFailure i bez capabilityFailure?',
      where: 'src/engine/orchestrator/context-routing/route.ts:30',
      inputs: ['ProfileFit[] z assessProfile', 'compareProfileRouteRank: contextLength rosnąco, potem nazwa'],
      branches: [
        { if: 'co najmniej jeden zdolny', then: 'wybrany ten z najmniejszym contextLength; configForProfile kopiuje contextLength do config.implementer (routing.ts:10); task_started niesie contextFit, estimatedTokens, routingReason' },
        { if: 'żaden', then: 'reason: credentials / capability / cannot fit; routingBlockMessage; halt context-overflow z listą rejected', next: 'recovery' },
      ],
      default: 'Brak: zawsze jedna z dwu gałęzi.',
      notes: 'Przy jednym implementerze bez implementerProfiles profil domyślny też przechodzi assessProfile. Overflow na jedynym profilu zatrzymuje run na context-overflow (Seat down wg haltOf).',
    },
    {
      id: 'BD_IMPL_AVAILABLE',
      title: 'Dostępność implementera',
      question: 'Czy taskImplementer.isAvailable() zwraca true?',
      where: 'src/engine/orchestrator/task/loop.ts:183',
      inputs: ['implementer.isAvailable()', 'implementer.unavailabilityReason?.()'],
      branches: [
        { if: 'false albo wyjątek', then: 'error row z powodem; halt implementation-error (buildImplementerUnavailableRecoveryIssue); status stopped', next: 'recovery' },
      ],
      default: 'Brief dostaje WorkflowContext z wybranym profilem (config, implementer, routingDecision).',
    },
    {
      id: 'BD_STALE_INPUTS',
      title: 'Czy brief jest stale',
      question: 'Czy zahaszowane pliki wejściowe briefu (suggestedFiles + contextFiles) zmieniły się od kompilacji w sposób, którego plan nie przewidział?',
      where: 'src/engine/orchestrator/task/stale-inputs.ts:61',
      inputs: ['task.inputHashes (z taskFromSpec)', 'inputHashesNow(workspace)', 'suggestedFiles wcześniejszych tasków', 'lineage.staleConsultedRevision', 'runsOnOwnFiles'],
      branches: [
        { if: 'brak inputHashes (stary run)', then: 'nie stale' },
        { if: 'każdy ruszony plik był do zapisania przez wcześniejszy task', then: 'nie stale: plan to przewidział' },
        { if: 'runsOnOwnFiles: kontynuacja przeciętej próby, carriedFailure albo ta rewizja już dispatchowana', then: 'nie stale: ruszone pliki to własny output briefu' },
        { if: 'rewizja już miała udaną stale konsultację', then: 'nie stale' },
        { if: 'inaczej', then: 'requestConsult reason=stale (step.ts:174)', next: 'BD_STALE_ANSWER' },
      ],
      default: 'Dispatch bez konsultacji.',
    },
    {
      id: 'BD_STALE_ANSWER',
      title: 'Odpowiedź na stale konsultację',
      question: 'Co seat odpowiedział na pytanie o zmienione wejścia?',
      where: 'src/engine/orchestrator/task/step.ts:221',
      inputs: ['applyConsultAnswer(...).action'],
      branches: [
        { if: 'rewrite-task', then: 'replaced: rerunReplacedTask uruchamia nową rewizję od START_TASK' },
        { if: 'guidance (także odpowiedź użytkownika z ask-user)', then: 'SET_TASK_INPUT_HASHES (świeże hashe, staleConsultedRevision); guidance staje się błędem pierwszej próby, która rusza jako implementer.retry' },
        { if: 'inna akcja albo failed', then: 'staleConsultError → handleTaskPlannerCallFailure: halt na seat-cie, hashe bez zmian', next: 'recovery' },
        { if: 'wyjątek wywołania', then: 'handleTaskPlannerCallFailure z etykietą Planner/Reviewer consult for Txxx failed', next: 'BD_PLANNER_CALL_FAILURE' },
      ],
      default: 'Brak: schemat stale dopuszcza tylko guidance, rewrite-task i ask-user.',
      notes: 'Stale konsultacja nie zużywa consultAllowance ani plannerCalls (request.ts:406). Retry z recovery konsultuje ten sam seat jeszcze raz przed dispatchem.',
    },
    {
      id: 'BD_PRE_TASK_HOOK',
      title: 'Hook pre_task',
      question: 'Czy skonfigurowany hook pre_task pozwala na start briefu?',
      where: 'src/engine/orchestrator/task/pre-task.ts:61',
      inputs: ['config.hooks', 'payload task_started (taskId, files, tool, model, routing)'],
      branches: [
        { if: 'brak config.hooks', then: 'bez hooka' },
        { if: 'hook odmawia', then: 'warning pre_task blocked; skipBrief: cofnięcie plików (gdy brief wraca na swoje pliki) i SKIP_TASK; publishTaskSkipped' },
      ],
      default: 'publishTaskStart z lineageAttempt = used + 1 i attemptAllowance; dalej snapshot.',
    },
    {
      id: 'BD_SNAPSHOT_OK',
      title: 'Snapshot task-start',
      question: 'Czy udało się zapisać snapshot workspace na starcie briefu?',
      where: 'src/engine/orchestrator/task/pre-task.ts:107',
      inputs: ['runsOnOwnFiles → changedFilesBaseline.activeTaskSnapshot', 'captureWorkspaceSnapshot(workspaceDir)'],
      branches: [
        { if: 'brief wraca na swoje pliki', then: 'pierwszy snapshot briefu zostaje (restoreFiles zachowane)' },
        { if: 'captureWorkspaceSnapshot rzuca', then: 'error row; halt snapshot-failed (retry-same-worker / end-run)', next: 'recovery' },
      ],
      default: 'Nowy snapshot z pustym restoreFiles; onTaskStartSnapshot zapisuje go na dysk (loop.ts:234) i RECORD_DISPATCH zapisuje startSnapshot lineage, gdy go nie było.',
      notes: 'Ten snapshot jest bazą każdego rollbacku briefu: restoreExhaustedTaskFiles, skipHaltedBrief, restoreInterruptedTaskFiles.',
    },
    {
      id: 'BD_IMPL_OUTCOME',
      title: 'Wynik wywołania implementera',
      question: 'Jak skończyło się implementer.implement() / retry() dla tej próby?',
      where: 'src/engine/orchestrator/task/step.ts:332',
      inputs: ['implResult.success', 'implResult.outcome', 'implResult.applyResult', 'implResult.report', 'wctx.signal'],
      branches: [
        { if: 'wyjątek (nie abort, nie retention)', then: 'CLEAR_CARRIED_FAILURE; error row Implementation failed; retryAndRecord', next: 'BD_LOCAL_PRECHECK' },
        { if: 'abort użytkownika', then: 'resumable stop → workspace.retain (gdy sukces lub user-abort, bez odmowy approval), inaczej cleanup; return bez liczenia próby' },
        { if: 'success=false', then: 'handleFailedImplementation', next: 'BD_FAIL_KIND' },
        { if: 'success=true', then: 'addUsageAndSave; CLEAR_CARRIED_FAILURE; gateAttemptChanges', next: 'BD_ATTEMPT_GATE' },
      ],
      default: 'Brak.',
      notes: 'Klasyfikacja outcome dzieje się w pipeline implementera (src/engine/implementers/pipeline/run.ts:613-659): rzucony błąd providera → unauthenticated / usage-limit (isSeatDown), timeout, no-progress-cut; tripwire → implementer-left-isolation / checkout-changed; raport blocked → success=false + blocked; brak zmian bez allowNoChange → no-staged-change. → zobacz runners.',
    },
    {
      id: 'BD_FAIL_KIND',
      title: 'Rodzaj nieudanej próby',
      question: 'Która ścieżka obsługuje success=false?',
      where: 'src/engine/orchestrator/task/implementation-failure.ts:45',
      inputs: ['implState.preApplyApprovalDenied', 'applyResult.status / code', 'implResult.outcome', 'recoveryBuilderForRunnerOutcome'],
      branches: [
        { if: 'preApplyApprovalDenied', then: 'cleanup; return (recovery approval-denied już podniesione przez approveWrite)' },
        { if: 'applyResult partial albo failed write-uncertain', then: 'raiseApiApplyRecovery: halt implementation-error; w checkout mode pliki wracają', next: 'recovery' },
        { if: 'outcome unauthenticated', then: 'buildSeatDownIssue (account/auth); INTERRUPT_STEP mid-step source=seat; raisePendingRecovery', next: 'recovery' },
        { if: 'outcome usage-limit', then: 'classifySeatFailure (reset?); buildSeatDownIssue; INTERRUPT_STEP; raisePendingRecovery (resetAt w error row)', next: 'recovery' },
        { if: 'outcome w RUNNER_DEFECT_BUILDERS (implementer-recipe-invalid, implementer-left-isolation, checkout-changed, missing-model, runner-timeout-repeated, input-too-large)', then: 'cleanup; halt defektu bez drabiny. input-too-large obejmuje prompt dłuższy niż linia poleceń narzędzia (argv-prompt-too-large, call-result.ts:93): Seat down · Prompt too large for <tool> on T001 z akcjami switch-seat / skip / end', next: 'recovery' },
      ],
      default: 'cleanup; retryAndRecord z initialFailure (outcome, runner, handBack ≤ 2000 znaków) i initialBlocked (pytanie + filesNeeded).',
      notes: 'Pierwsza próba usage-limit/unauthenticated nigdy nie wchodzi w retry ani konsultację: retry nie pomoże, a eskalacja po cichu przeniosłaby pracę na plannera (komentarz w kodzie, linie 64-66).',
    },
    {
      id: 'BD_ATTEMPT_GATE',
      title: 'Bramka zmian po próbie',
      question: 'Co zrobić ze zmienionymi plikami próby po gateChangedFiles?',
      where: 'src/engine/orchestrator/task/attempt-gate.ts:45',
      inputs: ['workspace.changedFiles()', 'preApprovedFiles (approveWrite)', 'decision z gateChangedFiles', 'wctx.signal'],
      branches: [
        { if: 'signal aborted', then: 'retain (resumable) albo cleanup; outcome aborted → return' },
        { if: 'decision.cancelled (użytkownik anulował kartę)', then: 'retain; outcome cancelled → parkStoppedRun (step.ts:437)' },
        { if: 'decision.allow=false', then: 'workspace.revert(deniedFiles); gdy nic nie zostało → denied → halt approval-denied (step.ts:455)', next: 'recovery' },
        { if: 'część odrzucona, część została', then: 'allow z denial: error row, rejection evidence; reszta idzie dalej' },
      ],
      default: 'allow; onApproved zapisuje approval evidence dla plików, o które pytano.',
    },
    {
      id: 'BD_CLASSIFY_WRITE',
      title: 'Klasa akcji dla zapisu pliku',
      question: 'Jaką klasę i tier dostaje zapis ścieżki?',
      where: 'src/engine/orchestrator/approval/action-classifier.ts:155',
      inputs: ['targetPath', 'task.suggestedFiles', 'taskDeclaredPatterns(task)', 'dependsOnFiles', 'config.approval.allowedPaths', 'DEFAULT_TIER_MAP'],
      branches: [
        { if: 'pierwszy segment .git albo .splitbrief', then: 'destructive → confirm' },
        { if: '.github/.circleci/.buildkite, .gitlab-ci.yml, Jenkinsfile, .npmrc, .pypirc, .env*, *.pem, *.key, id_rsa*', then: 'sensitive_change → confirm' },
        { if: 'package.json, lockfile, go.mod/go.sum, Cargo.*, pyproject.toml, requirements.txt, Pipfile ...', then: 'package_change → confirm' },
        { if: 'każda ścieżka w suggestedFiles, dependsOn files, scope.inBounds albo allowedPaths', then: 'write_in_scope → auto' },
      ],
      default: 'write_out_of_scope → auto. Pliki briefu to sugestie: zapis poza nimi jest tylko odnotowany (task_touched_not_suggested w commit.ts:120). gateAction (tiered-approval.ts:19) wymusza confirm dla każdej chronionej klasy.',
    },
    {
      id: 'BD_CONFIRMED_EARLIER',
      title: 'Potwierdzenie już w runie',
      question: 'Czy ta sama operacja (actionClass + write <path>) ma już wpis approvals w evidence.json?',
      where: 'src/engine/orchestrator/approval/confirm.ts:19',
      inputs: ['readEvidenceLedger(...).approvals', 'planConfirmations z karty planu (protectedOperations, npm run checks)'],
      branches: [
        { if: 'tak', then: 'approval_granted scope=session; allow bez pytania' },
      ],
      default: 'approval_prompted; pytanie przez callbacks.onTieredApproval.',
      notes: 'Zatwierdzenie planu (obszar planning) zapisuje protectedOperations z planu jako approvals, więc zapis wypisany w planie nie pyta drugi raz.',
    },
    {
      id: 'BD_APPROVAL_CALLBACK',
      title: 'Czy jest komu zadać pytanie',
      question: 'Czy callbacks.onTieredApproval istnieje (TUI), czy run jest headless?',
      where: 'src/engine/orchestrator/approval/confirm.ts:106',
      inputs: ['callbacks.onTieredApproval'],
      branches: [
        { if: 'brak', then: 'approval_rejected APPROVAL_REQUIRED; deny' },
      ],
      default: 'Karta potwierdzenia w TUI (→ ui).',
    },
    {
      id: 'BD_CONFIRM_RESPONSE',
      title: 'Odpowiedź na kartę potwierdzenia',
      question: 'Co odpowiedział użytkownik na kartę chronionej ścieżki?',
      where: 'src/engine/orchestrator/approval/confirm.ts:118',
      inputs: ['response.decision', 'response.phrase vs CONFIRM_PHRASE', 'response.reason'],
      branches: [
        { if: 'confirm z poprawną frazą i powodem', then: 'approval_granted scope=once; confirmApprovals zapisane do evidence (persistApprovalEvidence)' },
        { if: 'confirm bez frazy lub powodu', then: 'approval_rejected invalid_confirm_phrase; deny' },
        { if: 'reason = WORKFLOW_CANCEL_REASON_USER (stop)', then: 'cancelled: bramka przestaje pytać o kolejne pliki, nic nie jest odrzucone' },
      ],
      default: 'approval_rejected z powodem użytkownika; deny.',
    },
    {
      id: 'BD_DENIAL_SCOPE',
      title: 'Odmowa: całość czy część',
      question: 'Czy po cofnięciu odrzuconych plików zostały zaakceptowane zmiany?',
      where: 'src/engine/orchestrator/task/attempt-gate.ts:86',
      inputs: ['decision.deniedFiles', 'changedFiles'],
      branches: [
        { if: 'approvedFiles puste', then: 'denied; denialMessage ...blocked by approval gate...; halt approval-denied: retry-same-worker / skip-current-task / end-run', next: 'recovery' },
      ],
      default: 'allow z denial: komunikat Approval gate denied X: reason. SPLITBRIEF discarded this attempt writes to X.; walidacja idzie na resztę.',
      notes: 'W drabinie (step.ts w escalation) odmowa całości kończy retry jako failedRetry z komunikatem plus DISCARDED_WRITES_INSTRUCTION dla następnej próby (retry-evidence.ts:30).',
    },
    {
      id: 'BD_DECISION_CONFIRM',
      title: 'Potwierdzenie decyzji implementera',
      question: 'Czy raport done direct writera zgłasza decisions, których ledger planu jeszcze nie ma, i co planner z nimi zrobił?',
      where: 'src/engine/orchestrator/consult/decision-confirm.ts:37',
      inputs: ['implResult.report.decisions', 'state.plan.decisions', 'requestConsult reason=deviation (bez zużycia allowance)'],
      branches: [
        { if: 'brak raportu albo wszystkie decyzje już w ledgerze', then: 'validate: prosto do TASK_SENT' },
        { if: 'confirm obejmuje wszystkie id', then: 'CONFIRM_DECISIONS; validate' },
        { if: 'confirm pomija jakieś id', then: 'retry: błąd The planner rejected decisions... + diagnoza → retryAndRecord', next: 'BD_LOCAL_PRECHECK' },
        { if: 'ask-user (pierwsze pytanie)', then: 'pytanie do użytkownika; odpowiedź do instrukcji briefu; planner pytany drugi raz (answered=true)' },
        { if: 'drugi call: confirm', then: 'validate bez nowego wywołania implementera' },
        { if: 'drugi call: guidance / failed / błąd', then: 'answer: następna próba dostarcza odpowiedź użytkownika (bez rungu)' },
        { if: 'błąd pierwszego call', then: 'warning ...not confirmed or added to the ledger; validate' },
        { if: 'wyjątek z wywołania', then: 'COUNT_ATTEMPT; handleTaskPlannerCallFailure', next: 'BD_PLANNER_CALL_FAILURE' },
      ],
      default: 'validate.',
    },
    {
      id: 'BD_BRIEF_GATE_CHECKS',
      title: 'Które checks biegną po briefie',
      question: 'Jaki zestaw checks wybiera runBriefGate dla tego briefu?',
      where: 'src/engine/orchestrator/task/brief-gate.ts:54',
      inputs: ['config.workflow.review (end|task)', 'task.checks', 'plan.criteria due (dueCriterionIds)', 'task.fix.findings[].checkIds', 'opts.checkIds (verify)'],
      branches: [
        { if: 'review=task', then: 'task.checks + checkIds kryteriów, które ten brief domyka (każdy task kryterium done albo ten)' },
        { if: 'review=end (domyślnie)', then: 'żaden check planu/taska; tylko fix checks i checks nazwane przez wołającego' },
        { if: 'fix task', then: 'dodatkowo każdy check z findings, który brief naprawia (judgeFixCheck decyduje settled); gdy każda własna failure checku to test, check biegnie tylko na plikach tych testów (ownTestFiles, task-checks.ts:47), jeśli komenda to komenda testów stacku, a stack umie je wybrać; następny review uruchamia całą komendę' },
        { if: 'verify z konsultacji', then: 'dokładnie opts.checkIds; każdy musi przejść' },
      ],
      default: 'Zawsze najpierw validator.formatChangedFiles (formatter projektu na zmienionych plikach, run.ts:88); checkIds puste → bez pre_validation i bez komend.',
      notes: 'Z domyślnym review=end brief jest akceptowany bez uruchomienia testów. Checks planu i tasków biegną dopiero przed final review (runPreReviewChecks) → review.',
    },
    {
      id: 'BD_PRE_VALIDATION_HOOK',
      title: 'Hook pre_validation',
      question: 'Czy hook pre_validation pozwala uruchomić checks briefu?',
      where: 'src/engine/orchestrator/task/pre-validation-gate.ts:24',
      inputs: ['config.hooks', 'payload validate status=running'],
      branches: [
        { if: 'brak hooków albo checkIds puste', then: 'bez hooka' },
        { if: 'odmowa', then: 'warning pre_validation blocked; skipBrief: pliki briefu wracają do task-start, SKIP_TASK; gate zwraca stop=skipped' },
      ],
      default: 'runTaskChecks.',
    },
    {
      id: 'BD_CHECK_VERDICT',
      title: 'Werdykt brief gate',
      question: 'Czy brief przechodzi, i czy w kolejce czeka korekta?',
      where: 'src/engine/orchestrator/task/brief-gate.ts:125',
      inputs: ['runs (CheckRunResult[])', 'settled', 'registry required', 'state.messageQueue pending'],
      branches: [
        { if: 'check wybrany (verify) albo fix check: status != pass i nie settled', then: 'failedChecks; fix check jest settled, gdy jego własne failures zniknęły albo każdą pozostałą niesie też niedokończony fix task tego samego cyklu (ta sama komenda, także plan check vs reviewer check); cudze failures nie blokują' },
        { if: 'inny check: status fail, nie settled, required=true', then: 'failedChecks' },
        { if: 'failedChecks niepuste', then: 'accepted=false; error = checkFailureText każdego (własne, Left to <task>:, Other failures, not this brief\'s job:); diagnosis = check <id> failed, a dla fix checku z werdyktem, np. check V1 failed: 1 of your 2 failures remains → retryAndRecord' },
        { if: 'pass, ale isQueuedMessagePendingDelivery', then: 'correction=true; error = CORRECTION_AFTER_CHECKS; RESUME_TASK; retryAndRecord(initialAnswer) → próba dostarczająca bez rungu, potem checks znowu' },
      ],
      default: 'accepted=true → validateCommitAndAdvance.',
      notes: 'Status refused / not-runnable / unknown zwykłego, niewymaganego checku nie blokuje briefu. Dla fix checku i verify każdy status poza pass blokuje.',
    },
    {
      id: 'BD_CHECK_POLICY',
      title: 'Jak biegnie jeden check',
      question: 'Jaki status dostaje pojedynczy check (cmd / test / render)?',
      where: 'src/engine/orchestrator/validation/run-checks.ts:411',
      inputs: ['check.kind', 'commandTextRefusal (plan policy) / reviewerCommandRefusal', 'missingNpmScript', 'changedDefinitionRefusal', 'opts.testFiles (fix check: pliki własnych testów)', 'config.validation.timeoutMs', 'notRunnableReason'],
      branches: [
        { if: 'cmd odrzucony polityką (plan: allowlist; reviewer: zmieniony skrypt, shell syntax)', then: 'refused' },
        { if: 'plan check npm run <script>, a package.json nie ma skryptu albo pliku', then: 'fail z placeholderem no npm script: zmiana nie ma skryptu, fix go doda (run-checks.ts:241)' },
        { if: 'program nie istnieje (ENOENT / exit 127)', then: 'not-runnable, missingProgram' },
        { if: 'test: brak komendy testowej dla stacku', then: 'not-runnable: no test command for an unrecognised stack; set validation.test_command' },
        { if: 'test: workspace nie ma pliku testu, który check nazywa', then: 'fail z placeholderem no test file (the workspace has no test file for …, run-checks.ts:150)' },
        { if: 'test zawężony do celu cargo, a output nie pokazuje uruchomionego testu', then: 'fail z placeholderem no test ran' },
        { if: 'fix check cmd z własnymi failures tylko testowymi, komenda = komenda testów stacku', then: 'biegnie test runner stacku tylko na tych plikach (narrowed, run-checks.ts:431)' },
        { if: 'render bez validation.render', then: 'not-runnable; zły id → refused' },
        { if: 'exit != 0 albo timeout', then: 'fail z failureKeys (output ≤ 4096 znaków)' },
        { if: 'nieznany id', then: 'unknown' },
      ],
      default: 'pass. Timeout checku: validation.timeoutMs albo STAGE_TIMEOUT_MS = 3 600 000 ms.',
    },
    {
      id: 'BD_COMMIT_COMPLETE',
      title: 'Commit = VALIDATION_PASS, nie git',
      question: 'Kiedy validateCommitAndAdvance uznaje brief za ukończony?',
      where: 'src/engine/orchestrator/task/commit.ts:79',
      inputs: ['applyResult.status (bundle)', 'acceptance.accepted', 'lineageRemainder', 'taskStartSnapshot'],
      branches: [
        { if: 'applyResult istnieje i status != applied', then: 'completed=false (niedokończona aplikacja bundla nigdy nie jest ukończeniem)' },
        { if: 'acceptance.accepted=false', then: 'completed=false' },
      ],
      default: 'VALIDATION_PASS (task done, currentTaskIndex dalej, attempt=0, dropClosedLineageStart); task_completed z czasem pracy; task_touched_not_suggested; captureTaskReviewChanges (review-changes.json); bookedFiles = własne pliki + reszta lineage.',
      notes: 'Żadne polecenie git nie biegnie. commitSuffix (after consult) jest przyjmowany w opcjach, ale funkcja go nie czyta. Zmiany zostają w run workspace do Apply (→ lifecycle).',
    },
    {
      id: 'BD_LINEAGE_BOOKING',
      title: 'Które pliki księguje kończący się brief',
      question: 'Czy brief zamyka lineage i księguje jego resztę plików?',
      where: 'src/engine/orchestrator/task/booking.ts:17',
      inputs: ['state.lineages[id].startSnapshot', 'lineageHasOpenBrief', 'unbookedFiles', 'lineageFilesToBook'],
      branches: [
        { if: 'brak startSnapshot (stary stan)', then: 'tylko własne pliki od taskStartSnapshot' },
        { if: 'lineage ma inny otwarty brief (split child)', then: 'księguje z reszty tylko pliki, które sam nazywa' },
        { if: 'ostatni otwarty brief lineage', then: 'księguje całą resztę nieksięgowanych plików od startu lineage' },
      ],
      default: 'Zapis w evidence ledger (persistTaskEvidence) i review-changes.json.',
    },
    {
      id: 'BD_LOCAL_PRECHECK',
      title: 'Wejście do lokalnego rungu',
      question: 'Czy pierwsza porażka pozwala na lokalny retry?',
      where: 'src/engine/orchestrator/escalation/local-retries.ts:155',
      inputs: ['lastError === Aborted', 'initialFailure.outcome', 'initialBlocked'],
      branches: [
        { if: 'retryAndRecord: signal aborted', then: 'bez COUNT_ATTEMPT (retry.ts:238)' },
        { if: 'handle.ts: blocked != undefined', then: 'omija runLocalRetries; prosto do eskalacji' },
        { if: 'lastError = Aborted', then: 'failedRetry(0): run parkuje' },
        { if: 'outcome tool-use-limit albo input-too-large', then: 'bez retry; lastFailure → runnerHalt' },
        { if: 'outcome no-progress-cut', then: 'no_progress_cut row z idleKillMs; retry idzie dalej' },
      ],
      default: 'Pętla rungów: while (answer != undefined || rung < DEFAULT_LOCAL_RETRIES=1).',
    },
    {
      id: 'BD_ATTEMPT_BOUND',
      title: 'Limit prób lineage',
      question: 'Czy lineage zużył już swoje próby?',
      where: 'src/engine/orchestrator/recovery/builders/consult.ts:70',
      inputs: ['lineage.attempts', 'lineage.attemptAllowance (BOUNDS.attemptsPerLineage = 8)'],
      branches: [
        { if: 'attempts >= allowance', then: 'halt consult-bound-spent z licznikami; Continue daje +1 konsultację i +4 próby (GRANT_ALLOWANCE)', next: 'recovery' },
      ],
      default: 'Próba biegnie. Sprawdzane przed każdym rungiem (local-retries.ts:178) i przed każdą próbą po konsultacji (handle.ts:381).',
      notes: 'Co liczy się jako próba: każde wywołanie implementera, które skończyło się porażką albo wróciło z drabiny: pierwsza próba (COUNT_ATTEMPT w retryAndRecord), każdy retry, każda próba po konsultacji i próba dostarczająca odpowiedź użytkownika. Seat retries (transient, czekanie na reset) nie liczą się.',
    },
    {
      id: 'BD_LOCAL_RUNG',
      title: 'Wynik lokalnego retry',
      question: 'Jak skończył się retry z dokładnym błędem?',
      where: 'src/engine/orchestrator/escalation/local-retries.ts:204',
      inputs: ['outcome.result', 'outcome.lastFailure.outcome', 'outcome.blocked', 'consecutiveTimeouts', 'TIMEOUTS.consecutiveTimeoutsHalt = 2'],
      branches: [
        { if: 'lastFailure w haltsLocalRetries (unauthenticated, usage-limit, tool-use-limit, defekt)', then: 'return bez COUNT_ATTEMPT: zepsuty seat to nie zużyta próba → runnerHalt' },
        { if: 'result.completed', then: 'VALIDATION_PASS method=local' },
        { if: 'Aborted', then: 'failedRetry; park' },
        { if: 'blocked', then: 'return: planner odpowiada na pytanie' },
        { if: 'no-staged-change', then: 'return: implementer po feedbacku znów nic nie napisał → konsultacja' },
        { if: 'timeout albo no-progress-cut drugi raz z rzędu', then: 'lastFailure = runner-timeout-repeated → halt defektu' },
      ],
      default: 'COUNT_ATTEMPT; rung wyczerpany (1) → eskalacja. VALIDATION_FAIL przy attempt >= 1 przełącza phase na escalating (machine.ts:370).',
      notes: 'Pierwszy retry fix tasku ma własny framing (framingForAttempt, ladder.ts:31): napraw to, co błąd nazywa twoim; failures nazwane jako nie twoje zostają dla ich fix tasków albo następnego review. Brief fix tasku wymienia własne failures w sekcji Your failures, which this brief fixes.',
    },
    {
      id: 'BD_RUNNER_HALT',
      title: 'Halt runnera w drabinie',
      question: 'Czy ostatnia porażka to seat down albo defekt, który każda kolejna próba powtórzy?',
      where: 'src/engine/orchestrator/escalation/handle.ts:201',
      inputs: ['stepOutcome.lastFailure.outcome', 'loadSeatSwapContext (fallback seat-a)', 'state.seatSwitches'],
      branches: [
        { if: 'unauthenticated / usage-limit', then: 'buildSeatDownIssue z seatSwap; INTERRUPT_STEP mid-step (workspace zostaje); failedRetry', next: 'recovery' },
        { if: 'outcome w RUNNER_DEFECT_BUILDERS', then: 'halt defektu; runner-timeout-repeated ma booked attempt; w checkout mode inPlace.revertedDir', next: 'recovery' },
      ],
      default: 'null: drabina idzie dalej.',
    },
    {
      id: 'BD_BLOCKED',
      title: 'Implementer zgłosił blocked',
      question: 'Czy próba skończyła się raportem blocked (pytanie + filesNeeded)?',
      where: 'src/engine/orchestrator/escalation/handle.ts:315',
      inputs: ['initialBlocked', 'retries.blocked'],
      branches: [
        { if: 'blocked', then: 'bez lokalnego retry; konsultacja z reason=blocked; report w promptcie' },
      ],
      default: 'runLocalRetries najpierw.',
    },
    {
      id: 'BD_PRE_ESCALATION_HOOK',
      title: 'Hook pre_escalation',
      question: 'Czy hook pozwala eskalować brief do konsultacji?',
      where: 'src/engine/orchestrator/escalation/handle.ts:339',
      inputs: ['config.hooks', 'payload task_escalating'],
      branches: [
        { if: 'odmowa', then: 'warning pre_escalation blocked; halt retry-exhausted z escalationBlockedBy; retry-same-worker / skip / end', next: 'recovery' },
      ],
      default: 'publish task_escalating; pętla konsultacji.',
    },
    {
      id: 'BD_ANSWER_PENDING',
      title: 'Odpowiedź użytkownika do dostarczenia',
      question: 'Czy drabina trzyma odpowiedź użytkownika (korekta po checks, ask-user), którą następna próba ma dostarczyć?',
      where: 'src/engine/orchestrator/escalation/handle.ts:452',
      inputs: ['answer (z confirmAttemptDecisions, brief gate correction, applyConsultAnswer correction)'],
      branches: [
        { if: 'answer != undefined', then: 'attempt(answer, deliversAnswer=true): bez konsultacji, allowNoChange, liczy się COUNT_ATTEMPT, nie zużywa consultAllowance' },
      ],
      default: 'consultBoundSpent, potem konsultacja.',
    },
    {
      id: 'BD_CONSULT_BOUND',
      title: 'Limit konsultacji',
      question: 'Czy lineage albo run może jeszcze zapytać seat?',
      where: 'src/engine/orchestrator/recovery/builders/consult.ts:58',
      inputs: ['lineage.consults / consultAllowance (2)', 'lineage.attempts / attemptAllowance (8)', 'state.plannerCalls used / allowance (10)'],
      branches: [
        { if: 'consults >= 2 albo attempts >= 8', then: 'halt consult-bound-spent; Continue: +1 konsultacja, +4 próby, carriedFailure = ostatni output', next: 'recovery' },
        { if: 'plannerCalls >= 10', then: 'halt planner-calls-spent; Continue: +5 planner calls', next: 'recovery' },
      ],
      default: 'requestConsult. RECORD_CONSULT liczy consults (+1, deviation 0); COUNT_PLANNER_CALL dla każdej konsultacji poza deviation i stale, także reviewera.',
    },
    {
      id: 'BD_CONSULT_SEAT',
      title: 'Kto odpowiada na konsultację',
      question: 'Planner czy reviewer?',
      where: 'src/engine/orchestrator/consult/request.ts:93',
      inputs: ['task.fix', 'reason'],
      branches: [
        { if: 'task.fix ustawione i reason != deviation', then: 'review: jedno bezstanowe wywołanie reviewera z pełnym promptem (runReviewerCall); usage na reviewerze' },
      ],
      default: 'plan: askPlannerSession na sesji plannera (resumed); usage na plannerze. Bez bloku reviewer: planner jest reviewerem (resolveReviewerRunner) → runners.',
      notes: 'Prompt konsultacji niesie: plan, task z rewizjami, diff taska od startSnapshot lineage (tylko własne pliki, 40 000 znaków), attemptFailures, failingOutput (4000 znaków), report, wcześniejsze konsultacje, inne taski, instrukcje operatora.',
    },
    {
      id: 'BD_CONSULT_ACTION',
      title: 'Zastosowanie odpowiedzi seat-a',
      question: 'Jaką akcję niesie ConsultAnswer i co run z nią robi?',
      where: 'src/engine/orchestrator/consult/apply.ts:449',
      inputs: ['answer.answer.action'],
      branches: [
        { if: 'guidance', then: 'instructions + context → consultAttemptError → jedna próba więcej (retry kind=consult)' },
        { if: 'rewrite-task', then: 'guardViolation? → restoreAttemptFiles; REPLACE_TASK (id, criteria, fix, parentId zachowane; revision+1); tasks_planned, task_replaced' },
        { if: 'split-task', then: 'guardViolation? → restoreAttemptFiles; INSERT_TASKS (next free ids, parentId=lineage; dependsOn innych tasków przepięte); rodzic do replacedParents' },
        { if: 'verify', then: 'verifySelectionError → runBriefGate(checkIds) → validateCommitAndAdvance method=consulted' },
        { if: 'ask-user', then: 'applyAskUser: QuestionPrompt; odpowiedź → RECORD_CORRECTION; zwrot jako guidance' },
        { if: 'confirm', then: 'CONFIRM_DECISIONS: zaakceptowane decyzje w słowach implementera do plan.decisions' },
      ],
      default: 'assertNever: schemat Zod dopuszcza tylko te sześć akcji. Schemat odrzuca też rewrite z innym id, split dziecka (parentId), check cmd poza polityką planu, npm run ze skryptem, którego package.json nie ma (gdy żaden task go nie pisze), render bez validation.render albo ze złym id i test check z plikiem, którego nie ma w workspace ani w plikach odpowiedzi lub czekających tasków (answerContract, consult/request.ts:134); seat dostaje jedną naprawę.',
      notes: 'Konsultacja nie oferuje wyborów, których odpowiedź użytkownika nie wykona (zmiana narzędzia lub modelu seat-a, kupno kredytów, czekanie na reset): reguła answer rule w kontrakcie konsultacji; gdy seat w ogóle nie może obsłużyć wywołania, mówi to w answer.diagnosis, a zmiana seat-a idzie przez /crew.',
    },
    {
      id: 'BD_GUARD_VIOLATION',
      title: 'Strażnik kryteriów przy rewrite/split',
      question: 'Czy zamiennik briefu gubi kryterium albo check kryterium?',
      where: 'src/engine/orchestrator/consult/apply.ts:106',
      inputs: ['task.criteria', 'spec.criteria', 'plan.criteria[].checkIds', 'task.checks'],
      branches: [
        { if: 'rewrite zmienia zbiór criteria', then: 'applyGuardQuestion → ask-user: How should Txxx proceed?' },
        { if: 'rewrite gubi check wymagany przez kryterium', then: 'ask-user' },
        { if: 'subtaski razem gubią kryterium albo jego check', then: 'ask-user' },
      ],
      default: 'Zamiennik przechodzi.',
    },
    {
      id: 'BD_VERIFY_SELECTION',
      title: 'Walidacja wyboru verify',
      question: 'Czy checkIds z odpowiedzi verify są poprawne?',
      where: 'src/engine/orchestrator/consult/apply.ts:240',
      inputs: ['action.checkIds', 'checkRegistry', 'dueCriterionIds(state, task.id)'],
      branches: [
        { if: 'puste', then: 'failed: the verify selection names no check' },
        { if: 'nieznany id', then: 'failed: names unknown checks' },
        { if: 'brakuje checku due kryterium taska', then: 'failed: misses the task criteria checks' },
      ],
      default: 'runBriefGate z tymi checkIds; każdy musi być pass.',
    },
    {
      id: 'BD_ASK_REPLY',
      title: 'Odpowiedź użytkownika na ask-user',
      question: 'Czy pytanie seat-a dostało odpowiedź?',
      where: 'src/engine/orchestrator/consult/apply.ts:406',
      inputs: ['waitForPlannerReply', 'question.default'],
      branches: [
        { if: 'brak odpowiedzi i brak default', then: 'failed: The planner question remains unanswered.' },
        { if: 'pusty ⏎ z default', then: 'default jako odpowiedź' },
      ],
      default: 'SET_PLANNER_CONVERSATION answered; recordUserMessage; RECORD_CORRECTION (Question/Answer) → guidance z tekstem odpowiedzi.',
    },
    {
      id: 'BD_HANDED_BACK',
      title: 'Konsultacja oddała nowy brief pętli',
      question: 'Czy bieżący task to nowa rewizja albo pierwsze dziecko splitu, które pętla ma dispatchować?',
      where: 'src/engine/orchestrator/task/retry.ts:106',
      inputs: ['state.pendingRecovery', 'tasks[currentTaskIndex]', 'task.revision', 'parentId / lineageIdOf'],
      branches: [
        { if: 'pendingRecovery ustawione', then: 'false' },
        { if: 'current.id == task.id i revision większa', then: 'true: RESET_TASK; rerunReplacedTask w tym samym runSingleTask' },
        { if: 'current.parentId == lineage taska i task zniknął z listy', then: 'true (pierwsze dziecko splitu)' },
      ],
      default: 'false; bez recovery i bez handed back → halt retry-exhausted (retry.ts:301).',
    },
    {
      id: 'BD_RESTORE_ON_HALT',
      title: 'Rollback po wyczerpaniu drabiny',
      question: 'Czy pliki briefu wracają do stanu task-start po halcie?',
      where: 'src/engine/orchestrator/task/step.ts:623',
      inputs: ['retry.completed', 'retry.state.pendingRecovery.reason', 'isConsultBoundReason'],
      branches: [
        { if: 'halt i powód NIE jest consult-bound-spent / planner-calls-spent', then: 'restoreExhaustedTaskFiles: każdy plik zmieniony od task-start (wszystkie próby) wraca; warning Restored N failing task changes' },
        { if: 'powód consult-bound', then: 'pliki zostają: Continue retryuje na nich, Skip je cofa (skipHaltedBrief)' },
      ],
      default: 'Brak haltu: nic nie cofane.',
      notes: 'Rollback po rewrite/split cofa tylko bieżącą próbę (restoreAttemptFiles od attemptSnapshot). Denial bramki cofa tylko odrzucone pliki. Hook denial cofa cały brief od task-start. withAttemptRestoreScope dopisuje każdy zapis do restoreFiles, także te spoza suggestedFiles, z pominięciem gitignored.',
    },
    {
      id: 'BD_PLANNER_CALL_FAILURE',
      title: 'Nieudane wywołanie seat-a konsultacji',
      question: 'Jak klasyfikować wyjątek z konsultacji (stale, deviation, drabina)?',
      where: 'src/engine/orchestrator/task/retry.ts:144',
      inputs: ['err', 'thrownConsultSeat(err)', 'diagnosePlannerCallFailure', 'typedOutputError.isSeatProtocol'],
      branches: [
        { if: 'retention / local save failure', then: 'rethrow: run pada' },
        { if: 'abort', then: 'loadState; return bez haltu' },
        { if: 'recovery już w stanie', then: 'tylko error row' },
        { if: 'seat protocol error', then: 'seatProtocolHaltIssue (seat-protocol-error)', next: 'recovery' },
        { if: 'call-failed bez znanego seat-a', then: 'halt retry-exhausted z allowRetryOverride' },
      ],
      default: 'plannerCallHaltIssue: halt na seat-cie (plan albo review), seatSwitches, swap; recordFailedTask (evidence status failed).',
    },
    {
      id: 'BD_SEAT_RETRY',
      title: 'Seat retry wokół wywołania implementera',
      question: 'Co dzieje się z przejściowym błędem albo limitem z bliskim resetem?',
      where: 'src/engine/orchestrator/escalation/seat-wait.ts:199',
      inputs: ['withSeatRetry (BOUNDS.transientRetries = 3)', 'classifySeatFailure', 'parseUsageLimitReset', 'BOUNDS.rateLimitResetWaitMs = 600 000'],
      branches: [
        { if: 'błąd przejściowy', then: 'do 3 powtórzeń z backoff; seat_retry; usage odrzuconych prób doliczone' },
        { if: 'rate-limited z resetem ≤ 10 min', then: 'SET_SEAT_WAIT {seat, resetAt, tool, kind, holds}; seat_wait_started; czeka; CLEAR_SEAT_WAIT; to samo wywołanie raz jeszcze. Stop w trakcie i kontynuacja na innym narzędziu BUILD zdejmuje czekanie (recovery RC_SEAT_WAIT_HELD)' },
        { if: 'reset dalszy albo nieznany', then: 'porażka wraca do wołającego: usage-limit → Seat down', next: 'recovery' },
      ],
      default: 'Sukces. Żadna z tych prób nie jest próbą lineage. → zobacz runners.',
    },
    {
      id: 'BD_CONTINUATION_CUT',
      title: 'Przecięte wywołanie i steer',
      question: 'Czy wywołanie implementera zostało przecięte (Esc, /steer, idle cut) i ma być wznowione w miejscu?',
      where: 'src/engine/orchestrator/continuation.ts:221',
      inputs: ['sinks.consumeBoundaryInterrupt', 'bodySignal.aborted vs ctx.signal.aborted', 'processError.isIdleTimeout', 'callbacks.onContinuationNeeded'],
      branches: [
        { if: 'przerwane w tej próbie albo idle cut, a run nie zatrzymany i jest onContinuationNeeded', then: 'INTERRUPT_STEP mid-step z kept files; turn_interrupted; czeka na tekst; RESUME_STEP; recordSteer; partial = dotychczasowy output; steer = tekst; body znowu' },
        { if: 'brak onContinuationNeeded (headless)', then: 'wyjątek idzie dalej' },
      ],
      default: 'Wynik wywołania wraca. Następny prompt niesie continuation.partial, steer i changedDeclaredFilesNote (pliki, które przecięta próba już zmieniła), allowNoChange gdy kept.',
    },
    {
      id: 'BD_CADENCE_REVIEW',
      title: 'Review po każdym briefie',
      question: 'Czy po udanym briefie biegnie task review?',
      where: 'src/engine/orchestrator/task/loop.ts:271',
      inputs: ['config.workflow.review'],
      branches: [
        { if: 'task', then: 'runScheduledReview(afterTaskId): fix tasks z review doklejone do listy; stopped → pętla stopped', next: 'review' },
      ],
      default: 'end: żadnego review do ostatniego briefu.',
    },
    {
      id: 'BD_BOUNDARY_PAUSE',
      title: 'Pause after this brief',
      question: 'Czy użytkownik zażądał pauzy na granicy briefów?',
      where: 'src/engine/orchestrator/task/loop.ts:286',
      inputs: ['sinks.consumeBoundaryPause (stop sheet, intent pause-after-brief, src/features/workflow/stop/options.ts:230)'],
      branches: [
        { if: 'tak', then: 'status paused → parkAtBoundary: INTERRUPT_STEP cut=boundary na następnym briefie (albo review); czeka na ⏎/resume; RESUME_STEP; continuation.hold(steer)' },
      ],
      default: 'Następny brief.',
    },
    {
      id: 'BD_LOOP_END',
      title: 'Hand-off do final review',
      question: 'Czy po pętli run może wejść w final review?',
      where: 'src/engine/orchestrator/run/task-execution.ts:392',
      inputs: ['taskResult.status', 'state.phase'],
      branches: [
        { if: 'status != complete', then: 'summary, completed=false (halt, stop, park)' },
        { if: 'phase ani implementing ani final-review', then: 'summary bez review' },
        { if: 'complete i phase implementing/final-review', then: 'recordRunSnapshotForRun; captureReviewedCandidate; recheckMergedCandidate (po Apply merge); runFinalReviewPhase; fix tasks → runTaskLoop znowu', next: 'review' },
      ],
      default: 'Brak.',
    },
    {
      id: 'BD_QUEUE_PHASE',
      title: 'Przyjęcie wiadomości do kolejki',
      question: 'Czy wiadomość użytkownika może wejść do messageQueue?',
      where: 'src/engine/orchestrator/queue/submit.ts:51',
      inputs: ['isLivePhase / isImplementerPhase', 'MAX_QUEUE_SIZE = 50', 'pending first delivery'],
      branches: [
        { if: 'faza nie live', then: 'rejected phase-unavailable z warning' },
        { if: '50 wiadomości czeka', then: 'rejected queue-full' },
      ],
      default: 'ENQUEUE_USER_MSG; recordUserMessage; message_queued z seat (plan/build/review) i taskId bieżącego briefu.',
    },
    {
      id: 'BD_QUEUE_ROUTE',
      title: 'Droga dostarczenia wiadomości',
      question: 'Jak wiadomość dociera do seat-a?',
      where: 'src/engine/orchestrator/queue/submit.ts:127',
      inputs: ['steering.current() (trwające wywołanie)', 'messageSeat(phase, reviewing)', 'planner.injectUserTurn'],
      branches: [
        { if: 'trwa wywołanie tego samego seat-a ze sterowaniem', then: 'mid-call: deliverToRunningCall; wiadomość zaklejona na czas dostarczania', next: 'BD_MIDCALL_OUTCOME' },
        { if: 'seat=plan bez wywołania', then: 'dispatchNativeInjection (tylko w fazie plan; planner bez injectUserTurn → unsupported)' },
        { if: 'seat=build/review bez wywołania', then: 'czeka; następny prompt BUILD drenuje (absorbBuildCorrections) jako continuation.steer; review drenuje drainQueueForReview' },
      ],
      default: 'Brak.',
      notes: 'Obrazy z wiadomości idą do implementera tylko gdy buildSeatSupportsImages; inaczej build_images_as_paths i ścieżki w tekście.',
    },
    {
      id: 'BD_MIDCALL_OUTCOME',
      title: 'Wynik dostarczenia mid-call',
      question: 'Czy działające wywołanie przyjęło wiadomość?',
      where: 'src/engine/orchestrator/queue/submit.ts:208',
      inputs: ['SteerOutcome: delivered | deferred | uncertain', 'buildTask dla call.taskId'],
      branches: [
        { if: 'uncertain, albo delivered na build bez taska', then: 'MARK_POSSIBLE_DUPLICATE: dostarczona znowu z prefiksem You may have seen this message already' },
        { if: 'delivered, build', then: 'absorbBuildCorrectionsById via=mid-call: DRAIN_QUEUE + RECORD_CORRECTION' },
        { if: 'delivered, plan', then: 'MARK_DELIVERED_NATIVE via=mid-call; queue_drained' },
        { if: 'delivered, review', then: 'commitQueueMessagesDrained destination=reviewer' },
        { if: 'deferred', then: 'zostaje w kolejce; plan → próba native injection' },
      ],
      default: 'Brak.',
    },
    {
      id: 'BD_CORRECTION_PASSES',
      title: 'Dodatkowe przebiegi po korektach',
      question: 'Czy po udanym wywołaniu w kolejce czekają nowe wiadomości?',
      where: 'src/engine/orchestrator/queue/build-corrections.ts:174',
      inputs: ['absorb() → count', 'result.success', 'signal'],
      branches: [
        { if: 'success i absorb() > 0', then: 'pass(): implement() z continuation.steer = wszystkie korekty, allowNoChange=true; usage sumowane' },
        { if: 'abort po ukończonym wywołaniu', then: 'usage ukończonego przebiegu zaksięgowane jako odrzucone' },
      ],
      default: 'Wynik ostatniego przebiegu idzie do bramki i checks.',
    },
    {
      id: 'BD_DRIFT_FINDINGS',
      title: 'Reguły raportu driftu',
      question: 'Jakie findings dostaje drift-report.json przed final review?',
      where: 'src/engine/orchestrator/drift/analyze.ts:67',
      inputs: ['tasks z statusami', 'changedFiles workspace', 'evidence ledger changedFiles', 'preRunChangedFiles'],
      branches: [
        { if: 'plik zmieniony poza declared set każdego taska', then: 'info out_of_scope_file (pre-existing, gdy brudny przed runem i nie w ledgerze)' },
        { if: 'task done/escalated, ale żaden suggestedFile nie w diffie', then: 'warning missing_expected_file' },
        { if: 'task failed, a jego plik w diffie', then: 'error failed_task_with_diff' },
        { if: 'diff niepusty, a każdy task failed/skipped', then: 'error orphan_diff' },
      ],
      default: 'passed = brak findings error. Artefakty plannera (plan.md, tasks.md, research.md, spec.md, review.md) są pomijane, chyba że brief je deklaruje. Raport liczony w final-review.ts:537 i wstrzyknięty do promptu reviewera → review.',
    },
  ],
  config: [
    { key: 'workflow.review', values: 'end | task', default: 'end', effect: 'end: brief gate nie uruchamia checks planu/taska; wszystko biegnie przed final review. task: checks taska i due kryteriów po każdym briefie, potem task review.', where: 'src/core/schemas/config.ts:87; src/engine/orchestrator/task/brief-gate.ts:57; src/engine/orchestrator/task/loop.ts:271' },
    { key: 'workflow.isolation', values: 'worktree | staged-copy | none', default: 'worktree', effect: 'Gdzie implementer pisze i gdzie biegną checks. none = checkout użytkownika, bez Apply, rollback zapisuje bajty w .splitbrief/sessions/<id>/reverted/.', where: 'src/core/schemas/config.ts:91; src/engine/orchestrator/run/task-execution.ts:322 (→ lifecycle)' },
    { key: 'workflow.approve', values: 'plan | none', default: 'plan', effect: 'plan: zatwierdzony plan potwierdza protectedOperations i npm run checks (planConfirmations) → bramka nie pyta drugi raz; planApprovesNpmScripts pozwala na npm run w cmd checks.', where: 'src/engine/orchestrator/approval/confirm.ts:54; src/engine/orchestrator/validation/run-checks.ts:96' },
    { key: 'workflow.max_retries', values: 'wycofane', default: '—', effect: 'Ładuje się z jednym powiadomieniem i nic nie zmienia. Liczba retry to stała DEFAULT_LOCAL_RETRIES = 1.', where: 'src/core/schemas/config.ts:89; src/core/pipeline-spec/retries.ts:1' },
    { key: 'approval.allowed_paths', values: 'lista globów', default: 'brak', effect: 'Zapis pasujący do globu jest write_in_scope (auto). Nie zwalnia klas chronionych: package_change, sensitive_change i destructive nadal pytają.', where: 'src/core/schemas/config.ts:52; src/engine/orchestrator/approval/action-classifier.ts:151' },
    { key: 'approval.feed_rejections_to_planner', values: 'boolean', default: 'true', effect: 'Czytane przez pętlę wywołań plannera (→ planning); build tylko zapisuje rejection evidence.', where: 'src/core/schemas/config.ts:51; src/engine/orchestrator/planning/call-loop.ts:14' },
    { key: 'implementer_profiles', values: 'mapa profili + default', default: 'brak (jeden implementer)', effect: 'Routing wybiera profil o najmniejszym oknie, które mieści prompt. Recovery może przypiąć profil (retryProfile).', where: 'src/core/schemas/config.ts:62; src/engine/orchestrator/task/routing-selection.ts:29' },
    { key: 'implementer.context_length', values: 'liczba tokenów', default: 'katalog modelu albo 32768', effect: 'Jawny budżet promptu profilu; bez niego katalog, wykrycie albo conservative-fallback.', where: 'src/engine/orchestrator/context-routing/context-length.ts:107' },
    { key: 'implementer.idle_kill_ms / implementer.timeout', values: 'ms', default: 'brak (tylko ostrzeżenie po 5 min)', effect: 'Cięcie wywołania przy ciszy albo po czasie. Cut liczy się jako próba; dwa z rzędu → runner-timeout-repeated.', where: 'src/engine/orchestrator/escalation/local-retries.ts:57; src/core/pipeline-spec/timeouts.ts:1' },
    { key: 'validation.test_command', values: 'komenda', default: 'z registry stacku', effect: 'Komenda dla checków test; poza pięcioma stackami bez niej check jest not-runnable (powód kończy się na set validation.test_command). Ustawiona komenda wyłącza też zawężanie fix checku do plików testów.', where: 'src/core/schemas/config.ts:78; src/engine/orchestrator/validation/run.ts:136' },
    { key: 'validation.test_pattern', values: 'glob', default: 'wykryty', effect: 'Jak check test znajduje pliki testowe dotknięte przez plik briefu.', where: 'src/engine/orchestrator/validation/commands.ts:45' },
    { key: 'validation.timeout_ms', values: 'ms ≥ 1000', default: '3 600 000 (STAGE_TIMEOUT_MS)', effect: 'Limit czasu każdego checku i formattera.', where: 'src/engine/orchestrator/validation/run-checks.ts:138; src/core/pipeline-spec/gates.ts:8' },
    { key: 'validation.stack', values: 'typescript | javascript | python | go | rust', default: 'wykryty', effect: 'Wymusza stack dla komend testowych i narrowing.', where: 'src/engine/orchestrator/validation/run.ts:68' },
    { key: 'validation.render', values: 'szablon komendy z {id} i {out}', default: 'brak', effect: 'Bez niego check render jest not-runnable. PNG kopiowane do renders dir sesji. Fix task z review albo rewrite z konsultacji z checkiem render bez tego klucza jest odrzucany schematem i wraca do seat-a.', where: 'src/engine/orchestrator/validation/run-checks.ts:315' },
    { key: 'hooks.pre_task / pre_validation / pre_escalation', values: 'komendy hooków', default: 'brak', effect: 'Odmowa pre_task i pre_validation → SKIP_TASK z rollbackiem; odmowa pre_escalation → halt retry-exhausted.', where: 'src/engine/orchestrator/task/pre-task.ts:61; src/engine/orchestrator/task/pre-validation-gate.ts:40; src/engine/orchestrator/escalation/handle.ts:346' },
    { key: 'BOUNDS (stałe)', values: 'consultsPerLineage 2, attemptsPerLineage 8, plannerCallsPerRun 10, extra +1/+4/+5, rateLimitResetWaitMs 600 000, transientRetries 3', default: 'stałe', effect: 'Limity drabiny i seat retry; Continue w recovery podnosi je przez GRANT_ALLOWANCE.', where: 'src/core/pipeline-spec/bounds.ts:1' },
    { key: 'CONTEXT_CODE_BUDGET_CHARS', values: '40 000', default: 'stała', effect: 'Łączny budżet znaków dla contextFiles briefu; plik, który go przekracza, jest przycięty z markerem.', where: 'src/engine/orchestrator/task/refresh-code.ts:35' },
    { key: 'MAX_QUEUE_SIZE', values: '50', default: 'stała', effect: 'Maksimum wiadomości czekających na pierwsze dostarczenie.', where: 'src/engine/orchestrator/queue/types.ts:7' },
  ],
  states: [
    { name: 'implementing', meaning: 'Pętla briefów biegnie albo czeka między briefami. START_TASK, RESUME_TASK, SKIP_TASK i RESET_TASK wracają tu.', where: 'src/core/state/machine.ts:347' },
    { name: 'validating-task', meaning: 'TASK_SENT: brief po próbie, biegnie brief gate. currentCode zdjęty ze stanu.', where: 'src/core/state/machine.ts:355' },
    { name: 'escalating', meaning: 'VALIDATION_FAIL po zużytym retry (attempt >= 1): drabina konsultuje seat.', where: 'src/core/state/machine.ts:370' },
    { name: 'task.status pending → in_progress → done | escalated | failed | skipped', meaning: 'done: VALIDATION_PASS method local/consulted. escalated: method escalated-*. skipped: SKIP_TASK (hook, recovery Skip, verify skipped). failed: evidence; RESET_TASK wraca do pending.', where: 'src/core/schemas/enums.ts:67' },
    { name: 'state.attempt', meaning: 'Numer próby bieżącego briefu (0 na starcie, +1 przy VALIDATION_FAIL). Nie mylić z lineage.attempts.', where: 'src/core/state/machine.ts:371' },
    { name: 'LineageRecord', meaning: 'Liczniki wspólne dla briefu, jego rewizji i dzieci splitu: consults, attempts, allowances, consultRecords, attemptFailures, corrections, carriedFailure, startSnapshot, dispatchedRevision, staleConsultedRevision.', where: 'src/core/schemas/workflow.ts:165' },
    { name: 'state.plannerCalls', meaning: 'used / allowance (10) na run; konsultacje plannera i reviewera zużywają ten jeden licznik.', where: 'src/core/schemas/workflow.ts:192' },
    { name: 'state.messageQueue', meaning: 'Wiadomości użytkownika: pending → drained / deliveredViaNative / deliveredMidCall / possibleDuplicate.', where: 'src/core/queue-state.ts:13' },
    { name: 'TaskLoopResult.status complete | stopped | paused', meaning: 'complete → final review; stopped → halt/stop/park; paused → parkAtBoundary i ponowne wejście.', where: 'src/engine/orchestrator/task/loop.ts:45' },
  ],
  scenarios: [
    {
      title: 'Brief przechodzi za pierwszym razem (review: end, worktree)',
      steps: [
        '1. runTaskLoop: pendingRecovery puste, T001 pending, dependsOn puste → bramka zależności przepuszcza.',
        '2. refreshAndPersistCode czyta pliki T001 z worktree; kotwica istnieje → action modify; UPDATE_TASK_CODE.',
        '3. selectRoutingProfile: jeden profil, fit=fits; configForProfile kopiuje contextLength. isAvailable()=true.',
        '4. runSingleTask: START_TASK; inputHashes bez zmian; brak hooków; snapshot task-start; RECORD_DISPATCH; isolation.acquire.',
        '5. implementer.implement(): claude-code pisze w worktree, raport done bez decisions. success=true.',
        '6. gateAttemptChanges: oba pliki write_in_scope → allow bez pytania.',
        '7. TASK_SENT → validating-task. runBriefGate: formatter na dwóch plikach; review=end → checkIds puste → bez komend. accepted=true.',
        '8. validateCommitAndAdvance: VALIDATION_PASS, task_completed, review-changes.json, evidence status done method local.',
      ],
      outcome: 'T001 done; żaden test nie biegł. Checks planu uruchomi dopiero runPreReviewChecks przed final review.',
    },
    {
      title: 'Checks czerwone, lokalny retry ratuje brief (review: task)',
      steps: [
        '1. Po próbie brief gate uruchamia task.checks: C1 (npm test -- file) fail, exit 1, failureKeys.',
        '2. checkFailureText → initialError; diagnosis check C1 failed. retryAndRecord: COUNT_ATTEMPT (lineage.attempts=1).',
        '3. runLocalRetries: attemptBoundSpent nie; rung 1: TASK_SENT, VALIDATION_FAIL (attempt=1), task_retry maxRetries=1.',
        '4. runRetryStep: refreshAndPersistCode entry=retry (action zostaje); implementer.retry(kind=local) z framingiem Your previous attempt had an error.',
        '5. gateAttemptChanges allow; confirmAttemptDecisions validate; validateAndCommit → runBriefGate: C1 pass.',
        '6. result completed method=local, attempts=1; COUNT_ATTEMPT (lineage.attempts=2); evidence retries=1.',
      ],
      outcome: 'T002 done po jednym retry. Lineage zużył 2 z 8 prób, 0 konsultacji.',
    },
    {
      title: 'Retry nie pomaga, planner daje guidance',
      steps: [
        '1. Lokalny retry znowu czerwony; VALIDATION_FAIL przy attempt=1 → phase escalating; rung wyczerpany.',
        '2. runnerHalt: outcome zwykły → null. pre_escalation brak → task_escalating.',
        '3. answer brak; consultBoundSpent nie (0/2, 2/8, 0/10). consultSeat: brak task.fix → plan.',
        '4. requestConsult na sesji plannera: prompt z diffem od startSnapshot, attemptFailures, failingOutput. Odpowiedź guidance.',
        '5. RECORD_CONSULT (consults=1), COUNT_PLANNER_CALL (1/10), consult_answered PLAN → T003: guidance.',
        '6. attempt(): consultAttemptError = błąd + ## Guidance from the planner; runRetryStep method=consulted; COUNT_ATTEMPT.',
        '7. Brief gate zielony → VALIDATION_PASS; evidence method consulted.',
      ],
      outcome: 'T003 done method=consulted (status done). Lineage: 3 próby, 1 konsultacja; run: 1 planner call.',
    },
    {
      title: 'Planner dzieli brief (split-task)',
      steps: [
        '1. Po guidance brief znów czerwony; konsultacja druga (consults=1 < 2).',
        '2. Odpowiedź split-task z 2 TaskSpec. guardViolation: criteria razem zachowane → brak pytania.',
        '3. restoreAttemptFiles: pliki bieżącej próby wracają do attemptSnapshot; wcześniejsze briefy nietknięte.',
        '4. INSERT_TASKS: T010, T011 z parentId=T003, wstawione w miejsce T003; dependsOn innych tasków na T003 → [T010, T011]; T003 do replacedParents.',
        '5. handleRetryAndEscalation zwraca failedRetry bez recovery; consultHandedBackToLoop=true → RESET_TASK T010; rerunReplacedTask.',
        '6. T010 i T011 dzielą liczniki lineage (consults=2 → kolejna konsultacja już nie przejdzie bez Continue).',
      ],
      outcome: 'Dwa nowe briefy w kolejności; lineage ma 2/2 konsultacji. Trzecia porażka w tej lineage da consult-bound-spent.',
    },
    {
      title: 'Implementer trafia na limit konta w trakcie briefu',
      steps: [
        '1. pipeline/run.ts: provider rzuca 429; thrownSeatFailure → isSeatDown → success=false outcome=usage-limit.',
        '2. runSeatCall: seatResetWaitDeadline: reset za 4 godziny > 10 min → brak czekania; porażka wraca.',
        '3. run-implementation.ts: outcome usage-limit → workspace.retain (częściowe edycje zostają).',
        '4. handleFailedImplementation: buildSeatDownIssue (classifySeatFailure, resetAt), loadSeatSwapContext (fallback seat-a).',
        '5. INTERRUPT_STEP mid-step source=seat; raisePendingRecovery → recovery_prompted; loop zwraca stopped.',
      ],
      outcome: 'Halt Seat down · limit konta. Obszar recovery: automatyczny switch na fallback (raz na run i seat) albo menu retry-later / switch-seat / skip / end.',
    },
    {
      title: 'Lineage zużywa 8 prób: consult-bound-spent i Continue',
      steps: [
        '1. Przed kolejną próbą po konsultacji attemptBoundSpent: attempts 8 >= 8 → consultBoundHalt.',
        '2. buildConsultBoundRecoveryIssue: Last diagnosis, liczniki; consult_bound_spent; raisePendingRecovery.',
        '3. step.ts: halt consult-bound → pliki briefu NIE wracają (isConsultBoundReason).',
        '4. Użytkownik wybiera Continue z notatką → GRANT_ALLOWANCE target=lineage: consultAllowance 3, attemptAllowance 12, carriedFailure = ostatni output.',
        '5. RESET_TASK; pętla dispatchuje brief; runsOnOwnFiles=true (carriedFailure) → bez stale konsultacji, pierwszy snapshot zostaje; pierwsza próba rusza jako implementer.retry z carriedFailure.',
      ],
      outcome: 'Brief kontynuuje na plikach ostatniej próby z 4 nowymi próbami i 1 konsultacją.',
    },
    {
      title: 'Zapis do package.json: karta potwierdzenia, odmowa',
      steps: [
        '1. Direct writer zmienia src/a.ts i package.json. gateAttemptChanges → gateChangedFiles po jednym pliku.',
        '2. classifyAction(package.json): isKnownPackagePath → package_change → confirm. confirmedEarlierInRun: brak wpisu (plan nie wymieniał tej operacji).',
        '3. approval_prompted; onTieredApproval → karta Change a package manifest:. Użytkownik odrzuca z powodem.',
        '4. approval_rejected; decision deniedFiles=[package.json]. workspace.revert([package.json]); src/a.ts zostaje.',
        '5. Outcome allow z denial: error row Approval gate denied package.json: ...; rejection evidence. Walidacja biegnie na src/a.ts.',
      ],
      outcome: 'Brief może przejść bez zmiany package.json. Gdyby package.json był jedynym plikiem → halt approval-denied.',
    },
    {
      title: 'Użytkownik pisze korektę w trakcie buildu',
      steps: [
        '1. Faza implementing, trwa wywołanie claude-code dla T004 (steering.current() = call seat build).',
        '2. enqueueUserMessage: ENQUEUE_USER_MSG, message_queued seat=build taskId=T004 steerable=true.',
        '3. deliverToRunningCall → delivered. absorbBuildCorrectionsById via=mid-call: DRAIN_QUEUE, RECORD_CORRECTION (lineage.corrections).',
        '4. Gdyby wywołanie nie przyjęło (deferred): runWithCorrectionPasses po sukcesie wywołania widzi absorb()>0 → pass() z continuation.steer i allowNoChange.',
        '5. Gdyby wiadomość przyszła podczas checks: brief gate correction=true → CORRECTION_AFTER_CHECKS → RESUME_TASK → próba dostarczająca (COUNT_ATTEMPT, bez rungu) → checks znowu.',
      ],
      outcome: 'Każda późniejsza konsultacja i review widzi korektę w operatorInstructions.',
    },
    {
      title: 'Zależność nieudana: dependency-blocked',
      steps: [
        '1. T005 skipped przez recovery Skip. T006.dependsOn = [T005].',
        '2. checkDependencyGate: hasDependencyFailed=true. dependents: T006 i T008 (też zależy od T005).',
        '3. buildDependencyBlockedRecoveryIssue; affectedTaskIds [T006, T008]; raisePendingRecovery; loop stopped.',
      ],
      outcome: 'Halt Needs you · dependency-blocked z akcjami skip-current-task i end-run. Jedno pytanie dla wszystkich zablokowanych briefów.',
    },
    {
      title: 'Brief stale: wejścia zmienione przez wcześniejszy brief, którego plan nie przewidział',
      steps: [
        '1. T007.inputHashes z taskFromSpec (suggestedFiles + contextFiles). T003 (po rewrite) zmienił plik kontekstowy T007, którego nie deklarował.',
        '2. inputsMovedUnexpectedly: ruszony plik nie jest w suggestedFiles wcześniejszych tasków → stale.',
        '3. requestConsult reason=stale (STALE_CONSULT_ANSWER_JSON_SCHEMA: guidance / rewrite-task / ask-user); bez zużycia allowance.',
        '4. guidance → SET_TASK_INPUT_HASHES (staleConsultedRevision=1); pierwsza próba jako implementer.retry z instrukcjami.',
      ],
      outcome: 'Brief rusza z wiedzą o nowym stanie plików. Druga stale konsultacja tej rewizji nie wystąpi.',
    },
    {
      title: 'Dwa fix tasks dzielą failure jednego czerwonego npm test',
      steps: [
        '1. Review: V1 npm test czerwone z kluczami test/a.test.ts::parses i test/b.test.ts::loads. Reviewer daje T024 (oba klucze) i T025 (klucz b), ten sam cykl.',
        '2. T024 w bramce: fixCheckKeys widzi, że T025 (niedokończony, ten sam cykl, ta sama komenda) niesie test/b.test.ts::loads → sharedWith.',
        '3. Własne failures to same testy → check biegnie test runner stacku tylko na test/a.test.ts i test/b.test.ts.',
        '4. a przechodzi, b nadal czerwony: left puste, deferred [b → T025]. Wiersz: Fix check V1 · npm test · 1 of your 2 failures gone · 1 left to T025. T024 settled.',
        '5. T025 w bramce: brak niedokończonych rodzeństwa z kluczem b → b musi zniknąć; jeśli zostaje: your 1 failure remains → retry z framingiem fix briefu, potem konsultacja REVIEW.',
      ],
      outcome: 'Dzielona failure blokuje tylko ostatni fix task, który ją niesie. Następny review i tak uruchamia całe npm test.',
    },
  ],
  files: [
    { path: 'src/engine/orchestrator/run/task-execution.ts', role: 'runTasksAndReview: workspace, pętla, pauza na granicy, hand-off do final review i fix cycles' },
    { path: 'src/engine/orchestrator/task/loop.ts', role: 'runTaskLoop: iteracja po tasks, bramka zależności, routing, dostępność, cadence review' },
    { path: 'src/engine/orchestrator/task/step.ts', role: 'runSingleTask: jedna próba od START_TASK do VALIDATION_PASS; stale refresh; rollback po halcie' },
    { path: 'src/engine/orchestrator/task/run-implementation.ts', role: 'wywołanie implementera w attempt workspace z continuation, approveWrite i korektami' },
    { path: 'src/engine/orchestrator/task/implementation-failure.ts', role: 'klasyfikacja success=false: seat down, defekt, API apply, drabina' },
    { path: 'src/engine/orchestrator/task/attempt-gate.ts', role: 'gateAttemptChanges: bramka chronionych ścieżek po próbie, revert odrzuconych' },
    { path: 'src/engine/orchestrator/task/brief-gate.ts', role: 'runBriefGate: formatter, wybór checks wg cadence, werdykt, korekta po checks' },
    { path: 'src/engine/orchestrator/task/task-checks.ts', role: 'runTaskChecks: uruchomienie i zapis checks, fix check verdict rows' },
    { path: 'src/engine/orchestrator/task/commit.ts', role: 'validateCommitAndAdvance: VALIDATION_PASS, task_completed, booking plików (bez gita)' },
    { path: 'src/engine/orchestrator/task/retry.ts', role: 'retryAndRecord, consultHandedBackToLoop, handleTaskPlannerCallFailure' },
    { path: 'src/engine/orchestrator/task/rollback.ts', role: 'restore*: cofanie plików briefu, próby, hook denial, przerwanego briefu' },
    { path: 'src/engine/orchestrator/task/restore-scope.ts', role: 'withAttemptRestoreScope: dopisuje każdy zapis do restoreFiles snapshotów' },
    { path: 'src/engine/orchestrator/task/stale-inputs.ts', role: 'inputHashes, inputsMovedUnexpectedly, runsOnOwnFiles' },
    { path: 'src/engine/orchestrator/task/refresh-code.ts', role: 'refreshAndPersistCode, lineageAnchorAction, budżet contextFiles' },
    { path: 'src/engine/orchestrator/task/skip-brief.ts', role: 'skipBrief / skipHaltedBrief: SKIP_TASK z rollbackiem i evidence' },
    { path: 'src/engine/orchestrator/task/routing-selection.ts', role: 'selectRoutingProfile: przypięty profil, context-overflow halt' },
    { path: 'src/engine/orchestrator/context-routing/route.ts', role: 'routeTaskToImplementerProfile; assessment.ts, estimation.ts, context-length.ts, decision.ts' },
    { path: 'src/engine/orchestrator/escalation/handle.ts', role: 'handleRetryAndEscalation: drabina, konsultacje, limity, halty runnera' },
    { path: 'src/engine/orchestrator/escalation/local-retries.ts', role: 'runLocalRetries: jeden rung, haltsLocalRetries, consecutiveTimeouts' },
    { path: 'src/engine/orchestrator/escalation/step.ts', role: 'runRetryStep: jedna próba retry z bramką, decision confirm i validateAndCommit' },
    { path: 'src/engine/orchestrator/escalation/seat-wait.ts', role: 'runSeatCall: transient retry, czekanie na reset' },
    { path: 'src/engine/orchestrator/consult/request.ts', role: 'requestConsult: wybór seat-a, prompt, RECORD_CONSULT, COUNT_PLANNER_CALL' },
    { path: 'src/engine/orchestrator/consult/apply.ts', role: 'applyConsultAnswer: guidance, rewrite, split, verify, ask-user, confirm; strażnik kryteriów' },
    { path: 'src/engine/orchestrator/consult/decision-confirm.ts', role: 'confirmAttemptDecisions: potwierdzenie decyzji implementera przed walidacją' },
    { path: 'src/engine/orchestrator/approval/action-classifier.ts', role: 'classifyAction: klasy read / write_in_scope / write_out_of_scope / destructive / package_change / sensitive_change' },
    { path: 'src/engine/orchestrator/approval/tiered-approval.ts', role: 'gateAction: confirm dla klas chronionych, auto dla reszty' },
    { path: 'src/engine/orchestrator/approval/confirm.ts', role: 'gateConfirmTier, confirmedEarlierInRun, planConfirmations' },
    { path: 'src/engine/orchestrator/approval/gate-files.ts', role: 'gateChangedFiles: plik po pliku, cancelled vs denied' },
    { path: 'src/engine/orchestrator/queue/submit.ts', role: 'enqueueUserMessage, createQueueHandler: mid-call, native, kolejka' },
    { path: 'src/engine/orchestrator/queue/build-corrections.ts', role: 'absorbBuildCorrections, buildCorrectionInput, runWithCorrectionPasses' },
    { path: 'src/engine/orchestrator/queue/drain.ts', role: 'claim/release wiadomości, DRAIN_QUEUE' },
    { path: 'src/engine/orchestrator/queue/native-injection.ts', role: 'dispatchNativeInjection do sesji plannera' },
    { path: 'src/engine/orchestrator/continuation.ts', role: 'withContinuationLoop: przecięte wywołanie, steer, partial' },
    { path: 'src/engine/orchestrator/drift/analyze.ts', role: 'analyzeBriefDrift: findings drift-report.json' },
    { path: 'src/engine/orchestrator/validation/run-checks.ts', role: 'runChecks: cmd / test / render, polityki, statusy' },
    { path: 'src/engine/orchestrator/run/pre-review-checks.ts', role: 'runPreReviewChecks: checks planu i tasków przed final review (granica z review)' },
    { path: 'src/engine/implementers/pipeline/run.ts', role: 'createImplementerBase: prompt briefu, klasyfikacja outcome, tripwire, no-staged-change' },
    { path: 'src/engine/implementers/apply.ts', role: 'applyCode: SEARCH/REPLACE albo cały plik dla extracted-code' },
    { path: 'src/engine/implementers/file-bundle.ts', role: 'file-bundle-v1: gramatyka API, BundleApplyResult (applied / rejected / partial / failed)' },
    { path: 'src/engine/spec/plan-tasks.ts', role: 'taskFromSpec: kompilacja TaskSpec → Task (inputHashes, checks, evidence)' },
    { path: 'src/engine/spec/prompt-formatter.ts', role: 'formatTaskPrompt / formatRetryPrompt: tekst briefu dla implementera' },
    { path: 'src/core/pipeline-spec/bounds.ts', role: 'BOUNDS: limity lineage i runu' },
    { path: 'src/core/pipeline-spec/retries.ts', role: 'DEFAULT_LOCAL_RETRIES = 1' },
    { path: 'src/core/state/machine.ts', role: 'przejścia START_TASK, TASK_SENT, VALIDATION_PASS/FAIL, SKIP_TASK, COUNT_ATTEMPT, REPLACE_TASK, INSERT_TASKS, GRANT_ALLOWANCE' },
  ],
  gotchas: [
    'Kompilacja briefu: planner nie pisze tasks.md. taskFromSpec (plan-tasks.ts:23) robi Task z TaskSpec: description = intent, tests = checks kind=test, evidence = sformatowane checks, inputHashes = sha256 suggestedFiles + contextFiles (brak pliku = hash pustego). Prompt dla implementera składa formatTaskPrompt: Project, Task/Action/Files, Description, Signature, Type Definitions, Pattern, Plan context (read-only), Implementation Steps (Guidance only), Tests, Scope, Escalation, Evidence, Constraints, instrukcja odpowiedzi wg trybu zapisu.',
    'Docs (PLANNERS-AND-IMPLEMENTERS.md:229) mówią, że implementer widzi tylko swój brief i nie ma dostępu do planu. Kod (prompt-formatter.ts:95-112) dodaje sekcję ### Plan context (read-only): podsumowanie planu, ledger decyzji i kryteria taska. Kod wygrywa.',
    'Docs (APPROVAL-AND-RECOVERY.md:81) mówią, że przerwana próba cofa licznik prób. W kodzie nie ma takiego przejścia: local-retries.ts:241 wykonuje COUNT_ATTEMPT przed sprawdzeniem abortu (:247); retryAndRecord pomija tylko pierwszy COUNT_ATTEMPT, gdy sygnał już był anulowany (retry.ts:238). machine.ts nie ma akcji zmniejszającej lineage.attempts.',
    'Bramka chronionych ścieżek biegnie w dwóch miejscach: dla extracted-code (extracted-code.ts:75) i bundla API (apply-file-bundle.ts:211) approveWrite pyta PRZED zapisem; dla direct writera gateAttemptChanges pyta PO wywołaniu i cofa odrzucony plik. Docs opisują głównie drugi przypadek.',
    'Commit w tym obszarze to przejście VALIDATION_PASS plus evidence; żadne polecenie git. workflow.git.commitStrategy jest wycofane (config.ts transform). Parametr commitSuffix (after consult) jest przyjmowany, ale validateCommitAndAdvance go nie czyta.',
    'Z domyślnym workflow.review=end brief gate nie uruchamia żadnego checku planu ani taska; biegnie tylko formatter. Testy biegną dopiero przed final review (runPreReviewChecks). Brief jest done, choć jego testy nikt jeszcze nie uruchomił.',
    'write_out_of_scope jest auto: plik poza suggestedFiles nie pyta ani nie blokuje; jest tylko odnotowany (task_touched_not_suggested) i trafia do driftu jako info.',
    'Maks. prób na brief: 1 próba + 1 lokalny retry przed konsultacją (DEFAULT_LOCAL_RETRIES=1), ale limit lineage to 8 prób i 2 konsultacje (BOUNDS). Próba dostarczająca odpowiedź użytkownika i pierwsza nieudana próba też liczą się do 8. Retry seat-a (transient, czekanie na reset ≤ 10 min) nie liczą się.',
    'Licznik state.plannerCalls (10 na run) zużywają także konsultacje reviewera dla fix tasków. Konsultacje stale i deviation (decision confirm) nie zużywają ani consults, ani plannerCalls.',
    'no-staged-change kończy lokalny rung natychmiast: implementer, który po feedbacku znów nic nie napisał, idzie prosto do konsultacji. unauthenticated / usage-limit / tool-use-limit / input-too-large / defekty nie liczą się jako próba i omijają drabinę.',
    'Dwa timeouty albo no-progress-cuty z rzędu na jednym briefie halują jako runner-timeout-repeated (TIMEOUTS.consecutiveTimeoutsHalt=2). Inny wynik pomiędzy zeruje licznik.',
    'Rollback ma trzy zasięgi: rewrite/split cofa tylko bieżącą próbę (attemptSnapshot); odmowa bramki cofa tylko odrzucone pliki; wyczerpana drabina, Skip i odmowa hooka cofają cały brief od task-start. Halt consult-bound nie cofa nic: Continue retryuje na plikach ostatniej próby.',
    'Po rewrite lub split pętla nie wraca do runTaskLoop od razu: rerunReplacedTask wywołuje runSingleTask rekurencyjnie w tym samym obiegu (step.ts:111). Długość tasks jest czytana co obieg, więc dzieci splitu wchodzą do pętli naturalnie.',
    'Korekta, która przyjdzie, gdy checks są już zielone, nie jest ignorowana: brief wraca do próby dostarczającej (CORRECTION_AFTER_CHECKS) i checks biegną jeszcze raz. Ta próba liczy się do 8, ale nie zużywa rungu.',
    'Przy bundle API status partial albo failed write-uncertain brief haluje implementation-error zamiast retry; w checkout mode zmiany próby są cofane, w worktree zostają do ręcznego pogodzenia.',
    'Routing wybiera NAJMNIEJSZE okno kontekstu, które mieści prompt (compareProfileRouteRank), nie największe. Brak katalogu modelu → 32768 jako conservative-fallback, co łatwo daje overflow na jedynym profilu.',
    'Zmiana na main (2026-10): fix task przechodzi, gdy znikną jego własne failures; failure, którą niesie też niedokończony fix task tego samego cyklu i tej samej komendy, czeka na niego (1 left to T025), a fix check z samymi testami biegnie tylko na ich plikach (0b28a3f).',
    'Zmiana na main (2026-10): check, którego plik testu, skrypt npm albo test cargo nie istnieje w zmianie, jest czerwony (fail z placeholderem), nie not-runnable, więc builder go naprawia zamiast halt-u (befef41).',
    'Zmiana na main (2026-10): prompt BUILD dłuższy niż linia poleceń narzędzia nie wchodzi w drabinę: halt Prompt too large for <tool> on T001 od razu, bez retry i konsultacji (afbb4ea).',
    'Zmiana na main (2026-10): czekanie na reset BUILD zdejmuje się, gdy kontynuacja uruchamia BUILD na innym narzędziu (42fb57f).',
  ],
});
