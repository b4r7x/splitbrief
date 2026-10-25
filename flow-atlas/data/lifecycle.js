window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: 'lifecycle',
  order: 7,
  title: 'Cykl życia runu i trwałość',
  tagline: 'Jak run staje się rekordem na dysku: status, lock, stop, continue, Apply, Discard, End run.',
  summary: `Run to trwały rekord w \`.splitbrief/sessions/<id>/\`. Jego stan to \`state.json\` (wersja 4), jego historia to \`session.jsonl\`, a to, czy jakiś proces go trzyma, mówi \`lockfile.json\` z heartbeatem. Jedna funkcja, \`deriveRunStatus\` (\`src/core/sessions/run-status.ts\`), czyta te fakty i daje jedną odpowiedź: \`running\`, \`open\` (waiting-for-you albo stopped), \`ready-to-apply\` albo \`closed\`. Każda lista, ekran, guard CLI i finalizacja silnika czyta tę samą odpowiedź.

Użytkownik widzi pięć stanów: **running**, **waiting for you**, **stopped**, **ready to apply**, **closed**. Run otwarty zawsze da się kontynuować (\`continueRun\`). Run gotowy nie jest kontynuowany: bierze Apply albo Discard. Run zamknięty nie bierze nic poza komendami.

Run pracuje w **workspace**: worktree gita poza projektem (domyślnie), staged-copy (kopia pod sesją) albo wprost w checkout (\`workflow.isolation: none\`). W worktree i staged-copy wynik trafia do checkoutu dopiero przez **Apply**, które robi trójstronny merge (base, ours, theirs), zapisuje backup i pisze pliki z osłoną hashy. **Discard**, **End run** i \`CLOSE_RUN\` zapisują niezastosowane zmiany do \`run.patch\` i usuwają workspace. W trybie checkout nie ma Apply: zaliczony review zamyka run jako \`complete\`.

**Stop** parkuje run (\`INTERRUPT_STEP\`), zachowuje częściowe zmiany w workspace i pozwala kontynuować od tego samego miejsca. **Crash** nic nie zapisuje: lock czyta się jako \`dead\`, run jako \`stopped · interrupted\`, a następny start domyka osierocone wywołania, zabija osierocone procesy narzędzi, cofa pliki briefu ze snapshotu i startuje brief od nowa.`,
  entry: [
    'src/engine/orchestrator/run/workflow.ts:98',
    'src/core/sessions/run-status.ts:181',
    'src/engine/orchestrator/run/continue.ts:51',
    'src/engine/orchestrator/apply/run.ts:116',
  ],
  links: [
    { to: 'startup', label: 'CLI start/resume/continue/status wchodzą tu przez prepareExecution i runWorkflow' },
    { to: 'planning', label: 'resumeStep kieruje do sesji planowania albo plan card (resumeParkedApproval)' },
    { to: 'build', label: 'resumeStep kind brief → pętla briefów; stop w briefie zachowuje workspace' },
    { to: 'review', label: 'resumeStep kind review → final review; review passed → ready-to-apply albo closed' },
    { to: 'recovery', label: 'pendingRecovery → status waiting-for-you · halt; Seat down parkuje brief (source seat)' },
    { to: 'ui', label: 'stop sheet, result menu, closed block, hydrateRun, continueRunInPlace' },
    { to: 'subsystems', label: 'snapshoty (baseline, workspace-base, run-ledger), evidence ledger, EventBus i sink session.jsonl' },
  ],
  diagrams: [
    {
      id: 'lc-run-status',
      title: 'Pięć stanów runu i przejścia między nimi',
      caption: 'To, co widzi użytkownik. Każdy stan wynika z deriveRunStatus, nigdy z osobnego pola w stanie. Strzałki nazywają zdarzenie, które zmienia odpowiedź.',
      mermaid: `stateDiagram-v2
  state "running" as running
  state "waiting for you (open · waiting-for-you)" as waiting
  state "stopped (open · stopped)" as stopped
  state "ready to apply" as ready
  state "closed" as closed
  [*] --> running: START, proces pisze lockfile
  running --> waiting: pytanie plannera, plan card, halt (pendingRecovery)
  running --> stopped: Stop now, Pause after this brief, blad kroku, crash procesu, seatWait
  running --> ready: review passed w worktree lub staged-copy i proces puszcza lock
  running --> closed: review passed w trybie checkout, Apply done, End run
  waiting --> running: odpowiedz, approve, akcja recovery
  waiting --> closed: End run
  stopped --> running: continue, resume, bare Enter
  stopped --> closed: End run
  ready --> running: Apply trzyma lock (acquireLiveness)
  ready --> closed: Apply done (applied), Discard (discarded), End run (discarded)
  closed --> closed: /run reject confirm po Apply = undone
  closed --> [*]`,
    },
    {
      id: 'lc-derive',
      title: 'deriveRunStatus: od zapisanego stanu do jednej odpowiedzi',
      caption: 'Kolejność warunków jest regułą: pierwszy pasujący wygrywa. Wejście to state.json plus liveness (alive / not-alive) z lockfile.',
      mermaid: `flowchart TD
  IN["state.json + liveness"] --> LC_CLOSED{"state.closed ustawione?"}
  LC_CLOSED -->|"tak, as=applied i applied.undone"| C_UNDONE["closed · undone"]
  LC_CLOSED -->|"tak"| C_AS["closed · ended / applied / discarded"]
  LC_CLOSED -->|"nie"| LC_COMPLETE_CHECKOUT{"phase complete, review passed lub acceptedAsIs,<br/>bez pendingRecovery, workspace brak lub checkout?"}
  LC_COMPLETE_CHECKOUT -->|"tak"| C_COMPLETE["closed · complete"]
  LC_COMPLETE_CHECKOUT -->|"nie"| LC_ALIVE{"liveness = alive?"}
  LC_ALIVE -->|"tak"| RUN["running"]
  LC_ALIVE -->|"nie"| LC_READY{"awaitsApply i bez pendingRecovery,<br/>bez interruptedStep, bez applying?"}
  LC_READY -->|"tak"| READY["ready-to-apply<br/>override = reviewStatus != passed"]
  LC_READY -->|"nie"| LC_HALT{"pendingRecovery?"}
  LC_HALT -->|"tak"| W_HALT["open · waiting-for-you · halt"]
  LC_HALT -->|"nie"| LC_SEAT_WAIT{"seatWait?"}
  LC_SEAT_WAIT -->|"tak"| S_SEAT["open · stopped · seat-wait<br/>(seat, tool, resetAt)"]
  LC_SEAT_WAIT -->|"nie"| LC_QUESTION{"pendingPlannerConversation<br/>bez odpowiedzi?"}
  LC_QUESTION -->|"tak"| W_Q["open · waiting-for-you · question"]
  LC_QUESTION -->|"nie"| LC_PARKED{"interruptedStep lub awaitingContinue?"}
  LC_PARKED -->|"interruptedStep"| S_PAUSED["open · stopped · paused<br/>at = cut (mid-step / boundary), kept"]
  LC_PARKED -->|"tylko awaitingContinue"| S_PAUSED2["open · stopped · paused · mid-step"]
  LC_PARKED -->|"nie"| LC_GATE{"parkedGate(phase)?"}
  LC_GATE -->|"spec / plan / briefs"| W_GATE["open · waiting-for-you · gate<br/>reopens = plan card z zapisanym planem"]
  LC_GATE -->|"nie"| LC_FAILED{"lastFailure?"}
  LC_FAILED -->|"tak"| S_FAILED["open · stopped · failed (message)"]
  LC_FAILED -->|"nie"| S_INT["open · stopped · interrupted<br/>(proces zniknal, nic nie zapisal)"]`,
    },
    {
      id: 'lc-start-init',
      title: 'Start procesu: od runWorkflow do pierwszego kroku',
      caption: 'Każde wejście (start, resume, continue, headless) idzie tą samą drogą. Najpierw sprzątanie i lock, potem izolacja, potem init z naprawą zapisanego stanu, potem wybór kroku.',
      mermaid: `flowchart TD
  A["runWorkflow(opts)"] --> B["reapOrphanRunners: zabij procesy narzedzi,<br/>ktore zostawil martwy wlasciciel"]
  B --> C["pruneOrphanSessions: usun puste foldery sesji<br/>starsze niz 24h"]
  C --> LC_LOCK_ALIVE{"acquireLiveness: lock innego<br/>procesu zywy?"}
  LC_LOCK_ALIVE -->|"tak"| ERR1["blad workflow-session-already-live<br/>(pid w komunikacie)"]
  LC_LOCK_ALIVE -->|"nie"| D["writeLockfile(pid, startTimeMs) + heartbeat co 2 s"]
  LC_LOCK_ALIVE -->|"nie da sie czytac/pisac locka"| D2["ostrzezenie: inny proces moze otworzyc run;<br/>run idzie dalej bez locka"]
  D --> E["createRunIsolation(strategy z config)"]
  D2 --> E
  E --> F["withShutdownHandlers: SIGINT/SIGTERM/SIGHUP<br/>→ killAllProcesses + zapis trackedState"]
  F --> LC_SAVED_STATE{"purpose = new-workflow?"}
  LC_SAVED_STATE -->|"tak"| G["createInitialState → START → workflow_started<br/>opcjonalnie git branch"]
  LC_SAVED_STATE -->|"nie: readWorkflowStateHead"| H["reopenSessionRecord: summary.json traci stop"]
  H --> I["initializeWorkflow: pin approve, recordInterruptedCalls,<br/>reconcileSeatIdentities"]
  I --> LC_STALE_HALT{"pendingRecovery przestarzaly?"}
  LC_STALE_HALT -->|"tak"| J["RESOLVE_PENDING_RECOVERY + warning<br/>stale_file_halt_resolved"]
  LC_STALE_HALT -->|"nie"| K["restoreUnresumedBriefCut (RESTORE_BRIEF_PARK<br/>gdy log dowodzi ciecia bez parku)"]
  J --> K
  K --> LC_TASK_IN_FLIGHT{"brief in_progress bez parku<br/>(crash)?"}
  LC_TASK_IN_FLIGHT -->|"tak"| L["restoreInterruptedTaskFiles ze snapshotu startu<br/>+ RESET_TASK (attempt 0)"]
  LC_TASK_IN_FLIGHT -->|"nie"| M["seatWait? → resumeSeatWait czeka do resetAt"]
  L --> M
  M --> N["resumeContinuation: partial + steer + keepWorkspace"]
  N --> O["workflow_resumed"]
  G --> P["runPlanningPhases"]
  O --> P
  P --> Q["RESUME_STEP gdy run byl zaparkowany"]
  Q --> LC_RESUME_STEP{"resumeStep(state)"}
  LC_RESUME_STEP -->|"apply"| R1["runApply → patrz Apply"]
  LC_RESUME_STEP -->|"brief / review"| R2["runTasksAndReview → build / review"]
  LC_RESUME_STEP -->|"gate z planem"| R3["resumeParkedApproval: plan card"]
  LC_RESUME_STEP -->|"planner lub stara brama"| R4["runPlanningPhase: jedna sesja planowania"]`,
    },
    {
      id: 'lc-isolation',
      title: 'Jaki workspace dostaje run',
      caption: 'openWorkspace w isolation/create.ts. Tryb zapisuje się raz w state.workspace.kind; późniejsza zmiana config nie przenosi runu. Każda awaria worktree kończy się fallbackiem na staged-copy z jednym ostrzeżeniem.',
      mermaid: `flowchart TD
  A["runTasksAndReview: snapshot workspace-base"] --> LC_PREVIOUS_RECORD{"retained-workspace.json istnieje?"}
  LC_PREVIOUS_RECORD -->|"tak, staged-copy"| P1["dir = sessions/‹id›/‹leaf›/workspace;<br/>strategy worktree → fallback reported"]
  LC_PREVIOUS_RECORD -->|"tak, worktree"| P2["dir = trees/‹repo-key›/‹session-id›"]
  P1 --> P3{"retainedDirectoryMatches<br/>(dev, ino, birthtime)?"}
  P2 --> P3
  P3 -->|"nie"| ERR["isolation-retention-unavailable:<br/>pliki zostaja, kontynuacja zablokowana"]
  P3 -->|"tak"| OPEN["prepareWorktreeAcquisition + snapshot<br/>+ keptFiles z retained snapshot"]
  LC_PREVIOUS_RECORD -->|"nie"| LC_ISOLATION_STRATEGY{"workflow.isolation<br/>lub recorded kind?"}
  LC_ISOLATION_STRATEGY -->|"none / checkout"| CK["kind checkout: projectDir, head = HEAD,<br/>bez rekordu workspace"]
  LC_ISOLATION_STRATEGY -->|"staged-copy"| SC["createStagedProject pod<br/>sessions/‹id›/stage-‹hex›/workspace"]
  LC_ISOLATION_STRATEGY -->|"worktree (domyslne)"| LC_WORKTREE_AVAILABLE{"resolveWorktreeDir"}
  LC_WORKTREE_AVAILABLE -->|"nie repo git"| FB1["fallback: project is not a git repository"]
  LC_WORKTREE_AVAILABLE -->|"brak commitow"| FB2["fallback: repository has no commits"]
  LC_WORKTREE_AVAILABLE -->|"katalog istnieje, marker innej sesji"| FB3["fallback: directory already exists<br/>and is not owned by session"]
  LC_WORKTREE_AVAILABLE -->|"branch splitbrief/‹slug› istnieje"| FB4["fallback: worktree-branch-exists<br/>(worktree porzucony i usuwany przy dispose)"]
  LC_WORKTREE_AVAILABLE -->|"repo nie ignoruje node_modules"| FB5["fallback: dependency symlink<br/>would appear in every changed set"]
  LC_WORKTREE_AVAILABLE -->|"ok"| WT["git worktree add + seed dirty files<br/>+ marker + link node_modules"]
  FB1 --> SC
  FB2 --> SC
  FB3 --> SC
  FB4 --> SC
  FB5 --> SC
  SC --> OPEN
  WT --> OPEN
  OPEN --> REC["reconcileWorkspaceToBase(keep: keptFiles)<br/>RECORD_WORKSPACE(kind, path, base snapshotId, head)"]
  CK --> REC2["RECORD_WORKSPACE(kind checkout)"]`,
    },
    {
      id: 'lc-apply',
      title: 'Apply krok po kroku, z gałęziami awarii',
      caption: 'runApply w apply/run.ts. Checkout nie dostaje żadnego zapisu, dopóki merge nie jest czysty i backup nie jest zapisany. Każdy problem to halt (apply-conflict, apply-partial) albo powrót do review.',
      mermaid: `flowchart TD
  A["runApply(state) · live lub at rest<br/>(at rest: acquireLiveness → run czyta running)"] --> LC_APPLY_GATE{"acceptedAsIs bez potwierdzenia,<br/>bez halt, bez applying?"}
  LC_APPLY_GATE -->|"tak"| NC["needs-confirmation: warning<br/>apply_override_unconfirmed; /run accept confirm"]
  LC_APPLY_GATE -->|"nie"| LC_APPLY_PENDING{"pendingRecovery?"}
  LC_APPLY_PENDING -->|"nie odpowiedziany"| HALT0["halted: recovery_pending_unresolved,<br/>nic nie zapisano"]
  LC_APPLY_PENDING -->|"restore-backup"| RST["restoreApplyBackup → APPLY_RESTORED<br/>→ RESOLVE → outcome restored (run znow ready)"]
  LC_APPLY_PENDING -->|"retry-same-worker"| RETRY["RESOLVE_PENDING_RECOVERY; retrying = true"]
  LC_APPLY_PENDING -->|"brak"| LC_APPLY_CUT{"state.applying ustawione<br/>i to nie retry?"}
  LC_APPLY_CUT -->|"tak: proces zniknal w Apply"| CUT["haltCutApply: reconcile backup<br/>(written / pending / ambiguous) → halt apply-partial"]
  LC_APPLY_CUT -->|"nie"| CAP["captureApplyStates: base (snapshot),<br/>ours (workspace), theirs (checkout)"]
  RETRY --> CAP
  CAP --> MRG["mergeApplyStates do workspace"]
  MRG -->|"plik zmienil sie w trakcie"| HC["halt apply-conflict:<br/>checkout-changed / workspace-changed"]
  MRG --> LC_MERGE_CONFLICT{"konflikty?"}
  LC_MERGE_CONFLICT -->|"tak"| LC_CONFLICT_TEXT_ONLY{"wszystkie tekstowe<br/>z markerami?"}
  LC_CONFLICT_TEXT_ONLY -->|"tak"| MK["zapisz markery do workspace,<br/>APPLY_REVIEW_START + triage A1..An → review robi fix tasks"]
  LC_CONFLICT_TEXT_ONLY -->|"nie: binary, delete-modify, add-add,<br/>mode, symlink, unsupported-entry"| HC2["halt apply-conflict: rozwiaz pliki w workspace,<br/>potem Re-run Apply lub End run"]
  LC_MERGE_CONFLICT -->|"nie"| LC_CANDIDATE_CHANGED{"kandydat po merge rozni sie<br/>od reviewedCandidate?"}
  LC_CANDIDATE_CHANGED -->|"tak"| RV["APPLY_REVIEW_START (fix cycle +1):<br/>checki i review jeszcze raz, potem Apply"]
  LC_CANDIDATE_CHANGED -->|"nie"| BK["writeApplyBackup: replaced, created,<br/>expected, candidate pod sessions/‹id›/apply/‹backupId›"]
  BK --> LC_BACKUP_CHANGED{"checkout zmienil plik<br/>od capture?"}
  LC_BACKUP_CHANGED -->|"tak"| HC3["halt apply-conflict: checkout-changed"]
  LC_BACKUP_CHANGED -->|"nie"| ST["APPLY_START(backupId) → state.applying"]
  ST --> WR["promoteStagedChanges: jeden zapis z osloną hashy"]
  WR --> LC_WRITE_RESULT{"wynik zapisu"}
  LC_WRITE_RESULT -->|"failedFile"| PART["halt apply-partial: wrote N of M;<br/>akcje: Retry, Restore (End run odrzucane)"]
  LC_WRITE_RESULT -->|"wszystko"| DONE["APPLY_DONE: applied, closed as applied<br/>→ removeClosedRunWorkspace → workspace_closed"]`,
    },
    {
      id: 'lc-stop-resume',
      title: 'Stop, wyjście, crash i powrót',
      caption: 'Co zapisuje każdy rodzaj zatrzymania i co znajdzie następny start. Park (stop użytkownika) zachowuje częściowe pliki; crash ich nie zachowuje, bo nikt nie wybrał, żeby je zachować.',
      mermaid: `flowchart TD
  A["Run pracuje"] --> LC_STOP_KIND{"co sie dzieje?"}
  LC_STOP_KIND -->|"Stop now (esc esc, ctrl+c, /steer)"| S1["abort wywolania; INTERRUPT_STEP cut mid-step,<br/>kept = zmienione pliki briefu; workspace.retain()"]
  LC_STOP_KIND -->|"Pause after this brief"| S2["brief konczy checki i review;<br/>INTERRUPT_STEP cut boundary na nastepnym kroku"]
  LC_STOP_KIND -->|"End run"| S3["closeRunIfOpen → CLOSE_RUN ended<br/>(+ run.patch) → workflow_cancelled"]
  LC_STOP_KIND -->|"blad kroku"| S4["recordLastFailure → open · stopped · failed"]
  LC_STOP_KIND -->|"kill -9 / padnie zasilanie"| S5["nic nie zapisane; lock bez exitedAt,<br/>heartbeat stoi"]
  LC_STOP_KIND -->|"Seat down (limit / auth)"| S6["INTERRUPT_STEP source seat + SET_PENDING_RECOVERY<br/>→ waiting-for-you · halt (→ recovery)"]
  S1 --> R["markExited w lockfile; saveFinalSession;<br/>turn_interrupted w session.jsonl"]
  S2 --> R
  S4 --> R
  S5 --> X["inny proces czyta lock"]
  X --> LC_LOCK_STATUS{"checkSessionLockStatus"}
  LC_LOCK_STATUS -->|"exitedAt"| L1["exited → not alive"]
  LC_LOCK_STATUS -->|"pid nie zyje / inny start time"| L2["dead → not alive, takeover dozwolony"]
  LC_LOCK_STATUS -->|"pid zyje, heartbeat > 8 s"| L3["stale → not alive, ale takeover ZABRONIONY<br/>(resume: kill it first)"]
  LC_LOCK_STATUS -->|"heartbeat swiezy"| L4["live → running; continue odmawia"]
  L2 --> N["lista: stopped · interrupted"]
  R --> M["lista: stopped / waiting for you"]
  M --> LC_CONTINUE_REFUSE{"continueRun"}
  N --> LC_CONTINUE_REFUSE
  LC_CONTINUE_REFUSE -->|"park trzymany w tym procesie"| C1["continued-in-place: stopStore.resume(steer)"]
  LC_CONTINUE_REFUSE -->|"missing / invalid state"| C2["refused: No saved state / komunikat bledu"]
  LC_CONTINUE_REFUSE -->|"closed"| C3["refused: Cannot continue: this run is ... start a new one"]
  LC_CONTINUE_REFUSE -->|"ready-to-apply"| C4["refused: choose Apply or Discard"]
  LC_CONTINUE_REFUSE -->|"slowa, ktorych krok nie czyta"| C5["refused takes-no-words; tekst wraca do composera"]
  LC_CONTINUE_REFUSE -->|"restart"| C6["runWorkflow z savedState + steer"]
  C6 --> LC_KEEP_WORKSPACE{"resumeContinuation: cut mid-step tego briefu,<br/>ten sam attempt, task in_progress?"}
  LC_KEEP_WORKSPACE -->|"tak"| K1["keepWorkspace + partial z session.jsonl;<br/>acquire(resume: true) nie cofa plikow"]
  LC_KEEP_WORKSPACE -->|"nie"| K2["bez partiala; crash → pliki briefu cofniete,<br/>attempt 0"]`,
    },
    {
      id: 'lc-close',
      title: 'Zamknięcie runu: End run, Discard, Apply, reject',
      caption: 'closeRunIfOpen w run/close.ts jest jedyną drogą zamknięcia bez Apply. Decyduje, jak run się zamyka, czy pisze run.patch i co mówi o plikach w checkout.',
      mermaid: `flowchart TD
  A["End run / Discard / /run reject confirm / sygnal z powodem"] --> B["reapOrphanRunners"]
  B --> C["rebase na state.json z dysku"]
  C --> D{"juz closed?"}
  D -->|"tak"| D1["nic: closedNow = false"]
  D -->|"nie"| LC_APPLY_UNFINISHED{"state.applying ustawione?"}
  LC_APPLY_UNFINISHED -->|"tak"| E1["blad end-run-while-applying:<br/>Apply did not finish. Restore or retry Apply first"]
  LC_APPLY_UNFINISHED -->|"nie"| LC_CLOSE_PATCH{"workspace worktree / staged-copy?"}
  LC_CLOSE_PATCH -->|"tak, katalog istnieje"| P1["writeRunPatch: git diff --no-index base vs workspace<br/>→ sessions/‹id›/run.patch (brak zmian = brak pliku)"]
  LC_CLOSE_PATCH -->|"tak, katalog zniknal"| P2["warning: workspace is gone; no run patch"]
  LC_CLOSE_PATCH -->|"checkout lub brak"| P3["bez patcha"]
  P1 --> LC_CLOSE_AS{"jak zamknac?"}
  P2 --> LC_CLOSE_AS
  P3 --> LC_CLOSE_AS
  LC_CLOSE_AS -->|"as = discarded (Discard, reject)"| A1["CLOSE_RUN as discarded"]
  LC_CLOSE_AS -->|"status ready-to-apply (End run na ready)"| A2["CLOSE_RUN as discarded"]
  LC_CLOSE_AS -->|"inaczej"| A3["CLOSE_RUN as ended"]
  A1 --> F["commitWorkflowState CAS (do 3 prob)"]
  A2 --> F
  A3 --> F
  F --> G["persistStoppedBriefEvidence"]
  G --> LC_CLOSE_CHECKOUT_FILES{"checkout run i pliki runu<br/>nadal w checkout?"}
  LC_CLOSE_CHECKOUT_FILES -->|"tak"| H1["warning: This run edited your checkout directly...<br/>no run patch was written"]
  LC_CLOSE_CHECKOUT_FILES -->|"nie"| H2["bez notki"]
  H1 --> I["removeClosedRunWorkspace: git worktree remove + branch -D<br/>lub rm staged root; clearWorkspaceRecord; workspace_closed"]
  H2 --> I
  I --> J["finalizeRunAtRest: summary.json, clearActiveReceipt"]`,
    },
    {
      id: 'lc-files',
      title: 'Co leży na dysku',
      caption: 'Mapa plików jednego runu. Sesja mieszka w projekcie; worktree i base trees mieszkają poza projektem w katalogu stanu użytkownika.',
      mermaid: `flowchart LR
  subgraph PROJ[".splitbrief/ w projekcie"]
    ACT["active<br/>wskaznik aktywnej sesji (legacy id lub receipt v1)"]
    CFG["config.yaml"]
    subgraph SESS["sessions/‹id›/"]
      ST["state.json (v4, stateRevision)"]
      LOG["session.jsonl (events, messages, summary)"]
      LOCK["lockfile.json (pid, startTimeMs, lastAliveMs, exitedAt)"]
      SUM["summary.json (Session row, activeTime)"]
      SEATS["seats.json"]
      DRAFT["draft.json (niewyslany tekst composera)"]
      PIDS["runner-pids.jsonl (pid narzedzi do reapera)"]
      RET["retained-workspace.json (rekord workspace)"]
      BASEJ["isolation-baseline.json"]
      PATCH["run.patch (po Discard / End run)"]
      PLANF["plan.json, plan.md, tasks.md, review.json, evidence.json"]
      SNAP["snapshots/baseline, workspace-base, post-task-N,<br/>pre-final-review, run-ledger.json"]
      APPLYD["apply/‹backupId›/manifest.json, blobs/, candidate/"]
      ENT["entries/ (content-addressed bajty snapshotow)"]
      REV["reverted/‹stamp›/ (bajty zastapione w checkout)"]
      STAGE["stage-‹hex›/workspace (staged-copy)"]
      OWN[".prepare-owner.json (marker wlasnosci przy tworzeniu)"]
    end
  end
  subgraph XDG["~/.local/state/splitbrief/ (XDG_STATE_HOME)"]
    TREES["trees/‹sha12 git-common-dir›/‹session-id›/<br/>worktree runu, branch splitbrief/‹slug›"]
    MARK["trees/.../.splitbrief/isolation-marker"]
    BASES["bases/base-‹pid›-‹rand›/ (drzewo bazy do base re-run)"]
  end
  ACT -.->|"nazywa"| SESS
  RET -.->|"wskazuje"| TREES
  RET -.->|"lub"| STAGE`,
    },
    {
      id: 'lc-crash-detect',
      title: 'Co zostawia crash i jak następny start to wykrywa',
      caption: 'Trzy niezależne ślady: lockfile (kto trzyma run), state.json (gdzie run stał) i runner-pids.jsonl (jakie narzędzia żyły). Każdy start sprawdza wszystkie trzy, zanim coś zapisze.',
      mermaid: `flowchart TD
  A["Nastepny start: runWorkflow lub otwarcie runu w TUI"] --> LC_ORPHAN_RUNNER{"runner-pids.jsonl ma pidy<br/>i lock wlasciciela dead / exited?"}
  LC_ORPHAN_RUNNER -->|"tak"| K1["SIGTERM grupy, 2 s, SIGKILL;<br/>releaseRunnerPids tylko zreapowanych"]
  LC_ORPHAN_RUNNER -->|"wlasciciel live / stale / brak locka"| K2["nic: narzedzia moga byc czyjes"]
  K1 --> LC_ORPHAN_SESSION{"folder sesji pusty lub z samym<br/>readiness.json, starszy niz 24 h, nieaktywny?"}
  K2 --> LC_ORPHAN_SESSION
  LC_ORPHAN_SESSION -->|"tak"| P1["rename do .claim + rm"]
  LC_ORPHAN_SESSION -->|"nie"| P2["folder zostaje"]
  P1 --> LC_LIVENESS_RESULT{"inspectSessionLiveness(ref)"}
  P2 --> LC_LIVENESS_RESULT
  LC_LIVENESS_RESULT -->|"state.json brak lub phase terminalna"| V1["not live, takeover zabroniony<br/>(nie ma czego przejmowac)"]
  LC_LIVENESS_RESULT -->|"lock live"| V2["running: continue / resume odmawiaja"]
  LC_LIVENESS_RESULT -->|"lock stale"| V3["not live, takeover zabroniony:<br/>kill it first"]
  LC_LIVENESS_RESULT -->|"lock dead / exited / missing / invalid"| LC_PID_IDENTITY{"checkProcessIdentity:<br/>czas startu pid vs lock"}
  LC_PID_IDENTITY -->|"pid reused lub ESRCH"| V4["dead: run jest wolny"]
  LC_PID_IDENTITY -->|"zgodny"| V5["live (ale lock mowi exited):<br/>proces jeszcze sprzata"]
  V4 --> LC_ACTIVE_TAKEOVER{".splitbrief/active wskazuje<br/>inna sesje?"}
  LC_ACTIVE_TAKEOVER -->|"tak, jej wlasciciel ma takeover = true"| T1["resume: nowy receipt zastepuje wskaznik"]
  LC_ACTIVE_TAKEOVER -->|"tak, wlasciciel zywy / stale"| T2["session-still-active"]
  LC_ACTIVE_TAKEOVER -->|"nie lub ta sama sesja"| T3["receipt tej sesji"]
  T1 --> LC_STATE_VERSION{"loadState: stateVersion?"}
  T3 --> LC_STATE_VERSION
  LC_STATE_VERSION -->|"4, schema ok"| S1["loaded"]
  LC_STATE_VERSION -->|"3, schema v3 ok"| S2["mapV3StateToV4 w pamieci"]
  LC_STATE_VERSION -->|"> 4 lub zagniezdzona wersja > 1"| S3["invalid · future-version: odmowa"]
  LC_STATE_VERSION -->|"zly JSON / symlink / schema"| S4["invalid · malformed: odmowa z komunikatem"]
  LC_STATE_VERSION -->|"brak pliku"| S5["missing: No saved state"]
  S1 --> D["deriveRunStatus(not-alive) → stopped · interrupted;<br/>init: recordInterruptedCalls, crash restart briefu"]
  S2 --> D`,
    },
    {
      id: 'lc-entries',
      title: 'Wejścia do runu at rest: CLI, lista, komendy /run',
      caption: 'Każde wejście czyta ten sam RunRecord i te same odmowy. CLI mówi je na stderr i kończy exit 1; TUI pokazuje je w feedbacku.',
      mermaid: `flowchart TD
  A["splitbrief resume"] --> LC_CLI_RESUME{"active? lock? stan?"}
  LC_CLI_RESUME -->|"brak active"| R1["no active session to resume"]
  LC_CLI_RESUME -->|"lock alive"| R2["is running — stop it before resuming"]
  LC_CLI_RESUME -->|"lock stale"| R3["process exists but is unresponsive — kill it first"]
  LC_CLI_RESUME -->|"stan invalid / missing"| R4["has invalid saved state / no usable state.json"]
  LC_CLI_RESUME -->|"closed / ready"| R5["nothing to resume / ready-to-apply message"]
  LC_CLI_RESUME -->|"ok"| R6["resumeSavedSession: prepareExecution(resume),<br/>hydrateRun, workflow screen local"]
  B["splitbrief continue [id] --action"] --> LC_CLI_CONTINUE{"status i akcja"}
  LC_CLI_CONTINUE -->|"running"| C1["is still running — stop it before continuing"]
  LC_CLI_CONTINUE -->|"closed"| C2["Run X is closed (as); nothing to end/resume"]
  LC_CLI_CONTINUE -->|"end-run"| C3["endRunAtRest (applying → exit 1)"]
  LC_CLI_CONTINUE -->|"apply / discard, status ready"| C4["settleReadyRun: runApplyAtRest / closeRunIfOpen discarded"]
  LC_CLI_CONTINUE -->|"apply / discard, nie ready"| C5["is not ready to apply"]
  LC_CLI_CONTINUE -->|"akcja recovery"| C6["applyRecoveryAction, potem resume"]
  LC_CLI_CONTINUE -->|"bez akcji"| R6
  D["/sessions, home, palette: wybor runu"] --> LC_SESSION_SELECT{"Apply tego procesu pisze?<br/>run local na ekranie?"}
  LC_SESSION_SELECT -->|"Apply pisze"| S1["Apply is still writing to your checkout. Cannot open"]
  LC_SESSION_SELECT -->|"local run na ekranie"| S2["Stop the run on screen first."]
  LC_SESSION_SELECT -->|"ok"| S3["readRunHistory → replay session.jsonl,<br/>hydrateFromState, execution at-rest"]
  E["lista sesji"] --> LC_LISTING_ROW{"rowFor(status, summary.json)"}
  LC_LISTING_ROW -->|"closed"| L1["complete / ended + apply applied / undone / discarded"]
  LC_LISTING_ROW -->|"ready-to-apply"| L2["open, apply ready → ready to apply"]
  LC_LISTING_ROW -->|"running"| L3["open bez stop → running"]
  LC_LISTING_ROW -->|"open"| L4["open, stop → waiting for you / stopped"]
  S3 --> F["/run accept · /run reject confirm"] --> LC_RUN_COMMAND{"acceptRun / rejectRun"}
  LC_RUN_COMMAND -->|"accept, ready"| M1["runApplyAtRest → applied / halted / review / confirm-override"]
  LC_RUN_COMMAND -->|"accept, checkout open"| M2["closeRunIfOpen → ended"]
  LC_RUN_COMMAND -->|"reject, workspace ready"| M3["closeRunIfOpen discarded + run.patch"]
  LC_RUN_COMMAND -->|"reject, closed applied"| M4["undoApply → closed · undone"]
  LC_RUN_COMMAND -->|"reject, checkout"| LC_REJECT_CHECKOUT{"rejectRunSnapshot: konflikty<br/>lub brakujace pliki?"}
  LC_REJECT_CHECKOUT -->|"nie"| J1["closed · discarded"]
  LC_REJECT_CHECKOUT -->|"tak"| J2["run zostaje open; RECORD_REJECT<br/>otwiera briefy z cofnietymi plikami"]
  LC_REJECT_CHECKOUT -->|"brak run snapshot"| J3["No run snapshot to reject."]
  M4 --> LC_RESTORE_FILE{"restoreApplyBackup: plik pasuje do<br/>expected / before / zadnego?"}
  LC_RESTORE_FILE -->|"expected"| U1["written → bajty sprzed Apply, created usuniete"]
  LC_RESTORE_FILE -->|"before"| U2["pending → unchanged"]
  LC_RESTORE_FILE -->|"zadnego"| U3["ambiguous → left as you changed them"]`,
    },
  ],
  decisions: [
    {
      id: 'LC_CLOSED',
      title: 'Run zamknięty',
      question: 'Czy stan ma pole closed?',
      where: 'src/core/sessions/run-status.ts:188',
      inputs: ['state.closed', 'state.applied.undone'],
      branches: [
        { if: 'closed.as = applied i applied.undone ustawione', then: 'status closed · undone (stan dalej trzyma as: applied)', next: 'LC_RUN_COMMAND' },
        { if: 'closed ustawione', then: 'status closed · closed.as (ended, applied, discarded)' },
      ],
      default: 'Idzie do sprawdzenia complete w trybie checkout.',
      notes: 'CLOSE_RUN czyści interruptedStep, pendingRecovery i pendingPlannerConversation (machine.ts:646). Zamknięty run nie da się kontynuować.',
    },
    {
      id: 'LC_COMPLETE_CHECKOUT',
      title: 'Zaliczony run bez workspace do Apply',
      question: 'Czy run skończył review i nie ma czego zastosować?',
      where: 'src/core/sessions/run-status.ts:192',
      inputs: ['state.phase', 'state.reviewStatus', 'state.acceptedAsIs', 'state.pendingRecovery', 'state.workspace.kind'],
      branches: [
        { if: 'phase = complete, (reviewStatus = passed lub acceptedAsIs), bez pendingRecovery, workspace brak lub kind checkout', then: 'closed · complete (bez Apply)' },
      ],
      default: 'Run z worktree lub staged-copy idzie dalej: może być ready-to-apply.',
      notes: 'Starszy run bez state.workspace zamyka się tak samo. Override Accept as is też zamyka; closed block pokaże needs attention.',
    },
    {
      id: 'LC_ALIVE',
      title: 'Proces trzyma run',
      question: 'Czy liveness = alive?',
      where: 'src/core/sessions/run-status.ts:200',
      inputs: ['checkSessionLiveness(sessionDir).alive'],
      branches: [
        { if: 'alive', then: 'running — także gdy to Apply at rest trzyma lock' },
      ],
      default: 'not-alive: run stoi; dalej ready-to-apply albo open.',
      notes: 'Ten sam proces, który puścił lock a nie mógł zapisać exitedAt, czyta siebie jako exited przez exitedInMemory (lockfile-status.ts:150).',
    },
    {
      id: 'LC_READY',
      title: 'Gotowy do Apply',
      question: 'Czy workspace trzyma zrecenzowany wynik, którego checkout jeszcze nie dostał?',
      where: 'src/core/sessions/run-status.ts:201',
      inputs: ['awaitsApply(state)', 'state.pendingRecovery', 'state.interruptedStep', 'state.applying'],
      branches: [
        { if: 'awaitsApply (worktree lub staged-copy, phase complete, review passed lub acceptedAsIs, bez applied, bez closed) i bez halt, bez parku, bez applying', then: 'ready-to-apply, override = reviewStatus != passed', next: 'LC_APPLY_GATE' },
      ],
      default: 'open: halt apply-conflict / apply-partial, park albo niedokończone Apply trzymają run otwarty; resumeStep daje wtedy kind apply.',
    },
    {
      id: 'LC_HALT',
      title: 'Halt czeka na odpowiedź',
      question: 'Czy pendingRecovery jest ustawione?',
      where: 'src/core/sessions/run-status.ts:221',
      inputs: ['state.pendingRecovery'],
      branches: [
        { if: 'tak', then: 'open · waiting-for-you · halt(issue); UI pokazuje menu Needs you / Seat down' },
      ],
      default: 'Dalej: seatWait.',
      notes: 'Halt wygrywa nad każdym innym powodem stopu. → zobacz recovery.',
    },
    {
      id: 'LC_SEAT_WAIT',
      title: 'Seat czeka na reset limitu',
      question: 'Czy state.seatWait jest ustawione?',
      where: 'src/core/sessions/run-status.ts:224',
      inputs: ['state.seatWait.seat', 'state.seatWait.resetAt', 'plannerTool / implementerTool / reviewerTool'],
      branches: [
        { if: 'tak', then: 'open · stopped · seat-wait (seat, tool, resetAt); continue czeka do resetAt (resumeSeatWait)' },
      ],
      default: 'Dalej: pytanie plannera.',
      notes: 'Dokumentacja WORKFLOW.md wymienia tylko paused / failed / interrupted jako powody stopped; kod ma też seat-wait.',
    },
    {
      id: 'LC_QUESTION',
      title: 'Planner czeka na odpowiedź',
      question: 'Czy pendingPlannerConversation jest bez odpowiedzi?',
      where: 'src/core/sessions/run-status.ts:232',
      inputs: ['state.pendingPlannerConversation.answered'],
      branches: [
        { if: 'konwersacja istnieje i answered = false', then: 'open · waiting-for-you · question; resumeStep = planner (sesja planowania)' },
      ],
      default: 'Dalej: park.',
      notes: 'W headless ten stan kończy komendę z exit 1 i rekordem input_required (headless.ts:73).',
    },
    {
      id: 'LC_PARKED',
      title: 'Run zaparkowany przez stop',
      question: 'Czy stop zapisał, gdzie przeciął run?',
      where: 'src/core/sessions/run-status.ts:240',
      inputs: ['state.interruptedStep.cut', 'state.interruptedStep.partialRef', 'state.interruptedStep.kept', 'state.awaitingContinue'],
      branches: [
        { if: 'interruptedStep', then: 'open · stopped · paused, at = cut (mid-step lub boundary; stary stan: partialRef → mid-step, inaczej boundary), kept = pliki briefu' },
        { if: 'tylko awaitingContinue (stary stan)', then: 'open · stopped · paused · mid-step' },
      ],
      default: 'Dalej: brama.',
      notes: 'interruptedStep nie zmienia phase; mówi tylko, gdzie run podejmie pracę (WORKFLOW.md). Źródło user / watchdog / seat.',
    },
    {
      id: 'LC_GATE',
      title: 'Run stoi przy bramie',
      question: 'Czy phase to reviewing-spec, reviewing-plan albo reviewing-briefs?',
      where: 'src/core/sessions/run-status.ts:67',
      inputs: ['state.phase', 'state.plan', 'state.mode', 'state.approve'],
      branches: [
        { if: 'reviewing-plan z zapisanym planem', then: 'waiting-for-you · gate plan, reopens = true: plan card otwiera się bez nowego wywołania plannera' },
        { if: 'reviewing-plan bez planu, a stan mówi, że nie otwierał bramy planu (mode quick lub approve bez bramy)', then: 'brak bramy: run jest przy swoim wywołaniu briefów; dalej lastFailure' },
        { if: 'inna brama (stary run)', then: 'waiting-for-you · gate, reopens = false: kontynuacja to jedna sesja planowania' },
      ],
      default: 'Dalej: lastFailure.',
    },
    {
      id: 'LC_FAILED',
      title: 'Run umarł na błędzie albo proces zniknął',
      question: 'Czy lastFailure jest zapisane?',
      where: 'src/core/sessions/run-status.ts:254',
      inputs: ['state.lastFailure.message'],
      branches: [
        { if: 'tak', then: 'open · stopped · failed(message); continue powtarza krok, na którym padł' },
      ],
      default: 'open · stopped · interrupted: proces zniknął bez zapisu (crash). Następny start traktuje brief in_progress jako crash.',
      notes: 'recordLastFailure (state-ops.ts:720) pisze przez CAS; gdy zapis się nie uda, awaria jest trzymana w pamięci procesu (keepUnsavedFailure), a dysk mówi tylko „zatrzymany na ostatnim kroku”.',
    },
    {
      id: 'LC_RESUME_STEP',
      title: 'Gdzie run podejmuje pracę',
      question: 'resumeStep(state): pierwsza niedokończona rzecz',
      where: 'src/core/sessions/run-status.ts:95',
      inputs: ['pendingPlannerConversation', 'awaitsApply', 'parkedGate', 'phase', 'currentTaskIndex', 'attempt', 'fixCycles'],
      branches: [
        { if: 'pendingPlannerConversation', then: 'planner · plan (sesja planowania)' },
        { if: 'awaitsApply', then: 'apply → runApply', next: 'LC_APPLY_GATE' },
        { if: 'parkedGate', then: 'gate → resumeParkedApproval (plan card) albo sesja planowania' },
        { if: 'implementing / validating-task / escalating', then: 'brief(taskId, attempt); gdy indeks poza listą → review cycle 0' },
        { if: 'final-review / complete', then: 'review(cycle = fixCycles.used)' },
      ],
      default: 'planner · plan.',
      notes: 'runPlanningPhases (run/phases.ts:28) czyta tylko kind: apply, brief/review (do pętli zadań), gate, reszta to planowanie.',
    },
    {
      id: 'LC_LOCK_STATUS',
      title: 'Stan lockfile sesji',
      question: 'checkSessionLockStatus: czy lockfile mówi o żywym właścicielu?',
      where: 'src/core/sessions/lockfile-status.ts:145',
      inputs: ['lockfile.json: pid, startTimeMs, lastAliveMs, exitedAt, sessionId', 'czas procesu z /proc', 'HEARTBEAT_STALENESS_MS = 8000'],
      branches: [
        { if: 'brak katalogu / pliku', then: 'missing' },
        { if: 'zły JSON, zła wersja albo sessionId inny niż folder', then: 'invalid' },
        { if: 'exitedAt ustawione (lub ten pid i exitedInMemory)', then: 'exited' },
        { if: 'pid nie istnieje albo czas startu różni się o > 2 s (pid reused)', then: 'dead, processAlive = false', next: 'LC_PID_IDENTITY' },
        { if: 'pid żyje, lastAliveMs starsze niż 8 s', then: 'stale, processAlive = true' },
      ],
      default: 'live.',
      notes: 'Heartbeat pisze co 2 s (LOCKFILE_PING_INTERVAL_MS = 8000/4, run/heartbeat.ts:5), więc trzy zgubione pingi nie czynią runu stale.',
    },
    {
      id: 'LC_PID_IDENTITY',
      title: 'Czy pid z locka to ten sam proces',
      question: 'checkProcessIdentity(pid, startTimeMs)',
      where: 'src/core/sessions/lockfile-status.ts:126',
      inputs: ['readProcessStartTimeMs(pid)', 'PROCESS_START_TOLERANCE_MS = 2000', 'process.kill(pid, 0)'],
      branches: [
        { if: 'czas startu znany i |różnica| <= 2 s', then: 'live' },
        { if: 'czas startu znany i różni się', then: 'pid-reused (traktowane jak dead)' },
        { if: 'czas nieznany, kill(pid, 0) daje ESRCH', then: 'dead' },
      ],
      default: 'unknown (traktowane jak żywy).',
    },
    {
      id: 'LC_LIVENESS_RESULT',
      title: 'Czy sesję można przejąć',
      question: 'inspectSessionLiveness: live, takeoverMayBeAttempted',
      where: 'src/core/sessions/liveness.ts:135',
      inputs: ['phase ze state.json', 'wskaźnik active', 'checkSessionLockStatus'],
      branches: [
        { if: 'state.json brak lub bez phase', then: 'live = false, takeover = false (state-missing)' },
        { if: 'phase terminalna', then: 'live = false, takeover = false (terminal-state)' },
        { if: 'lock live', then: 'live = true, takeover = false' },
        { if: 'lock stale', then: 'live = false, takeover = false — nikt nie przejmie zawieszonego procesu' },
        { if: 'lock dead / exited / missing / invalid', then: 'live = false, takeover = true' },
      ],
      default: 'Brak.',
      notes: 'Tylko jawny resume (reactivateExistingSession z inspectOwner) może zastąpić wskaźnik active innej sesji, i tylko gdy takeover = true (active-pointer.ts:360).',
    },
    {
      id: 'LC_LOCK_ALIVE',
      title: 'Czy inny proces już trzyma ten run',
      question: 'acquireLiveness przed startem runu',
      where: 'src/engine/orchestrator/run/liveness.ts:55',
      inputs: ['checkSessionLiveness(sessionDir)', 'AbortSignal'],
      branches: [
        { if: 'alive', then: 'błąd workflow-session-already-live: „session X is already running (pid N) — stop it before resuming, or run splitbrief continue X once it stops”' },
        { if: 'nie da się przeczytać locka', then: 'ostrzeżenie „another SPLITBRIEF process can open this run at the same time”, run idzie dalej bez locka' },
        { if: 'nie da się zapisać locka', then: 'to samo ostrzeżenie; brak heartbeatu' },
      ],
      default: 'writeLockfile(pid, startTimeMs, lastAliveMs) + startHeartbeat; release robi markExited(0).',
      notes: 'Apply at rest też bierze ten lock (apply/at-rest.ts:8), więc run w Apply czyta się jako running i drugi Apply jest odrzucony.',
    },
    {
      id: 'LC_ORPHAN_SESSION',
      title: 'Który folder sesji jest śmieciem',
      question: 'pruneOrphanSessions na starcie runWorkflow',
      where: 'src/core/sessions/orphans.ts:58',
      inputs: ['zawartość sessions/<id>/', 'mtime katalogu', 'ORPHAN_SESSION_GRACE_MS = 24h', 'wskaźnik active'],
      branches: [
        { if: 'to aktywna sesja', then: 'zostaje' },
        { if: 'katalog pusty i starszy niż 24 h', then: 'usunięty (rename do .claim, potem rm)' },
        { if: 'katalog ma tylko readiness.json i jest starszy niż 24 h', then: 'usunięty' },
      ],
      default: 'Każdy folder z state.json, logiem lub czymkolwiek innym zostaje na zawsze.',
    },
    {
      id: 'LC_ORPHAN_RUNNER',
      title: 'Które procesy narzędzi zabić',
      question: 'reapOrphanRunners: czy właściciel runu zniknął, a jego narzędzia żyją?',
      where: 'src/engine/orchestrator/run/orphan-reaper.ts:104',
      inputs: ['runner-pids.jsonl (pid, startTimeMs)', 'checkSessionLockStatus właściciela'],
      branches: [
        { if: 'lista pidów pusta', then: 'nic' },
        { if: 'lock właściciela nie jest dead ani exited (live, stale, missing, invalid)', then: 'nic: właściciel może jeszcze żyć' },
        { if: 'pid <= 1 albo startTimeMs = null albo pid reused', then: 'wpis pominięty' },
        { if: 'grupa procesów odpowiada na sygnał', then: 'SIGTERM, 2 s, potem SIGKILL' },
      ],
      default: 'releaseRunnerPids usuwa tylko zreapowane pary pid:startTime.',
      notes: 'Wywoływane na starcie runu (workflow.ts:196), przy zamykaniu (close.ts:98) i przy otwieraniu runu at rest w TUI (run-history.ts:34).',
    },
    {
      id: 'LC_ACTIVE_TAKEOVER',
      title: 'Kto może zmienić wskaźnik active',
      question: 'reactivateExistingSession / clearStaleSession / assertNoLiveSession',
      where: 'src/core/sessions/active-pointer.ts:385',
      inputs: ['.splitbrief/active (legacy id albo receipt v1)', 'inspectSessionLiveness właściciela'],
      branches: [
        { if: 'resume: active wskazuje inną sesję i jej właściciel ma takeover = true', then: 'nowy receipt (generation uuid) zastępuje wskaźnik' },
        { if: 'resume: właściciel żywy albo stale', then: 'błąd session-still-active' },
        { if: 'start nowego runu: clearStaleSessionForCli', then: 'kasuje wskaźnik tylko gdy sesja nie żyje; żywą zostawia jako blocker readiness repo.active-session-live' },
        { if: 'home / setup: assertNoLiveSessionForCli', then: 'odrzuca przy żywej sesji, nigdy nie kasuje wskaźnika' },
      ],
      default: 'Zapis przez temp + hardlink + CAS na (dev, ino, bytes) pod file lockiem.',
      notes: 'saveFinalSession kasuje receipt tylko gdy status = closed (finalize.ts:154); otwarty run zostaje tym, co podnosi splitbrief resume.',
    },
    {
      id: 'LC_STATE_VERSION',
      title: 'Czy state.json da się wczytać',
      question: 'loadState / classifyStateVersion',
      where: 'src/core/state/persistence.ts:61',
      inputs: ['stateVersion', 'WORKFLOW_STATE_VERSION = 4', 'LEGACY_STATE_VERSION = 3', 'zagnieżdżone version > 1'],
      branches: [
        { if: 'plik to symlink albo nieczytelny', then: 'null + ostrzeżenie; rekord czyta jako invalid · malformed' },
        { if: 'stateVersion = 3 i schema v3 ok', then: 'mapV3StateToV4 w pamięci (plik na dysku zostaje v3 do następnego zapisu)' },
        { if: 'stateVersion > 4 albo zagnieżdżona wersja > 1', then: 'invalid · future-version: resume odmawia' },
        { if: 'stateVersion = 4, schema nie przechodzi', then: 'invalid · malformed' },
      ],
      default: 'loaded; cache po (mtime, size), max 64 wpisów.',
      notes: 'Rekord z nieczytelnym stanem czyta się jako open · stopped · failed z komunikatem (run-record.ts:38); CLI resume i continue odmawiają z tym komunikatem.',
    },
    {
      id: 'LC_SAVED_STATE',
      title: 'Nowy run czy wznowienie',
      question: 'runWorkflow: purpose = new-workflow?',
      where: 'src/engine/orchestrator/run/workflow.ts:257',
      inputs: ['opts.prepared.purpose', 'readWorkflowStateHead'],
      branches: [
        { if: 'new-workflow, a sesja już ma stan poza idle', then: 'błąd workflow-session-already-started (inwariant)' },
        { if: 'new-workflow', then: 'createInitialState → START → workflow_started, user message = feature, ostrzeżenia readiness, opcjonalnie branch' },
        { if: 'resume', then: 'reopenSessionRecord (summary.json traci stop), head z dysku jako savedState, initializeWorkflow naprawia go' },
      ],
      default: 'Brak.',
      notes: 'Przy resume approve z config jest przypinane do stanu CAS-em (init.ts:231); konflikt rewizji = błąd.',
    },
    {
      id: 'LC_STALE_HALT',
      title: 'Halt, który już nie obowiązuje',
      question: 'isStaleHalt na wejściu do runu',
      where: 'src/engine/orchestrator/run/init.ts:630',
      inputs: ['pendingRecovery.reason', 'isRetiredRecoveryReason', 'state.workspace'],
      branches: [
        { if: 'powód wycofany', then: 'RESOLVE_PENDING_RECOVERY + warning stale_file_halt_resolved; run idzie dalej' },
        { if: 'checkout-changed, run bez workspace, zmiany tylko HEAD / branch', then: 'to samo' },
      ],
      default: 'Halt stoi: continue pokazuje panel recovery przed jakąkolwiek pracą.',
    },
    {
      id: 'LC_TASK_IN_FLIGHT',
      title: 'Brief po crashu czy po parku',
      question: 'isTaskInFlight: czy brief in_progress nie ma zapisanego parku?',
      where: 'src/engine/orchestrator/run/init.ts:751',
      inputs: ['interruptedStep', 'phase', 'tasks[currentTaskIndex].status', 'changedFilesBaseline.activeTaskSnapshot', 'evidence promotionAttempts'],
      branches: [
        { if: 'interruptedStep cut mid-step na briefie', then: 'park: pliki zostają, kontynuacja z partialem' },
        { if: 'validating-task / escalating', then: 'in flight → restartInterruptedTask' },
        { if: 'implementing, brak parku, task in_progress', then: 'in flight → restoreInterruptedTaskFiles ze snapshotu startu briefu + RESET_TASK (attempt 0)' },
        { if: 'starszy run z zapisaną promocją częściową', then: 'tylko RESET_TASK, bez cofania plików' },
      ],
      default: 'Nic.',
      notes: 'Pomijane, gdy pendingRecovery jest ustawione (init.ts:320).',
    },
    {
      id: 'LC_UNRESUMED_CUT',
      title: 'Przywrócenie parku z logu',
      question: 'restoreUnresumedBriefCut: log dowodzi cięcia, którego stan już nie ma?',
      where: 'src/engine/orchestrator/run/init.ts:712',
      inputs: ['session.jsonl: turn_interrupted, runner_call_started, recovery_resolved, task_reset'],
      branches: [
        { if: 'ostatnie turn_interrupted mid-step na bieżącym briefie, bez późniejszego startu wywołania, resetu ani recovery innej niż continued', then: 'RESTORE_BRIEF_PARK: brief wraca do swojej próby w zachowanym workspace' },
      ],
      default: 'Stan bez zmian; crash check decyduje.',
      notes: 'Scenariusz: halt, potem Stop w luce po RESUME_STEP zostawia brief in_progress bez parku.',
    },
    {
      id: 'LC_KEEP_WORKSPACE',
      title: 'Czy kontynuacja dziedziczy częściowe pliki',
      question: 'resumeContinuation: keepWorkspace i partial',
      where: 'src/engine/orchestrator/run/init.ts:590',
      inputs: ['interruptedStep.cut', 'interruptedStep.step', 'tasks[currentTaskIndex]', 'state.attempt', 'closed', 'rewindPending', 'steer'],
      branches: [
        { if: 'cut mid-step, krok to bieżący brief, task in_progress, ten sam attempt, run otwarty, bez rewind', then: 'keepWorkspace + briefFingerprint; partial z readInterruptedPartial (session.jsonl)' },
        { if: 'cut mid-step na planner / review', then: 'partial bez keepWorkspace' },
        { if: 'cut boundary', then: 'bez partiala; steer trzymany dla kroku' },
        { if: 'brak partiala, steeru i keepWorkspace', then: 'pusty holder' },
      ],
      default: 'Holder z krokiem = interruptedStep.step albo resumeStep(state).',
      notes: 'acquire(resume: true) nie cofa retained snapshot (isolation/create.ts:431); zmieniony brief (fingerprint) kasuje seed.',
    },
    {
      id: 'LC_CONTINUE_REFUSE',
      title: 'Jedna droga kontynuacji',
      question: 'continueRun: wznowić w miejscu, restartować czy odmówić?',
      where: 'src/engine/orchestrator/run/continue.ts:51',
      inputs: ['deps.resumeParked(steer)', 'loadState', 'deriveRunStatus(not-alive)', 'statusLeavesWordsUnread'],
      branches: [
        { if: 'ten proces trzyma park', then: 'continued-in-place: stopStore.resume(steer)' },
        { if: 'stan missing', then: 'refused: No saved state to continue.' },
        { if: 'stan invalid', then: 'refused z komunikatem' },
        { if: 'closed', then: 'refused: Cannot continue: this run is complete/ended/applied/undone/discarded; start a new one.' },
        { if: 'ready-to-apply', then: 'refused: choose Apply or Discard (/run accept, /run reject confirm)' },
        { if: 'słowa, a status ich nie czyta (Apply, halt bez wybranej akcji)', then: 'refused takes-no-words; UI wraca tekst do composera' },
      ],
      default: 'restart(state, steer): TUI przygotowuje narzędzia (continueRunInPlace) i odpala runWorkflow z savedState.',
    },
    {
      id: 'LC_ISOLATION_STRATEGY',
      title: 'Tryb workspace',
      question: 'openWorkspace: skąd bierze się kind?',
      where: 'src/engine/orchestrator/isolation/create.ts:257',
      inputs: ['workflow.isolation (domyślnie worktree)', 'state.workspace.kind (recorded)', 'retained-workspace.json'],
      branches: [
        { if: 'brak rekordu i (recorded = checkout lub strategy none)', then: 'kind checkout: projectDir, head = HEAD, keptFiles []' },
        { if: 'rekord staged-copy a strategy worktree', then: 'fallback „resuming retained staged-copy workspace”' },
        { if: 'strategy staged-copy', then: 'createStagedProject pod sessions/<id>/stage-<hex>/' },
        { if: 'strategy worktree', then: 'resolveWorktreeDir', next: 'LC_WORKTREE_AVAILABLE' },
      ],
      default: 'Zapis rekordu workspace (saveRecord) z owner = {runId, hash config.implementer}.',
      notes: 'Readiness blokuje start, gdy workflow.isolation nie jest ustawione, a stack ma workspace links / editable venv / go.work (readiness/checks/isolation.ts:100). Z none te checki znikają.',
    },
    {
      id: 'LC_PREVIOUS_RECORD',
      title: 'Powrót do zachowanego workspace',
      question: 'Czy retained-workspace.json wskazuje katalog, który nadal jest tym samym katalogiem?',
      where: 'src/engine/orchestrator/isolation/create.ts:280',
      inputs: ['record.location', 'record.directory (dev, ino, birthtimeMs)', 'record.retained', 'realpath projectDir'],
      branches: [
        { if: 'rekord nie parsuje się, inny projectDir / sessionId, > 8 MiB, hardlink', then: 'isolation-retention-unavailable: „The stopped workspace could not be verified. Its files were left in place; automatic continuation is blocked.”' },
        { if: 'katalog nie pasuje identycznością', then: 'to samo' },
        { if: 'worktree a resolveWorktreeDir daje inny katalog', then: 'to samo' },
        { if: 'retained = true', then: 'retainedAttempt: keptFiles = zmiany od snapshotu próby; acquire(resume) czyta je' },
      ],
      default: 'Workspace otwarty; publishRetainedWorkspaceNotice pokaże „Workspace kept at … for Continue” tylko dla otwartego runu z retained = true.',
    },
    {
      id: 'LC_WORKTREE_AVAILABLE',
      title: 'Czy worktree da się zrobić',
      question: 'resolveWorktreeDir + ensureIsolationWorktree',
      where: 'src/engine/orchestrator/isolation/create.ts:128',
      inputs: ['isGitRepo', 'hasCommits', 'isolation-marker', 'branch splitbrief/<slug>', 'git status node_modules'],
      branches: [
        { if: 'nie repo git', then: 'fallback staged-copy: project is not a git repository' },
        { if: 'brak commitów', then: 'fallback: repository has no commits' },
        { if: 'katalog trees/<key>/<id> istnieje z markerem innej sesji lub innego projektu', then: 'fallback: directory already exists and is not owned by session' },
        { if: 'branch splitbrief/<slug> już istnieje', then: 'worktree-branch-exists → fallback; porzucony worktree usuwany przy dispose' },
        { if: 'node_modules nie jest ignorowane i exclude się nie udał', then: 'fallback: the repository does not ignore node_modules' },
        { if: 'katalog istnieje z markerem tej sesji', then: 'reused = true, bez nowego baseline' },
      ],
      default: 'git worktree add -b splitbrief/<slug>, submodules, kopia config.yaml i hooks, seed dirty files i symlinków, chmod jak w checkout, link node_modules.',
      notes: 'Ostrzeżenie „Isolation worktree unavailable; falling back to a staged copy: <reason>” publikuje się raz na run (workflow.ts:221).',
    },
    {
      id: 'LC_RETAIN',
      title: 'Zachować czy cofnąć pliki próby',
      question: 'Po przerwaniu próby: retain() czy cleanup()?',
      where: 'src/engine/orchestrator/task/run-implementation.ts:314',
      inputs: ['isResumableWorkspaceStop(signal) = abort bez powodu workflow_cancelled', 'wynik próby (usage-limit, unauthenticated)', 'decyzja bramy zmian'],
      branches: [
        { if: 'abort użytkownika bez powodu zamknięcia (Stop now)', then: 'workspace.retain(): rekord retained = true, restoreFiles = zmiany od snapshotu; pliki zostają' },
        { if: 'abort z powodem (End run, sygnał z powodem)', then: 'cleanup(): revert do snapshotu próby w tle' },
        { if: 'seat down: usage-limit / unauthenticated', then: 'retain(): kontynuowana próba czyta częściowe edycje' },
        { if: 'anulowane potwierdzenie w bramie zmian', then: 'retain() (attempt-gate.ts:81)' },
        { if: 'brama odmówiła plików', then: 'revert tylko odmówionych plików' },
      ],
      default: 'W checkout retain nic nie zapisuje: częściowe zmiany zostają w checkout bez rekordu.',
      notes: 'Nieudany zapis rekordu = isolation-retention-failed: pliki zostają, a run mówi „Automatic continuation is unavailable”.',
    },
    {
      id: 'LC_STOP_KIND',
      title: 'Rodzaj zatrzymania',
      question: 'Co użytkownik wybrał w stop sheet albo co zrobił system?',
      where: 'src/features/workflow/stop/options.ts:114',
      inputs: ['stopStore.intent', 'bieżący brief', 'pendingRecovery.availableActions', 'activeApply()'],
      branches: [
        { if: 'Stop now (esc esc / ctrl+c)', then: 'abort; withContinuationLoop lub parkRun: INTERRUPT_STEP cut mid-step, kept files, turn_interrupted; run reads stopped · paused' },
        { if: 'Pause after this brief', then: 'parkAtBoundary po checkach i review briefu: INTERRUPT_STEP cut boundary na następnym kroku (task-execution.ts:62)' },
        { if: 'End run', then: 'endRun → closeRunIfOpen → ended (+ run.patch) + workflow_cancelled', next: 'LC_CLOSE_AS' },
        { if: 'halt otwarty', then: 'menu zostawia tylko Stop now i End run gdy halt go oferuje' },
        { if: 'run running w innym procesie albo Apply tego procesu', then: 'tylko Back to sessions' },
        { if: 'stop failed', then: 'tylko Retry stop' },
      ],
      default: 'Zaparkowany: Resume / End run (ukryte gdy applying) / Back to sessions; ready: End run = Discard.',
      notes: 'Esc nigdy nie zamyka runu; End run jest zawsze jawny. /stop podczas Apply: „Nothing to stop: Apply finishes on its own.” (defs/workflow.ts:28). → zobacz ui.',
    },
    {
      id: 'LC_RUN_END_PATH',
      title: 'Jak proces kończy run',
      question: 'runWorkflow po ciele: sygnał z powodem, abort czy normalne wyjście?',
      where: 'src/engine/orchestrator/run/workflow.ts:392',
      inputs: ['workflowCancelledReasonFromSignal(signal)', 'signal.aborted', 'trackedState', 'cancelled (sygnał OS)'],
      branches: [
        { if: 'sygnał z powodem (End run / quit z zamknięciem)', then: 'closeRunIfOpen → workflow_cancelled gdy zamknięto teraz' },
        { if: 'abort bez powodu', then: 'parkRun: INTERRUPT_STEP na resumeStep (gate → boundary, inaczej mid-step), chyba że już zaparkowany, halt, complete lub closed' },
        { if: 'SIGINT/SIGTERM/SIGHUP (cancelled)', then: 'shutdownWorkflow: killAllProcesses + zapis trackedState; workflow_cancelled user' },
        { if: 'wyjątek w ciele', then: 'killAllProcesses, publishError, recordLastFailure → stopped · failed' },
      ],
      default: 'saveFinalSession (summary.json, status z deriveRunStatus not-alive, clearActiveReceipt gdy closed); finally: clearBridgedCliState, isolation.dispose, recordCheckoutRunSnapshot, releaseLiveness (markExited).',
    },
    {
      id: 'LC_APPLY_GATE',
      title: 'Potwierdzenie Apply as is',
      question: 'askOverrideConfirmation: czy run zaakceptowany jako jest bez potwierdzenia?',
      where: 'src/engine/orchestrator/apply/run.ts:134',
      inputs: ['state.acceptedAsIs', 'overrideConfirmed', 'pendingRecovery', 'applying'],
      branches: [
        { if: 'acceptedAsIs, bez confirm, bez halt, bez applying', then: 'needs-confirmation: warning apply_override_unconfirmed z listą otwartych findings; result menu pyta raz (Apply as is)' },
      ],
      default: 'applyRun startuje; trackActiveApply trzyma go do końca runu (shutdown czeka).',
    },
    {
      id: 'LC_APPLY_PENDING',
      title: 'Apply z otwartym haltem',
      question: 'Czy pendingRecovery jest odpowiedzianym haltem Apply?',
      where: 'src/engine/orchestrator/apply/run.ts:162',
      inputs: ['pendingRecovery.reason = apply-partial', 'status = applying', 'selectedAction'],
      branches: [
        { if: 'halt nie odpowiedziany', then: 'halted: warning recovery_pending_unresolved, nic nie zapisano' },
        { if: 'restore-backup', then: 'restoreApplyBackup → APPLY_RESTORED → RESOLVE_PENDING_RECOVERY → outcome restored; run wraca do ready-to-apply' },
        { if: 'retry-same-worker', then: 'RESOLVE_PENDING_RECOVERY; retrying = true; removeApplyWriteTemporaries, potem normalny Apply z tym samym backupId' },
      ],
      default: 'Bez haltu: dalej.',
      notes: 'Headless: splitbrief continue <id> --action restore-backup / retry-same-worker; sam halt kończy komendę exit 1 z rekordem recovery_required.',
    },
    {
      id: 'LC_APPLY_CUT',
      title: 'Apply przerwane przez zniknięcie procesu',
      question: 'state.applying bez retry?',
      where: 'src/engine/orchestrator/apply/run.ts:223',
      inputs: ['state.applying.backupId', 'apply/<backupId>/manifest.json', 'bieżący checkout'],
      branches: [
        { if: 'applying ustawione i to nie retry', then: 'haltCutApply: reconcileApplyBackup klasyfikuje pliki (written / pending / ambiguous) i podnosi halt apply-partial „Apply was cut off: wrote N of M files”' },
      ],
      default: 'Dalej: capture.',
      notes: 'Ten halt oferuje tylko Retry i Restore (recovery/builders/apply.ts:104). End run i Discard odmawiają (assertCanCloseRun).',
    },
    {
      id: 'LC_MERGE_CONFLICT',
      title: 'Klasyfikacja pliku w merge',
      question: 'mergeApplyStates: dla każdej ścieżki base / ours / theirs',
      where: 'src/engine/orchestrator/apply/merge.ts:61',
      inputs: ['BaseEntry (snapshot workspace-base)', 'ours (workspace)', 'theirs (checkout)', 'applyIntegrated (hand-off)'],
      branches: [
        { if: 'ours = theirs', then: 'nic' },
        { if: 'base bez trybu lub brak, ten sam hash, inny mode', then: 'konflikt mode' },
        { if: 'ours = base', then: 'checkout wygrywa: zapis theirs do workspace (nie do checkoutu)' },
        { if: 'theirs = base lub hand-off pasuje', then: 'promote (run wygrywa); symlink poza projekt → unsupported-entry' },
        { if: 'base absent', then: 'add-add' },
        { if: 'jedna strona absent', then: 'delete-modify' },
        { if: 'symlink po którejś stronie', then: 'symlink' },
        { if: 'bajt 0 w którymś', then: 'binary' },
        { if: 'brak blobu base', then: 'text bez markerów' },
        { if: 'git merge-file konflikt', then: 'text z markerami' },
        { if: 'merge czysty, tryby nie do pogodzenia', then: 'mode' },
        { if: 'katalog w drodze w workspace', then: 'unsupported-entry' },
      ],
      default: 'Czysty merge: plik zapisany do workspace, promote. Przed zapisem verifyApplyStates sprawdza, że nic się nie zmieniło (apply-checkout-changed / apply-workspace-changed).',
    },
    {
      id: 'LC_CONFLICT_TEXT_ONLY',
      title: 'Konflikty tylko tekstowe',
      question: 'Czy każdy konflikt ma markery git?',
      where: 'src/engine/orchestrator/apply/run.ts:307',
      inputs: ['merged.conflicts[].kind', 'markers'],
      branches: [
        { if: 'wszystkie text z markerami', then: 'markery zapisane do workspace, RECORD_APPLY_INTEGRATED, APPLY_REVIEW_START z triage A1..An (source apply) → review tworzy fix tasks; potem Apply jeszcze raz' },
        { if: 'choć jeden inny', then: 'halt apply-conflict: „Resolve each file in <workspace>: keep the run’s version, copy your checkout’s version over it, or edit it; then choose Re-run Apply.” Akcje: retry-same-worker, end-run' },
      ],
      default: 'Brak.',
      notes: 'Plik unsupported-entry nie jest oddawany do hand-off (run.ts:344).',
    },
    {
      id: 'LC_CANDIDATE_CHANGED',
      title: 'Merge zmienił zrecenzowany wynik',
      question: 'Czy kandydat po merge różni się od reviewedCandidate?',
      where: 'src/engine/orchestrator/apply/run.ts:356',
      inputs: ['state.reviewedCandidate (path → entry key)', 'candidateOf(after)', 'theirs'],
      branches: [
        { if: 'zmienione ścieżki, a nie są tylko kopią checkoutu', then: 'APPLY_REVIEW_START (fix cycle +1, phase final-review): checki + review całego run diff z oznaczonymi hunkami checkoutu; komunikat „Your checkout changed N files this run also changed …”' },
      ],
      default: 'Kandydat bez zmian: zapis.',
      notes: 'Re-review liczy się do REVIEW_CYCLE_CAP. → zobacz review.',
    },
    {
      id: 'LC_BACKUP_CHANGED',
      title: 'Backup i osłona przed zapisem',
      question: 'writeApplyBackup: czy checkout wciąż jest tym, co Apply przeczytało?',
      where: 'src/engine/orchestrator/apply/backup.ts:128',
      inputs: ['theirs z capture', 'bieżący wpis w checkout', 'wpis w workspace'],
      branches: [
        { if: 'plik checkoutu różni się od theirs', then: 'changed → halt apply-conflict checkout-changed, bez zapisu' },
        { if: 'plik workspace zniknął', then: 'apply-workspace-changed' },
      ],
      default: 'Backup zapisany: replaced (sha, mode lub target), created + createdDirs, expected, kopia kandydata; fsync katalogów; potem APPLY_START(backupId).',
      notes: 'Backup leży pod .splitbrief/sessions/<id>/apply/<backupId>/; ten sam backupId jest używany przy retry (write.ts:32).',
    },
    {
      id: 'LC_WRITE_RESULT',
      title: 'Wynik zapisu do checkoutu',
      question: 'promoteStagedChanges: wszystko, część czy zmiana w trakcie?',
      where: 'src/engine/orchestrator/apply/write.ts:58',
      inputs: ['promoted.promotedFiles', 'promoted.failure', 'promoted.conflictedFiles'],
      branches: [
        { if: 'failedFile (błąd zapisu albo plik zmieniony w trakcie)', then: 'partial → halt apply-partial „Wrote N of M files; X failed: <cause>”; state.applying zostaje' },
        { if: 'wszystko', then: 'APPLY_DONE: applied {at, backupId, files}, closed {as: applied}; removeClosedRunWorkspace; workspace_closed' },
      ],
      default: 'Brak.',
      notes: 'Apply nie jest atomowe (WORKFLOW.md). Zamknięty run applied można cofnąć: /run reject confirm → undoApply → APPLY_UNDONE → status closed · undone.',
    },
    {
      id: 'LC_RESTORE_FILE',
      title: 'Restore z backupu, plik po pliku',
      question: 'classifyApplyBackup: czy plik w checkout pasuje do tego, co Apply zapisało?',
      where: 'src/engine/orchestrator/apply/restore.ts:31',
      inputs: ['backup.expected', 'backup.replaced', 'backup.created', 'wpis w checkout'],
      branches: [
        { if: 'pasuje do expected', then: 'written → restore pisze bajty sprzed Apply (lub kasuje created); folder utworzony przez Apply usuwany gdy pusty' },
        { if: 'pasuje do stanu sprzed', then: 'pending → unchanged' },
        { if: 'nie pasuje do żadnego', then: 'ambiguous → zostaje jak jest (conflict); warning apply_restore_conflict „left as you changed them”' },
        { if: 'zmienił się między klasyfikacją a zapisem', then: 'conflict' },
      ],
      default: 'Komunikat „Restored Apply backup: put back N replaced files, removed M created files”.',
    },
    {
      id: 'LC_CLOSE_AS',
      title: 'Jak zamyka się run bez Apply',
      question: 'closeRunIfOpen: as',
      where: 'src/engine/orchestrator/run/close.ts:167',
      inputs: ['argument as', 'deriveRunStatus(latest, not-alive)'],
      branches: [
        { if: 'as = discarded (Discard, /run reject confirm, --action discard)', then: 'closed · discarded' },
        { if: 'status ready-to-apply (End run na gotowym runie)', then: 'closed · discarded' },
        { if: 'inaczej (End run wcześniej, sygnał z powodem)', then: 'closed · ended' },
        { if: 'już closed', then: 'closedNow = false, nic nie pisze' },
      ],
      default: 'CAS do 3 prób; durability-uncertain = błąd.',
      notes: 'End run na ready nie pisze workflow_cancelled i nie pokazuje „Stopped by you” (userStopStoppedWork: tylko open lub ended).',
    },
    {
      id: 'LC_CLOSE_PATCH',
      title: 'Czy zamknięcie pisze run.patch',
      question: 'Workspace worktree / staged-copy nadal istnieje?',
      where: 'src/engine/orchestrator/run/close.ts:153',
      inputs: ['latest.workspace.kind', 'existsSync(workspace.path)', 'snapshot base + baseline'],
      branches: [
        { if: 'worktree / staged-copy i katalog istnieje', then: 'writeRunPatch: git diff --no-index --binary base vs workspace; brak zmian → brak pliku; closed.patch = ścieżka' },
        { if: 'katalog zniknął', then: 'warning „The run workspace at … is gone; no run patch was written.”' },
        { if: 'checkout lub brak workspace', then: 'bez patcha' },
        { if: 'base nie ma blobu dla pliku', then: 'run-patch-base-unavailable: run zostaje otwarty, workspace nietknięty' },
      ],
      default: 'Po commicie: usunięcie workspace i workspace_closed.',
      notes: 'Headless: „Run changes not applied are saved in <patch>; apply them with git apply.” (closedChangesSuffix).',
    },
    {
      id: 'LC_APPLY_UNFINISHED',
      title: 'Zamknięcie podczas niedokończonego Apply',
      question: 'assertCanCloseRun: state.applying?',
      where: 'src/engine/orchestrator/run/close.ts:252',
      inputs: ['state.applying'],
      branches: [
        { if: 'ustawione', then: 'błąd end-run-while-applying: „Apply did not finish. Restore or retry Apply first, then end the run.”; /end odmawia, stop sheet ukrywa End run, CLI --action end-run kończy exit 1' },
      ],
      default: 'Zamknięcie dozwolone.',
    },
    {
      id: 'LC_CLOSE_CHECKOUT_FILES',
      title: 'Czy run zostawił pliki w checkout',
      question: 'runLeftFilesInCheckout przy zamknięciu',
      where: 'src/engine/orchestrator/run/close.ts:45',
      inputs: ['workspace.kind', 'evidence ledger tasks[].changedFiles', 'tasks[].status (stary run)'],
      branches: [
        { if: 'checkout i ledger ma zmienione pliki, zamknięcie bez as', then: 'warning „This run edited your checkout directly: its changes are already there, so nothing is unapplied and no run patch was written.”' },
        { if: 'stary run bez workspace i jakiś task nie pending', then: 'suffix „The files it wrote are still on disk.”' },
      ],
      default: 'Bez notki.',
    },
    {
      id: 'LC_REJECT_CHECKOUT',
      title: 'Reject runu w trybie checkout',
      question: 'rejectCheckoutRun: co cofnięto i czy run się zamyka?',
      where: 'src/engine/orchestrator/run/close.ts:215',
      inputs: ['rejectRunSnapshot: baseline, ostatni run snapshot, bieżący checkout', 'conflictedPaths', 'missingSnapshotFiles', 'evidence ledger'],
      branches: [
        { if: 'brak run snapshot', then: 'not-found: „No run snapshot to reject.”, pliki bez zmian' },
        { if: 'cofnięto wszystko bez konfliktów i braków', then: 'closeRunIfOpen as discarded' },
        { if: 'konflikty lub brakujące pliki', then: 'run zostaje otwarty: RECORD_REJECT otwiera ponownie briefy, które zaksięgowały cofnięte pliki; continue buduje je od nowa' },
        { if: 'workspace worktree / staged-copy (nie checkout)', then: 'tylko rekord rejectu; zamknięcie robi Discard' },
      ],
      default: 'Zastąpione bajty leżą w sessions/<id>/reverted/<stamp>/.',
    },
    {
      id: 'LC_RUN_COMMAND',
      title: '/run accept i /run reject w TUI',
      question: 'acceptRun / rejectRun: co dostaje użytkownik przy danym statusie?',
      where: 'src/app/command-context.ts:148',
      inputs: ['readRunRecord(ref).status', 'isRunAtRest', 'state.workspace.kind', 'canUndoApply'],
      branches: [
        { if: 'accept, run closed', then: '„Run already applied.” lub „Run is closed (as).”' },
        { if: 'accept, run nie at rest lub running', then: '„Apply is unavailable while the run is active.”' },
        { if: 'accept, workspace nie checkout i nie ready', then: '„Run is not ready to apply.”' },
        { if: 'accept, checkout', then: 'closeRunIfOpen → ended; finalizeRunAtRest' },
        { if: 'accept, ready', then: 'runApplyAtRest(overrideConfirmed = confirm) → applied / halted / review / confirm-override' },
        { if: 'reject, closed applied bez undone', then: 'undoApply → closed · undone' },
        { if: 'reject, checkout', then: 'rejectCheckoutRun', next: 'LC_REJECT_CHECKOUT' },
        { if: 'reject, workspace', then: 'closeRunIfOpen as discarded' },
        { if: 'reject bez confirm', then: '„Usage: /run reject confirm”' },
      ],
      default: 'Result menu mapuje Apply → /run accept, Apply as is → /run accept confirm, Discard → /run reject confirm (result/options.ts:117).',
    },
    {
      id: 'LC_LISTING_ROW',
      title: 'Wiersz na liście sesji',
      question: 'rowFor(status, summary) i cache listy',
      where: 'src/core/sessions/io.ts:92',
      inputs: ['RunStatus', 'summary.json', 'sygnatura (ino, mtime, size) state.json / summary.json / lockfile.json'],
      branches: [
        { if: 'closed applied / undone z summary', then: 'status complete, apply = applied / undone; bez summary → ended' },
        { if: 'closed discarded', then: 'ended, apply = discarded' },
        { if: 'closed complete z summary', then: 'complete; bez summary → ended' },
        { if: 'ready-to-apply', then: 'open, apply = ready → słowo „ready to apply”' },
        { if: 'running', then: 'open bez stop → „running”' },
        { if: 'open', then: 'open, stop = waiting-for-you / stopped' },
        { if: 'state.json nieczytelny', then: 'wiersz z summary.json jak był zapisany' },
      ],
      default: 'Wiersz z cache gdy sygnatura się nie zmieniła i nie był running; running czyta się zawsze od nowa (zabity właściciel nie zmienia pliku).',
      notes: 'sessionStatusWord (display.ts:56) spelluje jedno słowo na każdej powierzchni.',
    },
    {
      id: 'LC_CLI_RESUME',
      title: 'splitbrief resume',
      question: 'Co podnosi resume i kiedy odmawia?',
      where: 'src/cli/commands/resume.ts:25',
      inputs: ['.splitbrief/active', 'checkSessionLiveness', 'loadRunRecord', '--json / --plain'],
      branches: [
        { if: 'brak active', then: '„no active session to resume.”' },
        { if: 'lock alive', then: '„session X is running — stop it before resuming, or use splitbrief continue once it stops.” exit 1' },
        { if: 'lock stale (processAlive)', then: '„session process N exists but is unresponsive — kill it first” exit 1' },
        { if: 'stan invalid', then: '„has invalid saved state: …”' },
        { if: 'stan missing', then: '„has no usable state.json — cannot resume. Start a new workflow with splitbrief start.”' },
        { if: 'headless i pendingRecovery lub pytanie', then: 'rekord recovery_required / input_required, exit 1 z linią continue --action' },
        { if: 'closed', then: 'assertResumableState: „Run X is closed (as); nothing to resume.”' },
        { if: 'ready-to-apply', then: 'readyToApplyMessage z komendami apply / discard' },
      ],
      default: 'resumeSavedSession: prepareExecution(purpose resume, reactivateExistingSession), hydrateRun, workflow screen z execution local.',
      notes: '→ zobacz startup.',
    },
    {
      id: 'LC_CLI_CONTINUE',
      title: 'splitbrief continue [id] --action',
      question: 'Jaką akcję wykonać na runie at rest?',
      where: 'src/cli/commands/continue/command.ts:144',
      inputs: ['id lub alias lub active', 'record.status', '--action end-run | apply | discard | restore-backup | <akcja recovery>'],
      branches: [
        { if: 'running', then: '„is still running — stop it before continuing.” exit 1' },
        { if: 'closed', then: '„Run X is closed (as); nothing to end/resume.” exit 1' },
        { if: '--action end-run', then: 'endRunAtRest (zapisuje przerwane wywołania, zamyka, finalizuje); applying → exit 1' },
        { if: '--action apply / discard a status nie ready', then: '„is not ready to apply; --action … settles a run whose review passed in its workspace.”' },
        { if: '--action discard', then: 'closeRunIfOpen discarded; „Run X discarded.” + suffix o run.patch' },
        { if: '--action apply', then: 'runApplyAtRest pod withHeadlessStop: applied / restored / review (kontynuacja) / needs-confirmation (exit 1) / halted (exit 1)' },
        { if: 'akcja recovery (retry, skip, switch-seat, …)', then: 'applyRecoveryAction, potem resumeSavedSession; switch-seat zapisuje seat do config.yaml' },
      ],
      default: 'resumeSavedSession.',
    },
    {
      id: 'LC_SESSION_SELECT',
      title: 'Otwarcie runu z listy',
      question: 'handleSessionSelect: pokazać at rest czy odmówić?',
      where: 'src/stores/navigation/session-select.ts:216',
      inputs: ['deps.applying()', 'routerStore (local run na ekranie)', 'readRunRecord', 'readRunHistory'],
      branches: [
        { if: 'Apply tego procesu pisze', then: '„Apply is still writing to your checkout. Cannot open …”' },
        { if: 'na ekranie run local', then: '„Stop the run on screen first. …”' },
      ],
      default: 'Replay session.jsonl do stores (reap orphans, interruptedCallEvents gdy proces zniknął), hydrateFromState, route workflow execution at-rest; bare Enter → continueRunInPlace flipuje execution na local bez nawigacji.',
      notes: '→ zobacz ui.',
    },
    {
      id: 'LC_FINALIZE',
      title: 'Zapis rekordu końcowego',
      question: 'saveFinalSession: co trafia do summary.json i czy active jest czyszczony?',
      where: 'src/engine/orchestrator/session-lifecycle/finalize.ts:142',
      inputs: ['trackedState', 'deriveRunStatus(not-alive)', 'activeTimeOf(session.jsonl)', 'receipt active'],
      branches: [
        { if: 'brak stanu', then: 'wiersz open · stopped · interrupted' },
        { if: 'status closed i receipt należy do tej sesji', then: 'clearActiveReceipt: splitbrief resume nie ma czego podnosić' },
        { if: 'status open / ready', then: 'wiersz z stop lub apply = ready; active zostaje' },
      ],
      default: 'summary.json z activeTime i phaseTimings; nieudany zapis = ostrzeżenie, run i tak zwraca summary.',
      notes: 'finalizeRunAtRest (End run, Apply at rest, Discard) używa tej samej drogi; refreshSessionRow po undoApply.',
    },
    {
      id: 'LC_DRAFT',
      title: 'Niewysłany tekst composera',
      question: 'writeSessionDraft przy wyjściu z ekranu runu',
      where: 'src/core/sessions/draft.ts:49',
      inputs: ['DraftDocument', 'draftLength', 'sessions/<id>/draft.json'],
      branches: [
        { if: 'draft niepusty', then: 'zapis draft.json (confined)' },
        { if: 'pusty i plik istnieje', then: 'unlink; błąd session-draft-not-removed gdy się nie uda' },
        { if: 'zapis się nie uda', then: 'session-draft-not-saved: pierwszy Esc / quit zostaje i nazywa plik, następny wychodzi bez draftu' },
      ],
      default: 'Pusty draft nie pisze pliku. Odczyt sanitizuje tekst jak wklejkę (sanitizePasteBody).',
    },
  ],
  config: [
    {
      key: 'workflow.isolation',
      values: 'worktree | staged-copy | none',
      default: 'worktree (gdy klucz nieobecny)',
      effect: 'Gdzie pracuje run i czy ma Apply. none = checkout: brak Apply, review passed zamyka jako complete, reject cofa ze snapshotów. Tryb zapisuje się raz w state.workspace.kind. Nieobecny klucz plus stack z workspace links / editable venv / go.work = blocker readiness z fix „Set workflow.isolation: none …”.',
      where: 'src/core/config/accessors/values.ts:8',
    },
    {
      key: 'XDG_STATE_HOME',
      values: 'ścieżka absolutna (env)',
      default: '~/.local/state',
      effect: 'Korzeń worktree runów (…/splitbrief/trees/<sha12 git-common-dir>/<session-id>) i drzew bazy (…/splitbrief/bases/).',
      where: 'src/core/paths.ts:141',
    },
    {
      key: 'workflow.git.createBranch',
      values: 'true | false',
      default: 'wyłączone',
      effect: 'Przy START nowego runu tworzy branch splitbrief/<slug> w checkout; błąd daje tylko ostrzeżenie.',
      where: 'src/engine/orchestrator/run/init.ts:485',
    },
    {
      key: 'workflow.approve',
      values: 'plan | none',
      default: 'plan',
      effect: 'Przy wznowieniu wartość z config jest przypinana do zapisanego stanu (state.approve) przez CAS; stary stan z inną wartością jest przepisywany.',
      where: 'src/engine/orchestrator/run/init.ts:232',
    },
    {
      key: 'workflow.compactionThreshold',
      values: 'liczba wiadomości',
      default: 'brak (wyłączone)',
      effect: 'Przy continue bez natywnej sesji plannera transkrypt odbudowany z session.jsonl jest kompaktowany, gdy przekracza próg. → zobacz subsystems.',
      where: 'src/engine/orchestrator/resume-context.ts:34',
    },
    {
      key: 'continue --action',
      values: 'end-run | apply | discard | restore-backup | retry-same-worker | skip | switch-seat | …',
      default: 'brak (zwykłe wznowienie)',
      effect: 'Rozstrzyga run at rest bez TUI: zamyka, stosuje, odrzuca, przywraca backup Apply albo odpowiada na halt.',
      where: 'src/cli/commands/continue/command.ts:186',
    },
    {
      key: '--json / --plain',
      values: 'flaga',
      default: 'TUI',
      effect: 'Headless: pytanie plannera i halt kończą komendę exit 1 z rekordem input_required / recovery_required; ready-to-apply pisze ready_to_apply z komendami apply i discard; sygnał kończy z kodem 128+signal po tym, jak Apply dokończy.',
      where: 'src/cli/headless.ts:73',
    },
  ],
  states: [
    { name: 'running', meaning: 'Żywy proces trzyma lockfile (heartbeat < 8 s). Także Apply at rest.', where: 'src/core/sessions/run-status.ts:200' },
    { name: 'open · waiting-for-you · question', meaning: 'Planner czeka na odpowiedź; bare Enter bierze domyślne.', where: 'src/core/sessions/run-status.ts:232' },
    { name: 'open · waiting-for-you · gate', meaning: 'Plan card (reopens) albo stara brama spec/briefs.', where: 'src/core/sessions/run-status.ts:250' },
    { name: 'open · waiting-for-you · halt', meaning: 'pendingRecovery czeka na akcję: Needs you / Seat down / apply-conflict / apply-partial.', where: 'src/core/sessions/run-status.ts:221' },
    { name: 'open · stopped · paused (mid-step | boundary)', meaning: 'Stop użytkownika albo watchdog; kept = pliki briefu, które zostały.', where: 'src/core/sessions/run-status.ts:240' },
    { name: 'open · stopped · seat-wait', meaning: 'Seat czeka do resetAt; continue najpierw odczekuje.', where: 'src/core/sessions/run-status.ts:224' },
    { name: 'open · stopped · failed', meaning: 'lastFailure: krok umarł na błędzie; continue powtarza krok.', where: 'src/core/sessions/run-status.ts:254' },
    { name: 'open · stopped · interrupted', meaning: 'Proces zniknął bez zapisu (crash). Brief in_progress restartuje od zera.', where: 'src/core/sessions/run-status.ts:257' },
    { name: 'ready-to-apply (override)', meaning: 'Worktree / staged-copy z passed review (override = Accept as is). Apply / Show diff / Discard.', where: 'src/core/sessions/run-status.ts:201' },
    { name: 'closed · complete', meaning: 'Checkout run lub stary run z passed review; bez Apply.', where: 'src/core/sessions/run-status.ts:198' },
    { name: 'closed · applied', meaning: 'APPLY_DONE zapisał pliki do checkoutu; backup pozwala na undo.', where: 'src/core/state/machine.ts:615' },
    { name: 'closed · undone', meaning: '/run reject confirm po Apply przywrócił backup; stan trzyma closed.as applied + applied.undone.', where: 'src/core/sessions/run-status.ts:189' },
    { name: 'closed · discarded', meaning: 'Discard, reject lub End run na ready; run.patch zachowany.', where: 'src/engine/orchestrator/run/close.ts:167' },
    { name: 'closed · ended', meaning: 'End run przed ready (lub sygnał z powodem); run.patch dla workspace runów.', where: 'src/core/state/machine.ts:646' },
    { name: 'lock: missing | invalid | exited | dead | stale | live', meaning: 'Klasyfikacja lockfile; tylko dead/exited/missing/invalid pozwalają na przejęcie.', where: 'src/core/sessions/lockfile-status.ts:145' },
    { name: 'workspace.kind: worktree | staged-copy | checkout', meaning: 'Gdzie leży kod runu; zapisane raz w RECORD_WORKSPACE.', where: 'src/engine/orchestrator/run/task-execution.ts:332' },
    { name: 'Session row words', meaning: 'running, waiting for you, stopped, ready to apply, applied, apply undone, discarded, complete, ended.', where: 'src/core/sessions/display.ts:56' },
  ],
  scenarios: [
    {
      title: 'Szczęśliwa ścieżka: start → worktree → review passed → Apply',
      steps: [
        '1. runWorkflow: reapOrphanRunners, pruneOrphanSessions, acquireLiveness pisze lockfile.json i startuje heartbeat co 2 s (workflow.ts:196-199).',
        '2. START, workflow_started, user message z feature; planowanie i plan card (→ planning).',
        '3. runTasksAndReview: snapshot baseline, snapshot workspace-base, isolation.open: repo git z commitami → git worktree add w ~/.local/state/splitbrief/trees/<key>/<id> na branchu splitbrief/<id>, seed dirty files, link node_modules; RECORD_WORKSPACE (task-execution.ts:294-338).',
        '4. Briefy budują w worktree (→ build); po pętli snapshot pre-final-review (recordRunSnapshotForRun) i final review (→ review).',
        '5. Review passed w phase complete: proces kończy, saveFinalSession, markExited → deriveRunStatus daje ready-to-apply; ekran pokazuje Apply · Show diff · Discard.',
        '6. Apply (/run accept): runApplyAtRest bierze lock (run czyta running), captureApplyStates, merge czysty, kandydat = reviewedCandidate, writeApplyBackup, APPLY_START, promoteStagedChanges, APPLY_DONE.',
        '7. removeClosedRunWorkspace: git worktree remove + branch -D, clearWorkspaceRecord, workspace_closed; finalizeRunAtRest czyści active.',
      ],
      outcome: 'Run closed · applied; lista mówi „applied”; backup pod sessions/<id>/apply/<backupId>/ pozwala na /run reject confirm (undo).',
    },
    {
      title: 'Stop now w środku briefu, potem continue',
      steps: [
        '1. esc esc: requestStopNow → abort wywołania implementera (handlers.ts:166).',
        '2. run-implementation.ts:312: abort bez powodu zamknięcia → workspace.retain(): retained-workspace.json retained = true z restoreFiles.',
        '3. withContinuationLoop / parkRun: INTERRUPT_STEP {step: brief T002 attempt 1, source user, cut mid-step, kept: [pliki]}, turn_interrupted, częściowy strumień w session.jsonl z interrupted: true.',
        '4. runWorkflow finally: dispose (worktree zostaje), recordCheckoutRunSnapshot (nic dla worktree), markExited; summary.json ze stop = stopped.',
        '5. Lista: „stopped”; ekran at rest; notka „Workspace kept at … for Continue”.',
        '6. Bare Enter: continueRun → restart; init: resumeContinuation widzi cut mid-step na T002 z tym samym attempt → keepWorkspace + partial z logu.',
        '7. acquire(resume: true) nie cofa plików; brief dostaje swój prompt plus partial i linię z plikami, które już zmienił.',
      ],
      outcome: 'T002 kontynuuje tę samą próbę na swoich częściowych edycjach; licznik prób nie rośnie.',
    },
    {
      title: 'Crash (kill -9) w trakcie briefu',
      steps: [
        '1. Proces znika: lockfile bez exitedAt, heartbeat stoi, state.json ma T003 in_progress bez interruptedStep.',
        '2. Lista czyta lock: pid nie żyje → dead → not-alive; deriveRunStatus: brak halt / park / gate / lastFailure → open · stopped · interrupted.',
        '3. Otwarcie runu w TUI: readRunHistory reapuje osierocone narzędzia (runner-pids.jsonl) i dokleja do replay interruptedCallEvents (runner_call_error runner_interrupted, endUnknown).',
        '4. continue: init recordInterruptedCalls pisze te zdarzenia do logu; isTaskInFlight = true → restoreInterruptedTaskFiles ze snapshotu startu T003 i RESET_TASK.',
        '5. Pętla briefów startuje T003 od attempt 0 na czystym drzewie; wcześniejsze zaliczone briefy zostają w workspace.',
      ],
      outcome: 'Częściowe pliki T003 są cofnięte („nikt nie wybrał, żeby je zachować”); run idzie dalej.',
    },
    {
      title: 'Apply: obie strony zmieniły te same linie',
      steps: [
        '1. Użytkownik edytował src/a.ts w checkout w czasie runu; run też go zmienił.',
        '2. runApply: capture base/ours/theirs; mergeApplyStates: git merge-file daje konflikt → text z markerami.',
        '3. Wszystkie konflikty tekstowe: markery zapisane do workspace, RECORD_APPLY_INTEGRATED (hand-off), APPLY_REVIEW_START z triage A1 „Apply merge conflict in src/a.ts…”.',
        '4. Run wraca do final-review; review robi fix task, implementer rozwiązuje markery; review passed → ready-to-apply.',
        '5. Drugi Apply: bindApplyHandOffs wiąże rozwiązanie; plik handed-off bierze stronę workspace, gdy checkout wciąż ma to, co Apply widziało.',
      ],
      outcome: 'Checkout nie dostał żadnego zapisu przy pierwszym Apply; drugi zapisuje scalony wynik.',
    },
    {
      title: 'Apply przerwane po APPLY_START (padnięcie zasilania)',
      steps: [
        '1. state.applying = {backupId}; część plików zapisana, część nie, obok mogą leżeć pliki tymczasowe zapisu.',
        '2. Po restarcie: lock dead → not-alive; awaitsApply true, ale applyUnfinished true → nie ready; brak halt → open · stopped · interrupted; resumeStep = apply.',
        '3. continue: runPlanningPhases widzi kind apply → runApply; applying bez retry → haltCutApply: reconcileApplyBackup klasyfikuje written / pending / ambiguous i podnosi halt apply-partial „Apply was cut off: wrote 2 of 5 files”.',
        '4. Menu oferuje tylko Retry i Restore; End run i Discard odmawiają: „Apply did not finish. Restore or retry Apply first, then end the run.”',
        '5a. Restore: restoreApplyBackup pisze bajty sprzed Apply dla written, kasuje created, zostawia ambiguous; APPLY_RESTORED → run znów ready-to-apply.',
        '5b. Retry: removeApplyWriteTemporaries, ten sam backupId, capture i zapis od nowa.',
      ],
      outcome: 'Checkout wraca do stanu sprzed Apply albo Apply się dokańcza; nic nie ginie po cichu.',
    },
    {
      title: 'Użytkownik zmienił plik, który run też zmienił, bez konfliktu linii',
      steps: [
        '1. mergeApplyStates: ours i theirs różnią się od base w różnych liniach → git merge-file scala czysto; wynik zapisany do workspace.',
        '2. candidateOf(after) różni się od reviewedCandidate → APPLY_REVIEW_START (fix cycle +1) z merged hunkami checkoutu.',
        '3. Komunikat „Your checkout changed 1 file this run also changed (src/b.ts); the merged result goes through its checks and the review again before Apply.”',
        '4. Checki + review całego run diff; passed → ready-to-apply; Apply bez zmiany kandydata → zapis.',
      ],
      outcome: 'Scalony wynik jest zrecenzowany przed zapisem; ręczne zmiany użytkownika nie są tracone.',
    },
    {
      title: 'Tryb checkout (workflow.isolation: none)',
      steps: [
        '1. openWorkspace: brak rekordu i strategy none → kind checkout; RECORD_WORKSPACE z head = HEAD; readiness ostrzega o niezacommitowanych zmianach i nazywa reverted/.',
        '2. Każdy brief pisze wprost w checkout; po każdym briefie snapshot post-task-N (recordCheckoutRunSnapshot).',
        '3. Review passed → deriveRunStatus: phase complete + checkout → closed · complete, bez Apply i bez run.patch.',
        '4. /run accept na otwartym checkout runie → closeRunIfOpen → ended; notka „This run edited your checkout directly…”.',
        '5. /run reject confirm → rejectRunSnapshot porównuje baseline, ostatni run snapshot i checkout; cofa tylko zapisane zmiany runu; bez konfliktów → discarded; z konfliktami run zostaje otwarty i briefy z cofniętymi plikami są znów do zbudowania.',
      ],
      outcome: 'Brak kroku Apply; cofanie idzie ze snapshotów, zastąpione bajty leżą w sessions/<id>/reverted/<stamp>/.',
    },
    {
      title: 'Discard i End run na runie ready-to-apply',
      steps: [
        '1. Discard (/run reject confirm) albo End run ze stop sheet na ready: closeRunIfOpen(as discarded) lub status ready → as discarded.',
        '2. reapOrphanRunners; writeRunPatch: git diff --no-index base vs workspace → sessions/<id>/run.patch (brak zmian = brak pliku).',
        '3. CLOSE_RUN {as: discarded, patch}; removeClosedRunWorkspace usuwa worktree i branch albo stage-<hex>/; workspace_closed; finalizeRunAtRest.',
        '4. End run wcześniej (np. na zaparkowanym briefie) idzie tą samą drogą, ale as = ended i dodatkowo workflow_cancelled.',
      ],
      outcome: 'Run closed · discarded (lub ended); zmiany są w run.patch do „git apply”; Patch row w closed block.',
    },
    {
      title: 'Drugi proces próbuje wejść do runu, który pracuje',
      steps: [
        '1. splitbrief continue <id>: loadRunRecord → liveness alive → status running → „session X is still running — stop it before continuing.” exit 1.',
        '2. splitbrief resume: checkSessionLiveness alive → „session X is running — stop it before resuming, or use splitbrief continue once it stops.”',
        '3. Gdy proces żyje, ale heartbeat stoi > 8 s (stale): resume mówi „session process N exists but is unresponsive — kill it first”; nikt nie przejmuje wskaźnika active.',
        '4. TUI: otwarcie runu z listy pokazuje go at rest jako running; stop sheet ma tylko „Back to sessions”.',
      ],
      outcome: 'Jeden run, jeden proces; zawieszony właściciel wymaga ręcznego zabicia.',
    },
    {
      title: 'Stary worktree o tej nazwie należy do innej sesji',
      steps: [
        '1. ensureIsolationWorktree: katalog trees/<key>/<id> istnieje, marker nazywa inną sesję lub inny projectDir.',
        '2. result fallback „directory … already exists and is not owned by session …” → reportFallback raz → latchedStrategy staged-copy.',
        '3. Warning „Isolation worktree unavailable; falling back to a staged copy: …”; createStagedProject pod sessions/<id>/stage-<hex>/workspace.',
        '4. RECORD_WORKSPACE kind staged-copy; dispose nie rusza obcego worktree.',
      ],
      outcome: 'Run pracuje w staged-copy; Apply działa tak samo.',
    },
    {
      title: 'Esc na zaparkowanym runie z niewysłanym tekstem',
      steps: [
        '1. Esc wraca home; writeSessionDraft zapisuje draft.json pod sesją (pusty draft nie pisze pliku).',
        '2. Zapis się nie udaje (pełny dysk): session-draft-not-saved → pierwszy Esc zostaje i nazywa plik i przyczynę; drugi wychodzi bez draftu; komunikat zostaje jako Warning na końcu transkryptu.',
        '3. Ponowne otwarcie runu: readSessionDraft przywraca tekst (sanitizePasteBody); bare Enter wysyła go jako steer kontynuacji.',
      ],
      outcome: 'Tekst użytkownika przeżywa wyjście z ekranu; awaria zapisu jest nazwana, nie ukryta.',
    },
  ],
  files: [
    { path: 'src/core/sessions/run-status.ts', role: 'deriveRunStatus, resumeStep, awaitsApply, canUndoApply, applyUnfinished, processWentAway' },
    { path: 'src/core/sessions/run-record.ts', role: 'RunRecord: stan + liveness + summary + ledger + checkpoint w jednym odczycie' },
    { path: 'src/core/sessions/run-record-io.ts', role: 'readRunRecord z prawdziwymi czytnikami (lockfile, summary.json, evidence, run-ledger.json)' },
    { path: 'src/core/sessions/io.ts', role: 'rowFor, listSessions z cache po sygnaturze plików; saveSummary / readSession' },
    { path: 'src/core/sessions/lockfile.ts', role: 'writeLockfile, updateHeartbeat (read-modify-write z CAS), markExited, checkSessionLiveness' },
    { path: 'src/core/sessions/lockfile-status.ts', role: 'checkSessionLockStatus: missing/invalid/exited/dead/stale/live; HEARTBEAT_STALENESS_MS 8000' },
    { path: 'src/core/sessions/liveness.ts', role: 'inspectSessionLiveness: live i takeoverMayBeAttempted' },
    { path: 'src/core/sessions/active-pointer.ts', role: '.splitbrief/active: legacy id lub receipt v1; CAS przez hardlink; reactivateExistingSession' },
    { path: 'src/core/sessions/guards.ts', role: 'clearStaleSession (tylko start nowego runu), assertNoLiveSession (home, setup)' },
    { path: 'src/core/sessions/orphans.ts', role: 'pruneOrphanSessions: puste foldery sesji > 24 h' },
    { path: 'src/core/sessions/runner-pids.ts', role: 'runner-pids.jsonl: pidy narzędzi do reapera' },
    { path: 'src/core/sessions/log-writer.ts', role: 'session.jsonl append: walidacja, limit bajtów wpisu, odmowa symlinku' },
    { path: 'src/core/sessions/log-reader.ts', role: 'streamowy odczyt session.jsonl, readCompactedMessages dla transkryptu' },
    { path: 'src/core/sessions/draft.ts', role: 'draft.json: zapis i odczyt niewysłanego tekstu' },
    { path: 'src/core/sessions/prepare.ts', role: 'prepareNewSession: katalog sesji z markerem własności, wskaźnik active' },
    { path: 'src/core/sessions/confinement.ts', role: 'każda ścieżka pliku sesji sprawdzana przeciw symlinkom i ucieczce z katalogu' },
    { path: 'src/core/state/persistence.ts', role: 'saveState (CAS na rewizji), loadState (v3 → v4 w pamięci, cache)' },
    { path: 'src/core/state/state-file.ts', role: 'readRawState, classifyStateVersion (malformed / future-version / v3 / v4)' },
    { path: 'src/core/state/resume-hydration.ts', role: 'loadOwnerWorkflowState: loaded / missing / invalid, unsaved failure w pamięci' },
    { path: 'src/core/state/machine.ts', role: 'RECORD_WORKSPACE, APPLY_*, CLOSE_RUN, INTERRUPT_STEP, RESUME_STEP, RESTORE_BRIEF_PARK, RECORD_REJECT' },
    { path: 'src/engine/orchestrator/state-ops.ts', role: 'commitWorkflowState (CAS, 3 próby), parkStoppedRun, recordLastFailure, raisePendingRecovery' },
    { path: 'src/engine/orchestrator/run/workflow.ts', role: 'runWorkflow: lock, izolacja, shutdown handlers, park/close na końcu, finalize, dispose' },
    { path: 'src/engine/orchestrator/run/init.ts', role: 'initializeWorkflow: naprawa zapisanego stanu, stale halt, crash restart, resumeContinuation, workflow_resumed' },
    { path: 'src/engine/orchestrator/run/phases.ts', role: 'runPlanningPhases: RESUME_STEP, rozdział po resumeStep (apply / brief / review / gate / planner)' },
    { path: 'src/engine/orchestrator/run/continue.ts', role: 'continueRun: jedna droga kontynuacji i jej odmowy' },
    { path: 'src/engine/orchestrator/run/close.ts', role: 'closeRunIfOpen, endRun, endRunAtRest, rejectCheckoutRun, assertCanCloseRun' },
    { path: 'src/engine/orchestrator/run/liveness.ts', role: 'acquireLiveness / heldLiveness' },
    { path: 'src/engine/orchestrator/run/orphan-reaper.ts', role: 'reapOrphanRunners: SIGTERM, 2 s, SIGKILL dla narzędzi martwego właściciela' },
    { path: 'src/engine/orchestrator/run/heartbeat.ts', role: 'ping co HEARTBEAT_STALENESS_MS / 4' },
    { path: 'src/engine/orchestrator/run/snapshots.ts', role: 'baseline, pre-final-review, post-task-N (checkout)' },
    { path: 'src/engine/orchestrator/run/task-execution.ts', role: 'parkAtBoundary, snapshot workspace-base, isolation.open, RECORD_WORKSPACE, run-workspace-moved' },
    { path: 'src/engine/orchestrator/continuation.ts', role: 'readInterruptedPartial, readUnresumedBriefCut, ContinuationHolder, withContinuationLoop' },
    { path: 'src/engine/orchestrator/kept-work.ts', role: 'keptBriefFiles: pliki briefu, które stop zachował' },
    { path: 'src/engine/orchestrator/session-lifecycle/finalize.ts', role: 'saveFinalSession, finalizeRunAtRest, reopenSessionRecord, refreshSessionRow' },
    { path: 'src/engine/orchestrator/session-lifecycle/shutdown.ts', role: 'withShutdownHandlers, trackActiveApply / activeApply' },
    { path: 'src/engine/orchestrator/signals.ts', role: 'SIGINT/SIGTERM/SIGHUP → handler; SIGNAL_EXIT_CODE' },
    { path: 'src/engine/orchestrator/isolation/create.ts', role: 'createRunIsolation: open / acquire / dispose, fallback na staged-copy, retain' },
    { path: 'src/engine/orchestrator/isolation/retention.ts', role: 'retained-workspace.json, retentionError, publishRetainedWorkspaceNotice' },
    { path: 'src/engine/orchestrator/isolation/worktree.ts', role: 'ensureIsolationWorktree: marker, seed, node_modules link i exclude' },
    { path: 'src/engine/orchestrator/isolation/remove-worktree.ts', role: 'removeRunWorkspace: worktree remove + branch -D albo rm staged root' },
    { path: 'src/engine/orchestrator/isolation/acquisition.ts', role: 'isolation-baseline.json, reconcileWorkspaceToBase, createRunBaseReader' },
    { path: 'src/engine/orchestrator/isolation/base-tree.ts', role: 'withRunBaseTree: drzewo bazy pod bases/base-<pid>-* do base re-run' },
    { path: 'src/engine/orchestrator/apply/run.ts', role: 'runApply: override, halt, cut, capture, merge, re-review, write' },
    { path: 'src/engine/orchestrator/apply/states.ts', role: 'captureApplyStates (base / ours / theirs), candidateOf, verifyApplyStates' },
    { path: 'src/engine/orchestrator/apply/merge.ts', role: 'mergeApplyStates: klasyfikacja konfliktów, zapis do workspace' },
    { path: 'src/engine/orchestrator/apply/backup.ts', role: 'writeApplyBackup / readApplyBackup pod sessions/<id>/apply/<backupId>/' },
    { path: 'src/engine/orchestrator/apply/write.ts', role: 'writeApply: APPLY_START, promoteStagedChanges, APPLY_DONE / partial' },
    { path: 'src/engine/orchestrator/apply/restore.ts', role: 'reconcileApplyBackup, restoreApplyBackup, undoApply' },
    { path: 'src/engine/orchestrator/apply/patch.ts', role: 'writeRunPatch: run.patch z git diff --no-index' },
    { path: 'src/engine/orchestrator/apply/at-rest.ts', role: 'runApplyAtRest: Apply pod lockiem liveness' },
    { path: 'src/engine/orchestrator/apply/hand-off.ts', role: 'handOff / bindApplyHandOffs dla plików konfliktowych' },
    { path: 'src/engine/calls/interrupted.ts', role: 'recordInterruptedCalls: domknięcie otwartych wywołań po crashu' },
    { path: 'src/cli/commands/resume.ts', role: 'splitbrief resume' },
    { path: 'src/cli/commands/continue/command.ts', role: 'splitbrief continue [id] --action' },
    { path: 'src/cli/commands/continue/settle.ts', role: '--action apply / discard' },
    { path: 'src/cli/commands/status.ts', role: 'splitbrief status: feature, status word, task, started, session' },
    { path: 'src/features/workflow/run-history.ts', role: 'hydrateRun / readRunHistory: replay session.jsonl do stores' },
    { path: 'src/stores/navigation/session-select.ts', role: 'handleSessionSelect, continueRunInPlace' },
    { path: 'src/features/workflow/handlers.ts', role: 'requestStopNow, requestResume, requestSteer, requestEndRun, rereadRunAtRest' },
    { path: 'src/features/workflow/stop/options.ts', role: 'wiersze stop sheet zależne od stanu' },
    { path: 'src/features/workflow/result/options.ts', role: 'Apply · Show diff · Discard i mapowanie na /run' },
    { path: 'src/app/command-context.ts', role: 'acceptRun / rejectRun: odmowy i drogi Apply, Discard, undo' },
  ],
  gotchas: [
    'WORKFLOW.md (Run status) mówi, że stopped ma powody paused / failed / interrupted. Kod ma czwarty: seat-wait (run-status.ts:23, 210), sprawdzany między halt a pytaniem plannera.',
    'Kolejność w deriveRunStatus jest regułą: closed → complete-checkout → alive → ready → halt → seat-wait → question → park → gate → failed → interrupted. Run z halt i parkiem naraz czyta się jako waiting-for-you · halt.',
    'Lock stale (proces żyje, heartbeat > 8 s) blokuje przejęcie: takeoverMayBeAttempted = false. Trzeba zabić proces ręcznie; resume mówi to wprost.',
    'Apply at rest bierze lock liveness, więc run w Apply czyta się jako running na każdej liście, a /stop mówi „Nothing to stop: Apply finishes on its own.”',
    'Halt apply-partial nie oferuje End run. assertCanCloseRun odrzuca End run i Discard, dopóki state.applying stoi. Tylko Restore lub Retry go kończy.',
    'End run na ready-to-apply zamyka jako discarded, nie ended, i nie pisze workflow_cancelled. End run wcześniej zamyka jako ended. Oba piszą run.patch dla worktree / staged-copy.',
    'W trybie checkout /run accept na otwartym runie zamyka jako ended (nie complete); complete daje tylko passed review.',
    'Park (Stop now) zachowuje częściowe pliki briefu i kontynuuje tę samą próbę. Crash (brak interruptedStep) cofa pliki ze snapshotu startu briefu i startuje attempt 0.',
    'Tryb workspace zapisuje się raz (RECORD_WORKSPACE). Zmiana workflow.isolation po starcie nic nie zmienia dla tego runu; recorded kind wygrywa w openWorkspace.',
    'Każda awaria worktree (brak gita, brak commitów, obcy marker, istniejący branch, nieignorowane node_modules) to cichy fallback na staged-copy z jednym ostrzeżeniem, nie błąd.',
    'Lista sesji ma cache po (ino, mtime, size) trzech plików; wiersz running czyta się zawsze od nowa, bo zabity właściciel nie zmienia żadnego pliku.',
    'state.json v3 jest migrowany do v4 tylko w pamięci przy odczycie; plik na dysku zmienia wersję przy pierwszym zapisie przez CAS.',
    'Nieudany zapis lastFailure trzyma awarię tylko w pamięci procesu (keepUnsavedFailure). Inny proces czyta z dysku „zatrzymany na ostatnim kroku”, bez komunikatu błędu.',
    'saveFinalSession czyści .splitbrief/active tylko dla runu closed. Otwarty run zostaje tym, co podnosi splitbrief resume; home i setup nigdy nie kasują wskaźnika.',
    'pruneOrphanSessions usuwa tylko puste foldery (lub z samym readiness.json) starsze niż 24 h. Folder z state.json nigdy nie znika sam.',
    'Zamknięty run applied można cofnąć: /run reject confirm → undoApply → closed · undone; summary.json dostaje nowy wiersz przez refreshSessionRow.',
  ],
});
