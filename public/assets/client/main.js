/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseBoardCoordInput, STANDARD_FLEET, createEmptyBoard, createShip, createAiState, fireShot, isFleetSunk, keyToCoord, placeFleetRandomly, validatePlacement, nextShot, registerAiShot, CHAT_EMOJI, CHAT_GIF_IDS, } from "../shared/index.js";
const labels = "ABCDEFGHIJ";
const $ = (selector) => {
    const el = document.querySelector(selector);
    if (!el)
        throw new Error(`Missing element: ${selector}`);
    return el;
};
const coordKey = (coord) => `${coord.row},${coord.col}`;
const coordLabel = (coord) => `${labels[coord.col]}${coord.row + 1}`;
const SHIP_ICON = "⚓";
const HIT_ICON = "💥";
const MISS_ICON = "·";
const SINK_ICON = "🛳️";
const FALLBACK_SHIP_ICON = "S";
const FALLBACK_HIT_ICON = "X";
const FALLBACK_MISS_ICON = ".";
const FALLBACK_SINK_ICON = "#";
const cellIcon = (state, useFallback = false) => {
    if (useFallback) {
        if (state === "ship")
            return FALLBACK_SHIP_ICON;
        if (state === "sunk")
            return FALLBACK_SINK_ICON;
        if (state === "hit")
            return FALLBACK_HIT_ICON;
        if (state === "miss")
            return FALLBACK_MISS_ICON;
        return "";
    }
    if (state === "ship")
        return SHIP_ICON;
    if (state === "sunk")
        return SINK_ICON;
    if (state === "hit")
        return HIT_ICON;
    if (state === "miss")
        return MISS_ICON;
    return "";
};
const cellDescription = (coord, state) => {
    const cell = coordLabel(coord);
    if (language === "en") {
        if (state === "ship")
            return `${cell}: ship`;
        if (state === "hit")
            return `${cell}: hit`;
        if (state === "sunk")
            return `${cell}: sunk`;
        if (state === "miss")
            return `${cell}: miss`;
        if (state === "preview-valid")
            return `${cell}: placement preview (valid)`;
        if (state === "preview-invalid")
            return `${cell}: placement preview (invalid)`;
        return `${cell}: empty`;
    }
    if (state === "ship")
        return `${cell}: statek`;
    if (state === "hit")
        return `${cell}: trafienie`;
    if (state === "sunk")
        return `${cell}: zatopiony`;
    if (state === "miss")
        return `${cell}: pudło`;
    if (state === "preview-valid")
        return `${cell}: podgląd ustawienia (poprawne)`;
    if (state === "preview-invalid")
        return `${cell}: podgląd ustawienia (błędne)`;
    return `${cell}: puste`;
};
const useFallbackIcons = typeof document === "undefined"
    ? false
    : (() => {
        try {
            if (document.fonts && document.fonts.check) {
                const fallbackFont = document.fonts.check('16px "Apple Color Emoji"');
                const windowsFont = document.fonts.check('16px "Segoe UI Emoji"');
                return !fallbackFont && !windowsFont;
            }
            return false;
        }
        catch {
            return false;
        }
    })();
const coordEquals = (a, b) => a.row === b.row && a.col === b.col;
const markAroundSunkShip = (board, hits) => {
    for (const hit of hits) {
        for (let dr = -1; dr <= 1; dr += 1) {
            for (let dc = -1; dc <= 1; dc += 1) {
                const row = hit.row + dr;
                const col = hit.col + dc;
                if (row < 0 || col < 0 || row >= board.height || col >= board.width)
                    continue;
                board.shots.add(coordKey({ row, col }));
            }
        }
    }
};
const recordShipHit = (tracker, shipId, coord) => {
    const current = tracker[shipId] ?? [];
    if (!current.some((entry) => coordEquals(entry, coord))) {
        current.push(coord);
    }
    tracker[shipId] = current;
    return current;
};
const markSunkCells = (sunkCells, hits) => {
    for (const hit of hits) {
        sunkCells.add(coordKey(hit));
    }
};
const markAroundKnownSunkCells = (board, sunkCells) => {
    for (const key of sunkCells) {
        const coord = keyToCoord(key);
        if (!Number.isFinite(coord.row) || !Number.isFinite(coord.col))
            continue;
        for (let dr = -1; dr <= 1; dr += 1) {
            for (let dc = -1; dc <= 1; dc += 1) {
                const row = coord.row + dr;
                const col = coord.col + dc;
                if (row < 0 || col < 0 || row >= board.height || col >= board.width)
                    continue;
                board.shots.add(coordKey({ row, col }));
            }
        }
    }
};
const addShotPoint = (stateToUpdate, forYou) => {
    if (forYou) {
        stateToUpdate.shots += 1;
    }
    else {
        stateToUpdate.opponentShots += 1;
    }
};
const applyShotToBoardState = (board, coord, outcome) => {
    const key = coordKey(coord);
    const isNewShot = !board.shots.has(key);
    board.shots.add(key);
    if (outcome === "hit" || outcome === "sink") {
        if (!board.hits) {
            board.hits = new Set();
        }
        board.hits.add(key);
    }
    return isNewShot;
};
const syncSunkCellsFromBoard = (board, target) => {
    target.clear();
    for (const ship of board.ships) {
        if (!ship.sunk)
            continue;
        for (const cell of ship.cells) {
            target.add(coordKey(cell));
        }
    }
};
const statusEl = $("#status");
const shotsYourEl = $("#shotsYour");
const shotsOpponentEl = $("#shotsOpponent");
const shotsTotalEl = $("#shotsTotal");
const boardOwnEl = $("#myBoard");
const boardEnemyEl = $("#enemyBoard");
const opponentNameEl = $("#opponentName");
const queueTimerEl = document.querySelector("#queueTimer");
const modeEl = $("#modeBadge");
const readinessBadgeEl = $("#readinessBadge");
const remainingEl = $("#remainingShips");
const orientationBadgeEl = $("#orientationBadge");
const titleEl = $("#titleText");
const subtitleEl = $("#subtitleText");
const placementHintEl = $("#placementHint");
const labelNicknameEl = $("#labelNickname");
const labelShotEl = $("#labelShot");
const labelLanguageEl = $("#labelLanguage");
const myBoardTitleEl = $("#myBoardTitle");
const enemyBoardTitleEl = $("#enemyBoardTitle");
const legendShipEl = $("#legendShip");
const legendHitEl = $("#legendHit");
const legendMissEl = $("#legendMiss");
const legendSunkEl = $("#legendSunk");
const labelShotsEl = $("#labelShots");
const labelYouEl = $("#labelYou");
const labelOpponentInlineEl = $("#labelOpponentInline");
const labelTotalEl = $("#labelTotal");
const labelEnemyNameEl = $("#labelEnemyName");
const winnerFxEl = $("#winnerFx");
const winnerFxTitleEl = $("#winnerFxTitle");
const winnerFxNameEl = $("#winnerFxName");
const winnerFxConfettiEl = $("#winnerFxConfetti");
const chatTitleEl = $("#chatTitle");
const chatPanelEl = $("#chatPanel");
const chatListEl = $("#chatList");
const chatInputEl = $("#chatInput");
const chatSendBtnEl = $("#chatSendBtn");
const chatHintEl = $("#chatHint");
const chatGifToggleEl = $("#chatGifToggle");
const chatGifBarEl = $("#chatGifBar");
const chatUnreadEl = $("#chatUnread");
const chatEmojiButtons = Array.from(document.querySelectorAll("[data-chat-emoji]"));
const chatGifButtons = Array.from(document.querySelectorAll("[data-chat-gif]"));
const btnRotate = $("#btnRotate");
const btnAutoPlace = $("#btnAutoPlace");
const btnClearPlacement = $("#btnClearPlacement");
const btnStartLocal = $("#btnStartLocal");
const btnJoinQueue = $("#btnJoinQueue");
const btnPlayAgainOnline = $("#btnPlayAgainOnline");
const btnCancel = $("#btnCancel");
const shotInput = $("#shotInput");
const btnFire = $("#btnFire");
const nickInput = $("#nicknameInput");
const langPlBtn = $("#langPlBtn");
const langEnBtn = $("#langEnBtn");
const socket = typeof io !== "undefined" ? io() : null;
let online = false;
let inQueue = false;
let roomId = null;
let onlineReady = false;
let onlineOpponentReady = false;
let onlineVsBot = false;
let yourId = "";
let yourTurnOnline = false;
let opponentName = "Bot";
let queueTicker = null;
let queueDeadline = 0;
let queueTimeoutMs = 60000;
let awaitingShot = false;
let reconnectTicker = null;
let reconnectDeadline = 0;
let isCancelling = false;
let previousCanShoot = false;
let autoReconnectQueued = false;
let reconnectToken = null;
let hoverCoord = null;
let chatGifOpen = false;
const RECONNECT_TOKEN_KEY = "battleship_reconnect_token";
const LANGUAGE_KEY = "battleship_language";
const RECONNECT_GRACE_MS_FALLBACK = 3000;
let language = "pl";
let statusRaw = "";
let winnerFxTimer = null;
let chatState = {
    enabled: false,
    messages: [],
    unread: 0,
};
const DEFAULT_NICK_BY_LANG = {
    pl: "Gracz",
    en: "Player",
};
const DEFAULT_OPPONENT_NAME = {
    pl: "Przeciwnik",
    en: "Opponent",
};
const CHAT_GIF_LABELS = {
    direct_hit: { pl: "Celny strzał", en: "Direct hit" },
    missed_shot: { pl: "Pudło", en: "Missed shot" },
    ship_sunk: { pl: "Statek zatopiony", en: "Ship sunk" },
    nice_move: { pl: "Dobry ruch", en: "Nice move" },
    gg: { pl: "GG", en: "GG" },
};
const resetShotInputState = (clearValue = false) => {
    if (clearValue) {
        shotInput.value = "";
    }
    previousCanShoot = false;
};
let state = {
    phase: "setup",
    placement: "random",
    remainingShips: [...STANDARD_FLEET],
    orientation: "H",
    yourBoard: placeFleetRandomly(createEmptyBoard()),
    enemyBoard: placeFleetRandomly(createEmptyBoard()),
    turn: "you",
    yourTurn: true,
    shots: 0,
    opponentShots: 0,
    aiState: createAiState(),
    enemyShipHits: {},
    ownShipHits: {},
    enemySunkCells: new Set(),
    yourSunkCells: new Set(),
};
const I18N = {
    pl: {
        title: "GRA W STATKI",
        subtitle: "Tryb taktyczny: ręczne ustawianie i walka online",
        labelNickname: "Nickname:",
        labelShot: "Strzał (A1-J10):",
        labelLanguage: "Język:",
        labelShots: "Strzały:",
        labelYou: "Ty",
        labelOpponentInline: "Przeciwnik",
        labelTotal: "Razem",
        labelEnemyName: "Przeciwnik:",
        myBoard: "Moja plansza",
        enemyBoard: "Plansza przeciwnika",
        legendShip: "⚓ Twój statek",
        legendHit: "💥 Trafienie",
        legendMiss: "· Pudło",
        legendSunk: "🛳️ Zatopiony segment",
        hintPlacement: "Ustawianie: PPM / scroll / R = obrót",
        btnRotate: "Obróć ręczny (H/V)",
        btnAuto: "Losowe rozstawienie",
        btnClear: "Wyczyść do ręcznego",
        btnJoinQueue: "Szukaj online",
        btnPlayAgainOnline: "Nowa gra online",
        btnCancel: "Anuluj/wyjdź",
        btnFire: "Oddaj strzał",
        btnStartPva: "Start PvA",
        btnReadyWaiting: "Gotowy - czekam",
        btnReadySubmit: "Gotowe (wyślij ustawienie)",
        btnNewPva: "Nowa gra PvA",
        orientation: "Orientacja: {orientation}",
        remaining: "Pozostałe: {ships}",
        randomMode: "Tryb: losowe rozmieszczenie",
        localModeBadge: "Tryb lokalny: PvA",
        readiness: "Gotowość: Ty {you} / Przeciwnik {opponent}",
        readyYes: "TAK",
        readyNo: "NIE",
        gameActiveBadge: "Gra aktywna",
        gameOverBadge: "Gra zakończona",
        winnerTitle: "ZWYCIEZCA",
        chatTitle: "Czat online",
        chatPlaceholder: "Napisz wiadomość...",
        chatSend: "Wyślij",
        chatHintDisabled: "Czat działa tylko w meczu online PvP.",
        chatHintEnabled: "Czat aktywny: setup / gra / koniec gry (60s).",
        chatEmoji: "Emoji",
        chatGifs: "GIF reakcje",
        chatYou: "Ty",
        chatOpponent: "Przeciwnik",
        chatSystem: "System",
        chatUnread: "Nowe: {count}",
    },
    en: {
        title: "BATTLESHIP",
        subtitle: "Tactical mode: manual placement and online battle",
        labelNickname: "Nickname:",
        labelShot: "Shot (A1-J10):",
        labelLanguage: "Language:",
        labelShots: "Shots:",
        labelYou: "You",
        labelOpponentInline: "Opponent",
        labelTotal: "Total",
        labelEnemyName: "Opponent:",
        myBoard: "My Board",
        enemyBoard: "Enemy Board",
        legendShip: "⚓ Your ship",
        legendHit: "💥 Hit",
        legendMiss: "· Miss",
        legendSunk: "🛳️ Sunk segment",
        hintPlacement: "Placement: RMB / scroll / R = rotate",
        btnRotate: "Rotate manual (H/V)",
        btnAuto: "Random placement",
        btnClear: "Reset to manual",
        btnJoinQueue: "Find online",
        btnPlayAgainOnline: "New online game",
        btnCancel: "Cancel/leave",
        btnFire: "Fire shot",
        btnStartPva: "Start PvA",
        btnReadyWaiting: "Ready - waiting",
        btnReadySubmit: "Ready (send placement)",
        btnNewPva: "New PvA game",
        orientation: "Orientation: {orientation}",
        remaining: "Remaining: {ships}",
        randomMode: "Mode: random placement",
        localModeBadge: "Local mode: PvA",
        readiness: "Ready: You {you} / Opponent {opponent}",
        readyYes: "YES",
        readyNo: "NO",
        gameActiveBadge: "Game active",
        gameOverBadge: "Game finished",
        winnerTitle: "WINNER",
        chatTitle: "Online Chat",
        chatPlaceholder: "Type a message...",
        chatSend: "Send",
        chatHintDisabled: "Chat is available only in online PvP match.",
        chatHintEnabled: "Chat active: setup / playing / game over (60s).",
        chatEmoji: "Emoji",
        chatGifs: "GIF reactions",
        chatYou: "You",
        chatOpponent: "Opponent",
        chatSystem: "System",
        chatUnread: "Unread: {count}",
    },
};
const formatI18n = (template, vars) => {
    if (!vars)
        return template;
    return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
};
const t = (key, vars) => {
    const template = I18N[language][key] ?? I18N.pl[key] ?? key;
    return formatI18n(template, vars);
};
const getStoredLanguage = () => {
    try {
        const value = localStorage.getItem(LANGUAGE_KEY);
        return value === "en" ? "en" : "pl";
    }
    catch {
        return "pl";
    }
};
const storeLanguage = (value) => {
    try {
        localStorage.setItem(LANGUAGE_KEY, value);
    }
    catch {
        // Ignore storage issues.
    }
};
const applyNicknameDefaultForLanguage = (nextLanguage, prevLanguage) => {
    const current = nickInput.value.trim();
    const shouldReplace = current.length === 0 ||
        current === DEFAULT_NICK_BY_LANG.pl ||
        current === DEFAULT_NICK_BY_LANG.en ||
        (prevLanguage ? current === DEFAULT_NICK_BY_LANG[prevLanguage] : false);
    if (shouldReplace) {
        nickInput.value = DEFAULT_NICK_BY_LANG[nextLanguage];
    }
    nickInput.placeholder = DEFAULT_NICK_BY_LANG[nextLanguage];
};
const translateStatus = (text) => {
    if (language === "pl")
        return text;
    const readyWord = (value) => (value === "TAK" ? "YES" : "NO");
    const exact = {
        "Gra gotowa. Ustaw statki ręcznie albo startuj losowo.": "Game ready. Place ships manually or start with random setup.",
        "Ręczne ustawienie statków. Klikaj pola na swojej planszy.": "Manual ship placement. Click cells on your board.",
        "Losowe rozmieszczenie gotowe.": "Random placement ready.",
        "Błędne ustawienie tego statku.": "Invalid ship placement.",
        "Gotowe. Kliknij Start PvA.": "Placement complete. Click Start PvA.",
        "Nowa gra lokalna rozpoczęta. Twoja tura.": "New local game started. Your turn.",
        "Gra lokalna rozpoczęta. Twoja tura.": "Local game started. Your turn.",
        "To pole jest już strzelane.": "This cell was already targeted.",
        "To pole jest już zajęte.": "This cell is already used.",
        "Brak aktywnego pokoju. Poczekaj na połączenie.": "No active room. Wait for connection.",
        "Nie Twoja tura.": "Not your turn.",
        "Brak aktywnej gry.": "No active game.",
        "Nieprawidłowe id pokoju.": "Invalid room id.",
        "Nieprawidłowy pokój.": "Invalid room.",
        "Nieprawidłowe dane strzału.": "Invalid shot payload.",
        "Błędne współrzędne.": "Invalid coordinates.",
        "To pole zostało już trafione.": "This cell was already targeted.",
        "Niewłaściwe pole.": "Invalid target cell.",
        "Rozpocznij po ustawieniu wszystkich statków.": "Start after placing all ships.",
        "Pozycjonowanie statków jest niedostępne podczas gry.": "Ship placement is unavailable during active game.",
        "Nieprawidłowe dane ustawienia statków.": "Invalid ship placement payload.",
        "Nieprawidłowe ustawienie statków.": "Invalid ship placement.",
        "Brak planszy w danych.": "Missing board in payload.",
        "Brak celu strzału.": "No shot target available.",
        "Tura bota.": "Bot turn.",
        "Zbyt wiele ustawień statków. Poczekaj chwilę.": "Too many ship placements. Wait a moment.",
        "Zbyt wiele strzałów. Poczekaj chwilę.": "Too many shots. Wait a moment.",
        "Za dużo żądań do kolejki. Spróbuj ponownie za chwilę.": "Too many queue requests. Try again shortly.",
        "Za dużo prób reconnect. Spróbuj ponownie za chwilę.": "Too many reconnect attempts. Try again shortly.",
        "Za dużo żądań anulowania. Spróbuj ponownie za chwilę.": "Too many cancel requests. Try again shortly.",
        "Zbyt wiele błędnych żądań. Spróbuj ponownie za chwilę.": "Too many invalid requests. Try again shortly.",
        "Błędny format. Użyj A1..J10.": "Invalid format. Use A1..J10.",
        "Czekaj na odpowiedź serwera.": "Wait for server response.",
        "Poczekaj na swoją kolej.": "Wait for your turn.",
        "Gra nie jest aktywna.": "Game is not active.",
        "Brak socket.io. Uruchom serwer i odśwież stronę.": "Socket.io unavailable. Start server and refresh page.",
        "Dołączono do kolejki...": "Joined queue...",
        "Już czekasz na przeciwnika.": "You are already waiting for an opponent.",
        "Już jesteś online. Odśwież, aby zrestartować.": "You are already online. Refresh to restart.",
        "Jesteś już w grze. Wyjdź do menu przed dołączeniem.": "You are already in a game. Leave to menu before joining again.",
        "Anulowanie oczekiwania...": "Cancelling queue...",
        "Anulowanie gry...": "Cancelling game...",
        "Anulowano oczekiwanie w kolejce.": "Queue waiting canceled.",
        "Brak aktywnego oczekiwania w kolejce.": "No active queue waiting session.",
        "Brak połączenia z serwerem.": "No server connection.",
        "Możesz rozpocząć nowy mecz online po zakończeniu aktualnej gry.": "You can start a new online match after the current one ends.",
        "Połączenie utracone. Czekam na ponowne połączenie...": "Connection lost. Waiting for reconnect...",
        "Połączenie utracone.": "Connection lost.",
        "Próba odzyskania połączenia...": "Trying to restore connection...",
        "Próba dołączenia do gry...": "Trying to join game...",
        "Brak połączenia.": "No connection.",
        "Najpierw dołącz do kolejki.": "Join queue first.",
        "Token sesji wygasł. Tworzymy nową kolejkę.": "Session token expired. Creating a new queue.",
        "Token reconnecta jest już używany w aktywnej sesji.": "Reconnect token is already used in an active session.",
        "Token reconnecta jest nieaktualny.": "Reconnect token is no longer valid.",
        "Token reconnecta stracił ważność. Tworzę nową kolejkę.": "Reconnect token expired. Creating a new queue.",
        "Odzyskano połączenie z kolejką.": "Queue connection restored.",
        "Odzyskano token sesji.": "Session token restored.",
        "Nie znaleziono aktywnej gry ani kolejki z tym tokenem. Tworzę nową kolejkę.": "No active game or queue found for this token. Creating a new queue.",
        "Timeout kolejki. Gra z botem.": "Queue timeout. Starting game against bot.",
        "Połączenie z grą przywrócone.": "Game connection restored.",
        "Przeciwnik wrócił do gry. Gra została wznowiona.": "Opponent reconnected. Game resumed.",
        "Przeciwnik chwilowo niedostępny. Oczekiwanie na reconnect.": "Opponent temporarily unavailable. Waiting for reconnect.",
        "Połączenie z przeciwnikiem przywrócone.": "Opponent connection restored.",
        "Wysłano ustawienie statków. Czekam na gotowość przeciwnika.": "Ship placement sent. Waiting for opponent readiness.",
        "Obaj gracze gotowi. Rozpoczyna się gra...": "Both players are ready. Starting game...",
        "Akcja została anulowana.": "Action was canceled.",
        "Anulowano lokalną grę. Rozstaw ponownie lub kliknij Start PvA.": "Local game cancelled. Place ships again or click Start PvA.",
        "Błąd gry. Anulowano.": "Game error. Action canceled.",
        "Błąd gry.": "Game error.",
        "Przechodzisz do lokalnej rozgrywki.": "Switching to local game.",
        "Zakończono tryb online, wracasz do PvA.": "Online mode ended, returning to PvA.",
        "Twoja tura.": "Your turn.",
        "Czeka na ruch przeciwnika.": "Waiting for opponent move.",
    };
    if (exact[text])
        return exact[text];
    let result = text;
    result = result.replace(/^Ustaw następny statek \((\d) maszt\)\.$/, "Place next ship ($1 mast).");
    result = result.replace(/^Orientacja: ([HV]) \((button|PPM|scroll|R)\)\.$/, "Orientation: $1 ($2).");
    result = result.replace(/^Pudło: (.+)\. Tura bota\.$/, "Miss: $1. Bot turn.");
    result = result.replace(/^Trafiony: (.+)\. Oddajesz dalej\.$/, "Hit: $1. Shoot again.");
    result = result.replace(/^Bot pudłuje na (.+)\. Twoja tura\.$/, "Bot misses at $1. Your turn.");
    result = result.replace(/^Bot trafia na (.+)\. Bot kontynuuje\.$/, "Bot hits at $1. Bot continues.");
    result = result.replace(/^Gotowość: Ty (TAK|NIE), przeciwnik (TAK|NIE)$/, (_match, you, opponent) => `Ready: You ${readyWord(you)}, opponent ${readyWord(opponent)}`);
    result = result.replace(/^Czekanie na przeciwnika \((\d+)s\)\.$/, "Waiting for opponent ($1s).");
    result = result.replace(/^Czekanie na przeciwnika \(max (\d+)s, potem bot\)\.$/, "Waiting for opponent (max $1s, then bot).");
    result = result.replace(/^Przeciwnik rozłączył się\. Gra jest zawieszona na (\d+)s na próbę ponownego połączenia\.$/, "Opponent disconnected. The game is paused for $1s while waiting for reconnect.");
    result = result.replace(/^Przeciwnik rozłączył się\. Wygrana przyznana\.$/, "Opponent disconnected. Victory awarded.");
    result = result.replace(/^Znaleziono przeciwnika: (.+) \| Ustaw flota i kliknij Start PvA\.$/, "Opponent found: $1 | Place your fleet and click Start PvA.");
    result = result.replace(/^Znaleziono przeciwnika: (.+) \| Gotowe do gry z botem\.$/, "Opponent found: $1 | Ready to play against bot.");
    result = result.replace(/Znaleziono przeciwnika\./g, "Opponent found.");
    result = result.replace(/^Ustaw wszystkie statki\. Brakuje: (.+)$/, "Place all ships. Missing: $1");
    result = result.replace(/^Koniec gry: wygrałeś \((.+)\)! (.+)$/, "Game over: winner ($1)! $2");
    result = result.replace(/^Koniec gry: przegrałeś\. Wygrał (.+)\. (.+)$/, "Game over: you lost. Winner: $1. $2");
    result = result.replace(/^Koniec gry\. Wygrałeś! Twoje strzały: (\d+), strzały przeciwnika: (\d+), łącznie: (\d+) tur\.$/, "Game over. You won! Your shots: $1, opponent shots: $2, total turns: $3.");
    result = result.replace(/^Koniec gry\. Bot wygrał\. Twoje strzały: (\d+), strzały bota: (\d+), łącznie: (\d+) tur\.$/, "Game over. Bot won. Your shots: $1, bot shots: $2, total turns: $3.");
    result = result.replace(/^Koniec gry: wygrałeś! Twoje strzały: (\d+), strzały przeciwnika: (\d+), łącznie ruchów: (\d+)\.$/, "Game over: you won! Your shots: $1, opponent shots: $2, total moves: $3.");
    result = result.replace(/^Koniec gry: przegrałeś\. Twoje strzały: (\d+), strzały przeciwnika: (\d+), łącznie ruchów: (\d+)\.$/, "Game over: you lost. Your shots: $1, opponent shots: $2, total moves: $3.");
    result = result.replace(/Przeciwnik rozłączył się\./g, "Opponent disconnected.");
    result = result.replace(/Gra zakończona z powodu braku aktywności\./g, "Game ended due to inactivity.");
    result = result.replace(/Gra anulowana przez gracza\./g, "Game canceled by player.");
    result = result.replace(/Gra anulowana\./g, "Game canceled.");
    result = result.replace(/Koniec gry\./g, "Game over.");
    result = result.replace(/Gra zakończona\./g, "Game finished.");
    result = result.replace(/^(.+): pudło\.$/, "$1: miss.");
    result = result.replace(/^(.+): trafiony\.$/, "$1: hit.");
    result = result.replace(/^(.+): zatopiony!$/, "$1: sunk!");
    result = result.replace(/^(.+): już strzelano\.$/, "$1: already targeted.");
    return result;
};
const setStatus = (text) => {
    statusRaw = text;
    statusEl.textContent = translateStatus(text);
};
const getCurrentPlayerName = () => {
    const nick = nickInput.value.trim();
    if (nick.length > 0)
        return nick;
    return DEFAULT_NICK_BY_LANG[language];
};
const clearWinnerFxTimer = () => {
    if (winnerFxTimer) {
        clearTimeout(winnerFxTimer);
        winnerFxTimer = null;
    }
};
const buildConfetti = () => {
    const palette = ["#63d4ff", "#6be6a2", "#ffb86e", "#ff6d79", "#d2f1ff"];
    winnerFxConfettiEl.innerHTML = "";
    for (let i = 0; i < 52; i += 1) {
        const piece = document.createElement("span");
        piece.className = "winner-fx__confetti-piece";
        piece.style.left = `${Math.random() * 100}%`;
        piece.style.background = palette[Math.floor(Math.random() * palette.length)] ?? palette[0];
        piece.style.setProperty("--drift", `${Math.round((Math.random() - 0.5) * 200)}px`);
        piece.style.animationDelay = `${Math.random() * 0.5}s`;
        piece.style.animationDuration = `${2.5 + Math.random() * 1.6}s`;
        winnerFxConfettiEl.appendChild(piece);
    }
};
const showWinnerFx = (winnerName) => {
    clearWinnerFxTimer();
    winnerFxTitleEl.textContent = t("winnerTitle");
    winnerFxNameEl.textContent = winnerName;
    buildConfetti();
    winnerFxEl.classList.remove("active");
    // Reflow to restart CSS animations.
    void winnerFxEl.offsetHeight;
    winnerFxEl.classList.add("active");
    winnerFxTimer = setTimeout(() => {
        winnerFxEl.classList.remove("active");
        winnerFxConfettiEl.innerHTML = "";
    }, 5600);
};
const queueTimeoutText = (seconds) => language === "en" ? `Queue timeout in: ${seconds}s` : `Pozostało do timeoutu: ${seconds}s`;
const reconnectCountdownText = (seconds) => language === "en"
    ? `Opponent reconnect window: ${seconds}s`
    : `Ponowne połączenie przeciwnika za ${seconds}s`;
const isManualPlacementActive = () => {
    if (state.phase !== "setup")
        return false;
    if (state.placement !== "manual")
        return false;
    if (state.remainingShips.length === 0)
        return false;
    if (online && onlineReady)
        return false;
    return true;
};
const getPlacementPreview = () => {
    if (!isManualPlacementActive() || !hoverCoord)
        return null;
    const nextType = state.remainingShips[0];
    if (!nextType)
        return null;
    const previewShip = createShip("__preview__", nextType, hoverCoord, state.orientation);
    return {
        keys: new Set(previewShip.cells.map(coordKey)),
        valid: validatePlacement(state.yourBoard, previewShip),
    };
};
const setPlacementHoverCoord = (coord) => {
    if (!coord && !hoverCoord)
        return;
    if (coord && hoverCoord && coordEquals(coord, hoverCoord))
        return;
    hoverCoord = coord;
    render();
};
const isTypingContext = (element) => {
    if (!(element instanceof HTMLElement))
        return false;
    const tagName = element.tagName.toLowerCase();
    return tagName === "input" || tagName === "textarea" || element.isContentEditable;
};
const rotatePlacementOrientation = (source) => {
    if (!isManualPlacementActive())
        return false;
    state.orientation = state.orientation === "H" ? "V" : "H";
    setStatus(`Orientacja: ${state.orientation} (${source}).`);
    render();
    return true;
};
const getStoredReconnectToken = () => {
    try {
        return sessionStorage.getItem(RECONNECT_TOKEN_KEY);
    }
    catch {
        return null;
    }
};
const storeReconnectToken = (value) => {
    reconnectToken = value;
    try {
        if (value) {
            sessionStorage.setItem(RECONNECT_TOKEN_KEY, value);
        }
        else {
            sessionStorage.removeItem(RECONNECT_TOKEN_KEY);
        }
    }
    catch {
        // Storage can be unavailable in some contexts.
    }
};
reconnectToken = getStoredReconnectToken();
language = getStoredLanguage();
applyNicknameDefaultForLanguage(language);
const applyStaticTranslations = () => {
    titleEl.textContent = t("title");
    subtitleEl.textContent = t("subtitle");
    labelNicknameEl.textContent = t("labelNickname");
    labelShotEl.textContent = t("labelShot");
    labelLanguageEl.textContent = t("labelLanguage");
    labelShotsEl.textContent = t("labelShots");
    labelYouEl.textContent = t("labelYou");
    labelOpponentInlineEl.textContent = t("labelOpponentInline");
    labelTotalEl.textContent = t("labelTotal");
    labelEnemyNameEl.textContent = t("labelEnemyName");
    myBoardTitleEl.textContent = t("myBoard");
    enemyBoardTitleEl.textContent = t("enemyBoard");
    legendShipEl.textContent = t("legendShip");
    legendHitEl.textContent = t("legendHit");
    legendMissEl.textContent = t("legendMiss");
    legendSunkEl.textContent = t("legendSunk");
    placementHintEl.textContent = t("hintPlacement");
    btnRotate.textContent = t("btnRotate");
    btnAutoPlace.textContent = t("btnAuto");
    btnClearPlacement.textContent = t("btnClear");
    btnJoinQueue.textContent = t("btnJoinQueue");
    btnPlayAgainOnline.textContent = t("btnPlayAgainOnline");
    btnCancel.textContent = t("btnCancel");
    btnFire.textContent = t("btnFire");
    chatTitleEl.textContent = t("chatTitle");
    chatPanelEl.setAttribute("aria-label", t("chatTitle"));
    chatInputEl.placeholder = t("chatPlaceholder");
    chatSendBtnEl.textContent = t("chatSend");
    chatGifToggleEl.textContent = t("chatGifs");
    chatEmojiButtons.forEach((button) => {
        button.title = `${t("chatEmoji")} ${button.dataset.chatEmoji ?? ""}`.trim();
        button.setAttribute("aria-label", button.title);
    });
    chatGifButtons.forEach((button) => {
        const gifId = button.dataset.chatGif;
        if (!gifId || !(gifId in CHAT_GIF_LABELS))
            return;
        button.title = CHAT_GIF_LABELS[gifId][language];
        button.setAttribute("aria-label", button.title);
        const label = button.querySelector(".chat-gif__label");
        if (label) {
            label.textContent = CHAT_GIF_LABELS[gifId][language];
        }
    });
    langPlBtn.classList.toggle("active", language === "pl");
    langEnBtn.classList.toggle("active", language === "en");
};
const isCurrentRoomEvent = (payload) => {
    if (!payload?.roomId)
        return true;
    return payload.roomId === roomId;
};
const toRenderBoard = (board) => {
    const shots = new Set(board.shots);
    const hits = new Set(board.hits ?? []);
    if (hits.size === 0) {
        for (const ship of board.ships) {
            for (const cell of ship.cells) {
                const key = coordKey(cell);
                if (shots.has(key))
                    hits.add(key);
            }
        }
    }
    const shipByCoord = new Map();
    for (const ship of board.ships) {
        const state = { id: ship.id, sunk: ship.sunk };
        for (const cell of ship.cells) {
            shipByCoord.set(coordKey(cell), state);
        }
    }
    return { width: board.width, height: board.height, shots, hits, shipByCoord };
};
const resetToLocalMode = (message) => {
    inQueue = false;
    online = false;
    autoReconnectQueued = false;
    onlineReady = false;
    onlineOpponentReady = false;
    onlineVsBot = false;
    yourTurnOnline = false;
    roomId = null;
    clearReconnectCountdown();
    storeReconnectToken(null);
    opponentName = "AI";
    awaitingShot = false;
    stopQueueTimer();
    resetChatState();
    clearWinnerFxTimer();
    winnerFxEl.classList.remove("active");
    winnerFxConfettiEl.innerHTML = "";
    resetShotInputState(true);
    state = {
        ...state,
        phase: "setup",
        placement: "manual",
        remainingShips: [...STANDARD_FLEET],
        orientation: "H",
        yourBoard: createEmptyBoard(),
        enemyBoard: createEmptyBoard(),
        turn: "you",
        yourTurn: true,
        shots: 0,
        opponentShots: 0,
        aiState: createAiState(),
        enemyShipHits: {},
        ownShipHits: {},
        enemySunkCells: new Set(),
        yourSunkCells: new Set(),
    };
    setStatus(message);
    render();
};
const isChatEnabled = () => online &&
    !inQueue &&
    !onlineVsBot &&
    Boolean(roomId) &&
    (state.phase === "setup" || state.phase === "playing" || state.phase === "over");
const resetChatState = () => {
    chatState = {
        enabled: false,
        messages: [],
        unread: 0,
    };
    chatGifOpen = false;
};
const chatMessageAuthor = (message) => {
    if (message.kind === "system")
        return t("chatSystem");
    if (message.senderId === yourId)
        return t("chatYou");
    if (message.senderName && message.senderName.trim().length > 0)
        return message.senderName;
    return t("chatOpponent");
};
const chatMessageBody = (message) => {
    if (message.kind === "text")
        return message.text ?? "";
    if (message.kind === "emoji")
        return message.emoji ?? "";
    if (message.kind === "gif") {
        const gifId = message.gifId;
        if (gifId && CHAT_GIF_LABELS[gifId])
            return CHAT_GIF_LABELS[gifId][language];
        return "GIF";
    }
    return message.text ?? "";
};
const chatGifSrc = (gifId) => `/assets/chat-gifs/${gifId}.gif`;
const renderChat = () => {
    chatState.enabled = isChatEnabled();
    chatPanelEl.classList.toggle("chat-panel--disabled", !chatState.enabled);
    chatInputEl.disabled = !chatState.enabled;
    chatSendBtnEl.disabled = !chatState.enabled;
    chatGifToggleEl.disabled = !chatState.enabled;
    chatGifBarEl.hidden = !chatState.enabled || !chatGifOpen;
    chatHintEl.textContent = chatState.enabled ? t("chatHintEnabled") : t("chatHintDisabled");
    chatUnreadEl.textContent = chatState.unread > 0 ? t("chatUnread", { count: chatState.unread }) : "";
    chatListEl.innerHTML = "";
    for (const message of chatState.messages) {
        const item = document.createElement("div");
        item.className = "chat-message";
        if (message.kind === "system")
            item.classList.add("chat-message--system");
        else
            item.classList.add(message.senderId === yourId ? "chat-message--you" : "chat-message--opponent");
        const head = document.createElement("div");
        head.className = "chat-message__head";
        const author = document.createElement("span");
        author.className = "chat-message__author";
        author.textContent = chatMessageAuthor(message);
        const time = document.createElement("time");
        time.className = "chat-message__time";
        time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        head.append(author, time);
        const body = document.createElement("div");
        body.className = "chat-message__body";
        if (message.kind === "gif" && message.gifId) {
            const img = document.createElement("img");
            img.className = "chat-message__gif";
            img.src = chatGifSrc(message.gifId);
            img.alt = chatMessageBody(message);
            const caption = document.createElement("div");
            caption.className = "chat-message__gif-label";
            caption.textContent = chatMessageBody(message);
            body.appendChild(img);
            body.appendChild(caption);
        }
        else {
            body.textContent = chatMessageBody(message);
        }
        item.append(head, body);
        chatListEl.appendChild(item);
    }
    chatListEl.scrollTop = chatListEl.scrollHeight;
};
const replaceChatHistory = (messages) => {
    chatState.messages = messages.slice(-80);
    chatState.unread = 0;
};
const appendChatMessage = (message) => {
    chatState.messages.push(message);
    if (chatState.messages.length > 80) {
        chatState.messages = chatState.messages.slice(-80);
    }
    if (document.hidden && message.senderId !== yourId) {
        chatState.unread += 1;
    }
};
const emitChatSend = (payload) => {
    if (!socket || !chatState.enabled || !roomId)
        return;
    const outgoing = { ...payload, roomId };
    socket.emit("chat:send", outgoing);
};
const drawBoard = (container, board, revealShips, onCell, onHover = null, preview = null, sunkCells = null) => {
    const render = toRenderBoard(board);
    container.innerHTML = "";
    const header = document.createElement("div");
    header.className = "grid-row";
    const empty = document.createElement("div");
    empty.className = "coord-label";
    header.appendChild(empty);
    for (let col = 0; col < render.width; col += 1) {
        const colLabel = document.createElement("div");
        colLabel.className = "coord-label";
        colLabel.textContent = labels[col];
        header.appendChild(colLabel);
    }
    container.appendChild(header);
    for (let row = 0; row < render.height; row += 1) {
        const rowEl = document.createElement("div");
        rowEl.className = "grid-row";
        const rowLabel = document.createElement("div");
        rowLabel.className = "coord-label";
        rowLabel.textContent = String(row + 1);
        rowEl.appendChild(rowLabel);
        for (let col = 0; col < render.width; col += 1) {
            const coord = { row, col };
            const key = coordKey(coord);
            const shipState = render.shipByCoord.get(key);
            const isShot = render.shots.has(key);
            const isHit = render.hits.has(key);
            const isSunkCell = (isHit && Boolean(shipState?.sunk)) || Boolean(sunkCells?.has(key));
            let cellState = "empty";
            if (isShot) {
                if (isHit && isSunkCell) {
                    cellState = "sunk";
                }
                else if (isHit) {
                    cellState = "hit";
                }
                else {
                    cellState = "miss";
                }
            }
            else if (revealShips && shipState) {
                cellState = "ship";
            }
            if (preview &&
                preview.keys.has(key) &&
                cellState !== "hit" &&
                cellState !== "miss" &&
                cellState !== "sunk") {
                cellState = preview.valid ? "preview-valid" : "preview-invalid";
            }
            const cell = document.createElement("button");
            cell.type = "button";
            cell.className = "cell";
            cell.classList.add(`cell--${cellState}`);
            if (onCell || onHover) {
                cell.classList.add("cell--interactive");
            }
            cell.dataset.row = String(row);
            cell.dataset.col = String(col);
            cell.setAttribute("aria-label", cellDescription(coord, cellState));
            cell.textContent = cellIcon(cellState, useFallbackIcons);
            if (onCell) {
                cell.addEventListener("click", () => onCell(coord));
            }
            if (onHover) {
                cell.addEventListener("mouseenter", () => onHover(coord));
            }
            rowEl.appendChild(cell);
        }
        container.appendChild(rowEl);
    }
};
const canShootEnemy = () => state.phase === "playing" && !awaitingShot && (online ? yourTurnOnline : state.turn === "you" && state.yourTurn);
const updateRemaining = () => {
    remainingEl.textContent =
        state.placement === "manual"
            ? t("remaining", { ships: state.remainingShips.join(", ") })
            : t("randomMode");
};
const updateReadinessBadge = () => {
    if (!online) {
        readinessBadgeEl.textContent = t("localModeBadge");
        readinessBadgeEl.classList.remove("readiness-ready");
        readinessBadgeEl.classList.add("readiness-wait");
        return;
    }
    if (state.phase === "setup") {
        const allReady = onlineReady && onlineOpponentReady;
        readinessBadgeEl.textContent = t("readiness", {
            you: onlineReady ? t("readyYes") : t("readyNo"),
            opponent: onlineOpponentReady ? t("readyYes") : t("readyNo"),
        });
        readinessBadgeEl.classList.toggle("readiness-ready", allReady);
        readinessBadgeEl.classList.toggle("readiness-wait", !allReady);
        return;
    }
    readinessBadgeEl.textContent = state.phase === "playing" ? t("gameActiveBadge") : t("gameOverBadge");
    readinessBadgeEl.classList.remove("readiness-ready", "readiness-wait");
};
const updateControls = () => {
    if (!online) {
        btnStartLocal.textContent = state.phase === "over" ? t("btnNewPva") : t("btnStartPva");
        btnPlayAgainOnline.textContent = t("btnPlayAgainOnline");
        btnPlayAgainOnline.disabled = state.phase !== "over" || !socket;
        btnJoinQueue.disabled = false;
        btnStartLocal.disabled = false;
        btnAutoPlace.disabled = false;
        btnClearPlacement.disabled = false;
        btnRotate.disabled = !isManualPlacementActive();
        btnFire.disabled = !canShootEnemy();
        shotInput.disabled = !canShootEnemy();
        return;
    }
    if (state.phase === "setup") {
        if (onlineReady) {
            btnStartLocal.textContent = t("btnReadyWaiting");
            btnStartLocal.disabled = true;
            btnAutoPlace.disabled = true;
            btnClearPlacement.disabled = true;
            btnRotate.disabled = !isManualPlacementActive();
            btnPlayAgainOnline.disabled = true;
            btnJoinQueue.disabled = true;
            btnFire.disabled = !canShootEnemy();
            shotInput.disabled = !canShootEnemy();
        }
        else {
            btnStartLocal.textContent = t("btnReadySubmit");
            btnStartLocal.disabled = false;
            btnAutoPlace.disabled = false;
            btnClearPlacement.disabled = false;
            btnRotate.disabled = !isManualPlacementActive();
            btnPlayAgainOnline.disabled = true;
            btnJoinQueue.disabled = inQueue;
            btnFire.disabled = !canShootEnemy();
            shotInput.disabled = !canShootEnemy();
        }
    }
    else if (state.phase === "playing") {
        btnStartLocal.disabled = true;
        btnJoinQueue.disabled = true;
        btnAutoPlace.disabled = true;
        btnClearPlacement.disabled = true;
        btnRotate.disabled = !isManualPlacementActive();
        btnPlayAgainOnline.disabled = true;
        btnFire.disabled = !canShootEnemy();
        shotInput.disabled = !canShootEnemy();
    }
    else {
        btnPlayAgainOnline.textContent = t("btnPlayAgainOnline");
        btnStartLocal.textContent = t("btnNewPva");
        btnStartLocal.disabled = false;
        btnPlayAgainOnline.disabled = !socket;
        btnJoinQueue.disabled = false;
        btnAutoPlace.disabled = false;
        btnClearPlacement.disabled = false;
        btnRotate.disabled = !isManualPlacementActive();
        btnFire.disabled = !canShootEnemy();
        shotInput.disabled = !canShootEnemy();
    }
};
const render = () => {
    applyStaticTranslations();
    const manualPlacementActive = isManualPlacementActive();
    if (!manualPlacementActive) {
        hoverCoord = null;
    }
    const preview = getPlacementPreview();
    drawBoard(boardOwnEl, state.yourBoard, true, online
        ? state.phase === "setup" && !onlineReady
            ? onManualPlace
            : null
        : state.phase === "setup" && state.placement === "manual"
            ? onManualPlace
            : null, manualPlacementActive ? setPlacementHoverCoord : null, preview, state.yourSunkCells);
    drawBoard(boardEnemyEl, state.enemyBoard, false, canShootEnemy() ? onFireAtEnemy : null, null, null, state.enemySunkCells);
    modeEl.textContent = online ? "Online" : "PvA";
    orientationBadgeEl.textContent = t("orientation", { orientation: state.orientation });
    orientationBadgeEl.classList.toggle("orientation-active", manualPlacementActive);
    updateReadinessBadge();
    if (online) {
        shotsYourEl.textContent = String(state.shots);
        shotsOpponentEl.textContent = String(state.opponentShots);
        shotsTotalEl.textContent = String(state.shots + state.opponentShots);
    }
    else {
        const opponentShots = state.opponentShots;
        const yourShots = state.shots;
        const totalShots = yourShots + opponentShots;
        shotsYourEl.textContent = String(yourShots);
        shotsOpponentEl.textContent = String(opponentShots);
        shotsTotalEl.textContent = String(totalShots);
    }
    opponentNameEl.textContent = online ? opponentName : "AI";
    updateRemaining();
    updateControls();
    renderChat();
    const nowCanShoot = canShootEnemy();
    if (nowCanShoot && !previousCanShoot) {
        shotInput.focus();
        shotInput.select();
    }
    previousCanShoot = nowCanShoot;
};
const resetOnlineQueueSetupState = () => {
    resetChatState();
    state = {
        ...state,
        phase: "setup",
        placement: "manual",
        remainingShips: [...STANDARD_FLEET],
        orientation: "H",
        yourBoard: createEmptyBoard(),
        enemyBoard: createEmptyBoard(),
        turn: "you",
        yourTurn: true,
        shots: 0,
        opponentShots: 0,
        aiState: createAiState(),
        enemyShipHits: {},
        ownShipHits: {},
        enemySunkCells: new Set(),
        yourSunkCells: new Set(),
    };
};
const resetLocalSetup = () => {
    state = {
        ...state,
        phase: "setup",
        placement: "manual",
        remainingShips: [...STANDARD_FLEET],
        orientation: "H",
        yourBoard: createEmptyBoard(),
        enemyBoard: placeFleetRandomly(createEmptyBoard()),
        turn: "you",
        yourTurn: true,
        shots: 0,
        opponentShots: 0,
        aiState: createAiState(),
        enemyShipHits: {},
        ownShipHits: {},
        enemySunkCells: new Set(),
        yourSunkCells: new Set(),
    };
    setStatus("Ręczne ustawienie statków. Klikaj pola na swojej planszy.");
    resetShotInputState(true);
    render();
};
const applyRandomPlacement = () => {
    state.placement = "random";
    state.yourBoard = placeFleetRandomly(createEmptyBoard());
    state.remainingShips = [];
    setStatus("Losowe rozmieszczenie gotowe.");
    resetShotInputState(true);
    render();
};
const asServerBoard = (board) => ({
    width: board.width,
    height: board.height,
    ships: board.ships,
    shots: [...board.shots],
    hits: [...(board.hits ?? [])],
});
const onManualPlace = (coord) => {
    if (state.phase !== "setup" || state.placement !== "manual" || state.remainingShips.length === 0) {
        return;
    }
    const type = state.remainingShips[0];
    const ship = createShip(`manual-${Date.now()}`, type, coord, state.orientation);
    if (!validatePlacement(state.yourBoard, ship)) {
        setStatus("Błędne ustawienie tego statku.");
        render();
        return;
    }
    state.yourBoard = {
        ...state.yourBoard,
        ships: [...state.yourBoard.ships, ship],
    };
    state.remainingShips = [...state.remainingShips.slice(1)];
    if (state.remainingShips.length === 0) {
        setStatus("Gotowe. Kliknij Start PvA.");
    }
    else {
        setStatus(`Ustaw następny statek (${state.remainingShips[0]} maszt).`);
    }
    render();
};
const startLocalGame = () => {
    clearWinnerFxTimer();
    winnerFxEl.classList.remove("active");
    winnerFxConfettiEl.innerHTML = "";
    if (state.phase === "over") {
        state = {
            ...state,
            phase: "playing",
            placement: "random",
            remainingShips: [],
            orientation: "H",
            yourBoard: placeFleetRandomly(createEmptyBoard()),
            enemyBoard: createEmptyBoard(),
            turn: "you",
            yourTurn: true,
            shots: 0,
            opponentShots: 0,
            aiState: createAiState(),
            enemyShipHits: {},
            ownShipHits: {},
            enemySunkCells: new Set(),
            yourSunkCells: new Set(),
        };
        setStatus("Nowa gra lokalna rozpoczęta. Twoja tura.");
        resetShotInputState(true);
        render();
        return;
    }
    if (state.placement === "manual" && state.remainingShips.length > 0) {
        state.yourBoard = placeFleetRandomly(createEmptyBoard());
    }
    state.phase = "playing";
    state.turn = "you";
    state.yourTurn = true;
    state.shots = 0;
    state.opponentShots = 0;
    state.enemyBoard = placeFleetRandomly(createEmptyBoard());
    state.aiState = createAiState();
    state.enemyShipHits = {};
    state.ownShipHits = {};
    state.enemySunkCells = new Set();
    state.yourSunkCells = new Set();
    setStatus("Gra lokalna rozpoczęta. Twoja tura.");
    resetShotInputState(true);
    render();
};
const finishLocalGame = (winner) => {
    const opponentShots = state.opponentShots;
    const yourShots = state.shots;
    const totalShots = state.shots + opponentShots;
    state.phase = "over";
    previousCanShoot = false;
    state.yourTurn = false;
    if (winner === "you") {
        showWinnerFx(getCurrentPlayerName());
        setStatus(`Koniec gry. Wygrałeś! Twoje strzały: ${yourShots}, strzały przeciwnika: ${opponentShots}, łącznie: ${totalShots} tur.`);
    }
    else {
        showWinnerFx("Bot");
        setStatus(`Koniec gry. Bot wygrał. Twoje strzały: ${yourShots}, strzały bota: ${opponentShots}, łącznie: ${totalShots} tur.`);
    }
    render();
};
const handleAiTurn = () => {
    if (state.phase !== "playing" || state.turn !== "bot")
        return;
    const shot = nextShot(state.yourBoard, state.aiState);
    if (shot.row < 0 || shot.col < 0) {
        finishLocalGame("you");
        return;
    }
    const result = fireShot(state.yourBoard, shot);
    if (result.outcome === "miss" || result.outcome === "hit" || result.outcome === "sink") {
        addShotPoint(state, false);
    }
    registerAiShot(state.yourBoard, state.aiState, shot, result.outcome);
    if (result.outcome === "miss") {
        state.turn = "you";
        state.yourTurn = true;
        setStatus(`Bot pudłuje na ${coordLabel(shot)}. Twoja tura.`);
        render();
        return;
    }
    if (result.outcome === "hit" || result.outcome === "sink") {
        if (result.shipId) {
            const hits = recordShipHit(state.ownShipHits, result.shipId, shot);
            if (result.outcome === "sink") {
                markAroundSunkShip(state.yourBoard, hits);
                markSunkCells(state.yourSunkCells, hits);
            }
        }
        if (isFleetSunk(state.yourBoard)) {
            finishLocalGame("bot");
            return;
        }
        setStatus(`Bot trafia na ${coordLabel(shot)}. Bot kontynuuje.`);
        render();
        setTimeout(handleAiTurn, 350);
        return;
    }
    if (result.outcome === "invalid" || result.outcome === "already_shot") {
        setTimeout(handleAiTurn, 1);
    }
};
const onFireAtEnemy = (coord) => {
    if (!canShootEnemy())
        return false;
    const shotKey = coordKey(coord);
    if (state.enemyBoard.shots.has(shotKey)) {
        setStatus("To pole jest już strzelane.");
        return false;
    }
    if (online) {
        if (!roomId) {
            setStatus("Brak aktywnego pokoju. Poczekaj na połączenie.");
            return false;
        }
        if (!yourTurnOnline) {
            setStatus("Nie Twoja tura.");
            return false;
        }
        awaitingShot = true;
        socket?.emit("game:shot", { roomId, coord });
        return true;
    }
    const result = fireShot(state.enemyBoard, coord);
    if (result.outcome === "already_shot" || result.outcome === "invalid") {
        setStatus("To pole jest już zajęte.");
        return false;
    }
    if (result.outcome === "miss" || result.outcome === "hit" || result.outcome === "sink") {
        addShotPoint(state, true);
    }
    if (result.shipId) {
        const hits = recordShipHit(state.enemyShipHits, result.shipId, coord);
        if (result.outcome === "sink") {
            markAroundSunkShip(state.enemyBoard, hits);
            markSunkCells(state.enemySunkCells, hits);
        }
    }
    if (result.outcome === "miss") {
        state.turn = "bot";
        state.yourTurn = false;
        setStatus(`Pudło: ${coordLabel(coord)}. Tura bota.`);
        render();
        setTimeout(handleAiTurn, 400);
        return true;
    }
    if (result.outcome === "hit" || result.outcome === "sink") {
        if (isFleetSunk(state.enemyBoard) || result.gameOver) {
            finishLocalGame("you");
            return true;
        }
        setStatus(`Trafiony: ${coordLabel(coord)}. Oddajesz dalej.`);
        render();
        return true;
    }
    return false;
};
const fireFromInput = () => {
    if (!canShootEnemy()) {
        if (!online) {
            setStatus(state.phase === "playing" ? "Poczekaj na swoją kolej." : "Gra nie jest aktywna.");
        }
        else if (awaitingShot) {
            setStatus("Czekaj na odpowiedź serwera.");
        }
        else {
            setStatus("Nie Twoja tura.");
        }
        return;
    }
    const coord = parseBoardCoordInput(shotInput.value);
    if (!coord) {
        setStatus("Błędny format. Użyj A1..J10.");
        return;
    }
    const accepted = onFireAtEnemy(coord);
    if (accepted) {
        shotInput.value = "";
    }
};
const stopQueueTimer = () => {
    if (queueTicker) {
        clearInterval(queueTicker);
        queueTicker = null;
    }
    if (queueTimerEl) {
        queueTimerEl.textContent = "";
        queueTimerEl.classList.remove("urgent");
    }
};
const stopReconnectTimer = () => {
    if (reconnectTicker) {
        clearInterval(reconnectTicker);
        reconnectTicker = null;
    }
    if (queueTimerEl) {
        queueTimerEl.textContent = "";
        queueTimerEl.classList.remove("urgent");
    }
};
const startReconnectTimer = (remainingMs) => {
    stopQueueTimer();
    stopReconnectTimer();
    reconnectDeadline = Date.now() + Math.max(0, remainingMs);
    if (!queueTimerEl)
        return;
    reconnectTicker = setInterval(() => {
        const remainingSeconds = Math.max(0, Math.ceil((reconnectDeadline - Date.now()) / 1000));
        if (remainingSeconds <= 0) {
            stopReconnectTimer();
            return;
        }
        queueTimerEl.textContent = reconnectCountdownText(remainingSeconds);
        if (remainingSeconds <= 10) {
            queueTimerEl.classList.add("urgent");
        }
        else {
            queueTimerEl.classList.remove("urgent");
        }
    }, 1000);
    const firstTick = Math.max(0, Math.ceil((reconnectDeadline - Date.now()) / 1000));
    queueTimerEl.textContent = reconnectCountdownText(firstTick);
    if (firstTick <= 10)
        queueTimerEl.classList.add("urgent");
};
const clearReconnectCountdown = () => {
    stopReconnectTimer();
};
const startQueueTimer = (payload) => {
    stopQueueTimer();
    clearReconnectCountdown();
    queueDeadline = payload.joinedAt + payload.timeoutMs;
    queueTicker = setInterval(() => {
        const remainingSeconds = Math.max(0, Math.ceil((queueDeadline - Date.now()) / 1000));
        if (remainingSeconds <= 0) {
            if (queueTimerEl) {
                queueTimerEl.textContent = "";
                queueTimerEl.classList.remove("urgent");
            }
            stopQueueTimer();
            return;
        }
        if (!inQueue || state.phase !== "setup" || !online) {
            return;
        }
        if (queueTimerEl) {
            queueTimerEl.textContent = queueTimeoutText(remainingSeconds);
            if (remainingSeconds <= 10) {
                queueTimerEl.classList.add("urgent");
            }
            else {
                queueTimerEl.classList.remove("urgent");
            }
        }
        setStatus(`Czekanie na przeciwnika (${remainingSeconds}s).`);
    }, 1000);
};
const applyOnlineState = (payload) => {
    stopQueueTimer();
    online = true;
    onlineVsBot = payload.vsBot;
    roomId = payload.roomId;
    yourId = payload.yourId;
    yourTurnOnline = payload.yourTurn;
    onlineReady = payload.youReady ?? false;
    onlineOpponentReady = payload.opponentReady ?? false;
    opponentName = payload.opponentName ?? DEFAULT_OPPONENT_NAME[language];
    const wasSetup = state.phase === "setup";
    state.phase = payload.phase ?? (payload.gameOver ? "over" : "playing");
    state.shots = payload.yourShots;
    state.opponentShots = payload.opponentShots;
    if (!wasSetup || state.phase !== "setup") {
        state.yourBoard = {
            width: payload.yourBoard.width,
            height: payload.yourBoard.height,
            ships: payload.yourBoard.ships,
            shots: new Set(payload.yourBoard.shots),
            hits: new Set(payload.yourBoard.hits ?? []),
        };
    }
    state.enemyBoard = {
        width: payload.opponentBoard.width,
        height: payload.opponentBoard.height,
        ships: payload.opponentBoard.ships,
        shots: new Set(payload.opponentBoard.shots),
        hits: new Set(payload.opponentBoard.hits ?? []),
    };
    state.yourSunkCells = new Set(payload.yourBoard.sunkCells ?? []);
    state.enemySunkCells = new Set(payload.opponentBoard.sunkCells ?? []);
    if (state.yourBoard.ships.length > 0) {
        syncSunkCellsFromBoard(state.yourBoard, state.yourSunkCells);
    }
    markAroundKnownSunkCells(state.yourBoard, state.yourSunkCells);
    markAroundKnownSunkCells(state.enemyBoard, state.enemySunkCells);
    state.yourTurn = payload.yourTurn;
    if (payload.gameOver || state.phase === "over") {
        const totalShots = payload.yourShots + payload.opponentShots;
        if (payload.winner === yourId) {
            setStatus(`Koniec gry: wygrałeś! Twoje strzały: ${payload.yourShots}, strzały przeciwnika: ${payload.opponentShots}, łącznie ruchów: ${totalShots}.`);
        }
        else {
            setStatus(`Koniec gry: przegrałeś. Twoje strzały: ${payload.yourShots}, strzały przeciwnika: ${payload.opponentShots}, łącznie ruchów: ${totalShots}.`);
        }
    }
    else {
        if (state.phase === "setup") {
            const myReady = payload.youReady ?? false;
            const opponentReady = payload.opponentReady ?? false;
            if (myReady && opponentReady) {
                setStatus("Obaj gracze gotowi. Rozpoczyna się gra...");
            }
            else {
                setStatus(`Gotowość: Ty ${myReady ? "TAK" : "NIE"}, przeciwnik ${opponentReady ? "TAK" : "NIE"}`);
            }
        }
        else {
            setStatus(yourTurnOnline ? "Twoja tura." : "Czeka na ruch przeciwnika.");
        }
    }
    render();
};
const joinQueue = () => {
    clearWinnerFxTimer();
    winnerFxEl.classList.remove("active");
    winnerFxConfettiEl.innerHTML = "";
    if (!socket) {
        setStatus("Brak socket.io. Uruchom serwer i odśwież stronę.");
        return;
    }
    if ((online || inQueue) && state.phase !== "over") {
        setStatus(inQueue ? "Już czekasz na przeciwnika." : "Już jesteś online. Odśwież, aby zrestartować.");
        return;
    }
    autoReconnectQueued = true;
    awaitingShot = false;
    clearReconnectCountdown();
    stopQueueTimer();
    resetShotInputState(true);
    const nickname = nickInput.value.trim() || DEFAULT_NICK_BY_LANG[language];
    resetOnlineQueueSetupState();
    roomId = null;
    yourTurnOnline = false;
    opponentName = DEFAULT_OPPONENT_NAME[language];
    online = true;
    inQueue = true;
    const payload = {
        nickname,
    };
    if (reconnectToken) {
        payload.reconnectToken = reconnectToken;
    }
    socket.emit("search:join", payload);
    onlineReady = false;
    onlineOpponentReady = false;
    onlineVsBot = false;
    setStatus("Dołączono do kolejki...");
    render();
};
const cancelOnline = () => {
    if (!socket)
        return;
    if (state.phase === "over") {
        isCancelling = false;
        awaitingShot = false;
        autoReconnectQueued = false;
        resetToLocalMode("Zakończono tryb online, wracasz do PvA.");
        return;
    }
    isCancelling = true;
    awaitingShot = false;
    if (inQueue) {
        autoReconnectQueued = false;
        stopQueueTimer();
        inQueue = false;
        roomId = null;
        onlineOpponentReady = false;
        setStatus("Anulowanie oczekiwania...");
        socket.emit("search:cancel");
        return;
    }
    autoReconnectQueued = false;
    socket.emit("game:cancel");
    setStatus("Anulowanie gry...");
};
const startOnlineAgain = () => {
    if (!socket) {
        setStatus("Brak połączenia z serwerem.");
        return;
    }
    if (state.phase !== "over") {
        setStatus("Możesz rozpocząć nowy mecz online po zakończeniu aktualnej gry.");
        return;
    }
    autoReconnectQueued = false;
    joinQueue();
};
btnRotate.addEventListener("click", () => {
    rotatePlacementOrientation("button");
});
btnAutoPlace.addEventListener("click", () => {
    applyRandomPlacement();
    render();
});
btnClearPlacement.addEventListener("click", () => {
    resetLocalSetup();
});
btnJoinQueue.addEventListener("click", () => {
    joinQueue();
});
btnPlayAgainOnline.addEventListener("click", startOnlineAgain);
btnCancel.addEventListener("click", () => {
    if (online)
        cancelOnline();
    else {
        resetLocalSetup();
        setStatus("Anulowano lokalną grę. Rozstaw ponownie lub kliknij Start PvA.");
    }
});
btnStartLocal.addEventListener("click", () => {
    if (online) {
        if (state.phase === "over") {
            resetToLocalMode("Przechodzisz do lokalnej rozgrywki.");
            startLocalGame();
            return;
        }
        submitPlacementOnline();
        return;
    }
    startLocalGame();
});
btnFire.addEventListener("click", fireFromInput);
shotInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter")
        return;
    event.preventDefault();
    fireFromInput();
});
chatSendBtnEl.addEventListener("click", () => {
    const text = chatInputEl.value.trim();
    if (!text)
        return;
    emitChatSend({ kind: "text", text });
    chatInputEl.value = "";
});
chatInputEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter")
        return;
    event.preventDefault();
    const text = chatInputEl.value.trim();
    if (!text)
        return;
    emitChatSend({ kind: "text", text });
    chatInputEl.value = "";
});
chatGifToggleEl.addEventListener("click", () => {
    chatGifOpen = !chatGifOpen;
    render();
});
chatEmojiButtons.forEach((button) => {
    button.addEventListener("click", () => {
        const emoji = button.dataset.chatEmoji;
        if (!emoji || !CHAT_EMOJI.includes(emoji))
            return;
        emitChatSend({ kind: "emoji", emoji });
    });
});
chatGifButtons.forEach((button) => {
    button.addEventListener("click", () => {
        const gifId = button.dataset.chatGif;
        if (!gifId || !CHAT_GIF_IDS.includes(gifId))
            return;
        emitChatSend({ kind: "gif", gifId });
    });
});
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        chatState.unread = 0;
        render();
    }
});
boardOwnEl.addEventListener("mouseleave", () => {
    setPlacementHoverCoord(null);
});
boardOwnEl.addEventListener("contextmenu", (event) => {
    if (!isManualPlacementActive())
        return;
    const target = event.target;
    if (!(target instanceof Element))
        return;
    if (!target.closest("button.cell"))
        return;
    event.preventDefault();
    rotatePlacementOrientation("PPM");
});
boardOwnEl.addEventListener("wheel", (event) => {
    if (!isManualPlacementActive())
        return;
    const target = event.target;
    if (!(target instanceof Element))
        return;
    if (!target.closest("button.cell"))
        return;
    event.preventDefault();
    rotatePlacementOrientation("scroll");
}, { passive: false });
document.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "r")
        return;
    if (isTypingContext(document.activeElement))
        return;
    if (!isManualPlacementActive())
        return;
    event.preventDefault();
    rotatePlacementOrientation("R");
});
const switchLanguage = (nextLanguage) => {
    if (nextLanguage === language)
        return;
    const previousLanguage = language;
    const shouldSwitchOpponentDefault = opponentName === DEFAULT_OPPONENT_NAME.pl ||
        opponentName === DEFAULT_OPPONENT_NAME.en;
    language = nextLanguage;
    storeLanguage(language);
    applyNicknameDefaultForLanguage(language, previousLanguage);
    if (shouldSwitchOpponentDefault) {
        opponentName = DEFAULT_OPPONENT_NAME[language];
    }
    setStatus(statusRaw);
    render();
};
langPlBtn.addEventListener("click", () => switchLanguage("pl"));
langEnBtn.addEventListener("click", () => switchLanguage("en"));
if (socket) {
    socket.on("queue:queued", (payload) => {
        awaitingShot = false;
        inQueue = true;
        online = true;
        roomId = null;
        yourTurnOnline = false;
        onlineReady = false;
        onlineOpponentReady = false;
        resetOnlineQueueSetupState();
        let introMessage = "";
        if (payload?.reconnectToken) {
            storeReconnectToken(payload.reconnectToken);
            autoReconnectQueued = true;
        }
        if (payload?.recovered) {
            introMessage = payload?.message
                ? payload.message
                : language === "en"
                    ? "Queue session restored."
                    : "Odzyskano połączenie z kolejką.";
        }
        else if (payload?.message) {
            introMessage = payload.message;
        }
        else if (payload?.reconnectToken) {
            introMessage =
                language === "en"
                    ? "No active game to resume, waiting for a new opponent."
                    : "Brak aktywnej gry do wznowienia, czeka na nowego przeciwnika.";
        }
        if (payload) {
            startQueueTimer(payload);
            queueTimeoutMs = payload.timeoutMs;
            if (queueTimerEl) {
                queueTimerEl.classList.remove("urgent");
                queueTimerEl.textContent = queueTimeoutText(Math.ceil(payload.timeoutMs / 1000));
            }
        }
        const waiting = language === "en"
            ? `Waiting for opponent (max ${Math.ceil(queueTimeoutMs / 1000)}s, then bot).`
            : `Czekanie na przeciwnika (max ${Math.ceil(queueTimeoutMs / 1000)}s, potem bot).`;
        setStatus(introMessage ? `${introMessage} ${waiting}` : waiting);
        render();
    });
    socket.on("game:cancelled", (payload) => {
        if (!isCurrentRoomEvent(payload)) {
            return;
        }
        isCancelling = false;
        resetToLocalMode(payload?.message ?? "Akcja została anulowana.");
    });
    socket.on("queue:matched", (payload) => {
        awaitingShot = false;
        inQueue = false;
        autoReconnectQueued = true;
        clearReconnectCountdown();
        stopQueueTimer();
        roomId = payload.roomId;
        onlineVsBot = payload.vsBot;
        if (payload.reconnectToken) {
            storeReconnectToken(payload.reconnectToken);
        }
        opponentName = payload.opponent ?? DEFAULT_OPPONENT_NAME[language];
        onlineReady = false;
        onlineOpponentReady = payload.opponentReady ?? false;
        if (payload.vsBot) {
            state.placement = "random";
            state.remainingShips = [];
            state.yourBoard = placeFleetRandomly(createEmptyBoard());
            state.enemyBoard = createEmptyBoard();
            setStatus(`${payload?.message || `Znaleziono przeciwnika: ${payload?.opponent ?? "Bot"}`} | Gotowe do gry z botem.`);
            setTimeout(() => {
                if (roomId) {
                    submitPlacementOnline();
                }
            }, 0);
        }
        else {
            setStatus(`${payload?.message || `Znaleziono przeciwnika: ${payload?.opponent ?? DEFAULT_OPPONENT_NAME[language]}`} | Ustaw flota i kliknij Start PvA.`);
        }
        render();
    });
    socket.on("game:state", (payload) => {
        if (payload.roomId !== roomId) {
            return;
        }
        clearReconnectCountdown();
        applyOnlineState(payload);
    });
    socket.on("chat:history", (payload) => {
        if (payload.roomId !== roomId)
            return;
        replaceChatHistory(Array.isArray(payload.messages) ? payload.messages : []);
        render();
    });
    socket.on("chat:message", (payload) => {
        if (payload.roomId !== roomId)
            return;
        appendChatMessage(payload.message);
        render();
    });
    socket.on("game:turn", (payload) => {
        if (payload.roomId !== roomId) {
            return;
        }
        clearReconnectCountdown();
        awaitingShot = false;
        yourTurnOnline = payload.yourTurn;
        state.phase = payload.phase;
        state.shots = payload.yourShots;
        state.opponentShots = payload.opponentShots;
        syncSunkCellsFromBoard(state.yourBoard, state.yourSunkCells);
        if (payload.gameOver || payload.phase === "over") {
            const totalShots = payload.yourShots + payload.opponentShots;
            if (payload.winner && payload.winner === yourId) {
                setStatus(`Koniec gry: wygrałeś! Twoje strzały: ${payload.yourShots}, strzały przeciwnika: ${payload.opponentShots}, łącznie: ${totalShots}.`);
            }
            else {
                setStatus(`Koniec gry: przegrałeś. Twoje strzały: ${payload.yourShots}, strzały przeciwnika: ${payload.opponentShots}, łącznie: ${totalShots}.`);
            }
        }
        else {
            setStatus(yourTurnOnline ? "Twoja tura." : "Czeka na ruch przeciwnika.");
        }
        render();
    });
    socket.on("game:shot_result", (payload) => {
        if (payload.roomId !== roomId) {
            return;
        }
        clearReconnectCountdown();
        const isYourShot = payload.shooter === yourId;
        if (isYourShot) {
            awaitingShot = false;
        }
        const pretty = coordLabel(payload.coord);
        if (isYourShot) {
            const shouldCount = payload.coord && applyShotToBoardState(state.enemyBoard, payload.coord, payload.outcome);
            if (shouldCount && payload.shipId && payload.coord) {
                const hits = recordShipHit(state.enemyShipHits, payload.shipId, payload.coord);
                if (payload.outcome === "sink") {
                    markAroundSunkShip(state.enemyBoard, hits);
                    markSunkCells(state.enemySunkCells, hits);
                }
            }
            if (payload.outcome === "sink" && payload.coord) {
                state.enemySunkCells.add(coordKey(payload.coord));
                markAroundKnownSunkCells(state.enemyBoard, state.enemySunkCells);
            }
        }
        else if (payload.coord) {
            const shouldCount = applyShotToBoardState(state.yourBoard, payload.coord, payload.outcome);
            if (shouldCount && payload.shipId) {
                const hits = recordShipHit(state.ownShipHits, payload.shipId, payload.coord);
                if (payload.outcome === "sink") {
                    markAroundSunkShip(state.yourBoard, hits);
                    markSunkCells(state.yourSunkCells, hits);
                    syncSunkCellsFromBoard(state.yourBoard, state.yourSunkCells);
                }
            }
            if (payload.outcome === "sink") {
                state.yourSunkCells.add(coordKey(payload.coord));
                syncSunkCellsFromBoard(state.yourBoard, state.yourSunkCells);
                markAroundKnownSunkCells(state.yourBoard, state.yourSunkCells);
            }
        }
        syncSunkCellsFromBoard(state.yourBoard, state.yourSunkCells);
        if (payload.outcome === "miss")
            setStatus(`${pretty}: pudło.`);
        if (payload.outcome === "hit")
            setStatus(`${pretty}: trafiony.`);
        if (payload.outcome === "sink")
            setStatus(`${pretty}: zatopiony!`);
        if (payload.outcome === "already_shot")
            setStatus(`${pretty}: już strzelano.`);
        render();
    });
    socket.on("game:error", (payload) => {
        if (!isCurrentRoomEvent(payload)) {
            return;
        }
        if (payload.code === "chat_invalid_payload" ||
            payload.code === "chat_rate_limited" ||
            payload.code === "chat_not_allowed" ||
            payload.code === "chat_room_mismatch") {
            chatHintEl.textContent = payload?.message ?? t("chatHintDisabled");
            return;
        }
        if (payload.code === "reconnect_grace") {
            const remainingMs = payload.remainingMs ?? RECONNECT_GRACE_MS_FALLBACK;
            setStatus(payload?.message ?? "Przeciwnik chwilowo niedostępny. Oczekiwanie na reconnect.");
            startReconnectTimer(remainingMs);
            awaitingShot = false;
            yourTurnOnline = false;
            render();
            return;
        }
        if (payload.code === "reconnect_restored") {
            setStatus(payload?.message ?? "Połączenie z przeciwnikiem przywrócone.");
            clearReconnectCountdown();
            return;
        }
        if (payload.code === "reconnect_token_expired") {
            storeReconnectToken(null);
            clearReconnectCountdown();
            setStatus(payload?.message ?? "Token sesji wygasł. Tworzymy nową kolejkę.");
            return;
        }
        if (isCancelling) {
            isCancelling = false;
            resetToLocalMode(payload?.message ?? "Błąd gry. Anulowano.");
            return;
        }
        awaitingShot = false;
        setStatus(payload?.message ?? "Błąd gry.");
        if (state.phase === "setup") {
            onlineReady = false;
            render();
        }
    });
    socket.on("game:over", (payload) => {
        if (!isCurrentRoomEvent(payload)) {
            return;
        }
        stopQueueTimer();
        clearReconnectCountdown();
        awaitingShot = false;
        autoReconnectQueued = false;
        storeReconnectToken(null);
        state.phase = "over";
        state.shots = payload.yourShots;
        state.opponentShots = payload.opponentShots;
        const totalShots = payload.totalShots ?? payload.yourShots + payload.opponentShots;
        const reason = payload?.reason ?? "normal";
        const reasonMessage = payload.message
            ? payload.message
            : reason === "disconnect"
                ? "Przeciwnik rozłączył się."
                : reason === "manual_cancel"
                    ? "Gra anulowana."
                    : reason === "inactivity_timeout"
                        ? "Gra zakończona z powodu braku aktywności."
                        : "";
        const localPlayerName = getCurrentPlayerName();
        const winnerName = payload?.winner === yourId
            ? localPlayerName
            : payload?.winner
                ? opponentName
                : "";
        if (winnerName) {
            showWinnerFx(winnerName);
        }
        if (payload?.winner && payload.winner === yourId) {
            setStatus(`Koniec gry: wygrałeś (${winnerName})! Twoje strzały: ${payload.yourShots}, strzały przeciwnika: ${payload.opponentShots}, łącznie ruchów: ${totalShots}. ${reasonMessage}`.trim());
        }
        else if (payload?.winner === null) {
            setStatus(`Gra zakończona. ${reasonMessage}`.trim());
        }
        else {
            setStatus(`Koniec gry: przegrałeś. Wygrał ${winnerName}. Twoje strzały: ${payload.yourShots}, strzały przeciwnika: ${payload.opponentShots}, łącznie ruchów: ${totalShots}. ${reasonMessage}`.trim());
        }
        yourTurnOnline = false;
        onlineReady = false;
        onlineOpponentReady = false;
        resetShotInputState();
        render();
    });
    socket.on("disconnect", () => {
        stopQueueTimer();
        clearReconnectCountdown();
        if (autoReconnectQueued) {
            setStatus("Połączenie utracone. Czekam na ponowne połączenie...");
            awaitingShot = false;
            render();
            return;
        }
        resetToLocalMode("Połączenie utracone.");
    });
    socket.on("connect", () => {
        if (!autoReconnectQueued) {
            return;
        }
        const nickname = nickInput.value.trim() || DEFAULT_NICK_BY_LANG[language];
        const payload = {
            nickname,
        };
        if (reconnectToken) {
            payload.reconnectToken = reconnectToken;
        }
        socket.emit("search:join", payload);
        if (online || inQueue) {
            setStatus("Próba odzyskania połączenia...");
        }
        else {
            setStatus("Próba dołączenia do gry...");
        }
    });
}
const submitPlacementOnline = () => {
    if (!socket) {
        setStatus("Brak połączenia.");
        return;
    }
    if (!roomId) {
        setStatus("Najpierw dołącz do kolejki.");
        return;
    }
    if (state.placement === "manual" && state.remainingShips.length > 0) {
        setStatus(`Ustaw wszystkie statki. Brakuje: ${state.remainingShips.join(", ")}`);
        return;
    }
    const payload = {
        board: asServerBoard(state.yourBoard),
    };
    if (roomId) {
        payload.roomId = roomId;
    }
    socket?.emit("game:place_ships", payload);
    onlineReady = true;
    setStatus("Wysłano ustawienie statków. Czekam na gotowość przeciwnika.");
    state.phase = "setup";
    resetShotInputState();
    render();
};
const init = () => {
    stopQueueTimer();
    awaitingShot = false;
    resetChatState();
    resetShotInputState(true);
    state = {
        phase: "setup",
        placement: "manual",
        remainingShips: [...STANDARD_FLEET],
        orientation: "H",
        yourBoard: placeFleetRandomly(createEmptyBoard()),
        enemyBoard: placeFleetRandomly(createEmptyBoard()),
        turn: "you",
        yourTurn: true,
        shots: 0,
        opponentShots: 0,
        aiState: createAiState(),
        enemyShipHits: {},
        ownShipHits: {},
        enemySunkCells: new Set(),
        yourSunkCells: new Set(),
    };
    setStatus("Gra gotowa. Ustaw statki ręcznie albo startuj losowo.");
    render();
};
init();
