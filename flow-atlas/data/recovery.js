window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: "recovery",
  order: 6,
  title: "Halty, limity i fallback",
  tagline: "Co się dzieje, gdy wywołanie seat-a pada: klasyfikacja przyczyny, halt `Needs you` lub `Seat down`, automatyczny fallback, menu recovery i powrót do biegu.",
  summary: `Każde nieudane wywołanie seat-a (PLAN, BUILD, REVIEW) przechodzi przez jeden klasyfikator: classifySeatFailure. Wynik to jedna z pięciu klas: authoritative, account (auth, quota, balance, billing), rate-limited (z odczytaną godziną resetu), transient albo other. Od klasy zależy, czy wywołanie jest powtarzane po cichu, czy run czeka, czy powstaje halt.

Halt to obiekt RecoveryIssue zapisany w state.json jako pendingRecovery. Ma reason (kod przyczyny), seat, opcjonalnie taskId, listę availableActions i recommendedAction. Jedna funkcja, haltOf, mapuje każdy reason na jeden z dwóch tytułów, które widzi użytkownik: **Needs you** (decyzja, którą może podjąć tylko człowiek) albo **Seat down** (seat nie może pracować: wylogowany, bez limitu, odrzucił komendę, odpowiedział poza kontraktem). Panel i byline czytają Needs you · <cause> lub Seat down · <cause>.

Automatyczny fallback działa tylko dla halt-u Seat down zbudowanego przez buildSeatDownIssue (runner-usage-limit, runner-unauthenticated). Seat przechodzi na zadeklarowany fallback bez pytania, gdy spełnione są cztery warunki: fallback jest zadeklarowany i prowadzi listę kandydatów, przyczyna to odmowa konta albo limit z resetem dalej niż 10 minut, ten run nie przełączył jeszcze tego seat-a automatycznie, a halt zna rewizję config.yaml. Każde przełączenie ląduje w seatSwitches.

Krótki reset (do 10 minut) nie tworzy halt-u na BUILD i w konsultacjach: wywołanie czeka w miejscu (state.seatWait) i powtarza się raz. PLAN i werdykt REVIEW nie mają tego czekania: ich błąd od razu jest haltem, a czekanie oferuje dopiero akcja Retry at HH:MM.

Powiązane obszary: wykrywanie limitu w adapterach narzędzi → zobacz runners; pętla briefów i drabina eskalacji → zobacz build; werdykt i fix-loop → zobacz review; status runu, park i wznowienie → zobacz lifecycle; panel, picker, Settings › Fallback → zobacz ui.`,
  entry: [
    "src/engine/orchestrator/task/implementation-failure.ts:67",
    "src/engine/orchestrator/escalation/handle.ts:193",
    "src/engine/orchestrator/planning/failure.ts:25",
    "src/engine/orchestrator/run/review.ts:149",
    "src/engine/orchestrator/task/retry.ts:171",
    "src/engine/orchestrator/escalation/seat-wait.ts:150",
  ],
  links: [
    { to: "runners", label: "adapter narzędzia zwraca outcome `usage-limit` / `unauthenticated` i słowa narzędzia; tu są klasyfikowane" },
    { to: "build", label: "halt BUILD tnie brief (`INTERRUPT_STEP source: seat`); Retry, Skip i switch wracają do pętli briefów" },
    { to: "planning", label: "błąd wywołania planu trafia do `handlePlanningFailure`; Try again wznawia ten sam krok sesji planowania" },
    { to: "review", label: "nieudany werdykt (`seat-blocked`, `seat-protocol-error`, `input-too-large`) halt-uje na seat REVIEW" },
    { to: "lifecycle", label: "`deriveRunStatus` czyta `pendingRecovery` jako waiting-for-you · halt i `seatWait` jako stopped · seat-wait" },
    { to: "ui", label: "`RecoveryMenu`, picker seat-a po `switch-seat`, Settings › Fallback, zegar resetu w nagłówku" },
    { to: "startup", label: "headless: `--on-seat-down halt|switch`, `continue --action …`, rekord `recovery_required` i exit 1" },
    { to: "subsystems", label: "zdarzenia `recovery_prompted`, `seat_switched`, `seat_wait_started`, `seat_retry` na EventBus i w session.jsonl" },
  ],
  diagrams: [
    {
      id: "rc-master",
      title: "Od błędu wywołania do halt-u: klasyfikacja i tytuł menu",
      caption: "Jeden klasyfikator czyta słowa narzędzia i jego outcome. Klasa decyduje, czy wywołanie powtarza się po cichu, czy czeka, czy powstaje halt. Każdy reason ma dokładnie jeden tytuł: Needs you albo Seat down.",
      mermaid: `flowchart TD
  A["Wywołanie seat-a kończy się błędem<br/>(outcome + słowa narzędzia)"] --> RC_FAILURE_SOURCE{"Który seat i jaka droga?"}
  RC_FAILURE_SOURCE -->|"BUILD lub konsultacja"| B["runSeatCall: drabina seat-trouble<br/>(diagram rc-seat-call)"]
  RC_FAILURE_SOURCE -->|"PLAN (sesja planowania)"| C["handlePlanningFailure"]
  RC_FAILURE_SOURCE -->|"REVIEW (werdykt)"| D["final-review catch → haltVerdictlessReview"]
  B --> RC_AUTHORITATIVE
  C --> RC_PLANNER_DIAGNOSIS
  D --> RC_REVIEW_FAILURE_KIND
  RC_PLANNER_DIAGNOSIS --> RC_PLANNER_BUILDER{"Diagnoza niesie<br/>klasyfikację seat-down?"}
  RC_PLANNER_BUILDER -->|"nie: missing-model / input-too-large / call-failed"| P1["planner-call-failed"]
  RC_PLANNER_BUILDER -->|"tak: usage-limit / unauthenticated"| S["buildSeatDownIssue"]
  RC_REVIEW_FAILURE_KIND -->|"seat-blocked"| S
  RC_REVIEW_FAILURE_KIND -->|"seat-protocol-error"| P2["seat-protocol-error"]
  RC_REVIEW_FAILURE_KIND -->|"input-too-large"| P3["review-input-too-large"]
  RC_REVIEW_FAILURE_KIND -->|"insufficient-context / call-failed"| P4["review-failed (bez werdyktu)"]
  RC_AUTHORITATIVE{"classifySeatFailure:<br/>outcome autorytatywny?"}
  RC_AUTHORITATIVE -->|"tak (recipe-invalid, left-isolation, missing-model…)"| E["builder defektu runnera<br/>recoveryBuilderForRunnerOutcome"]
  RC_AUTHORITATIVE -->|"nie"| RC_ACCOUNT_CAUSE{"Fraza konta?<br/>401/403, 402, balance, billing, quota"}
  RC_ACCOUNT_CAUSE -->|"auth"| S
  RC_ACCOUNT_CAUSE -->|"quota / balance / billing"| S
  RC_ACCOUNT_CAUSE -->|"nie"| RC_RATE_LIMITED{"429 lub fraza limitu<br/>z parsowalnym resetem?"}
  RC_RATE_LIMITED -->|"tak"| RC_RESET_WAIT_ONCE{"Reset w ciągu 10 min?"}
  RC_RESET_WAIT_ONCE -->|"tak (BUILD, konsultacja)"| W["Czekaj w miejscu<br/>state.seatWait, powtórz raz"]
  RC_RESET_WAIT_ONCE -->|"nie"| S
  RC_RATE_LIMITED -->|"nie"| RC_TRANSIENT{"Sieć / 5xx / 408 /<br/>429 w tekście bez rzeczownika limitu?"}
  RC_TRANSIENT -->|"tak"| R["Powtórz z backoffem 2s, 4s, 8s<br/>(max 3 razy)"]
  RC_TRANSIENT -->|"nie: other"| F["Zwykła porażka próby<br/>→ drabina eskalacji (build)"]
  S --> RC_HALT_OF{"haltOf(reason)"}
  P1 --> RC_HALT_OF
  P2 --> RC_HALT_OF
  P3 --> RC_HALT_OF
  P4 --> RC_HALT_OF
  E --> RC_HALT_OF
  RC_HALT_OF -->|"runner-usage-limit, runner-unauthenticated,<br/>planner-call-failed, seat-protocol-error,<br/>recipe-invalid, left-isolation, timeout-repeated,<br/>context-overflow"| SD["Seat down · cause<br/>akcje: switch-seat, retry-later,<br/>retry-same-worker, skip, end-run"]
  RC_HALT_OF -->|"review-failed, retry-exhausted,<br/>consult-bound-spent, apply-*, checkout-changed,<br/>approval-denied, plan-*, …"| NY["Needs you · cause<br/>akcje: continue, retry, revise,<br/>accept-as-is, restore-backup, skip, end-run"]`,
    },
    {
      id: "rc-seat-call",
      title: "runSeatCall: cicha drabina przed haltem (BUILD i konsultacje)",
      caption: "Każde wywołanie implementera (pierwsza próba i próby drabiny) oraz każda konsultacja PLAN/REVIEW przechodzi tędy. Błąd przejściowy powtarza się do 3 razy. Limit z resetem do 10 minut czeka raz. Reszta wraca jako porażka do wywołującego.",
      mermaid: `flowchart TD
  A["runSeatCall(call)"] --> B["withSeatRetry: próba n"]
  B --> RC_TRANSIENT_RETRY{"Porażka klasy transient<br/>i n ≤ 3?"}
  RC_TRANSIENT_RETRY -->|"tak"| C["publish seat_retry<br/>czekaj 2s · 4s · 8s"]
  C --> B
  RC_TRANSIENT_RETRY -->|"nie, sukces"| OK["Zwróć wynik"]
  RC_TRANSIENT_RETRY -->|"nie, inna porażka"| RC_RESET_WAIT_ONCE{"seatResetWaitDeadline:<br/>rate-limited, reset &gt; 0<br/>i ≤ 600 000 ms?"}
  RC_RESET_WAIT_ONCE -->|"nie"| FAIL["Zwróć porażkę<br/>→ wywołujący buduje halt"]
  RC_RESET_WAIT_ONCE -->|"tak"| W["SET_SEAT_WAIT seat, resetAt<br/>publish seat_wait_started"]
  W --> S["abortableDelay do deadline"]
  S -->|"stop runu (abort)"| PARK["seatWait zostaje w state.json<br/>status: stopped · Waiting for tool"]
  PARK -.->|"wznowienie: init.ts resumeSeatWait"| S
  S -->|"deadline minął"| CL["CLEAR_SEAT_WAIT"]
  CL --> B2["withSeatRetry: ta sama próba jeszcze raz"]
  B2 -->|"sukces"| OK
  B2 -->|"porażka (także drugi limit)"| FAIL`,
    },
    {
      id: "rc-fallback",
      title: "Decyzja o fallbacku: oferta switch-seat i intencja automatyczna",
      caption: "loadSeatSwapContext czyta fallback z config.yaml (nie z pamięci runu) razem z hashem pliku. Oferta to lista gotowych narzędzi z ostatniej detekcji; fallback prowadzi listę. Intencja automatyczna powstaje tylko dla halt-u Seat down z buildSeatDownIssue i tylko raz na run i seat.",
      mermaid: `flowchart TD
  A["Seat-down halt dla seat-a S"] --> RC_CONFIG_LOADS{"config.yaml ładuje się?"}
  RC_CONFIG_LOADS -->|"nie"| NR["wiersz: fallback: not read · config.yaml does not load<br/>fallback nieznany, intencji brak"]
  RC_CONFIG_LOADS -->|"tak (lub brak pliku: config runu)"| RC_FALLBACK_DECLARED{"Seat S ma fallback w config.yaml?<br/>(REVIEW bez bloku: fallback PLAN)"}
  RC_FALLBACK_DECLARED -->|"nie"| NF["wiersz: no fallback set<br/>oferta = inne gotowe narzędzia"]
  RC_FALLBACK_DECLARED -->|"tak"| RC_FALLBACK_BLOCKED{"fallbackDecision:<br/>narzędzie zainstalowane, ready/unverified,<br/>trasa bez needs-sign-in?"}
  RC_FALLBACK_BLOCKED -->|"snapshot mówi nie → sprawdź raz na żywo → wciąż nie"| BL["wiersz: fallback: X · not offered: reason<br/>oferta bez fallbacku"]
  RC_FALLBACK_BLOCKED -->|"tak"| LEAD["fallback (z modelem i effortem) na czele detectedTools"]
  NF --> RC_OFFER_NONEMPTY
  BL --> RC_OFFER_NONEMPTY
  LEAD --> RC_OFFER_NONEMPTY{"switchSeatOffer: zostaje ≥1 kandydat<br/>ready, hostowalny przez seat,<br/>inny niż bieżąca tożsamość?"}
  RC_OFFER_NONEMPTY -->|"nie"| NO["akcja switch-seat nieoferowana<br/>zostają: retry, retry-later, skip, end"]
  RC_OFFER_NONEMPTY -->|"tak"| RC_AUTO_USED{"seatSwitches ma już wpis<br/>seat=S i auto=true?"}
  RC_AUTO_USED -->|"tak"| MAN["wiersz: automatic switch already used in this run<br/>oferta ręczna, panel pyta"]
  RC_AUTO_USED -->|"nie"| RC_AUTO_SWITCHABLE{"Przyczyna: account (auth/quota/balance/billing)<br/>albo rate-limited z resetem &gt; 10 min?"}
  RC_AUTO_SWITCHABLE -->|"nie (reset ≤ 10 min)"| MAN2["oferta ręczna + Retry at HH:MM"]
  RC_AUTO_SWITCHABLE -->|"tak"| RC_AUTO_LEADS{"Pierwszy kandydat == fallback<br/>i halt ma configRevision?"}
  RC_AUTO_LEADS -->|"nie"| MAN
  RC_AUTO_LEADS -->|"tak"| AUTO["switchSeat.auto = {candidate: fallback, configRevision}<br/>TUI i headless przełączają bez pytania"]`,
    },
    {
      id: "rc-switch-commit",
      title: "Przełączenie seat-a: plan → przygotowanie → zapis config.yaml → commit stanu",
      caption: "Kolejność jest kontraktem. Nic nie jest zapisane, dopóki nowy seat nie przejdzie admisji. Zapis jednego seat-a do config.yaml sprawdza hash pliku z chwili halt-u. Dopiero potem halt znika ze stanu.",
      mermaid: `flowchart TD
  A["applyOfferedSeatSwap(choice)<br/>(TUI run loop / headless)"] --> B["switchSeatAndPrepareResume"]
  B --> RC_SWITCH_PLAN_OK{"planSwitchSeatRecoveryAction:<br/>oferta istnieje, profil BUILD znany,<br/>config czytelny, kandydat hostowalny?"}
  RC_SWITCH_PLAN_OK -->|"nie"| BLK["blocked: warning<br/>Could not switch the seat…<br/>halt zostaje"]
  RC_SWITCH_PLAN_OK -->|"tak"| RC_RECORD_AHEAD{"Intencja auto i hash pliku<br/>inny niż w intencji?"}
  RC_RECORD_AHEAD -->|"tak: seat w pliku == kandydat"| FIN["Dokończ ruch bez drugiego zapisu<br/>commit auto:true"]
  RC_RECORD_AHEAD -->|"tak: seat w pliku inny niż stary"| ONTO["Porzuć intencję, przełącz na to,<br/>co plik mówi · commit auto:false"]
  RC_RECORD_AHEAD -->|"nie"| PREP["prepareExecution(switchedConfig)<br/>admisja nowego narzędzia"]
  PREP --> RC_PREPARED{"preparation.kind == prepared<br/>i nie przerwano?"}
  RC_PREPARED -->|"aborted"| UN1["unswitched: nic nie zapisane,<br/>halt zostaje (stop operatora)"]
  RC_PREPARED -->|"unadmitted / failed"| UN2["warning: seat was not switched…; the halt stays"]
  RC_PREPARED -->|"tak"| RC_REVISION_MATCH{"recordSeatOfRecord:<br/>rawSha256 pliku == rewizja z halt-u?"}
  RC_REVISION_MATCH -->|"nie"| UN3["warning: config changed meanwhile · the halt stays"]
  RC_REVISION_MATCH -->|"tak (lub brak pliku: bez zapisu)"| COMMIT["commitSeatSwitch"]
  FIN --> COMMIT
  ONTO --> COMMIT
  COMMIT --> RC_SWITCH_COMMIT_KIND{"Halt nazywa brief (taskId)?"}
  RC_SWITCH_COMMIT_KIND -->|"tak"| RA["RESTART_ATTEMPT_ON_SEAT<br/>ten sam attempt, pin profilu"]
  RC_SWITCH_COMMIT_KIND -->|"nie (PLAN / REVIEW)"| RP["RESOLVE_PENDING_RECOVERY<br/>krok uruchomi się ponownie"]
  RA --> REC["RECORD_SEAT_SWITCH → seatSwitches<br/>publish seat_switched, recovery_resolved"]
  RP --> REC
  REC --> OUT["onSeatSwapped(prepared)<br/>run wraca do runWorkflow na nowym seat"]`,
    },
    {
      id: "rc-seq-limit-fallback",
      title: "Limit 5h na BUILD w trakcie implementing, fallback zadeklarowany",
      caption: "Implementer trafia na limit, którego reset jest za kilka godzin. Halt powstaje, ale niesie intencję automatyczną. TUI nie pokazuje panelu: seat przechodzi na fallback, a brief wraca do tej samej próby w zachowanym workspace.",
      mermaid: `sequenceDiagram
  participant I as Implementer (codex)
  participant RS as runSeatCall
  participant HF as handleFailedImplementation
  participant SW as loadSeatSwapContext
  participant ST as state.json
  participant RL as TUI run loop
  participant SS as switchSeatAndPrepareResume
  I-->>RS: error: You have hit your usage limit… try again at 15:27 (za 4h50)
  RS->>RS: classify → rate-limited, reset powyżej 10 min → bez czekania
  RS-->>HF: outcome usage-limit, słowa narzędzia
  HF->>SW: seat build, profil, config
  SW->>SW: config.yaml: fallback opencode · ready → na czele oferty
  SW-->>HF: SeatSwapContext + configRevision
  HF->>HF: buildSeatDownIssue → auto = {fallback, configRevision}
  HF->>ST: INTERRUPT_STEP (source seat) · SET_PENDING_RECOVERY
  HF-->>RL: publish error (cause-only) · recovery_prompted
  RL->>RL: recovery-driver: issue.switchSeat.auto → bez panelu, bez pickera
  RL->>SS: applyOfferedSeatSwap(candidate = fallback)
  SS->>SS: prepareExecution(switchedConfig) → prepared
  SS->>SS: recordSeatOfRecord: zapis implementer.tool=opencode, fallback=codex
  SS->>ST: RESTART_ATTEMPT_ON_SEAT · RECORD_SEAT_SWITCH auto:true
  SS-->>RL: switched + nowa preparation
  RL->>RL: transcript: Recovery usage limit → continued on fallback · BUILD codex → opencode · automatic fallback
  RL->>I: runWorkflow na opencode, brief od swojej ciętej próby`,
    },
    {
      id: "rc-seq-limit-nofallback",
      title: "Ten sam limit bez fallbacku: panel Seat down",
      caption: "Bez zadeklarowanego fallbacku nie ma intencji automatycznej. Run staje jako waiting-for-you · halt. Panel oferuje zmianę narzędzia (jeśli detekcja widziała inne gotowe narzędzie), czekanie do resetu, powtórkę, pominięcie briefu i zakończenie runu.",
      mermaid: `sequenceDiagram
  participant I as Implementer (codex)
  participant HF as handleFailedImplementation
  participant ST as state.json
  participant RD as recovery-driver (TUI)
  participant U as Użytkownik
  participant AC as applyRecoveryAction
  I-->>HF: outcome usage-limit · try again at 15:27
  HF->>HF: loadSeatSwapContext: no fallback set · detected: claude-code ready
  HF->>HF: buildSeatDownIssue: actions retry, switch-seat, retry-later, skip, end · recommended switch-seat
  HF->>ST: INTERRUPT_STEP (seat) · SET_PENDING_RECOVERY
  HF-->>RD: recovery_prompted
  RD->>U: Seat down · Usage limit on OpenAI Codex CLI · resets 15:27
  RD->>U: [w] switch BUILD to claude-code · [l] Retry at 15:27 · [r] Try again · [s] Skip task · [a] End run
  alt użytkownik wybiera Retry at 15:27
    U->>RD: l
    RD->>AC: retry-later
    AC->>ST: SET_SEAT_WAIT build 15:27 · RESOLVE_PENDING_RECOVERY
    RD->>RD: run wchodzi ponownie, init.ts resumeSeatWait śpi do 15:27 (bez limitu 10 min)
  else użytkownik wybiera switch BUILD
    U->>RD: w
    RD->>U: otwiera picker BUILD na claude-code (model, effort do wyboru)
    U->>RD: zatwierdza wiersz pickera → zapis config.yaml
    RD->>RD: switchSeat → applyOfferedSeatSwap (auto:false)
  else użytkownik wybiera Skip task
    U->>RD: s
    RD->>AC: skip-current-task → evidence skipped · skipHaltedBrief przywraca pliki
  else użytkownik wybiera End run
    U->>RD: a
    RD->>AC: end-run → endRun → run closed (ended)
  end`,
    },
    {
      id: "rc-actions-resume",
      title: "Akcja recovery → gdzie run wraca",
      caption: "applyRecoveryAction sprawdza akcję dwa razy: czy halt ją oferuje i czy tytuł halt-u ją dopuszcza. Potem każda akcja ma jedną ścieżkę zapisu stanu. Halt bez taskId (PLAN, REVIEW) wznawia ten sam krok; halt z taskId resetuje brief albo wznawia jego ciętą próbę.",
      mermaid: `flowchart TD
  A["applyRecoveryAction(action)"] --> P0["Apply ucięty przez crash<br/>bez pendingRecovery?"]
  P0 -->|"tak"| HC["haltCutApply → apply-partial halt"]
  P0 -->|"nie"| RC_ACTION_ALLOWED{"action == end-run?<br/>else: w availableActions<br/>i dopuszczona przez haltOf?"}
  HC --> RC_ACTION_ALLOWED
  RC_ACTION_ALLOWED -->|"end-run"| ENDR["endRun → closed (ended)<br/>ready run: discarded, run.patch zostaje"]
  RC_ACTION_ALLOWED -->|"nie"| BLK["blocked: action-not-available<br/>halt zostaje"]
  RC_ACTION_ALLOWED -->|"tak"| RC_ACTION{"Która akcja?"}
  RC_ACTION -->|"continue"| RC_CONTINUE_SAFE{"consult-bound-spent /<br/>planner-calls-spent / reason retired?"}
  RC_CONTINUE_SAFE -->|"nie"| BLK2["blocked: unsafe-continue"]
  RC_CONTINUE_SAFE -->|"bound"| GR["GRANT_ALLOWANCE (+1 consult, +4 attempts<br/>albo +5 planner calls) · RESET_TASK"]
  RC_CONTINUE_SAFE -->|"retired"| RS0["RESOLVE_PENDING_RECOVERY"]
  RC_ACTION -->|"retry-same-worker"| RC_SEAT_LEVEL_RETRY{"isSeatLevelRetry:<br/>brak taskId i seat plan/review?"}
  RC_SEAT_LEVEL_RETRY -->|"tak"| RS1["RESOLVE (+ ENQUEUE_USER_MSG z korektą)<br/>ten sam krok: plan / werdykt"]
  RC_SEAT_LEVEL_RETRY -->|"nie"| RT["RESET_TASK (status pending, attempt 0)<br/>+ korekta briefu · retry-current-task"]
  RC_ACTION -->|"retry-later"| RC_RETRY_LATER_OK{"issue.resetAt i issue.seat znane?"}
  RC_RETRY_LATER_OK -->|"nie"| BLK
  RC_RETRY_LATER_OK -->|"tak"| SWT["SET_SEAT_WAIT · RESOLVE<br/>init.ts czeka do resetu, potem krok"]
  RC_ACTION -->|"switch-seat"| SWS["diagram rc-switch-commit<br/>(TUI: najpierw picker seat-a)"]
  RC_ACTION -->|"skip-current-task"| SK["evidence: skipped · skipHaltedBrief<br/>przywraca pliki · RESOLVE → następny brief"]
  RC_ACTION -->|"revise"| RV["reason == review-failed?"]
  RV -->|"tak"| RVC["REVIEW_CORRECTION → final-review<br/>+1 fix cycle"]
  RV -->|"nie"| RVQ["ENQUEUE_USER_MSG → kolejka plannera<br/>krok planowania ponownie"]
  RC_ACTION -->|"accept-as-is"| AAI["ACCEPT_AS_IS (+REVIEW_DONE failed /<br/>CLEAR_SCHEDULED_REVIEW) → ready to apply"]
  RC_ACTION -->|"restore-backup / retry na apply-partial"| MA["MARK_RECOVERY_APPLYING<br/>Apply dokończy albo przywróci (lifecycle)"]`,
    },
    {
      id: "rc-headless",
      title: "Headless: polityka --on-seat-down i pętla intencji",
      caption: "Bez TUI nie ma panelu. Intencja automatyczna jest wykonywana przed wejściem w runWorkflow. Halt bez intencji (albo intencja, która nie przeszła) kończy proces rekordem recovery_required i kodem 1; dalej idzie `splitbrief continue <id> --action …`.",
      mermaid: `flowchart TD
  A["runHeadless start/resume/continue"] --> RC_HEADLESS_POLICY{"--on-seat-down?"}
  RC_HEADLESS_POLICY -->|"switch, a config nie deklaruje fallbacku"| E2["exit 2: needs a seat that declares fallback"]
  RC_HEADLESS_POLICY -->|"halt"| L0["nigdy nie przełącza automatycznie"]
  RC_HEADLESS_POLICY -->|"switch lub brak"| L1["pętla"]
  L0 --> RUN
  L1 --> I["state.pendingRecovery.switchSeat.auto?"]
  I -->|"tak"| SW["applyOfferedSeatSwap(auto.candidate)"]
  SW --> I2["halt wciąż ma intencję?"]
  I2 -->|"tak (swap nie przeszedł)"| REQ["recovery_required JSON · exit 1"]
  I2 -->|"nie"| RUN
  I -->|"nie"| PRE["resume i pendingRecovery<br/>(poza odpowiedzianym apply-partial)?"]
  PRE -->|"tak"| REQ
  PRE -->|"nie"| RUN["runWorkflow(headless)"]
  RUN --> AFTER["po runie: nowa intencja auto<br/>i polityka != halt?"]
  AFTER -->|"tak"| I
  AFTER -->|"nie"| DONE["koniec: sukces, halt (exit 1)<br/>lub stop"]`,
    },
    {
      id: "rc-build-halt",
      title: "BUILD: od outcome implementera do halt-u i rekomendacji",
      caption: "Pierwsza próba briefu i każdy szczebel drabiny czytają outcome tak samo. Seat-down i defekt runnera halt-ują od razu; reszta idzie do drabiny eskalacji (obszar build). Lista akcji i rekomendacja zależą od oferty, resetu i briefu.",
      mermaid: `flowchart TD
  A["Porażka wywołania implementera<br/>(po runSeatCall)"] --> RC_IMPL_OUTCOME{"implResult.outcome?"}
  RC_IMPL_OUTCOME -->|"unauthenticated"| SD["buildSeatDownIssue<br/>account · auth → runner-unauthenticated"]
  RC_IMPL_OUTCOME -->|"usage-limit"| CL["classifySeatFailure(outcome usage-limit)"]
  CL --> SD2["buildSeatDownIssue<br/>rate-limited / quota / balance / billing<br/>→ runner-usage-limit"]
  RC_IMPL_OUTCOME -->|"missing-model"| RC_MODEL_REFUSAL_ROUTE{"seatRouteRefusal:<br/>listing poświadczeń trasy?"}
  RC_MODEL_REFUSAL_ROUTE -->|"signed-out"| SD3["buildSeatDownIssue<br/>no credential for provider"]
  RC_MODEL_REFUSAL_ROUTE -->|"wrong-model"| MR1["implementer-recipe-invalid<br/>Model not listed by tool<br/>oferta kończy się własnym narzędziem"]
  RC_MODEL_REFUSAL_ROUTE -->|"unknown"| MR2["implementer-recipe-invalid<br/>Model refused by tool"]
  RC_IMPL_OUTCOME -->|"recipe-invalid / left-isolation /<br/>checkout-changed / timeout-repeated /<br/>input-too-large"| DF["builder defektu<br/>RUNNER_DEFECT_BUILDERS"]
  RC_IMPL_OUTCOME -->|"inny / brak"| RC_LADDER_HALT{"Drabina eskalacji:<br/>szczebel kończy się na seat-down,<br/>defekcie, bound lub hooku?"}
  RC_LADDER_HALT -->|"seat-down"| SD2
  RC_LADDER_HALT -->|"defekt runnera"| DF
  RC_LADDER_HALT -->|"consult / attempt / planner-calls bound"| CB["consult-bound-spent /<br/>planner-calls-spent (Needs you)"]
  RC_LADDER_HALT -->|"pre_escalation odmówił"| RX["retry-exhausted<br/>allowRetryOverride"]
  RC_LADDER_HALT -->|"nie"| NEXT["kolejny szczebel (build)"]
  SD --> RC_SEAT_DOWN_ACTIONS
  SD2 --> RC_SEAT_DOWN_ACTIONS
  SD3 --> RC_SEAT_DOWN_ACTIONS{"Jakie akcje?<br/>oferta switch · resetAt · brief"}
  RC_SEAT_DOWN_ACTIONS -->|"zawsze"| A1["Try again · End run"]
  RC_SEAT_DOWN_ACTIONS -->|"oferta"| A2["Change BUILD tool<br/>(do 3 wierszy switch BUILD to …)"]
  RC_SEAT_DOWN_ACTIONS -->|"resetAt"| A3["Retry at HH:MM"]
  RC_SEAT_DOWN_ACTIONS -->|"brief"| A4["Skip task"]
  A1 --> RC_RECOMMENDED{"chooseRecommended"}
  A2 --> RC_RECOMMENDED
  A3 --> RC_RECOMMENDED
  A4 --> RC_RECOMMENDED
  RC_RECOMMENDED -->|"oferta istnieje"| R1["switch-seat"]
  RC_RECOMMENDED -->|"brak oferty, jest reset"| R2["retry-later"]
  RC_RECOMMENDED -->|"ani oferta, ani reset"| R3["retry-same-worker"]`,
    },
    {
      id: "rc-tui-panel",
      title: "TUI: wejście z haltem, panel i słowa z composera",
      caption: "Run loop wchodzi z zapisanym haltem. Najpierw rozwiązuje się to, co nie wymaga pytania: stale halt, intencja automatyczna, odgrywana akcja. Dopiero potem panel. Słowa wpisane w composerze są korektą tylko dla akcji, która je czyta.",
      mermaid: `flowchart TD
  A["Wejście run loop<br/>state.pendingRecovery != undefined"] --> RC_STALE_HALT{"Halt stale?<br/>reason retired lub checkout-changed<br/>tylko HEAD/branch bez workspace"}
  RC_STALE_HALT -->|"tak"| ST["init.ts settleStaleHalt: RESOLVE,<br/>warning: no longer applies"]
  RC_STALE_HALT -->|"nie"| RC_CREW_CHANGED{"Seat w config.yaml inny<br/>niż w seats.json runu?"}
  RC_CREW_CHANGED -->|"tak"| CC["seat_switched cause crew-changed<br/>PLAN: plannerSessionId = null"]
  RC_CREW_CHANGED -->|"nie"| DRV
  CC --> DRV["createRecoveryDriver → promptPendingRecovery"]
  DRV --> RC_TUI_AUTO{"issue.switchSeat.auto?<br/>albo status applying + selectedAction?"}
  RC_TUI_AUTO -->|"auto"| SW["switchSeat = fallback<br/>→ applyOfferedSeatSwap, bez panelu"]
  RC_TUI_AUTO -->|"applying"| RP["odegraj selectedAction<br/>ze słowami wejścia jako notatką"]
  RC_TUI_AUTO -->|"nie"| OPEN["recoveryNoticeStore.open<br/>nagłówek: zegar resetu przy seat<br/>recovery_prompted"]
  OPEN --> MENU["RecoveryMenu: Needs you · cause / Seat down · cause<br/>wiersze akcji, recommended, Tab = composer"]
  MENU --> RC_TUI_ANSWER{"Odpowiedź: klawisz,<br/>pusty ⏎ czy tekst?"}
  RC_TUI_ANSWER -->|"pusty ⏎"| REC["akcja rekomendowana"]
  RC_TUI_ANSWER -->|"w / w2 / w3"| PK["picker seat-a na kandydacie n<br/>Escape = halt zostaje"]
  RC_TUI_ANSWER -->|"r l v k c s a"| ACT["akcja z klawisza"]
  RC_TUI_ANSWER -->|"tekst"| COR["correctionActionFor: retry → steer,<br/>revise → korekta, bound → continue"]
  ACT --> RC_WORDS_UNREAD{"Słowa w composerze,<br/>a akcja ich nie czyta?"}
  REC --> RC_WORDS_UNREAD
  RC_WORDS_UNREAD -->|"tak"| ERR["Cannot send words with label. Clear them."]
  RC_WORDS_UNREAD -->|"nie"| APPLY["applyRecoveryAction<br/>(revise: najpierw pytanie o notatkę)"]
  COR --> APPLY
  ERR --> MENU
  APPLY -->|"blocked"| MENU
  APPLY -->|"closed"| CLOSED["Run ended · finalizeEndedRun"]
  APPLY -->|"continued / retry-current-task"| RUN["runWorkflow na zwróconym stanie<br/>steer = korekta"]
  RUN --> RC_RESUME_SEAT_WAIT{"state.seatWait<br/>(po Retry at lub stopie w czekaniu)?"}
  RC_RESUME_SEAT_WAIT -->|"deadline w przyszłości"| WAIT["resumeSeatWait śpi do resetu"]
  RC_RESUME_SEAT_WAIT -->|"minął / brak"| GO["krok rusza"]
  WAIT --> GO`,
    },
  ],
  decisions: [
    {
      id: "RC_FAILURE_SOURCE",
      title: "Którą drogą błąd wywołania dochodzi do recovery",
      question: "Który seat zawiódł i czy jego wywołanie przeszło przez drabinę seat-trouble?",
      where: "src/engine/orchestrator/escalation/seat-wait.ts:150",
      inputs: ["seat (plan/build/review)", "rodzaj wywołania: brief, konsultacja, krok planowania, werdykt"],
      branches: [
        { if: "wywołanie implementera (pierwsza próba `run-implementation.ts:286` lub próba drabiny `make-implementer-retry-invoker.ts:125`)", then: "przechodzi przez `runSeatCall`: retry transient ×3, czekanie na reset ≤ 10 min; porażka wraca jako `implResult.outcome`", next: "RC_IMPL_OUTCOME" },
        { if: "konsultacja PLAN lub REVIEW (`consult/request.ts:339`)", then: "też przez `runSeatCall`; wyjątek jest rzucany dalej i ląduje w `task/retry.ts:171`", next: "RC_PLANNER_DIAGNOSIS" },
        { if: "krok sesji planowania rzuca (`planning/session.ts:513`, `:771`)", then: "`handlePlanningFailure` bez żadnego retry i bez czekania", next: "RC_PLANNER_DIAGNOSIS" },
        { if: "wywołanie werdyktu rzuca (`final-review.ts:970`)", then: "catch klasyfikuje porażkę na `FinalReviewFailure`, potem `haltVerdictlessReview`", next: "RC_REVIEW_FAILURE_KIND" },
      ],
      default: "Nie ma innej drogi: każde nieudane wywołanie seat-a trafia do jednej z tych czterech.",
      notes: "Tylko BUILD i konsultacje mają cichą drabinę (retry, czekanie). PLAN i werdykt REVIEW halt-ują od razu. WORKFLOW.md:532 opisuje drabinę ogólnie jako „seat call”; kod ogranicza ją do `runSeatCall`.",
    },
    {
      id: "RC_AUTHORITATIVE",
      title: "Outcome, którego żadne słowa nie zmienią",
      question: "Czy porażka niesie outcome, który jest własnym werdyktem?",
      where: "src/engine/runners/seat-failure.ts:171",
      inputs: ["`outcome` runnera", "`code` błędu"],
      branches: [
        { if: "outcome lub code w `AUTHORITATIVE_OUTCOMES`: `user-abort`, `implementer-left-isolation`, `checkout-changed`, `implementer-recipe-invalid`, `input-too-large`, `missing-model`, `no-progress-cut`", then: "klasa `authoritative`: bez retry, bez czekania; builder defektu z `RUNNER_DEFECT_BUILDERS` (`builders/task.ts:984`) buduje halt", next: "RC_HALT_OF" },
      ],
      default: "Czyta słowa narzędzia dalej (fraza konta → limit → transient).",
    },
    {
      id: "RC_ACCOUNT_CAUSE",
      title: "Odmowa konta: auth, quota, balance, billing",
      question: "Czy słowa albo status HTTP mówią, że konto nie obsłuży wywołania?",
      where: "src/engine/runners/seat-failure.ts:129",
      inputs: ["status HTTP", "frazy `HALT_SIGNATURES.auth` / `ACCOUNT_PHRASES`", "`providerType`", "źródło słów (stderr-tail / stdout-tail matchują tylko frazy haltu)"],
      branches: [
        { if: "status 402", then: "`account · balance`", next: "RC_HALT_OF" },
        { if: "status 401 lub 403, albo fraza auth (`please run /login`, `401 unauthorized`, `not logged in`…)", then: "`account · auth` → reason `runner-unauthenticated`", next: "RC_HALT_OF" },
        { if: "fraza z `ACCOUNT_PHRASES` (`insufficient balance`, `payment required`, `billing_hard_limit`, `account suspended`…)", then: "`account · balance|billing`", next: "RC_HALT_OF" },
        { if: "limit z parsowalnym resetem", then: "to NIE jest konto: zwraca null, dalej klasa rate-limited", next: "RC_RATE_LIMITED" },
        { if: "fraza wyczerpania (`usage limit`, `quota exceeded`, `exhausted your`…) bez resetu, status 429 albo `providerType provider.quota`", then: "`account · quota` → reason `runner-usage-limit`, `facts.cause = quota`", next: "RC_HALT_OF" },
      ],
      default: "Brak przyczyny konta.",
      notes: "Limit odczytany ze słów bez godziny resetu jest `quota`, czyli odmową konta: kwalifikuje się do automatycznego fallbacku nawet gdy prawdziwy reset jest za chwilę. Logowanie nigdy nie jest doradzane przy limicie (`usageLimitAdvice`).",
    },
    {
      id: "RC_RATE_LIMITED",
      title: "Limit z odczytaną godziną resetu",
      question: "Czy tekst nazywa limit i czy `parseUsageLimitReset` odczyta z niego chwilę resetu?",
      where: "src/engine/runners/seat-failure.ts:123",
      inputs: ["status 429 lub `429` w tekście lub fraza wyczerpania", "wzorce resetu: `try again at …`, `try again in …`, `resets 3:45pm`, `resets Mon 12:00am`, `Resets in 2h6m30s`, `retry-after: N`, `|<epoch>`"],
      branches: [
        { if: "sygnał limitu i reset parsowalny", then: "`rate-limited · resetAt`; halt niesie `resetAt`, panel i wiersze piszą `resets HH:MM`", next: "RC_RESET_WAIT_ONCE" },
      ],
      default: "Reset nieznany → sprawdza klasę transient.",
      notes: "Względny reset liczy się od `Date.now()`. Nazwana strefa IANA (`resets 4pm (Europe/Warsaw)`) jest czytana w tej strefie. Weekly limit Claude Code `resets Mon 12:00am` daje reset w następny poniedziałek.",
    },
    {
      id: "RC_TRANSIENT",
      title: "Błąd przejściowy sieci lub serwera",
      question: "Czy porażkę można powtórzyć tym samym wywołaniem?",
      where: "src/engine/runners/seat-failure.ts:148",
      inputs: ["outcome", "markery sieci (`ECONNRESET`, `fetch failed`, `ENOTFOUND`…)", "status HTTP z tekstu"],
      branches: [
        { if: "outcome znany i nie należy do `non-zero-exit` / `protocol-failure` / `usage-limit`", then: "nie transient (outcome jest ostateczny)", next: "RC_HALT_OF" },
        { if: "wygląda na offline, marker sieci, status 408 lub 5xx", then: "`transient` → `withSeatRetry` powtarza do 3 razy z backoffem 2s, 4s, 8s", next: "RC_TRANSIENT_RETRY" },
        { if: "`429` w tekście (bez pola `status`), bez parsowalnego resetu, z silną frazą limitu (`request rejected (429)`, `api error … 429`), ale bez rzeczownika (`too many requests`, `quota`, `limit`)", then: "`transient` (pojemnościowe 429, np. Claude Code `Request rejected (429)`) → retry. Z rzeczownikiem albo z polem `status: 429` to `account · quota` (seat-failure.ts:129, 143), nie transient", next: "RC_TRANSIENT_RETRY" },
      ],
      default: "`other`: zwykła porażka próby; na BUILD wchodzi drabina eskalacji (→ zobacz build), na PLAN/REVIEW halt `planner-call-failed`.",
    },
    {
      id: "RC_TRANSIENT_RETRY",
      title: "Ile razy powtórzyć błąd przejściowy",
      question: "Czy ta próba kwalifikuje się do kolejnego powtórzenia?",
      where: "src/engine/runners/transient.ts:91",
      inputs: ["`isTransientSeatFailure`", "numer próby", "`BOUNDS.transientRetries = 3`", "sygnał abort"],
      branches: [
        { if: "sukces albo porażka nie-transient albo próba > 3", then: "zwraca wynik takim, jaki jest", next: "RC_RESET_WAIT_ONCE" },
        { if: "transient i próba ≤ 3", then: "`onDiscarded` (zużycie tokenów zapisane), `publishSeatRetry` (`seat_retry`), `abortableDelay(2s·2^(n-1))`, powtórka" },
      ],
      default: "Abort sygnału przerywa backoff (`throwIfAborted`).",
      notes: "Powtórki nie są próbami lineage: żadna tranzycja stanu ich nie liczy. Zużycie każdej odrzuconej próby jest dopisywane do runu.",
    },
    {
      id: "RC_RESET_WAIT_ONCE",
      title: "Czekać na reset czy halt-ować",
      question: "Czy run może poczekać na reset limitu w miejscu?",
      where: "src/engine/orchestrator/escalation/seat-wait.ts:64",
      inputs: ["klasa porażki", "`parseUsageLimitReset(message)`", "`BOUNDS.rateLimitResetWaitMs = 600 000`"],
      branches: [
        { if: "klasa != rate-limited albo reset nieparsowalny", then: "bez czekania; porażka wraca do wywołującego, który buduje halt", next: "RC_IMPL_OUTCOME" },
        { if: "reset ≤ 0 ms albo > 10 min", then: "bez czekania; halt (z fallbackiem: intencja automatyczna, bo reset > 10 min)", next: "RC_AUTO_SWITCHABLE" },
        { if: "0 < reset ≤ 10 min", then: "`waitForSeatReset`: `SET_SEAT_WAIT`, `seat_wait_started`, sen do deadline, `CLEAR_SEAT_WAIT`, potem TA SAMA próba jeszcze raz (jedna powtórka)", next: "RC_RESUME_SEAT_WAIT" },
      ],
      default: "Po jednym czekaniu drugi limit nie czeka: `runSeatCall` zwraca porażkę i powstaje halt.",
      notes: "Dotyczy tylko `runSeatCall` (BUILD, konsultacje). Czekanie nie jest widoczne jako halt: status runu to `running`, w transkrypcie jest wiersz `seat_wait_started`.",
    },
    {
      id: "RC_RESUME_SEAT_WAIT",
      title: "Czekanie przeżywa stop runu",
      question: "Co z `state.seatWait`, gdy run został zatrzymany w trakcie czekania?",
      where: "src/engine/orchestrator/run/init.ts:330",
      inputs: ["`savedState.seatWait`", "`savedState.pendingRecovery`", "zegar"],
      branches: [
        { if: "abort w trakcie `abortableDelay`", then: "`seatWait` zostaje w state.json; `deriveRunStatus` daje `stopped · seat-wait`, byline `Waiting for <tool> · resets HH:MM` (`run-status.ts:210`, `closed/byline.ts:271`)" },
        { if: "wznowienie, brak pendingRecovery, `seatWait` ustawiony, deadline w przyszłości", then: "`resumeSeatWait` czeka resztę czasu, potem krok rusza (`seat-wait.ts:120`)" },
        { if: "deadline już minął albo nieparsowalny", then: "`CLEAR_SEAT_WAIT` i krok rusza od razu" },
      ],
      default: "Bez `seatWait` nic się nie dzieje.",
    },
    {
      id: "RC_IMPL_OUTCOME",
      title: "Pierwsza porażka implementera: halt czy drabina",
      question: "Jaki outcome zwróciła pierwsza próba briefu?",
      where: "src/engine/orchestrator/task/implementation-failure.ts:67",
      inputs: ["`implResult.outcome`", "`implResult.applyResult` (runner API)", "`preApplyApprovalDenied`"],
      branches: [
        { if: "`preApplyApprovalDenied`", then: "nic: gate protected-path już to obsłużył (→ zobacz build)" },
        { if: "Apply runnera API `partial` lub `write-uncertain`", then: "`raiseApiApplyRecovery` (→ zobacz build)" },
        { if: "outcome `unauthenticated`", then: "`buildSeatDownIssue` class account·auth → `runner-unauthenticated`; `INTERRUPT_STEP source: seat cut: mid-step`; workspace zachowany", next: "RC_FALLBACK_DECLARED" },
        { if: "outcome `usage-limit`", then: "`classifySeatFailure(outcome usage-limit)` → `buildSeatDownIssue` → `runner-usage-limit`; `INTERRUPT_STEP source: seat`; wiersz błędu z `resetAt`", next: "RC_FALLBACK_DECLARED" },
        { if: "outcome w `RUNNER_DEFECT_BUILDERS` (`implementer-recipe-invalid`, `implementer-left-isolation`, `checkout-changed`, `missing-model`, `runner-timeout-repeated`, `input-too-large`)", then: "builder defektu; `missing-model` sprawdza trasę (`seatRouteRefusal`)", next: "RC_MODEL_REFUSAL_ROUTE" },
      ],
      default: "`retryAndRecord`: drabina eskalacji (→ zobacz build). Drabina sama halt-uje na seat-down między szczeblami (`handle.ts:193`).",
      notes: "Przy `usage-limit`/`unauthenticated` `run-implementation.ts:324` wywołuje `workspace.retain`, by wznowiona próba czytała częściowe edycje.",
    },
    {
      id: "RC_LADDER_HALT",
      title: "Drabina eskalacji przerywa się na seat-down i defekcie",
      question: "Czy ostatnia porażka szczebla drabiny to seat, który nie może pracować?",
      where: "src/engine/orchestrator/escalation/handle.ts:193",
      inputs: ["`stepOutcome.lastFailure.outcome`", "`stepOutcome.lastError`"],
      branches: [
        { if: "outcome `unauthenticated` lub `usage-limit`", then: "`seatDownHalt`: ten sam `buildSeatDownIssue` co pierwsza próba, bez konsultacji; `INTERRUPT_STEP source: seat`; `failedRetry`", next: "RC_FALLBACK_DECLARED" },
        { if: "outcome w `RUNNER_DEFECT_BUILDERS`", then: "`runnerDefectHalt`: builder defektu; kolejny szczebel zapłaciłby konsultację za ten sam defekt", next: "RC_HALT_OF" },
        { if: "bound konsultacji/prób/wywołań plannera wyczerpany (`consultBoundSpent`, `attemptBoundSpent`)", then: "`consult-bound-spent` lub `planner-calls-spent` (Needs you, akcje continue/skip/end)", next: "RC_CONTINUE_SAFE" },
        { if: "hook `pre_escalation` odmawia", then: "`retry-exhausted` z `escalationBlockedBy`, `allowRetryOverride: true` (`handle.ts:350`)", next: "RC_HALT_OF" },
      ],
      default: "Drabina idzie dalej (→ zobacz build).",
    },
    {
      id: "RC_PLANNER_DIAGNOSIS",
      title: "Diagnoza nieudanego wywołania PLAN / REVIEW / konsultacji",
      question: "Co słowa narzędzia mówią o seat planner-tier?",
      where: "src/engine/orchestrator/recovery/planner-call-failure.ts:64",
      inputs: ["kod typowanego błędu (`missing-model`, `input-too-large`, `timeout`)", "`thrownSeatFailure(err)`: słowa i klasyfikacja", "runner seat-a"],
      branches: [
        { if: "kod `missing-model`", then: "failure `missing-model`; halt pyta listing poświadczeń trasy, czy to sign-out czy zły model", next: "RC_MODEL_REFUSAL_ROUTE" },
        { if: "kod `input-too-large`", then: "failure `input-too-large`: retry wysłałby ten sam prompt, więc Try again nieoferowane", next: "RC_PLANNER_BUILDER" },
        { if: "klasa `rate-limited` albo `account` z cause != auth", then: "failure `usage-limit`, `resetsAt` z klasyfikacji, porada `usageLimitAdvice` (nigdy login)", next: "RC_PLANNER_BUILDER" },
        { if: "klasa `account · auth`", then: "failure `unauthenticated` z `runnerLoginInstruction` (np. `codex login`)", next: "RC_PLANNER_BUILDER" },
      ],
      default: "failure `call-failed` (także transient i timeout): reason `planner-call-failed`, Seat down, Try again oferowane.",
      notes: "Przed diagnozą `handlePlanningFailure` sprawdza abort (park, nie halt), zamknięty run (tylko error) i `readApiContextDiagnostic` (pakiet nie został wysłany → `planner-call-failed` z radą „Pick a plan seat with a larger context”).",
    },
    {
      id: "RC_PLANNER_BUILDER",
      title: "Który halt buduje nieudane wywołanie plannera",
      question: "Czy diagnoza niesie klasyfikację seat-down?",
      where: "src/engine/orchestrator/recovery/builders/planner.ts:75",
      inputs: ["`diagnosis.failure`", "`diagnosis.seatDown.classification`", "`seatRouteRefusal` dla missing-model", "`task` (konsultacja briefu)", "`seatSwitches`"],
      branches: [
        { if: "klasyfikacja seat-down obecna, albo missing-model na trasie `signed-out`", then: "`buildSeatDownIssue` na seat `plan`/`review` (z fallbackiem, intencją auto)", next: "RC_FALLBACK_DECLARED" },
        { if: "inaczej", then: "reason z `PLANNER_FAILURE_REASONS` (`runner-unauthenticated`, `runner-usage-limit`, `planner-call-failed`); akcje: `retry-same-worker` (nie przy input-too-large), `switch-seat` (gdy oferta), `skip-current-task` (gdy brief), `end-run`", next: "RC_RECOMMENDED" },
      ],
      default: "Recommended: `switch-seat` przy usage-limit, odmowie modelu i input-too-large; inaczej pierwsza akcja z listy.",
      notes: "Konsultacja z `task` nazywa brief: Try again i switch odtwarzają brief od początku; Skip pomija go. Konsultacja na REVIEW dziedziczonym z PLAN dopisuje wiersz `REVIEW = PLAN… Switching here gives REVIEW its own seat`.",
    },
    {
      id: "RC_REVIEW_FAILURE_KIND",
      title: "Nieudany werdykt: który halt",
      question: "Jak padło wywołanie werdyktu?",
      where: "src/engine/orchestrator/final-review.ts:984",
      inputs: ["kod typowanego błędu", "`readApiContextDiagnostic`", "`diagnosePlannerCallFailure(seat review)`"],
      branches: [
        { if: "kod `input-too-large`", then: "`review-input-too-large` (Needs you): `accept-as-is` = „Skip review with a note” tylko dla final review / task review, `end-run`; recommended end-run (`builders/review-input.ts:27`)" },
        { if: "odpowiedź poza kontraktem po powtórce", then: "`seat-protocol-error` (Seat down): retry, switch-seat (gdy oferta), end-run (`builders/seat-protocol.ts:24`)" },
        { if: "`insufficient-context` (pakiet nie wysłany)", then: "`review-failed` bez werdyktu na seat `review`: retry, end-run; detail „Pick a review seat with a larger context in /crew review”" },
        { if: "diagnoza `usage-limit` / `unauthenticated`", then: "`seat-blocked` → `plannerCallHaltIssue(seat review)` → Seat down z fallbackiem REVIEW (lub PLAN, gdy brak bloku `reviewer`)", next: "RC_FALLBACK_DECLARED" },
        { if: "diagnoza `call-failed`", then: "`review-failed` bez werdyktu (`reviewFailureKind: call-failed`): Try again with REVIEW, end-run" },
      ],
      default: "Werdykt z blokerami to nie błąd wywołania: `review-failed` z `revise`/`accept-as-is` (→ zobacz review).",
    },
    {
      id: "RC_MODEL_REFUSAL_ROUTE",
      title: "Odrzucony model: sign-out czy zły model",
      question: "Co listing poświadczeń i modeli narzędzia mówi o trasie seat-a?",
      where: "src/engine/orchestrator/recovery/builders/task.ts:742",
      inputs: ["`seatSwap.routeAuth` (odczytany na świeżo przy missing-model, `seat-swap-context.ts:87`)", "`routeRefusal`"],
      branches: [
        { if: "brak poświadczenia dla providera trasy i listing modeli nie serwuje jego modelu (gateway `opencode/…` wystarczy sam brak)", then: "`signed-out` → `buildSeatDownIssue` account·auth z `routeProvider`: „OpenCode CLI has no credential for <provider>”; fallback może przełączyć", next: "RC_FALLBACK_DECLARED" },
        { if: "jest poświadczenie albo listing serwuje model providera", then: "`wrong-model`: `implementer-recipe-invalid` / `planner-call-failed` „Model not listed by …”; oferta kończy się własnym narzędziem bez modelu (picker modelu); recommended switch-seat" },
        { if: "listingu nie da się odczytać", then: "`unknown`: „Model refused by …”; nic nie rusza się samo" },
      ],
      default: "Brak `routeAuth` (seat nie-CLI) czyta się jako `wrong-model`.",
    },
    {
      id: "RC_HALT_OF",
      title: "Tytuł halt-u: Needs you czy Seat down",
      question: "Jak reason mapuje się na jeden z dwóch tytułów, które widzi użytkownik?",
      where: "src/core/recovery/halt.ts:44",
      inputs: ["`issue.reason`", "tabela `REASON_HALT`"],
      branches: [
        { if: "`runner-unauthenticated`, `runner-usage-limit`, `runner-timeout-repeated`, `implementer-recipe-invalid`, `implementer-left-isolation`, `context-overflow`, `planner-call-failed`, `seat-protocol-error`", then: "`seat-down` → `Seat down · <cause>`; dozwolone akcje: switch-seat, retry-later, retry-same-worker, skip-current-task, end-run", next: "RC_SEAT_DOWN_ACTIONS" },
        { if: "każdy inny reason (`review-failed`, `retry-exhausted`, `consult-bound-spent`, `planner-calls-spent`, `dependency-blocked`, `checkout-changed`, `review-input-too-large`, `required-checks-unrunnable`, `approval-denied`, `snapshot-failed`, `plan-questions-exhausted`, `plan-checks-failed`, `apply-conflict`, `apply-partial`, reasons retired)", then: "`needs-you` → `Needs you · <cause>`; dozwolone: continue, retry-same-worker, revise, accept-as-is, restore-backup, skip-current-task, end-run", next: "RC_ACTION_ALLOWED" },
      ],
      default: "Tabela jest wyczerpująca (`satisfies Record<RecoveryReason, RecoveryHalt>`); kod reason zostaje w issue, zdarzeniu i logu, tytuł jest tylko dla człowieka.",
      notes: "Cause w tytule to `formatRecoveryHeadlineSpans` (`headline.ts:104`), np. `Usage limit on OpenAI Codex CLI · resets 15:27`, `Signed out of Claude Code`, `Quota spent on …`, `Planner call failed`, `Seat answer did not match its contract`.",
    },
    {
      id: "RC_CONFIG_LOADS",
      title: "Fallback czytany z config.yaml, nie z pamięci runu",
      question: "Czy halt może odczytać seat i jego fallback z pliku config.yaml?",
      where: "src/engine/orchestrator/recovery/seat-swap-context.ts:57",
      inputs: ["`loadConfig(projectDir)`", "`loaded.revision`", "seat i profil BUILD"],
      branches: [
        { if: "`loadConfig` rzuca", then: "`read-failed`: wiersz `fallback: not read · config.yaml does not load`; brak oferty fallbacku, brak intencji; `switch-seat` zablokowany kodem `fallback-read-failed`" },
        { if: "plik nie istnieje (`revision === null`)", then: "config runu jest rekordem; `configRevision` undefined → intencja auto niemożliwa (wymaga rewizji), ale switch ręczny działa bez zapisu pliku" },
        { if: "plik ładuje się", then: "seat z pliku (BUILD: profil z halt-u; REVIEW: `reviewer` albo `planner`) i `configRevision = rawSha256`", next: "RC_FALLBACK_DECLARED" },
      ],
      default: "Fallback zapisany w Settings w trakcie runu działa przy najbliższym halcie, bo każdy halt czyta plik na nowo.",
    },
    {
      id: "RC_FALLBACK_DECLARED",
      title: "Czy seat ma zadeklarowany fallback",
      question: "Czy blok seat-a w config.yaml niesie `fallback`?",
      where: "src/engine/orchestrator/recovery/seat-swap-context.ts:224",
      inputs: ["`record.seat.fallback`", "dla REVIEW bez bloku `reviewer`: `planner.fallback`"],
      branches: [
        { if: "brak", then: "wiersz `no fallback set`; oferta = inne gotowe narzędzia z ostatniej detekcji; żadnej intencji auto", next: "RC_OFFER_NONEMPTY" },
        { if: "jest", then: "`fallbackDecision` sprawdza, czy halt może go zaoferować", next: "RC_FALLBACK_BLOCKED" },
      ],
      default: "Żaden seat nie ma domyślnego fallbacku; deklaracja jest jedynym upoważnieniem do automatycznego przełączenia.",
    },
    {
      id: "RC_FALLBACK_BLOCKED",
      title: "Czy fallback da się uruchomić",
      question: "Dlaczego halt nie zaoferuje zadeklarowanego fallbacku?",
      where: "src/engine/orchestrator/recovery/seat-swap-context.ts:135",
      inputs: ["wiersz detekcji narzędzia z zapamiętanego snapshotu", "katalog modeli trasy", "`fallbackBlockedReason` (`core/crew/fallback.ts:71`)", "sprawdzenie na żywo `detectAvailableCliTools`"],
      branches: [
        { if: "snapshot nie zna narzędzia albo `unavailable`", then: "powód `not installed`; jeśli wiersz nie jest `ready`, jedno sprawdzenie na żywo na domyślnym kanale logowania; brak dalej → nieoferowany" },
        { if: "stan `ready` lub `unverified`, trasa `needs-sign-in` (brak poświadczenia providera i listing nie serwuje modelu)", then: "powód `needs sign-in`; po sprawdzeniu live listing modeli czytany raz na świeżo (provider z `opencode.json` może odblokować)" },
        { if: "stan `unauthenticated` i trasa `configured`", then: "oferowany (narzędzie bez poświadczenia wciąż woła trasę, którą serwuje jego listing)" },
        { if: "inny stan nie-ready", then: "powód = słowo stanu" },
        { if: "nic nie blokuje", then: "fallback z modelem/effortem/variantem ląduje na czele `detectedTools` z `ready: true`", next: "RC_OFFER_NONEMPTY" },
      ],
      default: "Powód trafia do wiersza panelu: `fallback: <identity> · not offered: <reason>`.",
    },
    {
      id: "RC_OFFER_NONEMPTY",
      title: "Oferta switch-seat: co zostaje po filtrach",
      question: "Czy jest co najmniej jeden kandydat, na który seat może przejść?",
      where: "src/engine/orchestrator/recovery/builders/task.ts:188",
      inputs: ["`detectedTools`", "`seatHostableTools(seat)` (IMPLEMENTER_CLI_TOOL_IDS / PLANNER_CLI_TOOL_IDS)", "bieżąca tożsamość seat-a (`isSeatIdentity`)"],
      branches: [
        { if: "kandydat nie `ready`, nie hostowalny przez rolę seat-a, równy bieżącej tożsamości albo duplikat tool+model", then: "pominięty" },
        { if: "lista pusta", then: "`switchSeatOffer` zwraca undefined: akcja `switch-seat` nie jest oferowana, intencja auto niemożliwa" },
        { if: "≥1 kandydat", then: "`SwitchSeatOffer {seat, from, candidates}`; panel pokazuje do 3 wierszy (`OFFERED_SEAT_SWAP_CANDIDATES`, `recovery-prompt.ts:219`) i notkę `(N more ready tools detected)`", next: "RC_AUTO_USED" },
      ],
      default: "Przy odrzuceniu modelu oferta kończy się własnym narzędziem bez modelu (`modelRefusalSeatOffer`), więc fallback wciąż prowadzi.",
    },
    {
      id: "RC_AUTO_USED",
      title: "Raz na run i seat",
      question: "Czy ten run już przełączył ten seat automatycznie?",
      where: "src/engine/orchestrator/recovery/builders/task.ts:317",
      inputs: ["`state.seatSwitches`", "`offer.seat`"],
      branches: [
        { if: "istnieje rekord `seat === offer.seat && auto === true`", then: "brak intencji; wiersz `fallback: <identity> · automatic switch already used in this run`; panel pyta, fallback (jeśli ready) wciąż jest pierwszym wierszem ręcznym" },
        { if: "brak takiego rekordu", then: "sprawdza przyczynę", next: "RC_AUTO_SWITCHABLE" },
      ],
      default: "Przełączenia ręczne (`auto: false`) i `crew-changed` nie zużywają limitu automatycznego.",
      notes: "Po automatycznym przełączeniu stary seat staje się fallbackiem nowego (`switchedRunner`, `switch-seat.ts:59`). Gdy nowy seat też padnie, jego fallback (stary tool) jest oferowany tylko ręcznie, bo licznik auto dla tego seat-a jest zużyty.",
    },
    {
      id: "RC_AUTO_SWITCHABLE",
      title: "Które przyczyny przełączają automatycznie",
      question: "Czy seat naprawdę nie może pracować?",
      where: "src/engine/orchestrator/recovery/builders/task.ts:321",
      inputs: ["`classification.class`", "`classification.resetAt`", "`BOUNDS.rateLimitResetWaitMs = 600 000`"],
      branches: [
        { if: "`account` (auth, quota, balance, billing)", then: "switchable", next: "RC_AUTO_LEADS" },
        { if: "`rate-limited` i `resetAt - now > 10 min` (limit 5h, weekly, reset za godziny)", then: "switchable", next: "RC_AUTO_LEADS" },
        { if: "`rate-limited` i reset ≤ 10 min", then: "nie switchable: halt ręczny z `Retry at HH:MM`; na BUILD taki reset zwykle został już przeczekany w `runSeatCall` i halt powstaje po drugim limicie" },
      ],
      default: "Inne klasy nie budują seat-down przez `buildSeatDownIssue`, więc nie mają intencji.",
    },
    {
      id: "RC_AUTO_LEADS",
      title: "Intencja tylko gdy fallback prowadzi ofertę",
      question: "Czy pierwszy kandydat oferty to zadeklarowany fallback i czy halt zna rewizję pliku?",
      where: "src/engine/orchestrator/recovery/builders/task.ts:315",
      inputs: ["`offer.candidates[0]`", "`seatSwap.fallback`", "`seatSwap.configRevision`"],
      branches: [
        { if: "`configRevision` undefined (brak pliku) albo fallback undefined", then: "brak intencji" },
        { if: "`candidates[0]` != fallback (fallback zablokowany lub równy bieżącej tożsamości)", then: "brak intencji" },
        { if: "wszystko spełnione", then: "`switchSeat.auto = {candidate: fallback, configRevision}`; `recommendedAction = switch-seat`; wiersz błędu w transkrypcie to tylko cause (`runnerHaltRow`, `task.ts:438`)", next: "RC_TUI_AUTO" },
      ],
      default: "Intencja jest zapisana w `pendingRecovery.switchSeat.auto` w state.json, więc przeżywa stop runu.",
    },
    {
      id: "RC_SEAT_DOWN_ACTIONS",
      title: "Akcje halt-u Seat down (buildSeatDownIssue)",
      question: "Które akcje dostaje panel przy limicie lub wylogowaniu?",
      where: "src/engine/orchestrator/recovery/builders/task.ts:361",
      inputs: ["oferta switch", "`resetAt`", "`task`"],
      branches: [
        { if: "zawsze", then: "`retry-same-worker` (Try again) i `end-run`" },
        { if: "oferta istnieje", then: "`switch-seat` (etykieta `Change BUILD tool`, wiersze `switch BUILD to <identity>`; przy odrzuconym modelu `Pick another BUILD model`)" },
        { if: "halt zna `resetAt`", then: "`retry-later` (etykieta `Retry at 15:27`, `action-label.ts:58`)" },
        { if: "halt nazywa brief", then: "`skip-current-task` (Skip task)" },
      ],
      default: "Kolejność wierszy to `RECOVERY_ACTIONS` (`enums.ts:144`): continue, retry, switch-seat, retry-later, revise, accept-as-is, restore-backup, skip, end-run. Rekomendację wybiera RC_RECOMMENDED.",
    },
    {
      id: "RC_RECOMMENDED",
      title: "Akcja rekomendowana",
      question: "Który wiersz panel zaznacza jako `recommended` i co bierze pusty ⏎?",
      where: "src/engine/orchestrator/recovery/builders/actions.ts:19",
      inputs: ["lista akcji", "preferencje buildera"],
      branches: [
        { if: "seat-down: oferta switch istnieje", then: "`switch-seat`" },
        { if: "seat-down: brak oferty, jest `resetAt`", then: "`retry-later`" },
        { if: "seat-down: ani oferty, ani resetu", then: "pierwsza akcja z listy = `retry-same-worker`" },
        { if: "planner-call-failed przy usage-limit / odrzuconym modelu / input-too-large", then: "`switch-seat`, inaczej pierwsza z listy" },
        { if: "plan-questions-exhausted / plan-checks-failed", then: "`revise`" },
        { if: "consult-bound-spent / planner-calls-spent", then: "`continue`" },
      ],
      default: "Pusta lista → `end-run` (nie zdarza się: `end-run` jest w każdym halcie).",
    },
    {
      id: "RC_TUI_AUTO",
      title: "TUI: intencja automatyczna omija panel",
      question: "Co recovery-driver robi z halt-em, który niesie `switchSeat.auto`?",
      where: "src/features/workflow/recovery-driver.ts:223",
      inputs: ["`issue.switchSeat.auto`", "`runResumePolicy(prepared.runtime)`"],
      branches: [
        { if: "intencja obecna", then: "zwraca od razu `{shouldRun: true, switchSeat: {candidate: auto.candidate}}`: bez pytania, bez pickera; run loop woła `applyOfferedSeatSwap` (`use-run-loop.ts:395`)", next: "RC_SWITCH_PLAN_OK" },
        { if: "swap nie rozwiązał halt-u (blocked, unadmitted, conflict)", then: "run loop zdejmuje intencję z pamięci (`use-run-loop.ts:426`) i wraca do pętli: następne wejście pokazuje panel; w state.json intencja zostaje, więc późniejsze `continue` spróbuje jej znowu" },
        { if: "brak intencji", then: "panel: `formatRecoveryPrompt`, pętla odpowiedzi", next: "RC_TUI_ANSWER" },
      ],
      default: "Halt zapisany z `status: applying` i `selectedAction` (proces padł w trakcie akcji) jest odgrywany bez pytania (`recovery-driver.ts:363`).",
    },
    {
      id: "RC_TUI_ANSWER",
      title: "TUI: odpowiedź na panel i słowa z composera",
      question: "Jak wpisany tekst albo klawisz staje się akcją?",
      where: "src/features/workflow/recovery-driver.ts:405",
      inputs: ["`parseRecoveryActionAnswer` (klawisze r/w/l/v/k/c/s/a, aliasy, `w2`, `w3`)", "`correctionActionFor(issue)`", "`leavesWordsUnread`"],
      branches: [
        { if: "pusty ⏎", then: "akcja rekomendowana" },
        { if: "klawisz `w` / `w2` / `w3`", then: "`switch-seat` z kandydatem n; otwiera picker seat-a na jego narzędziu z modelem i effortem w draftcie (`pickSwappedSeat`); Escape lub wybór tego samego seat-a = anulowane, halt zostaje" },
        { if: "tekst, który nie jest akcją, a halt ma akcję korekty (retry → steer, inaczej revise, dla bound: continue)", then: "tekst to korekta tej akcji" },
        { if: "tekst, a halt oferuje tylko end-run albo akcja nie czyta słów (Apply, accept-as-is poza review-input-too-large)", then: "błąd: `This halt takes no typed correction` / `Cannot send words with <label>. Clear them.`" },
        { if: "akcja `revise` lub accept-as-is przy review-input-too-large", then: "najpierw pytanie o notatkę (`noteQuestion`)" },
      ],
      default: "Akcja zablokowana przez silnik (`ok: false`) pokazuje komunikat i zostaje w pętli: ten sam halt pozostaje do odpowiedzi.",
    },
    {
      id: "RC_ACTION_ALLOWED",
      title: "Czy akcja jest dozwolona dla tego halt-u",
      question: "Czy silnik przyjmie akcję, którą wybrał operator lub CLI?",
      where: "src/engine/orchestrator/recovery/actions.ts:153",
      inputs: ["`state.pendingRecovery`", "`issue.availableActions`", "`allowedActionsForHalt(haltOf(reason))`"],
      branches: [
        { if: "brak `pendingRecovery` (i brak uciętego Apply)", then: "`blocked · no-pending-recovery`" },
        { if: "`end-run`", then: "zawsze: `endRun` zamyka run (ended; ready run → discarded z `run.patch`)" },
        { if: "akcja poza `availableActions`", then: "`blocked · action-not-available` + `recovery_action_failed`" },
        { if: "`continue`", then: "`applyContinueRecoveryAction`", next: "RC_CONTINUE_SAFE" },
        { if: "akcja poza listą dozwolonych przez tytuł halt-u", then: "`blocked · action-not-available` (druga bariera, typowo niemożliwa)" },
        { if: "dozwolona", then: "dispatch po akcji", next: "RC_ACTION" },
      ],
      default: "Każda akcja publikuje `recovery_action_selected`; sukces publikuje `recovery_resolved` z outcome `continued`, `retry-current-task`, `skipped-current-task` lub `closed`.",
    },
    {
      id: "RC_ACTION",
      title: "Dispatch akcji recovery",
      question: "Co dokładnie zmienia w stanie każda akcja?",
      where: "src/engine/orchestrator/recovery/actions.ts:180",
      inputs: ["`action`", "`issue.reason`", "`issue.taskId`", "`comment` operatora"],
      branches: [
        { if: "`revise`", then: "review-failed: `REVIEW_CORRECTION` (jeden fix cycle więcej, → zobacz review); inaczej `ENQUEUE_USER_MSG` do kolejki plannera i `RESOLVE`" },
        { if: "`accept-as-is`", then: "`ACCEPT_AS_IS` z otwartymi findings; review-input-too-large w implementing: `CLEAR_SCHEDULED_REVIEW`, w final: `REVIEW_DONE failed`; run staje się ready to apply (→ zobacz lifecycle)" },
        { if: "`skip-current-task`", then: "evidence `skipped` w ledgerze, `skipHaltedBrief` przywraca pliki briefu, `RESOLVE`; brief musi być bieżącym (`currentRecoveryTask`), inaczej `missing-current-task`" },
        { if: "`restore-backup` lub `retry-same-worker` na apply-partial", then: "tylko `MARK_RECOVERY_APPLYING`; Apply (lifecycle) dokończy lub przywróci" },
        { if: "`retry-same-worker`", then: "`isSeatLevelRetry` decyduje: reset briefu albo ponowne wydanie kroku", next: "RC_SEAT_LEVEL_RETRY" },
        { if: "`switch-seat`", then: "`applySwitchSeatRecoveryAction` (CLI) lub `switchSeatAndPrepareResume` (run loop)", next: "RC_SWITCH_PLAN_OK" },
        { if: "`retry-later`", then: "`SET_SEAT_WAIT` + `RESOLVE`", next: "RC_RETRY_LATER_OK" },
      ],
      default: "`assertNever`: każda akcja z enum ma gałąź.",
    },
    {
      id: "RC_CONTINUE_SAFE",
      title: "Continue: grant allowance albo stale halt",
      question: "Czy `continue` ma co zrobić?",
      where: "src/engine/orchestrator/recovery/actions.ts:1178",
      inputs: ["`issue.reason`", "`issue.taskId`", "notatka operatora"],
      branches: [
        { if: "`planner-calls-spent` bez taskId", then: "`GRANT_ALLOWANCE target planner` (+5 wywołań plannera, `BOUNDS.extraPlannerCallsPerRun`), `RESOLVE`" },
        { if: "`consult-bound-spent` / `planner-calls-spent` z briefem", then: "`GRANT_ALLOWANCE` (lineage: +1 consult, +4 attempts; planner: +5) z notatką i `failingOutput`, `RESET_TASK`, korekta briefu → `retry-current-task`" },
        { if: "reason retired (`validation-failed`, `scope-violation`…)", then: "`RESOLVE_PENDING_RECOVERY`: halt już nic nie sprawdza" },
      ],
      default: "`blocked · unsafe-continue` dla każdego innego reason.",
    },
    {
      id: "RC_SEAT_LEVEL_RETRY",
      title: "Try again: reset briefu czy ponowne wydanie kroku",
      question: "Czy halt jest o seat (bez briefu), czy o brief?",
      where: "src/engine/orchestrator/recovery/actions.ts:576",
      inputs: ["`issue.taskId`", "`issue.seat`", "`phaseRole(issue.phase)`"],
      branches: [
        { if: "brak taskId i seat `plan`/`review` (lub brak seat w fazie plannera)", then: "`resolveSeatIssueWithoutTask`: `RESOLVE` (+ korekta do kolejki); run wraca do tego samego kroku: planowanie lub werdykt; etykieta `Try again with PLAN/REVIEW`" },
        { if: "halt nazywa brief", then: "`RESET_TASK`: status `pending`, `attempt: 0`, faza `implementing`, pin profilu BUILD (`retryProfile`); korekta jako seed briefu; `task_reset`; outcome `retry-current-task`" },
        { if: "`required-checks-unrunnable`", then: "dodatkowo `validation` z przeładowanego config.yaml trafia do `currentConfig`, by Run the checks again czytało nową politykę" },
      ],
      default: "Brief musi być bieżącym i nieukończonym (`currentRecoveryTask`), inaczej `missing-current-task`.",
      notes: "Różnica od switch-seat: `RESTART_ATTEMPT_ON_SEAT` zachowuje attempt i park (`machine.ts:1123`), `RESET_TASK` zeruje attempt (`machine.ts:796`).",
    },
    {
      id: "RC_RETRY_LATER_OK",
      title: "Retry at HH:MM: czekanie bez limitu 10 minut",
      question: "Czy halt zna reset i seat, by zaparkować czekanie?",
      where: "src/engine/orchestrator/recovery/actions.ts:923",
      inputs: ["`issue.resetAt`", "`issue.seat`"],
      branches: [
        { if: "brak `resetAt` lub `seat`", then: "`blocked · action-not-available` („needs the reset the halt names”)" },
        { if: "oba znane", then: "`SET_SEAT_WAIT {seat, resetAt}` i `RESOLVE_PENDING_RECOVERY`; run wchodzi ponownie, `init.ts:330 resumeSeatWait` śpi do resetu, choćby to było 5 godzin, potem krok rusza", next: "RC_RESUME_SEAT_WAIT" },
      ],
      default: "Czekanie wybrane przez operatora nie ma granicy `rateLimitResetWaitMs`; granica dotyczy tylko czekania automatycznego.",
    },
    {
      id: "RC_SWITCH_PLAN_OK",
      title: "Plan przełączenia: co musi się zgadzać przed zapisem",
      question: "Czy switch ma wszystko, by zbudować przełączony config?",
      where: "src/engine/orchestrator/recovery/actions.ts:627",
      inputs: ["`issue.switchSeat`", "`opts.candidate`", "`opts.config`", "`issue.selectedImplementerProfile`", "`readSeatOfRecord`"],
      branches: [
        { if: "brak oferty lub `switch-seat` nieoferowane", then: "`seat-swap-unavailable`" },
        { if: "brak config runu", then: "`seat-swap-unavailable` („requires the run config”)" },
        { if: "BUILD: profil z halt-u nie istnieje w tabeli profili", then: "`profile-not-found`" },
        { if: "config.yaml nie ładuje się", then: "`fallback-read-failed`: „Cannot switch the BUILD seat: config.yaml does not load”" },
        { if: "`configWithSwitchedSeat` zwraca null (schema seat-a odrzuca narzędzie)", then: "`candidate-not-offered`: „'x' cannot host the build seat”" },
        { if: "CLI `--action switch-seat:<tool>` z narzędziem spoza oferty", then: "`candidate-not-offered` (`actions.ts:855`); picker TUI nie jest sprawdzany względem oferty" },
        { if: "wszystko ok", then: "`SeatSwitchPlan {seat, candidate, from, switchedConfig, auto, configRevision}`", next: "RC_RECORD_AHEAD" },
      ],
      default: "`auto` planu = intencja istnieje i kandydat jest jej fallbackiem; CLI i picker zdejmują intencję, więc zapisują `auto: false`.",
      notes: "`switchedRunner` (`switch-seat.ts:51`): nowy seat jest `cli`, przenosi ustawienia seat-a z pliku; przy auto fallbackiem nowego seat-a staje się stary seat (tool, model, effort tylko dla kanału effort-flag, variant tylko dla kanału variant); stary seat `api/shell/agent` nie może być fallbackiem.",
    },
    {
      id: "RC_RECORD_AHEAD",
      title: "Zapis wyprzedził stan (crash między zapisem a commitem)",
      question: "Czy config.yaml już nazywa inny seat niż w chwili halt-u?",
      where: "src/engine/orchestrator/recovery/switch-seat-resume.ts:157",
      inputs: ["`plan.auto`", "`intent.configRevision` vs `plan.configRevision`", "seat w pliku vs kandydat vs `plan.from`"],
      branches: [
        { if: "intencja auto i hash pliku == hash intencji", then: "zwykła droga: prepare → write → commit", next: "RC_PREPARED" },
        { if: "hash inny i seat w pliku == kandydat", then: "poprzedni proces zapisał plik i padł: `prepare` na configu z pliku, commit `auto: true`, bez drugiego zapisu" },
        { if: "hash inny i seat w pliku != stary seat (operator zapisał coś innego)", then: "intencja porzucona: prepare i commit na to, co plik nazywa, `auto: false`" },
        { if: "hash inny, ale seat w pliku == stary seat (zmieniły się inne seaty)", then: "zwykła droga: zapis jednego seat-a przechodzi", next: "RC_PREPARED" },
      ],
      default: "Ręczny switch (`auto: false`) omija tę gałąź.",
    },
    {
      id: "RC_PREPARED",
      title: "Admisja nowego seat-a przed zapisem",
      question: "Czy `prepareExecution(switchedConfig)` dopuściło nowe narzędzie?",
      where: "src/engine/orchestrator/recovery/switch-seat-resume.ts:189",
      inputs: ["`preparation.kind`", "`signal.aborted`"],
      branches: [
        { if: "`aborted` lub sygnał przerwany po przygotowaniu", then: "`unswitched · aborted`: nic nie zapisane, halt z intencją zostaje; stop raportuje ścieżka stopu" },
        { if: "`failed` / nie `prepared`", then: "`unswitched · unadmitted`: warning `The build seat was not switched to 'x': preparing it failed: …; the halt stays.`" },
        { if: "`prepared`", then: "zapis jednego seat-a", next: "RC_REVISION_MATCH" },
      ],
      default: "Seat, który padł, nie jest ponownie admitowany: przełączenie jest jedyną preparacją tego wejścia, więc narzędzie bez limitu nie blokuje ucieczki od siebie.",
    },
    {
      id: "RC_REVISION_MATCH",
      title: "Zapis jednego seat-a do config.yaml pod kontrolą hasha",
      question: "Czy plik wciąż ma hash z chwili halt-u?",
      where: "src/engine/orchestrator/recovery/switch-seat-resume.ts:204",
      inputs: ["`expectedRevision` (rawSha256 z halt-u)", "`recordSeatOfRecord`"],
      branches: [
        { if: "brak rewizji (projekt bez config.yaml)", then: "bez zapisu pliku; przełączony config podróżuje w pamięci; commit" },
        { if: "zapis zwraca inne niż `saved`", then: "`unswitched · conflict`: warning `config changed meanwhile · the halt stays`" },
        { if: "`saved`", then: "`commitSeatSwitch`", next: "RC_SWITCH_COMMIT_KIND" },
      ],
      default: "Zapis dotyczy jednego seat-a: BUILD pisze do profilu z halt-u (domyślnego, gdy halt nie nazwał profilu); REVIEW dziedziczony z PLAN dostaje nowy blok `reviewer`, `planner` zostaje.",
    },
    {
      id: "RC_SWITCH_COMMIT_KIND",
      title: "Commit przełączenia: wznowić próbę czy krok",
      question: "Czy halt nazywa brief?",
      where: "src/engine/orchestrator/recovery/actions.ts:760",
      inputs: ["`issue.taskId`", "`seat`", "`issue.selectedImplementerProfile`"],
      branches: [
        { if: "brief", then: "`RESTART_ATTEMPT_ON_SEAT {taskId, profile}`: `currentTaskIndex` na brief, `pendingRecovery` czyszczone, `retryProfile` przypięty; attempt i park (`interruptedStep source: seat`) zostają, więc brief wznawia tę samą próbę w zachowanym workspace; outcome `retry-current-task`" },
        { if: "bez briefu (PLAN / REVIEW)", then: "`RESOLVE_PENDING_RECOVERY`; krok (planowanie / werdykt) rusza ponownie; outcome `continued`" },
      ],
      default: "Potem `RECORD_SEAT_SWITCH` dopisuje do `seatSwitches` {switchId, seat, from, to, fromSeat, toSeat, cause, accountCause?, headline, auto, configRevision, ts} i publikuje `seat_switched` oraz `recovery_resolved`.",
      notes: "Zmieniony seat PLAN kasuje zapisany `plannerSessionId` przy wznowieniu (`init.ts:308`): nowy tool nie wznowi sesji starego, kontekst jest budowany od nowa.",
    },
    {
      id: "RC_HEADLESS_POLICY",
      title: "Headless: --on-seat-down",
      question: "Czy headless może przełączyć seat bez człowieka?",
      where: "src/cli/headless.ts:365",
      inputs: ["`--on-seat-down halt|switch` (`options.ts:333`)", "`configDeclaresFallback`", "`pendingRecovery.switchSeat.auto`"],
      branches: [
        { if: "`switch`, a żaden seat nie deklaruje fallbacku", then: "exit 2: ``--on-seat-down switch` needs a seat that declares `fallback``" },
        { if: "`halt`", then: "intencja nigdy nie jest wykonywana; pętla kończy się po pierwszym runie" },
        { if: "`switch` albo brak flagi, intencja w stanie", then: "`applyOfferedSeatSwap(auto.candidate)` przed `runWorkflow`; jeśli po swapie intencja wciąż jest → `recovery_required` + exit 1 (bez drugiej próby w tym procesie)" },
        { if: "resume z pendingRecovery bez intencji (poza odpowiedzianym apply-partial)", then: "`emitRecoveryAndFailIfPending`: rekord `recovery_required` {halt, reason, status, availableActions, recommendedAction, resumeCommand, cause, providerMessage, requestId, resetAt, fallback} i exit 1" },
        { if: "po runie nowa intencja i polityka != halt", then: "pętla: swap i kolejny `runWorkflow` (inny seat padł ze swoją intencją)" },
      ],
      default: "Linia dla człowieka: `Seat down (runner-usage-limit): <message> (resets HH:MM)` + `Recommended:` + `Continue with: splitbrief continue <id> --action …` (treść linii: RC_HEADLESS_LINE).",
    },
    {
      id: "RC_HEADLESS_LINE",
      title: "Która akcja nazywa się w linii `continue`",
      question: "Czy rekomendowaną akcję da się podać jako `--action`?",
      where: "src/core/recovery/resume-command.ts:29",
      inputs: ["`issue.recommendedAction`", "`issue.switchSeat.candidates[0]`"],
      branches: [
        { if: "`skip-current-task`", then: "`--action skip`" },
        { if: "`retry-same-worker`", then: "`--action retry`" },
        { if: "`end-run`", then: "`--action end-run`" },
        { if: "`switch-seat` z kandydatem", then: "`--action switch-seat:<tool>[:<model>][@<effort|variant>]`" },
      ],
      default: "Każda inna rekomendacja (`retry-later`, `revise`, `accept-as-is`, `continue`, `restore-backup`) to wiersz panelu: linia brzmi `splitbrief continue <id>, then choose <label> in the recovery panel` i nie działa headless. Parser: `parseContinueActionOption` (`options.ts:126`) zna też `restore`, `apply`, `discard`; `@` na narzędziu variant-channel (opencode, kilo-code) to variant, inaczej effort.",
    },
    {
      id: "RC_STALE_HALT",
      title: "Halt, który już nic nie znaczy, znika przy wejściu",
      question: "Czy zapisany halt dotyczy reguły, której run już nie sprawdza?",
      where: "src/engine/orchestrator/run/init.ts:619",
      inputs: ["`issue.reason`", "`state.workspace`", "treść `checkout-changed`"],
      branches: [
        { if: "reason retired (`validation-failed`, `user-edit-conflict`, `approval-promotion-conflict`, `scope-violation`, `planner-returned-no-briefs`, `constitution-check-failed`, `brief-review-no-progress`, `brief-quality-unrepaired`)", then: "stale: `RESOLVE`, `recovery_resolved continue`, warning `The halt this run saved no longer applies; continuing.`" },
        { if: "`checkout-changed` bez zapisanego workspace, gdy zmiany to tylko `HEAD` i `branch …`", then: "stale: jak wyżej" },
      ],
      default: "Każdy inny halt stoi: run loop pokazuje panel; `task/loop.ts:91` przy wejściu z nierozwiązanym haltem publikuje warning `recovery_pending_unresolved` i nie startuje pracy.",
    },
    {
      id: "RC_CREW_CHANGED",
      title: "Seat zmieniony w Settings, gdy run stał: to też switch",
      question: "Czy seat w config.yaml różni się od zapisanego w `seats.json` runu?",
      where: "src/engine/orchestrator/run/init.ts:261",
      inputs: ["`reconcileSeatIdentities`", "zdarzenia `seat_switched` od ostatniego `workflow_started`/`workflow_resumed`"],
      branches: [
        { if: "zmiana, której żaden `seat_switched` tego wejścia nie nazwał", then: "publikuje `seat_switched` z `cause: crew-changed`, `auto: false`, rewizja pliku; halt czekający na ten seat wznawia się na nowym (Try again / korekta)" },
        { if: "zmiana seat-a PLAN", then: "dodatkowo `plannerSessionId: null`: nowy tool nie wznowi sesji starego" },
      ],
      default: "Bez różnic nic się nie dzieje.",
    },
    {
      id: "RC_FALLBACK_DETAIL",
      title: "Wiersz `fallback:` w panelu",
      question: "Co panel Seat down mówi o fallbacku?",
      where: "src/engine/orchestrator/recovery/builders/task.ts:271",
      inputs: ["`seatSwap.fallbackReadFailed`", "`seatSwap.fallback`", "`seatSwap.fallbackBlockedReason`", "`seatSwitches`", "tożsamość bieżącego seat-a"],
      branches: [
        { if: "config.yaml nie ładuje się", then: "`fallback: not read · config.yaml does not load`" },
        { if: "brak fallbacku", then: "`no fallback set`" },
        { if: "zablokowany", then: "`fallback: <identity> · not offered: <reason>`" },
        { if: "auto już użyte dla seat-a", then: "`fallback: <identity> · automatic switch already used in this run`" },
        { if: "seat już jest fallbackiem (`isSeatIdentity`)", then: "`fallback: <identity> · the seat runs it now`" },
      ],
      default: "`fallback: <identity>` (oferowany i gotowy do intencji).",
    },
    {
      id: "RC_WORDS_UNREAD",
      title: "Czy słowa z composera dotrą do jakiegoś kroku",
      question: "Którą akcję czytają wpisane słowa, a która je gubi?",
      where: "src/core/recovery/typed-words.ts:11",
      inputs: ["`reason`", "`action`"],
      branches: [
        { if: "`accept-as-is` poza `review-input-too-large`", then: "słowa nieczytane (notatkę przy failed review przeczytałby tylko Apply)" },
        { if: "`retry-same-worker` / `restore-backup` na `apply-partial` / `apply-conflict`", then: "nieczytane: Apply nie czyta słów" },
        { if: "każda inna akcja", then: "słowa idą do kroku: steer briefu, korekta plannera, notatka grantu" },
      ],
      default: "`continueRun` (`run/continue.ts:92`) odmawia wznowienia ze słowami, gdy `statusLeavesWordsUnread`; panel odmawia `Cannot send words with <label>. Clear them.`",
    },
  ],
  config: [
    { key: "planner.fallback / implementer.fallback / reviewer.fallback", values: "{ tool: <cli tool id>, model?, effort? (effort-flag), variant? (opencode, kilo-code) }", default: "brak (żaden seat nie ma domyślnego fallbacku)", effect: "Jedyne upoważnienie do automatycznego przełączenia seat-a; prowadzi też ofertę ręczną. Każdy `kind` seat-a przyjmuje `fallback`; walidowany schematem CLI seat-a; `effort` na narzędziu variant-channel odrzucany. REVIEW bez bloku `reviewer` używa `planner.fallback`.", where: "src/core/schemas/runner-fields.ts:322" },
    { key: "implementerProfiles.<name>.fallback", values: "jak wyżej", default: "brak", effect: "Halt BUILD, który nazwał profil, czyta fallback tego profilu i zapisuje przełączenie do niego; wiersz BUILD w Settings › Fallback edytuje profil domyślny.", where: "src/engine/orchestrator/recovery/seat-swap-context.ts:72" },
    { key: "--on-seat-down <halt|switch>", values: "halt · switch · brak", default: "brak = jak `switch` (intencja wykonywana)", effect: "Headless `start`/`resume`/`continue`: `halt` nigdy nie przełącza; `switch` bez zadeklarowanego fallbacku kończy exit 2.", where: "src/cli/headless.ts:365" },
    { key: "splitbrief continue <id> --action <skip|retry|restore|switch-seat:<tool>[:<model>][@<effort>]|end-run|apply|discard>", values: "jak w nazwie", default: "bez `--action`: TUI z panelem", effect: "Odpowiada na pendingRecovery bez TUI; akcja poza `availableActions` → blocked, exit 1; nieznana wartość → exit 2.", where: "src/cli/options.ts:126" },
    { key: "BOUNDS.rateLimitResetWaitMs", values: "stała 600 000 ms (10 min)", default: "600000", effect: "Granica cichego czekania na reset w `runSeatCall` i próg „długiego resetu” dla intencji automatycznej.", where: "src/core/pipeline-spec/bounds.ts:13" },
    { key: "BOUNDS.transientRetries", values: "stała 3", default: "3", effect: "Liczba powtórek błędu przejściowego z backoffem 2s, 4s, 8s.", where: "src/core/pipeline-spec/bounds.ts:14" },
    { key: "BOUNDS.extraConsultsPerLineage / extraAttemptsPerLineage / extraPlannerCallsPerRun", values: "1 / 4 / 5", default: "1 / 4 / 5", effect: "Co daje `Continue` na halcie `consult-bound-spent` / `planner-calls-spent`.", where: "src/core/pipeline-spec/bounds.ts:5" },
    { key: "OFFERED_SEAT_SWAP_CANDIDATES", values: "stała 3", default: "3", effect: "Ile wierszy `switch <SEAT> to …` pokazuje panel; reszta w notce `(N more ready tools detected)`.", where: "src/features/workflow/recovery-prompt.ts:219" },
    { key: "Settings › Fallback (wiersz `fallback:<seat>`)", values: "picker w slocie `fallback`; wiersz None czyści", default: "`none · pause and ask`", effect: "Zapisuje `fallback` do config.yaml; działa przy najbliższym halcie bieżącego runu (→ zobacz ui).", where: "src/core/crew/fallback.ts:90" },
  ],
  states: [
    { name: "pendingRecovery (status awaiting-user)", meaning: "Halt czeka na decyzję; `deriveRunStatus` → `open · waiting-for-you · halt`. Panel w TUI, `recovery_required` headless.", where: "src/core/sessions/run-status.ts:207" },
    { name: "pendingRecovery (status applying, selectedAction)", meaning: "Akcja wybrana, zapis stanu w toku; przy ponownym wejściu driver odgrywa `selectedAction` bez pytania.", where: "src/core/state/machine.ts:281" },
    { name: "pendingRecovery.switchSeat.auto", meaning: "Intencja automatycznego fallbacku {candidate, configRevision}; TUI i headless wykonują ją przed panelem.", where: "src/core/schemas/recovery/schemas.ts:34" },
    { name: "interruptedStep (source: seat, cut: mid-step)", meaning: "Brief ucięty przez seat-down; workspace zachowany; switch wznawia tę samą próbę.", where: "src/engine/orchestrator/task/implementation-failure.ts:97" },
    { name: "seatWait {seat, resetAt}", meaning: "Run czeka na reset (auto ≤ 10 min lub Retry at). Proces żywy: `running`; zatrzymany: `stopped · seat-wait`, byline `Waiting for <tool> · resets HH:MM`.", where: "src/core/schemas/workflow.ts:277" },
    { name: "seatSwitches[]", meaning: "Każde przełączenie seat-a: seat, from, to, cause, accountCause?, headline, auto, configRevision, ts. Wpis `auto: true` blokuje drugą intencję dla tego seat-a w runie.", where: "src/core/schemas/workflow.ts:286" },
    { name: "retryProfile {taskId, profile}", meaning: "Brief przypięty do profilu BUILD po Retry/switch, aż przejdzie lub zostanie pominięty.", where: "src/core/state/machine.ts:300" },
    { name: "halt `needs-you`", meaning: "Decyzja tylko człowieka: wyczerpane bound-y, failed review po limicie cykli, chroniona ścieżka, konflikt Apply.", where: "src/core/recovery/halt.ts:14" },
    { name: "halt `seat-down`", meaning: "Seat nie może pracować: wylogowany, bez limitu, odrzucił komendę lub model, dwa timeouty, odpowiedź poza kontraktem.", where: "src/core/recovery/halt.ts:14" },
  ],
  scenarios: [
    {
      title: "Limit 5h na PLAN w trakcie planowania, fallback PLAN = codex",
      steps: [
        "1. Claude Code odpowiada `You've hit your session limit · resets 7:30pm` (za ~4 h); sesja planowania rzuca.",
        "2. `handlePlanningFailure` (`planning/failure.ts:91`): brak abortu, run otwarty, brak diagnostyki kontekstu → `diagnosePlannerCallFailure(seat plan)`.",
        "3. Klasyfikacja: fraza limitu + `resets 7:30pm` parsowalne → `rate-limited`; failure `usage-limit`, `resetsAt`.",
        "4. `plannerCallHaltIssue` → `loadSeatSwapContext(plan)`: config.yaml ładuje się, `planner.fallback = codex`, snapshot: codex ready → fallback na czele.",
        "5. `buildSeatDownIssue`: reset > 10 min, brak wpisu auto dla PLAN, pierwszy kandydat == fallback, rewizja znana → `switchSeat.auto`.",
        "6. `SET_PENDING_RECOVERY`, wiersz błędu cause-only `Usage limit on Claude Code · resets 19:30`, `recovery_prompted`.",
        "7. TUI: `recovery-driver.ts:223` zwraca switch bez panelu; `applyOfferedSeatSwap` → prepare codex → zapis `planner: {tool: codex, fallback: {tool: claude-code, model: …}}` → `RESOLVE_PENDING_RECOVERY` (bez briefu) → `RECORD_SEAT_SWITCH auto:true`.",
        "8. Transkrypt: `Recovery usage limit → continued on fallback`, `PLAN claude-code → codex · automatic fallback`. Krok planowania rusza ponownie na codex; `plannerSessionId` nie jest używany (nowe narzędzie).",
      ],
      outcome: "Run planuje dalej na codex; `seatSwitches` ma 1 wpis (seat plan, auto true). Stary seat jest teraz fallbackiem PLAN.",
    },
    {
      title: "Limit 5h na BUILD w implementing, fallback BUILD zadeklarowany",
      steps: [
        "1. Codex zwraca `You've hit your usage limit… or try again at 3:27 PM` (za ~5 h); adapter daje outcome `usage-limit` (→ runners).",
        "2. `runSeatCall` (`run-implementation.ts:286`): klasa rate-limited, reset > 600 000 ms → bez czekania, porażka wraca.",
        "3. `run-implementation.ts:324`: `workspace.retain()` (częściowe edycje zostają).",
        "4. `handleFailedImplementation` (`implementation-failure.ts:108`): `buildSeatDownIssue` z fallbackiem na czele i intencją auto; `INTERRUPT_STEP {brief, attempt} source: seat`; `SET_PENDING_RECOVERY`.",
        "5. Run loop: swap bez panelu; `switchSeatAndPrepareResume`: prepare opencode, zapis profilu BUILD do config.yaml pod hashem, `RESTART_ATTEMPT_ON_SEAT` (ten sam attempt, pin profilu), `RECORD_SEAT_SWITCH auto:true`.",
        "6. `runWorkflow` wraca na opencode; brief kontynuuje od ciętej próby w zachowanym workspace; pierwsze wywołanie może nic nie zmienić i czyta się `kept the interrupted attempt's work` (→ build).",
      ],
      outcome: "Brief idzie dalej na fallbacku bez pytania; licznik auto dla BUILD zużyty w tym runie.",
    },
    {
      title: "Ten sam limit bez fallbacku: panel Seat down i wybór Retry at",
      steps: [
        "1. Jak wyżej do kroku 4, ale `loadSeatSwapContext`: `no fallback set`; detekcja pamięta claude-code ready → oferta [claude-code].",
        "2. Akcje: `retry-same-worker`, `switch-seat`, `retry-later` (jest resetAt), `skip-current-task`, `end-run`; recommended `switch-seat`.",
        "3. Panel: `Seat down · Usage limit on OpenAI Codex CLI · resets 15:27`; wiersze `[r] Try again`, `[w] switch BUILD to claude-code · restarts this brief` (recommended), `[l] Retry at 15:27`, `[s] Skip task`, `[a] End run`; nagłówek workflow dopisuje zegar resetu przy BUILD.",
        "4. Użytkownik wybiera `l`: `applyRetryLaterRecoveryAction` → `SET_SEAT_WAIT build 15:27`, `RESOLVE`.",
        "5. Run wchodzi ponownie; `init.ts:330 resumeSeatWait` śpi do 15:27 (bez granicy 10 min); status `running`; stop w trakcie → `stopped · Waiting for OpenAI Codex CLI · resets 15:27`, ⏎ wznawia i czeka resztę.",
        "6. Po resecie brief startuje; `restoreUnresumedBriefCut` przywraca park, więc kontynuuje od ciętej próby.",
      ],
      outcome: "Run czeka na reset i sam rusza dalej na tym samym narzędziu; żaden wpis w `seatSwitches`.",
    },
    {
      title: "Krótki reset (7 minut) na BUILD: ciche czekanie, bez halt-u",
      steps: [
        "1. Claude Code: `You've hit your session limit · resets 2:07pm`, teraz 14:00.",
        "2. `runSeatCall` → `seatResetWaitDeadline`: rate-limited, 7 min ≤ 10 min → `waitForSeatReset`: `SET_SEAT_WAIT`, `seat_wait_started` w transkrypcie, sen.",
        "3. Użytkownik naciska esc esc: abort; `seatWait` zostaje w state.json; `deriveRunStatus` → `stopped · seat-wait`.",
        "4. Po 20 minutach `splitbrief resume`/⏎: `init.ts:330` widzi deadline w przeszłości → `CLEAR_SEAT_WAIT`, brief rusza od razu (bez halt-u, bo nie było pendingRecovery).",
        "5. Wariant bez stopu: po deadline `CLEAR_SEAT_WAIT` i TA SAMA próba powtarza się raz; jeśli znowu limit, `runSeatCall` zwraca porażkę → `buildSeatDownIssue`; reset ≤ 10 min → bez intencji auto, panel z `Retry at`.",
      ],
      outcome: "Krótki reset nie jest haltem; drugi limit po czekaniu już nim jest.",
    },
    {
      title: "Weekly limit vs limit bez godziny: ta sama droga auto",
      steps: [
        "1. `You've hit your weekly limit · resets Mon 12:00am`: `parseResetsAt` daje poniedziałek 00:00 → rate-limited, reset >> 10 min → switchable; panel/halt niosą `resets Oct 27, 00:00` (data, bo nie dziś).",
        "2. `You've reached your Opus limit. Run /usage-credits…` bez zegara: `rateLimitedReset` null → `isExhaustion` → `account · quota` → switchable; `facts.cause = quota`, nagłówek `Quota spent on Claude Code`, brak `retry-later` (bez resetAt).",
        "3. Oba budują intencję auto, gdy fallback zadeklarowany; bez fallbacku: pierwszy ma `Retry at`, drugi nie.",
      ],
      outcome: "Długi reset i brak resetu traktowane są jak odmowa konta; tylko krótki, parsowalny reset trzyma seat w miejscu.",
    },
    {
      title: "Wylogowanie codex na BUILD (auth logout)",
      steps: [
        "1. Codex: `Your access token could not be refreshed…` → adapter outcome `unauthenticated` (→ runners).",
        "2. `implementation-failure.ts:67`: `buildSeatDownIssue` class account·auth → `runner-unauthenticated`; message `Signed out of OpenAI Codex CLI. Run codex logout, then codex login…`; `INTERRUPT_STEP source: seat`.",
        "3. Z fallbackiem: intencja auto (account zawsze switchable) → przełączenie bez pytania.",
        "4. Bez fallbacku: panel `Seat down · Signed out of OpenAI Codex CLI`; akcje Try again, Change BUILD tool (gdy inne narzędzie ready), Skip, End; brak Retry at.",
        "5. Użytkownik loguje się w drugim terminalu i wybiera `r`: `RESET_TASK` (attempt 0), brief od nowa na tym samym narzędziu z nowym poświadczeniem.",
      ],
      outcome: "Logowanie nigdy nie jest robione przez SPLITBRIEF; halt podaje komendę, Try again odbudowuje runner.",
    },
    {
      title: "Błąd transportu (ECONNRESET): BUILD powtarza, PLAN halt-uje",
      steps: [
        "1. BUILD: `fetch failed` → klasa transient → `withSeatRetry`: `seat_retry` i czekanie 2 s, 4 s, 8 s; po 3 powtórkach porażka wraca jako zwykła próba → drabina eskalacji (→ build), nie seat-down.",
        "2. PLAN: ten sam `fetch failed` w sesji planowania nie przechodzi przez `runSeatCall`; `diagnosePlannerCallFailure` → `call-failed` → `planner-call-failed` (Seat down): `Planner call failed`, akcje Try again with PLAN, Change PLAN tool (gdy oferta), End run.",
        "3. Werdykt REVIEW z `fetch failed`: catch w `final-review.ts:1004` → `call-failed` → `review-failed` bez werdyktu na seat review (Needs you): Try again with REVIEW, End run.",
      ],
      outcome: "Tylko BUILD i konsultacje mają cichą powtórkę; na PLAN i REVIEW błąd transportu wymaga kliknięcia Try again.",
    },
    {
      title: "Błąd protokołu (zły JSON) w werdykcie REVIEW",
      steps: [
        "1. Reviewer odpowiada poza schematem dwa razy (`error.data.attempts`); `final-review.ts:842` ustawia `seat-protocol-error`.",
        "2. `haltVerdictlessReview` → `haltProtocolError` → `seatProtocolHaltIssue`: seat `review`, `loadSeatSwapContext(review, runner reviewer ?? planner)`.",
        "3. `buildSeatProtocolErrorRecoveryIssue`: akcje `retry-same-worker`, `switch-seat` (gdy oferta), `end-run`; recommended pierwsza = retry; brak intencji auto (to nie `buildSeatDownIssue`).",
        "4. Panel: `Seat down · Seat answer did not match its contract`, detale z błędami parsera; `[r] Try again with REVIEW · runs the review again`.",
        "5. Try again: `resolveSeatIssueWithoutTask` → `RESOLVE`; run wraca do final-review i woła werdykt ponownie bez powtarzania gate-ów.",
      ],
      outcome: "Błąd protokołu to Seat down bez automatycznego fallbacku; człowiek wybiera retry lub zmianę narzędzia.",
    },
    {
      title: "Użytkownik wybiera Change BUILD tool ręcznie",
      steps: [
        "1. Panel oferuje `[w] switch BUILD to claude-code`, `[w2] switch BUILD to opencode`. Użytkownik wpisuje `w2`.",
        "2. `recovery-driver.ts:261`: `switchSeatCandidateForAnswer` → opencode; `pickSwappedSeat` otwiera picker BUILD na wierszu opencode (model/effort kandydata w draftcie); `recoveryNoticeStore.open` podświetla halt.",
        "3. Escape → `committed=false` → `null`: halt zostaje, nic nie zapisane. Wybór tego samego seat-a (`kept`) → też anulowane.",
        "4. Zatwierdzony inny wiersz: picker zapisuje do config.yaml (profil z halt-u); driver czyta seat z pliku i zwraca `switchSeat`.",
        "5. Run loop → `applyOfferedSeatSwap`: `applySwitchSeatRecoveryAction`-owa droga z `auto: false`; prepare → zapis (hash sprawdzony) → `RESTART_ATTEMPT_ON_SEAT` → `RECORD_SEAT_SWITCH auto:false`; fallback seat-a zachowany (nie podmieniony).",
      ],
      outcome: "Brief wznawia ciętą próbę na opencode; licznik auto nietknięty; transkrypt `BUILD codex → opencode` bez `automatic fallback`.",
    },
    {
      title: "Fallback też ma limit",
      steps: [
        "1. Po automatycznym przełączeniu codex → opencode nowy seat BUILD ma `fallback: codex` (stary seat).",
        "2. opencode zwraca `provider.quota: Go usage limit exceeded` (status 429, bez resetu) → `account · quota`.",
        "3. `loadSeatSwapContext`: fallback codex w pliku; snapshot: codex ready (detekcja nie wie o limicie) → na czele oferty.",
        "4. `autoSwitchIntent`: `seatSwitches` ma wpis `build, auto:true` → intencji brak; wiersz `fallback: codex · automatic switch already used in this run`.",
        "5. Panel Seat down z `[w] switch BUILD to codex` (recommended), Try again, Skip, End; brak Retry at. Wybór `w` wróciłby na codex, który dalej ma limit.",
      ],
      outcome: "Drugi limit tego samego seat-a zawsze zatrzymuje run i pyta; automat działa raz na run i seat.",
    },
    {
      title: "Headless: halt bez TUI i powrót przez `continue --action`",
      steps: [
        "1. `splitbrief start --json` bez fallbacku; BUILD trafia na limit → `pendingRecovery` bez intencji.",
        "2. Po `runWorkflow` pętla kończy się; `emitRecoveryAndFailIfPending` pisze rekord `recovery_required {halt: seat-down, reason: runner-usage-limit, availableActions, recommendedAction: switch-seat, resumeCommand: 'splitbrief continue <id> --action switch-seat:claude-code', cause: rate-limit, providerMessage, resetAt}` i kończy exit 1.",
        "3. Operator: `splitbrief continue <id> --action switch-seat:claude-code:opus@high --json` → `parseContinueActionOption` → kandydat; `applySwitchSeatRecoveryAction` sprawdza, że tool jest w ofercie, planuje i commituje `auto:false`; run idzie dalej.",
        "4. Wariant z fallbackiem i bez `--on-seat-down halt`: intencja wykonana przed `runWorkflow`; gdy swap nie przeszedł (np. hash pliku zmieniony), `recovery_required` i exit 1 bez drugiej próby.",
      ],
      outcome: "Headless nigdy nie zgaduje akcji; jedyny automat to zadeklarowany fallback.",
    },
    {
      title: "Limit na werdykcie REVIEW, gdy REVIEW dziedziczy z PLAN",
      steps: [
        "1. Brak bloku `reviewer`: `resolveReviewerRunner` daje runner PLAN, `source: planner`.",
        "2. Werdykt pada na limit → `seat-blocked` → `plannerCallHaltIssue(seat review, swap: {review, runner PLAN})`; detail `REVIEW = PLAN. Switching here gives REVIEW its own seat.`",
        "3. `loadSeatSwapContext(review)`: `readActiveRunner(role reviewer)` → blok `planner`, więc fallback PLAN prowadzi ofertę; intencja auto na seat `review`.",
        "4. `configWithSwitchedSeat(review)`: `ReviewerConfigSchema.parse(switchedRunner(config.reviewer ?? config.planner…))` → nowy blok `reviewer` w config.yaml; `planner` nietknięty.",
        "5. `RESOLVE` (bez briefu) → werdykt rusza ponownie na nowym seat REVIEW.",
      ],
      outcome: "REVIEW dostaje własny blok; PLAN zostaje na starym narzędziu i zachowuje własny licznik auto.",
    },
  ],
  files: [
    { path: "src/core/recovery/halt.ts", role: "`REASON_HALT`, `haltOf`, `allowedActionsForHalt`, `recoveryHaltLabel` (Needs you / Seat down)" },
    { path: "src/core/recovery/headline.ts", role: "`formatRecoveryHeadlineSpans`: cause w tytule panelu, byline i wierszu błędu; `formatSeatSwitchCause`" },
    { path: "src/core/recovery/account-cause.ts", role: "słowa odmowy konta: Balance spent on / Billing refused by / Quota spent on / Signed out of" },
    { path: "src/core/recovery/reset-clock.ts", role: "`formatResetAt` (`resets HH:MM`, z datą gdy nie dziś), `stripRecoveryResetClause`" },
    { path: "src/core/recovery/action-label.ts", role: "etykiety akcji: Try again, Retry at HH:MM, Change BUILD tool, Pick another model, Skip task, End run" },
    { path: "src/core/recovery/resume-command.ts", role: "`formatResumeCommand`: linia `splitbrief continue <id> --action …` albo „then choose … in the recovery panel”" },
    { path: "src/core/recovery/typed-words.ts", role: "`leavesWordsUnread`: które akcje gubią wpisane słowa" },
    { path: "src/core/schemas/recovery/schemas.ts", role: "`RecoveryIssueSchema`, `SwitchSeatOfferSchema`, `SeatSwapAutoSchema`, czytanie akcji retired" },
    { path: "src/core/schemas/enums.ts", role: "`RECOVERY_REASONS`, `RETIRED_RECOVERY_REASONS`, `RECOVERY_ACTIONS` (kolejność wierszy menu)" },
    { path: "src/engine/runners/seat-failure.ts", role: "`classifySeatFailure`: authoritative → account → rate-limited → transient → other" },
    { path: "src/engine/runners/usage-limit.ts", role: "`parseUsageLimitReset`, `isUsageLimitDiagnostic`, `usageLimitAdvice`" },
    { path: "src/engine/runners/transient.ts", role: "`withSeatRetry` (3 powtórki, 2s/4s/8s), `abortableDelay`" },
    { path: "src/engine/orchestrator/escalation/seat-wait.ts", role: "`runSeatCall`, `seatResetWaitDeadline` (≤ 10 min), `waitForSeatReset`, `resumeSeatWait`" },
    { path: "src/engine/orchestrator/task/implementation-failure.ts", role: "pierwsza porażka implementera → seat-down / defekt / drabina" },
    { path: "src/engine/orchestrator/escalation/handle.ts", role: "`seatDownHalt`, `runnerDefectHalt`, `consultBoundHalt`, halt `pre_escalation`" },
    { path: "src/engine/orchestrator/task/retry.ts", role: "nieudana konsultacja → halt na seat plan/review z briefem" },
    { path: "src/engine/orchestrator/planning/failure.ts", role: "`handlePlanningFailure`: abort → park, closed → error, insufficient-context, diagnoza → halt" },
    { path: "src/engine/orchestrator/run/review.ts", role: "`haltVerdictlessReview`: input-too-large, seat-protocol-error, seat-blocked, review-failed bez werdyktu" },
    { path: "src/engine/orchestrator/final-review.ts", role: "catch wywołania werdyktu: klasyfikacja na `FinalReviewFailure`" },
    { path: "src/engine/orchestrator/recovery/planner-call-failure.ts", role: "`diagnosePlannerCallFailure`, `plannerHaltRow`, `plannerCallHaltIssue`" },
    { path: "src/engine/orchestrator/recovery/seat-protocol-halt.ts", role: "halt `seat-protocol-error` na seat, który odpowiedział" },
    { path: "src/engine/orchestrator/recovery/builders/task.ts", role: "`buildSeatDownIssue`, `autoSwitchIntent`, `switchSeatOffer`, `fallbackDetail`, buildery defektów runnera, review-failed" },
    { path: "src/engine/orchestrator/recovery/builders/planner.ts", role: "`buildPlannerCallFailedRecoveryIssue`, `PLANNER_FAILURE_REASONS`, halty sesji planowania" },
    { path: "src/engine/orchestrator/recovery/builders/consult.ts", role: "`consultBoundSpent`, `attemptBoundSpent`, halt bound-ów" },
    { path: "src/engine/orchestrator/recovery/builders/actions.ts", role: "`haltActions` (typowo ogranicza akcje do tytułu halt-u), `chooseRecommended`" },
    { path: "src/engine/orchestrator/recovery/seat-swap-context.ts", role: "`loadSeatSwapContext`, `readSeatOfRecord`, `fallbackDecision`, `haltRouteAuth`" },
    { path: "src/core/crew/fallback.ts", role: "`fallbackBlockedReason`, `fallbackRunner`, `deriveFallbackRows` (Settings › Fallback)" },
    { path: "src/engine/orchestrator/recovery/actions.ts", role: "`applyRecoveryAction` i każda akcja; `planSwitchSeatRecoveryAction`, `commitSeatSwitch`, `isSeatLevelRetry`" },
    { path: "src/engine/orchestrator/recovery/switch-seat.ts", role: "`configWithSwitchedSeat`, `switchedRunner` (stary seat staje się fallbackiem przy auto)" },
    { path: "src/engine/orchestrator/recovery/switch-seat-resume.ts", role: "`switchSeatAndPrepareResume`: plan → prepare → write → commit; reguły wznowienia po crashu" },
    { path: "src/engine/orchestrator/run/seat-swap.ts", role: "`applyOfferedSeatSwap`: ostrzeżenia blocked/unswitched, `onSeatSwapped`" },
    { path: "src/engine/orchestrator/recovery/bus.ts", role: "`createRecoveryBus`: zdarzenia recovery między turami trafiają do TUI i session.jsonl" },
    { path: "src/engine/orchestrator/run/init.ts", role: "`resumeSeatWait`, `settleStaleHalt`, `restoreUnresumedBriefCut`, rekoncyliacja `crew-changed`" },
    { path: "src/core/state/machine.ts", role: "`SET_PENDING_RECOVERY`, `MARK_RECOVERY_APPLYING`, `RESOLVE_PENDING_RECOVERY`, `RESTART_ATTEMPT_ON_SEAT`, `RECORD_SEAT_SWITCH`, `SET_SEAT_WAIT`, `RESET_TASK`, `GRANT_ALLOWANCE`" },
    { path: "src/features/workflow/recovery-driver.ts", role: "TUI: intencja auto bez panelu, picker po switch-seat, pętla odpowiedzi, odgrywanie `applying`" },
    { path: "src/features/workflow/recovery-prompt.ts", role: "klawisze akcji, wiersze `switch <SEAT> to …`, nagłówek `Needs you · …` / `Seat down · …`" },
    { path: "src/features/workflow/hooks/use-run-loop.ts", role: "run loop: wejście z `pendingRecovery`, `applyOfferedSeatSwap`, zdejmowanie zużytej intencji" },
    { path: "src/cli/headless.ts", role: "`--on-seat-down`, pętla intencji, `recovery_required`, exit 1/2" },
    { path: "src/cli/options.ts", role: "`parseContinueActionOption` (`--action`), `--on-seat-down`" },
    { path: "src/core/sessions/run-status.ts", role: "`pendingRecovery` → waiting-for-you · halt; `seatWait` → stopped · seat-wait" },
  ],
  gotchas: [
    "Cicha drabina (3 powtórki transient, czekanie na reset ≤ 10 min) obejmuje tylko wywołania przez `runSeatCall`: implementer (pierwsza próba i próby drabiny) oraz konsultacje. Sesja planowania i wywołanie werdyktu REVIEW nie mają jej: błąd transportu lub krótki limit na PLAN/REVIEW jest od razu haltem. WORKFLOW.md:532 mówi ogólnie o „seat call”; APPROVAL-AND-RECOVERY.md (sekcja Every planner-tier call) opisuje to poprawnie tylko dla konsultacji.",
    "Granica 10 minut (`BOUNDS.rateLimitResetWaitMs`) dotyczy czekania automatycznego i progu intencji auto. `Retry at HH:MM` wybrane przez człowieka czeka bez granicy: `SET_SEAT_WAIT` z `issue.resetAt`, a `resumeSeatWait` śpi do końca, choćby 5 godzin.",
    "Automatyczny fallback podmienia role: po przełączeniu stary seat staje się fallbackiem nowego (`switchedRunner`, tylko dla starego seat-a `cli`). Licznik „raz na run i seat” liczy wpisy `auto: true` w `seatSwitches`; ręczne przełączenia i `crew-changed` go nie zużywają.",
    "Limit bez parsowalnej godziny resetu jest klasyfikowany jako `account · quota`, czyli jak odmowa konta: przełącza automatycznie nawet, gdy prawdziwy reset jest za 2 minuty. `Request rejected (429)` bez rzeczownika limitu jest transient i jest powtarzany.",
    "Halt czyta fallback z config.yaml, nie z configu runu: fallback zapisany w Settings w trakcie runu działa przy najbliższym halcie. Gdy plik istnieje, ale nie ładuje się, panel pokazuje `fallback: not read · config.yaml does not load` i switch jest zablokowany (`fallback-read-failed`).",
    "Intencja auto wymaga `configRevision`; projekt bez config.yaml nie przełącza automatycznie (switch ręczny działa bez zapisu pliku).",
    "`switch-seat` w TUI nie przełącza samego narzędzia: otwiera picker seat-a na kandydacie; Escape lub wybór tego samego seat-a anuluje bez zmian. CLI `--action switch-seat:<tool>` przyjmuje tylko narzędzie z oferty, ale model/effort są dowolne.",
    "Przełączenie z briefem to `RESTART_ATTEMPT_ON_SEAT` (ten sam attempt, zachowany park i workspace); Try again to `RESET_TASK` (attempt 0, status pending). Etykieta menu mówi `restarts this brief` dla switch i dla retry na PLAN/REVIEW z briefem.",
    "Kolejność commitu switcha jest kontraktem: prepare → zapis jednego seat-a pod hashem → dopiero `RESOLVE`. Każda przerwa zostawia halt z intencją w state.json; w TUI run loop zdejmuje intencję tylko z pamięci, więc `continue` w nowym procesie spróbuje jej znowu.",
    "W headless halt bez intencji kończy proces z exit 1 i rekordem `recovery_required`; `--on-seat-down switch` bez zadeklarowanego fallbacku to exit 2; brak flagi zachowuje się jak `switch`.",
    "`end-run` omija `availableActions` (zawsze dozwolone), ale wszystkie inne akcje przechodzą dwie bariery: lista halt-u i lista tytułu (`allowedActionsForHalt`). `continue` jest bezpieczne tylko dla bound-ów i reasons retired.",
    "Wiersz błędu w transkrypcie przy intencji auto jest cause-only (`runnerHaltRow`), a porada (`Wait for the limit to reset or change the BUILD tool`) zostaje tylko w issue; zegar resetu jest zdejmowany ze słów narzędzia (`stripRecoveryResetClause`) i pisany raz z `resetAt`.",
    "Przy `missing-model` na opencode te same słowa (`provider.no-route`) dają trzy różne halty zależnie od listingu poświadczeń odczytanego na świeżo: sign-out (Seat down z fallbackiem), `Model not listed` (picker modelu), `Model refused` (nic samo nie rusza).",
    "Zmiana seat-a w Settings, gdy run stoi na halcie, jest zapisywana przy wznowieniu jako `seat_switched cause: crew-changed, auto: false`, a zmiana PLAN kasuje `plannerSessionId`.",
  ],
});
