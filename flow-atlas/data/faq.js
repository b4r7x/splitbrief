window.ATLAS_FAQ = window.ATLAS_FAQ || [];
window.ATLAS_FAQ.push(
  {
    id: 'limit',
    q: 'Co się dzieje, gdy walnie limit konta?',
    a: 'Limit kończy się haltem `Seat down` na seacie, który go trafił, chyba że run może krótko poczekać. Na BUILD i w konsultacjach reset za nie więcej niż 10 minut daje ciche czekanie i jedną powtórkę tego samego wywołania. Na PLAN i REVIEW nie ma czekania: halt powstaje od razu, a panel oferuje `Retry at HH:MM`, gdy godzina resetu jest znana. Gdy seat deklaruje `fallback`, a limit to odmowa konta albo reset dalej niż 10 minut, seat przełącza się sam, raz na run i seat. Bez fallbacku run czeka na twój wybór: zmiana narzędzia, `Retry at`, Try again, Skip task albo End run; gdy przed kontynuacją przeniesiesz seat na inne narzędzie, run nie czeka na reset starego narzędzia i od razu startuje nowe. Odmowę konta, którą narzędzie wypisuje tylko na stderr (np. Cursor: `not included in your weekly usage`), SPLITBRIEF też czyta jako `Seat down` przy pierwszym wywołaniu. Reviewer checks i Apply nie wołają modelu, więc limit ich nie dotyczy.',
    refs: ['JR_SEAT_CLASS', 'JR_SEAT_RUNG', 'JR_RESET_WAIT', 'JR_AUTO_SWITCH', 'RC_FAILURE_SOURCE', 'RC_SEAT_WAIT_HELD', 'RC_ACCOUNT_CAUSE', 'diagram:journey-seat-failure', 'area:recovery'],
    tags: ['limity', 'fallback']
  },
  {
    id: 'limit-planning',
    q: 'Co się dzieje, gdy limit trafi w planowanie?',
    a: 'Planowanie staje od razu na halcie `Seat down` na seacie PLAN, bez cichego retry i bez czekania na reset. Kod przyczyny to `runner-usage-limit`, a przy wylogowaniu `runner-unauthenticated`. Pytania i odpowiedzi sesji zostają w stanie runu. Z zadeklarowanym `planner.fallback` seat przełącza się sam i planowanie rusza na nowym narzędziu z odbudowanym transkryptem. Bez fallbacku panel pokazuje zmianę narzędzia PLAN, `Retry at HH:MM` (gdy reset jest znany), Try again i End run. Run czyta się `open · waiting-for-you · halt` także po restarcie procesu.',
    refs: ['JR_PLANNING_FAILURE', 'PL_FAILURE', 'RC_PLANNER_DIAGNOSIS', 'RC_PLANNER_BUILDER', 'diagram:planning-call', 'area:planning'],
    tags: ['limity', 'planowanie']
  },
  {
    id: 'limit-build',
    q: 'Co się dzieje, gdy limit trafi w build (brief)?',
    a: 'Krótki limit (reset do 10 minut) build przeczekuje sam; dłuższy limit albo odmowa konta zatrzymuje brief na halcie `Seat down`. Przy krótkim resecie run czeka w miejscu i powtarza tę samą próbę raz; stop w trakcie czekania daje `stopped · seat-wait`, a ⏎ czeka resztę, chyba że BUILD zmienisz na inne narzędzie: wtedy brief rusza od razu. Reset dalej, bez godziny albo odmowa konta: halt `Seat down` od razu, bez lokalnego retry i bez konsultacji. Brief jest zaparkowany jak po stopie, a częściowe pliki zostają w workspace. Z `implementer.fallback` seat przełącza się sam i wznawia tę samą próbę na nowym narzędziu. Bez fallbacku panel oferuje zmianę narzędzia BUILD, `Retry at HH:MM`, Try again, Skip task i End run.',
    refs: ['JR_BUILD_SEAT_DOWN', 'BD_SEAT_RETRY', 'RC_RESET_WAIT_ONCE', 'RC_SEAT_WAIT_HELD', 'RC_IMPL_OUTCOME', 'RC_SWITCH_COMMIT_KIND', 'diagram:rc-seq-limit-fallback', 'diagram:rc-seq-limit-nofallback'],
    tags: ['limity', 'build']
  },
  {
    id: 'limit-review',
    q: 'Co się dzieje, gdy limit trafi w review?',
    a: 'Review staje od razu na halcie `Seat down` na seacie REVIEW, a nieudane wywołanie nigdy nie jest passem. Wybór reviewer checks i werdykt nie mają cichego retry ani czekania na reset. Reviewer checks to komendy projektu, nie wywołania modelu, więc limit konta ich nie dotyczy. Bez bloku `reviewer` REVIEW dziedziczy narzędzie i fallback PLAN; przełączenie zapisuje wtedy nowy blok `reviewer`, a planner zostaje. Try again albo switch uruchamia review od nowa. Fix task biegnie na BUILD, więc jego limit zachowuje się jak limit w buildzie.',
    refs: ['JR_REVIEW_VERDICT', 'RC_REVIEW_FAILURE_KIND', 'RV_CALL_FAILURE_KIND', 'RV_VERDICTLESS_HALT', 'diagram:review-override', 'area:review'],
    tags: ['limity', 'review']
  },
  {
    id: 'fallback',
    q: 'Jak działa fallback i kiedy przełącza automatycznie?',
    a: 'Fallback przełącza seat sam tylko przy `Seat down` z odmowy konta (auth, quota, balance, billing) albo z limitu z resetem dalej niż 10 minut, i tylko raz na run i seat. Deklarujesz go blokiem `fallback` przy seacie w `config.yaml`: `planner.fallback`, `implementer.fallback` albo `reviewer.fallback`. Żaden seat nie ma domyślnego fallbacku, a deklaracja to jedyne upoważnienie do automatycznego przełączenia. Fallback musi być gotowy i prowadzić listę kandydatów, a halt musi znać rewizję `config.yaml`. Przełączenie zapisuje seat do `config.yaml`, dopisuje wpis do `seatSwitches` i wznawia krok bez pytania. Stary seat CLI staje się fallbackiem nowego.',
    refs: ['JR_AUTO_SWITCH', 'RC_FALLBACK_DECLARED', 'RC_AUTO_SWITCHABLE', 'RC_AUTO_LEADS', 'RC_AUTO_USED', 'RC_REVISION_MATCH', 'diagram:rc-fallback', 'diagram:rc-switch-commit'],
    tags: ['fallback', 'limity']
  },
  {
    id: 'fallback-not-auto',
    q: 'Kiedy fallback nie przełącza sam?',
    a: 'Błąd przejściowy, timeout, błąd protokołu i `planner-call-failed` nie budują intencji automatycznej, więc panel pyta. Krótki reset (do 10 minut) też nie przełącza: na BUILD run czeka, na PLAN i REVIEW panel oferuje `Retry at HH:MM`. Fallback nie prowadzi oferty, gdy nie jest zainstalowany, wymaga logowania albo seat już na nim pracuje; panel pisze wtedy `not offered: <reason>`. Projekt bez `config.yaml` nie przełącza automatycznie, bo halt nie zna rewizji pliku. Headless z `--on-seat-down halt` nigdy nie przełącza. Ręczny switch z pickera działa zawsze i nie zużywa przełączenia automatycznego.',
    refs: ['RC_AUTO_SWITCHABLE', 'RC_FALLBACK_BLOCKED', 'RC_AUTO_LEADS', 'RC_FALLBACK_DETAIL', 'RC_HEADLESS_POLICY', 'diagram:rc-fallback'],
    tags: ['fallback']
  },
  {
    id: 'fallback-also-limited',
    q: 'Co, jeśli fallback też ma limit?',
    a: 'Automatyczne przełączenie działa raz na run i seat. Po pierwszym przełączeniu wpis `auto: true` w `seatSwitches` blokuje drugą intencję dla tego seatu. Gdy nowy seat też trafi na limit, run staje na panelu `Seat down` z wierszem `automatic switch already used in this run`. Panel nadal proponuje stary seat (teraz fallback) jako pierwszy wiersz ręczny, ale ten seat może dalej mieć limit. Do wyboru masz inne narzędzie, `Retry at HH:MM` (gdy reset jest znany), Try again, Skip task albo End run.',
    refs: ['RC_AUTO_USED', 'RC_FALLBACK_DETAIL', 'RC_SEAT_DOWN_ACTIONS', 'RC_RECOMMENDED', 'diagram:rc-fallback', 'area:recovery'],
    tags: ['fallback', 'limity']
  },
  {
    id: 'retries',
    q: 'Ile razy SPLITBRIEF ponawia i ile czeka?',
    a: 'Błąd przejściowy (sieć, DNS, 5xx, 408, gołe 429 bez resetu) jest powtarzany do 3 razy, z przerwą 2 s, 4 s i 8 s. Limit z resetem za nie więcej niż 10 minut daje jedno ciche czekanie i jedną powtórkę tego samego wywołania; drugi limit po czekaniu jest już haltem. To dotyczy tylko wywołań BUILD i konsultacji. Plan call, review plan call i werdykt halthują od razu, więc trzeba wybrać Try again. `Retry at HH:MM` wybrane przez ciebie czeka bez granicy 10 minut, nawet kilka godzin, chyba że przed kontynuacją zmienisz narzędzie tego seatu. Te powtórki nie liczą się do limitu prób briefu.',
    refs: ['RC_TRANSIENT', 'RC_TRANSIENT_RETRY', 'RC_RESET_WAIT_ONCE', 'RC_RETRY_LATER_OK', 'RC_SEAT_WAIT_HELD', 'JR_SEAT_RUNG', 'BD_SEAT_RETRY', 'diagram:rc-seat-call'],
    tags: ['limity', 'recovery']
  },
  {
    id: 'needs-you-vs-seat-down',
    q: 'Czym różni się Needs you od Seat down?',
    a: '`Needs you` to decyzja, którą może podjąć tylko człowiek; `Seat down` znaczy, że seat nie może pracować. Needs you dostajesz przy wyczerpanych limitach prób, nieudanym review po cyklach naprawczych, odmowie zapisu chronionej ścieżki, konflikcie Apply i planie po dwóch nieudanych sprawdzeniach. Seat down dostajesz, gdy seat jest wylogowany, nie ma limitu, dwa razy przekroczył czas, odrzucił model, nie przyjął promptu jako za dużego albo odpowiedział poza kontraktem. Seat down oferuje, zależnie od przyczyny, zmianę narzędzia, `Retry at`, Try again, Skip task i End run. Needs you oferuje Continue, Try again, revise, Accept as is, Restore backup, Skip task i End run, zależnie od przyczyny. Tylko Seat down z limitu albo odmowy konta przełącza się automatycznie na fallback; tytuł wybiera jedna funkcja `haltOf`.',
    refs: ['JR_HALT_KIND', 'RC_HALT_OF', 'RC_SEAT_DOWN_ACTIONS', 'RC_ACTION_ALLOWED', 'RC_IMPL_OUTCOME', 'diagram:rc-master', 'area:recovery'],
    tags: ['recovery']
  },
  {
    id: 'halt-panel',
    q: 'Co robią akcje w panelu recovery?',
    a: 'Pusty ⏎ bierze akcję rekomendowaną, a tekst, który nie jest akcją, staje się korektą akcji, która go czyta (retry, revise albo continue). Try again na briefie zeruje próby i buduje brief od nowa; switch zachowuje próbę i wznawia ją na nowym seacie. `Retry at HH:MM` parkuje run do resetu i sam go wznawia; zmiana narzędzia seatu przed kontynuacją zdejmuje to czekanie. Skip task zapisuje brief jako pominięty i cofa jego pliki. End run zamyka run i jest dozwolony przy każdym halcie. Silnik odmawia akcji spoza listy halta, a ten sam halt zostaje do odpowiedzi.',
    refs: ['RC_TUI_ANSWER', 'RC_RECOMMENDED', 'RC_ACTION', 'RC_SEAT_LEVEL_RETRY', 'RC_RETRY_LATER_OK', 'RC_ACTION_ALLOWED', 'JR_RECOVERY_ACTION', 'diagram:rc-actions-resume', 'diagram:rc-tui-panel'],
    tags: ['recovery']
  },
  {
    id: 'crash',
    q: 'Co się dzieje po crashu (kill -9, brak prądu)?',
    a: 'Crash nie gubi runu: następny start czyta go jako `open · stopped · interrupted`, a ⏎ kontynuuje od briefu, który był w toku. Wcześniejsze briefy zostają w workspace, a planowanie nie jest powtarzane. Crash nie zapisuje parku ani błędu, więc przerwany brief wraca do snapshotu ze swojego startu i rusza od próby 0. Gdy `session.jsonl` dowodzi, że brief był zaparkowany i nie biegł ponownie, park wraca i częściowa praca zostaje. Otwarte wywołania są zapisane jako przerwane, a osierocone procesy narzędzi są zabijane. Gdy proces padł po zamknięciu runu, ale przed usunięciem jego worktree albo staged copy, następny start z terminala usuwa je razem z wpisem git worktree i branchem. Katalog sesji, który nigdy nie wystartował, znika po 24 h.',
    refs: ['LC_FAILED', 'LC_TASK_IN_FLIGHT', 'LC_UNRESUMED_CUT', 'LC_ORPHAN_RUNNER', 'LC_LEFTOVER_WORKSPACE', 'LC_ORPHAN_SESSION', 'diagram:lc-crash-detect', 'diagram:journey-exits'],
    tags: ['stop']
  },
  {
    id: 'stop-resume',
    q: 'Co robi Stop i jak wznowić run?',
    a: 'Stop parkuje run tak, że ⏎ kontynuuje go od tego samego kroku; zamyka go tylko End run. `Stop now` (drugi esc albo ctrl+c) przerywa bieżące wywołanie, zapisuje park w połowie kroku i zostawia częściowe zmiany w workspace. `Pause after this brief` niczego nie zabija: brief kończy bramkę, a run staje przed następnym. `End run` zamyka run i jest jedyną drogą zamknięcia z klawiatury; esc nigdy nie zamyka runu. Zatrzymany run jest `open · stopped`: ⏎ albo tekst w composerze go kontynuuje, a tekst dokleja się do promptu kroku jako korekta. Z terminala działa `splitbrief resume` (aktywny run) albo `splitbrief continue <id>`.',
    refs: ['JR_STOP_KIND', 'LC_STOP_KIND', 'JR_CONTINUE_GUARD', 'LC_KEEP_WORKSPACE', 'LC_CLI_RESUME', 'diagram:lc-stop-resume', 'diagram:ui-esc-ladder'],
    tags: ['stop']
  },
  {
    id: 'statuses',
    q: 'W jakich stanach może być run?',
    a: 'Użytkownik widzi pięć stanów: running, waiting for you, stopped, ready to apply i closed. Liczy je jedna funkcja `deriveRunStatus`, a każda lista, ekran i komenda czyta tę samą odpowiedź. `waiting for you` to halt, pytanie plannera albo karta planu; `stopped` to park, czekanie na reset, błąd albo przerwany proces. Run otwarty zawsze da się kontynuować, run ready bierze tylko Apply albo Discard. Run closed bierze tylko komendy, a ⏎ wraca na home. Pierwsze dopasowanie w ustalonej kolejności wygrywa: closed przed running, a running przed każdym stanem otwartym.',
    refs: ['JR_RUN_STATUS', 'LC_ALIVE', 'LC_HALT', 'LC_PARKED', 'JR_CONTINUE_GUARD', 'diagram:lc-run-status', 'diagram:journey-status'],
    tags: ['stop', 'apply']
  },
  {
    id: 'apply-fails',
    q: 'Co, jeśli Apply padnie w połowie?',
    a: 'Nic nie ginie po cichu: Apply robi backup przed pierwszym zapisem, a przerwany zapis daje halt `apply-partial · Needs you` z akcjami Retry i Restore. Backup leży w `.splitbrief/sessions/<id>/apply/<backupId>/`, a każdy zapis jest strzeżony hashem bajtów, które Apply przeczytał do merge. Halt powstaje, gdy część zapisów się nie uda albo proces zniknie w trakcie („wrote N of M files”). End run i Discard odmawiają, dopóki Apply nie jest dokończony albo cofnięty. Restore przywraca bajty sprzed Apply, a pliki zmienione przez ciebie później zostawia; run wraca do ready-to-apply. Retry używa tego samego backupu i zapisuje od nowa. Gdy Apply zapisał wszystko i zamknął run, ale nie usunął worktree albo staged copy, następny start z terminala je usuwa.',
    refs: ['JR_APPLY_OUTCOME', 'LC_APPLY_CUT', 'LC_WRITE_RESULT', 'LC_RESTORE_FILE', 'LC_APPLY_UNFINISHED', 'LC_BACKUP_CHANGED', 'LC_LEFTOVER_WORKSPACE', 'diagram:lc-apply'],
    tags: ['apply']
  },
  {
    id: 'ready-vs-closed',
    q: 'Kiedy run jest ready-to-apply, a kiedy od razu closed?',
    a: 'Worktree i staged copy po zaliczonym review dają `ready-to-apply`, a tryb checkout (`workflow.isolation: none`) od razu zamyka run jako `closed · complete`. W ready-to-apply zmiany czekają poza twoim checkoutem, a menu pokazuje Apply · Show diff · Discard; Accept as is też prowadzi tutaj. W checkoucie i na starym runie bez workspace zmiany już są na dysku, więc nie ma Apply. Run ready nie jest kontynuowany: bierze tylko Apply albo Discard. Apply, Discard albo End run zamyka go; End run na runie ready działa jak Discard i zachowuje `run.patch`. Gdy proces właśnie robi Apply, run czyta się jako `running`.',
    refs: ['JR_READY_OR_CLOSE', 'RV_AFTER_PASS', 'LC_READY', 'LC_COMPLETE_CHECKOUT', 'LC_CLOSE_AS', 'diagram:journey-status', 'diagram:lc-close'],
    tags: ['apply', 'review']
  },
  {
    id: 'own-changes',
    q: 'Co z moimi własnymi zmianami w checkout?',
    a: 'Plik zmieniony w checkout przed startem runu to twoja praca; zmianą runu staje się tylko wtedy, gdy run zmieni go jeszcze raz. Żaden fix task nie może wskazać twojego pliku, a Apply go zachowuje. Raport gotowości tylko ostrzega o brudnym drzewie, nigdy nie blokuje. Gdy w trakcie runu zmienisz plik, który run też zmienił, Apply robi trójstronny merge, a scalony wynik przechodzi checki i review jeszcze raz przed zapisem. Konflikt samych linii tekstu wraca do review jako fix task; każdy inny konflikt daje halt `apply-conflict · Needs you`. W trybie checkout run pisze wprost w twoją kopię, a bajty zastąpione przy cofnięciu leżą w `reverted/<stamp>/`.',
    refs: ['RV_RUN_UNIVERSE', 'RV_FIX_TASK_TARGETS', 'ST_DIRTY_WORKTREE', 'LC_CANDIDATE_CHANGED', 'LC_CONFLICT_TEXT_ONLY', 'LC_MERGE_CONFLICT', 'diagram:lc-apply'],
    tags: ['apply']
  },
  {
    id: 'discard-patch',
    q: 'Jak odzyskać pracę po Discard albo End run?',
    a: 'Discard i End run na runie z worktree albo staged copy zapisują wszystkie niezastosowane zmiany do `.splitbrief/sessions/<id>/run.patch`. Patch to binarny diff run base i workspace, a pracę przywracasz przez `git apply run.patch` w checkoucie. Potem workspace jest usuwany, a blok `Closed ─` w transkrypcie nazywa plik patcha. Gdy workspace już zniknął, patcha nie ma i SPLITBRIEF to mówi. W trybie checkout patcha nie ma, bo zmiany są już w twojej kopii. End run w trakcie niedokończonego Apply odmawia: najpierw Restore albo Retry.',
    refs: ['LC_CLOSE_PATCH', 'LC_CLOSE_AS', 'LC_APPLY_UNFINISHED', 'JR_RESULT_MENU', 'diagram:lc-close'],
    tags: ['apply', 'pliki']
  },
  {
    id: 'brief-attempts',
    q: 'Ile prób ma brief i co po ich wyczerpaniu?',
    a: 'Nieudana próba dostaje najpierw jeden lokalny retry z dokładnym błędem. Potem SPLITBRIEF konsultuje seat, który odpowiada jedną akcją: guidance, rewrite-task, split-task, verify, ask-user albo confirm. Limity to 8 prób i 2 konsultacje na lineage briefu oraz 10 wywołań plannera na run. Po ich wyczerpaniu run staje na `consult-bound-spent` albo `planner-calls-spent · Needs you`, a pliki briefu zostają. Continue daje +1 konsultację i +4 próby (albo +5 wywołań plannera) i ponawia brief na zachowanych plikach; Skip task cofa pliki briefu. Seat down i defekt runnera przerywają drabinę od razu, bez konsultacji.',
    refs: ['BD_LOCAL_RUNG', 'BD_ATTEMPT_BOUND', 'BD_CONSULT_BOUND', 'BD_CONSULT_ACTION', 'BD_RESTORE_ON_HALT', 'RC_CONTINUE_SAFE', 'RC_LADDER_HALT', 'diagram:build-ladder'],
    tags: ['build']
  },
  {
    id: 'planner-consulted',
    q: 'Kiedy planner jest konsultowany?',
    a: 'Planner jest konsultowany w buildzie, gdy lokalny retry briefu nie pomógł albo gdy implementer zgłosił `blocked` z pytaniem. Raport blocked omija lokalny retry i idzie prosto do konsultacji. Brief z planu konsultuje PLAN na swojej wznowionej sesji, a fix task z review konsultuje REVIEW jednym bezstanowym wywołaniem. Konsultacja dostaje plan, brief, diff briefu, błędy prób i wynik checków. Każda konsultacja liczy się do limitu 2 na lineage i 10 wywołań plannera na run. Hook `pre_escalation` może zablokować konsultację; wtedy powstaje halt `retry-exhausted`.',
    refs: ['BD_BLOCKED', 'BD_CONSULT_SEAT', 'BD_CONSULT_BOUND', 'BD_PRE_ESCALATION_HOOK', 'BD_CONSULT_ACTION', 'diagram:build-ladder', 'diagram:build-consult-answer'],
    tags: ['build']
  },
  {
    id: 'brief-tests',
    q: 'Czy testy biegną po każdym briefie?',
    a: 'Z domyślnym `workflow.review: end` nie. Po briefie biegnie tylko formatter projektu na zmienionych plikach, a brief jest akceptowany bez komend. Checki planu i briefów biegną dopiero przed review końcowym. Z `workflow.review: task` po każdym briefie biegną jego checki i checki kryteriów, które ten brief domyka, a potem zawężony review. Fix task i akcja verify z konsultacji zawsze uruchamiają swoje checki; fix task, którego własne failures to same testy, uruchamia tylko pliki tych testów.',
    refs: ['BD_BRIEF_GATE_CHECKS', 'BD_CHECK_VERDICT', 'RV_CADENCE', 'RV_PRE_REVIEW_SCOPE', 'diagram:build-gate', 'diagram:review-task-cadence'],
    tags: ['build', 'review']
  },
  {
    id: 'protected-paths',
    q: 'Kiedy SPLITBRIEF pyta o zgodę na zapis pliku?',
    a: 'Zgody wymagają trzy klasy zapisu: `.git` i `.splitbrief` (destrukcyjne), konfiguracja CI, `.env*`, klucze i `.npmrc` (wrażliwe) oraz `package.json`, lockfile, `go.mod`, `Cargo.*`, `pyproject.toml` i podobne (pakiety). Zapis każdej innej ścieżki przechodzi bez pytania, także poza plikami briefu. Karta zgody w TUI wymaga frazy potwierdzenia i powodu. Zatwierdzona karta planu potwierdza z góry zapisy, które plan wymienia. Odmowa cofa tylko odrzucone pliki; gdy nic nie zostaje, powstaje halt `approval-denied · Needs you`. Headless nie ma kogo zapytać, więc odmawia (`APPROVAL_REQUIRED`).',
    refs: ['BD_CLASSIFY_WRITE', 'BD_CONFIRM_RESPONSE', 'BD_APPROVAL_CALLBACK', 'BD_DENIAL_SCOPE', 'PL_PROTECTED_CONFIRM', 'diagram:build-protected'],
    tags: ['build', 'planowanie']
  },
  {
    id: 'review-loop',
    q: 'Co sprawdza review i kiedy fix loop się kończy?',
    a: 'Najpierw SPLITBRIEF uruchamia wszystkie checki planu i briefów; czerwony required check staje się wejściem dla reviewera. Potem reviewer wybiera do 6 komend (V1…V6), a SPLITBRIEF uruchamia je w workspace pod polityką komend reviewera. Czerwona komenda biegnie drugi raz na run base, więc porażka sprzed runu nie blokuje. Na końcu reviewer daje werdykt, a SPLITBRIEF sam liczy pass, pass-with-notes albo fail. Fail z fix tasks wydaje jeden z 2 cykli naprawczych: fix tasks wracają do pętli briefów, każdy przechodzi, gdy znikną jego własne failures, a review biegnie od nowa. Check fix tasku, którego nie da się uruchomić (zły plik testu, brak skryptu npm), wraca do reviewera do poprawy albo jest czerwony, ale nie zatrzymuje runu. Fix loop kończy się passem albo haltem `review-failed · Needs you`, gdy cykle się skończą albo nie ma nic do naprawy. Nieudane wywołanie reviewera i pominięty check nigdy nie są passem.',
    refs: ['RV_PRE_REVIEW_SCOPE', 'RV_END_CHECKS', 'RV_BASE_RESULT', 'RV_OUTCOME', 'RV_PASSED', 'RV_CAP', 'RV_NOTHING_TO_FIX', 'RV_BLOCKING_RED', 'RV_FIX_CHECK_JUDGE', 'RV_ANSWER_SCHEMA', 'diagram:review-master', 'diagram:review-fix-loop'],
    tags: ['review']
  },
  {
    id: 'accept-as-is',
    q: 'Co to jest Accept as is?',
    a: 'Accept as is to akcja na halcie `review-failed` po review końcowym. Zapisuje override z otwartymi findings i notą, a nieudany werdykt zostaje w rekordzie. Jest dostępna tylko wtedy, gdy żaden czerwony check nie blokuje. W worktree i staged copy run staje się ready-to-apply, a Apply nazywa się `Apply as is` i raz pyta o potwierdzenie. W trybie checkout Accept as is od razu zamyka run jako complete. Przy `review-input-too-large` ta sama akcja to „Skip review with a note”.',
    refs: ['RV_ACCEPT_AS_IS_KIND', 'RV_HALT_FAILED_REVIEW', 'RV_BLOCKING_RED', 'LC_APPLY_GATE', 'diagram:review-override'],
    tags: ['review', 'apply']
  },
  {
    id: 'workflow-approve',
    q: 'Co robi workflow.approve?',
    a: '`workflow.approve` ma dwie wartości: `plan` (domyślnie) i `none`. Przy `plan` po sprawdzeniach planu otwiera się karta: Approve, Request changes, Edit plan.json albo End run. Approve potwierdza też chronione zapisy i komendy `npm run` z planu, więc build nie pyta o nie drugi raz. Przy `none` build startuje od razu, a każdy chroniony zapis pyta dopiero w buildzie. Stare wartości `all`, `spec` i `default` ładują się jako `plan` z jedną notą, a flaga `--approve` nie istnieje. Headless zatwierdza kartę bez pytania i nie zapisuje potwierdzeń.',
    refs: ['PL_APPROVE_LEVEL', 'PL_CARD_RESULT', 'PL_PROTECTED_CONFIRM', 'PL_UNATTENDED', 'JR_APPROVE', 'diagram:planning-card'],
    tags: ['planowanie']
  },
  {
    id: 'planner-questions',
    q: 'Ile pytań może zadać planner?',
    a: 'Planner zadaje najwyżej 3 pytania na rundę, w najwyżej 2 rundach. Każde pytanie ma odpowiedź domyślną, a pusty ⏎ ją bierze. Odpowiedzi wracają na tej samej natywnej sesji plannera. Po drugiej rundzie planner dostaje polecenie, żeby zwrócił plan i wziął domyślne odpowiedzi. Trzecia runda pytań daje halt `plan-questions-exhausted · Needs you`. Headless kończy się na pytaniu kodem różnym od 0 i rekordem `input_required`.',
    refs: ['JR_PLAN_TURN', 'PL_RESULT_KIND', 'PL_ROUNDS_EXHAUSTED', 'PL_REPLY_KIND', 'diagram:planning-questions'],
    tags: ['planowanie']
  },
  {
    id: 'plan-checks',
    q: 'Co, jeśli plan nie przejdzie sprawdzeń?',
    a: 'Plan przechodzi deterministyczne sprawdzenia `checkPlan` i dopasowanie do kontekstu seatu BUILD. Plan z błędami wraca do plannera raz, z listą błędów. Drugi nieudany plan daje halt `plan-checks-failed · Needs you`, a rekomendowana akcja to revise. Check `npm run <skrypt>`, którego `package.json` nie definiuje, też wraca do plannera, chyba że któryś task wymienia `package.json`. Jedyny błąd, który nie blokuje, to check render bez `validation.render`: plan przechodzi z notą „Before you approve”. Naprawa odpowiedzi poza schematem JSON liczy się osobno od tej jednej naprawy.',
    refs: ['JR_PLAN_CHECKS', 'PL_CHECK_ERRORS', 'PL_BLOCKS_PLAN', 'PL_CMD_REFUSAL', 'PL_TYPED_REPAIR', 'RC_RECOMMENDED', 'diagram:planning-checks'],
    tags: ['planowanie']
  },
  {
    id: 'headless',
    q: 'Czym różni się headless od TUI?',
    a: '`--json` albo `--plain` uruchamia run bez ekranu: zdarzenia jako NDJSON albo linie tekstu; obie flagi naraz kończą się kodem 2. Headless zatwierdza kartę planu bez pytania, ale zapis chronionej ścieżki odmawia (`APPROVAL_REQUIRED`). Pytanie plannera albo halt bez intencji kończy proces kodem 1 z rekordem `input_required` albo `recovery_required` i komendą `splitbrief continue <id> --action …`. Zadeklarowany fallback przełącza się sam także w headless, chyba że podasz `--on-seat-down halt`. Przy `validation.approve_checks: ask` reviewer checks są pominięte, bo nie ma ekranu, a pominięty check nigdy nie jest passem. Run ready-to-apply kończy się kodem 0 i podpowiedzią `--action apply`.',
    refs: ['JR_HEADLESS', 'ST_HEADLESS_MODE', 'ST_OUTPUT_MODE', 'ST_HEADLESS_FINAL', 'RC_HEADLESS_POLICY', 'RV_APPROVE_CHECKS', 'PL_UNATTENDED', 'diagram:startup-headless', 'diagram:rc-headless'],
    tags: ['start']
  },
  {
    id: 'start-blockers',
    q: 'Co blokuje start?',
    a: 'Node starszy niż 22, katalog bez repozytorium git i brak terminala w trybie TUI kończą proces od razu. Config w innej wersji niż 3 nie wczytuje się i też zatrzymuje start. Raport gotowości blokuje start przy braku commitów, trwającym merge lub rebase, innym żywym runie w projekcie i stosie, którego worktree nie obsłuży bez jawnego `workflow.isolation`. Jeden zablokowany seat blokuje cały start: narzędzie niezainstalowane, niezalogowane, w niezgodnej wersji albo niezaufane. Niezaufane hooki bez odpowiedzi `y` albo `--allow-hooks` też blokują. Brudne drzewo robocze i detached HEAD tylko ostrzegają.',
    refs: ['ST_NODE_VERSION', 'ST_GIT_REPO', 'ST_TTY', 'ST_CONFIG_VERSION', 'ST_REPO_CHECK', 'ST_ACTIVE_SESSION', 'ST_ISOLATION_STACK', 'ST_SEATS_BLOCKED', 'ST_CLI_ADMISSION', 'ST_HOOK_TRUST', 'ST_READINESS_STATUS', 'diagram:startup-readiness'],
    tags: ['start']
  },
  {
    id: 'first-run',
    q: 'Co się dzieje przy pierwszym starcie bez configu?',
    a: 'W TUI otwiera się ekran Setup, w którym wybierasz narzędzie i model dla każdego seatu. Continue zapisuje załogę tylko wtedy, gdy każdy seat jest gotowy. Headless sam wybiera załogę z wykrytych narzędzi: PLAN to pierwszy gotowy z claude-code, codex i reszty, BUILD to Ollama albo gotowe narzędzie CLI. REVIEW nie jest ustawiany, więc planner trzyma seat review. Gdy nie ma gotowej załogi, headless kończy się kodem 1 i radzi `splitbrief init`.',
    refs: ['ST_NEEDS_SETUP', 'ST_FIRST_RUN_PATH', 'ST_SETUP_CONTINUE', 'ST_DEFAULT_CREW', 'ST_CREW_AVAILABLE', 'diagram:startup-first-run'],
    tags: ['start']
  },
  {
    id: 'run-files',
    q: 'Jakie pliki zapisuje run i gdzie?',
    a: 'Run mieszka w `.splitbrief/sessions/<id>/` w projekcie. `state.json` mówi, gdzie run stoi, `session.jsonl` mówi, co się wydarzyło, a `lockfile.json` z heartbeatem mówi, czy proces go trzyma. Obok leżą `plan.json`, `plan.md`, `tasks.md`, `review.json`, `summary.json`, `draft.json`, snapshoty, backup Apply w `apply/<backupId>/` i `run.patch` po Discard albo End run. Plik `.splitbrief/active` wskazuje bieżącą sesję. Worktree runu leży poza projektem w `~/.local/state/splitbrief/trees/` (`XDG_STATE_HOME`), a kopia run base w `bases/`. Staged copy leży w katalogu sesji jako `stage-<hex>`.',
    refs: ['JR_WORKSPACE', 'LC_FINALIZE', 'LC_CLOSE_PATCH', 'LC_DRAFT', 'diagram:lc-files', 'area:lifecycle'],
    tags: ['pliki']
  }
);
