/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BoardModel,
  Coord,
  parseBoardCoordInput,
  STANDARD_FLEET,
  createEmptyBoard,
  createShip,
  createAiState,
  fireShot,
  isFleetSunk,
  keyToCoord,
  placeFleetRandomly,
  validatePlacement,
  nextShot,
  registerAiShot,
  QueueMatchedPayload,
  QueueQueuedPayload,
  GameStatePayload,
  GameTurnPayload,
  GameShotResultPayload,
  GameErrorPayload,
  GameCancelledPayload,
  GameOverPayload,
  GamePlaceShipsPayload,
  ChatHistoryPayload,
  ChatMessage,
  ChatMessagePayload,
  ChatSendPayload,
  CHAT_EMOJI,
  CHAT_GIF_IDS,
  SearchJoinPayload,
} from "../shared/index.js";

declare const io: any;

type Phase = "setup" | "playing" | "over";
type PlacementMode = "manual" | "random";
type Turn = "you" | "bot";
type Lang = "pl" | "en";
type ShotTracker = Record<string, Coord[]>;
type CellState =
  | "empty"
  | "ship"
  | "hit"
  | "miss"
  | "sunk"
  | "preview-valid"
  | "preview-invalid";
type PlacementPreview = {
  keys: Set<string>;
  valid: boolean;
};
type ChatDockCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

interface ChatState {
  enabled: boolean;
  messages: ChatMessage[];
  unread: number;
}

interface LocalState {
  phase: Phase;
  placement: PlacementMode;
  remainingShips: number[];
  orientation: "H" | "V";
  yourBoard: BoardModel;
  enemyBoard: BoardModel;
  turn: Turn;
  yourTurn: boolean;
  shots: number;
  opponentShots: number;
  aiState: ReturnType<typeof createAiState>;
  enemyShipHits: ShotTracker;
  ownShipHits: ShotTracker;
  enemySunkCells: Set<string>;
  yourSunkCells: Set<string>;
}

const labels = "ABCDEFGHIJ";
const $ = <T extends Element>(selector: string): T => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el as T;
};

const coordKey = (coord: Coord): string => `${coord.row},${coord.col}`;
const coordLabel = (coord: Coord): string => `${labels[coord.col]}${coord.row + 1}`;
const SHIP_ICON = "⚓";
const HIT_ICON = "💥";
const MISS_ICON = "·";
const SINK_ICON = "🛳️";
const FALLBACK_SHIP_ICON = "S";
const FALLBACK_HIT_ICON = "X";
const FALLBACK_MISS_ICON = ".";
const FALLBACK_SINK_ICON = "#";
const cellIcon = (state: CellState, useFallback = false): string => {
  if (useFallback) {
    if (state === "ship") return FALLBACK_SHIP_ICON;
    if (state === "sunk") return FALLBACK_SINK_ICON;
    if (state === "hit") return FALLBACK_HIT_ICON;
    if (state === "miss") return FALLBACK_MISS_ICON;
    return "";
  }
  if (state === "ship") return SHIP_ICON;
  if (state === "sunk") return SINK_ICON;
  if (state === "hit") return HIT_ICON;
  if (state === "miss") return MISS_ICON;
  return "";
};

const cellDescription = (coord: Coord, state: CellState): string => {
  const cell = coordLabel(coord);
  if (language === "en") {
    if (state === "ship") return `${cell}: ship`;
    if (state === "hit") return `${cell}: hit`;
    if (state === "sunk") return `${cell}: sunk`;
    if (state === "miss") return `${cell}: miss`;
    if (state === "preview-valid") return `${cell}: placement preview (valid)`;
    if (state === "preview-invalid") return `${cell}: placement preview (invalid)`;
    return `${cell}: empty`;
  }
  if (state === "ship") return `${cell}: statek`;
  if (state === "hit") return `${cell}: trafienie`;
  if (state === "sunk") return `${cell}: zatopiony`;
  if (state === "miss") return `${cell}: pudło`;
  if (state === "preview-valid") return `${cell}: podgląd ustawienia (poprawne)`;
  if (state === "preview-invalid") return `${cell}: podgląd ustawienia (błędne)`;
  return `${cell}: puste`;
};
const useFallbackIcons =
  typeof document === "undefined"
    ? false
    : (() => {
        try {
          if (document.fonts && document.fonts.check) {
            const fallbackFont = document.fonts.check('16px "Apple Color Emoji"');
            const windowsFont = document.fonts.check('16px "Segoe UI Emoji"');
            return !fallbackFont && !windowsFont;
          }
          return false;
        } catch {
          return false;
        }
      })();

const coordEquals = (a: Coord, b: Coord): boolean => a.row === b.row && a.col === b.col;


const markAroundSunkShip = (board: BoardModel, hits: Coord[]) => {
  for (const hit of hits) {
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const row = hit.row + dr;
        const col = hit.col + dc;
        if (row < 0 || col < 0 || row >= board.height || col >= board.width) continue;
        board.shots.add(coordKey({ row, col }));
      }
    }
  }
};

const recordShipHit = (tracker: ShotTracker, shipId: string, coord: Coord): Coord[] => {
  const current = tracker[shipId] ?? [];
  if (!current.some((entry) => coordEquals(entry, coord))) {
    current.push(coord);
  }
  tracker[shipId] = current;
  return current;
};

const markSunkCells = (sunkCells: Set<string>, hits: Coord[]) => {
  for (const hit of hits) {
    sunkCells.add(coordKey(hit));
  }
};

const markAroundKnownSunkCells = (board: BoardModel, sunkCells: Set<string>) => {
  for (const key of sunkCells) {
    const coord = keyToCoord(key);
    if (!Number.isFinite(coord.row) || !Number.isFinite(coord.col)) continue;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const row = coord.row + dr;
        const col = coord.col + dc;
        if (row < 0 || col < 0 || row >= board.height || col >= board.width) continue;
        board.shots.add(coordKey({ row, col }));
      }
    }
  }
};

const addShotPoint = (stateToUpdate: LocalState, forYou: boolean): void => {
  if (forYou) {
    stateToUpdate.shots += 1;
  } else {
    stateToUpdate.opponentShots += 1;
  }
};

const applyShotToBoardState = (board: BoardModel, coord: Coord, outcome: string) => {
  const key = coordKey(coord);
  const isNewShot = !board.shots.has(key);
  board.shots.add(key);
  if (outcome === "hit" || outcome === "sink") {
    if (!board.hits) {
      board.hits = new Set<string>();
    }
    board.hits.add(key);
  }
  return isNewShot;
};

const syncSunkCellsFromBoard = (board: BoardModel, target: Set<string>) => {
  target.clear();
  for (const ship of board.ships) {
    if (!ship.sunk) continue;
    for (const cell of ship.cells) {
      target.add(coordKey(cell));
    }
  }
};

const statusEl = $("#status") as HTMLDivElement;
const shotsYourEl = $("#shotsYour") as HTMLSpanElement;
const shotsOpponentEl = $("#shotsOpponent") as HTMLSpanElement;
const shotsTotalEl = $("#shotsTotal") as HTMLSpanElement;
const boardOwnEl = $("#myBoard") as HTMLDivElement;
const boardEnemyEl = $("#enemyBoard") as HTMLDivElement;
const opponentNameEl = $("#opponentName") as HTMLSpanElement;
const queueTimerEl = document.querySelector("#queueTimer") as HTMLSpanElement | null;
const modeEl = $("#modeBadge") as HTMLSpanElement;
const readinessBadgeEl = $("#readinessBadge") as HTMLSpanElement;
const remainingEl = $("#remainingShips") as HTMLDivElement;
const orientationBadgeEl = $("#orientationBadge") as HTMLSpanElement;
const titleEl = $("#titleText") as HTMLHeadingElement;
const subtitleEl = $("#subtitleText") as HTMLParagraphElement;
const placementHintEl = $("#placementHint") as HTMLSpanElement;
const labelNicknameEl = $("#labelNickname") as HTMLSpanElement;
const labelShotEl = $("#labelShot") as HTMLSpanElement;
const labelLanguageEl = $("#labelLanguage") as HTMLSpanElement;
const myBoardTitleEl = $("#myBoardTitle") as HTMLHeadingElement;
const enemyBoardTitleEl = $("#enemyBoardTitle") as HTMLHeadingElement;
const legendShipEl = $("#legendShip") as HTMLSpanElement;
const legendHitEl = $("#legendHit") as HTMLSpanElement;
const legendMissEl = $("#legendMiss") as HTMLSpanElement;
const legendSunkEl = $("#legendSunk") as HTMLSpanElement;
const labelShotsEl = $("#labelShots") as HTMLSpanElement;
const labelYouEl = $("#labelYou") as HTMLSpanElement;
const labelOpponentInlineEl = $("#labelOpponentInline") as HTMLSpanElement;
const labelTotalEl = $("#labelTotal") as HTMLSpanElement;
const labelEnemyNameEl = $("#labelEnemyName") as HTMLSpanElement;
const winnerFxEl = $("#winnerFx") as HTMLDivElement;
const winnerFxTitleEl = $("#winnerFxTitle") as HTMLDivElement;
const winnerFxNameEl = $("#winnerFxName") as HTMLDivElement;
const winnerFxConfettiEl = $("#winnerFxConfetti") as HTMLDivElement;
const chatTitleEl = $("#chatTitle") as HTMLHeadingElement;
const chatPanelEl = $("#chatPanel") as HTMLDivElement;
const chatListEl = $("#chatList") as HTMLDivElement;
const chatInputEl = $("#chatInput") as HTMLInputElement;
const chatSendBtnEl = $("#chatSendBtn") as HTMLButtonElement;
const chatShortcutHintEl = $("#chatShortcutHint") as HTMLParagraphElement;
const chatHintEl = $("#chatHint") as HTMLParagraphElement;
const chatGifToggleEl = $("#chatGifToggle") as HTMLButtonElement;
const chatMuteBtnEl = $("#chatMuteBtn") as HTMLButtonElement;
const chatGifBarEl = $("#chatGifBar") as HTMLDivElement;
const chatUnreadEl = $("#chatUnread") as HTMLSpanElement;
const chatLauncherEl = $("#chatLauncher") as HTMLButtonElement;
const chatLauncherUnreadEl = $("#chatLauncherUnread") as HTMLSpanElement;
const chatEmojiButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-chat-emoji]"));
const chatGifButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-chat-gif]"));

const btnRotate = $("#btnRotate") as HTMLButtonElement;
const btnAutoPlace = $("#btnAutoPlace") as HTMLButtonElement;
const btnClearPlacement = $("#btnClearPlacement") as HTMLButtonElement;
const btnStartLocal = $("#btnStartLocal") as HTMLButtonElement;
const btnJoinQueue = $("#btnJoinQueue") as HTMLButtonElement;
const btnPlayAgainOnline = $("#btnPlayAgainOnline") as HTMLButtonElement;
const btnCancel = $("#btnCancel") as HTMLButtonElement;
const shotInput = $("#shotInput") as HTMLInputElement;
const btnFire = $("#btnFire") as HTMLButtonElement;
const nickInput = $("#nicknameInput") as HTMLInputElement;
const langPlBtn = $("#langPlBtn") as HTMLButtonElement;
const langEnBtn = $("#langEnBtn") as HTMLButtonElement;

const socket = typeof io !== "undefined" ? io() : null;
const baseDocumentTitle = document.title;

let online = false;
let inQueue = false;
let roomId: string | null = null;
let onlineReady = false;
let onlineOpponentReady = false;
let onlineVsBot = false;
let yourId = "";
let yourTurnOnline = false;
let opponentName = "Bot";
let queueTicker: ReturnType<typeof setInterval> | null = null;
let queueDeadline = 0;
let queueTimeoutMs = 60_000;
let awaitingShot = false;
let reconnectTicker: ReturnType<typeof setInterval> | null = null;
let reconnectDeadline = 0;
let isCancelling = false;
let previousCanShoot = false;
let autoReconnectQueued = false;
let reconnectToken: string | null = null;
let hoverCoord: Coord | null = null;
let boardTouchLastTapTs = 0;
let chatGifOpen = false;
const RECONNECT_TOKEN_KEY = "battleship_reconnect_token";
const LANGUAGE_KEY = "battleship_language";
const CHAT_MUTED_KEY = "battleship_chat_muted";
const CHAT_COLLAPSED_KEY = "battleship_chat_collapsed";
const CHAT_DOCK_KEY = "battleship_chat_dock";
const RECONNECT_GRACE_MS_FALLBACK = 3_000;
let language: Lang = "pl";
let statusRaw = "";
let winnerFxTimer: ReturnType<typeof setTimeout> | null = null;
let chatMuted = false;
let chatAudioCtx: AudioContext | null = null;
let chatCollapsed = false;
let chatDock: ChatDockCorner = "bottom-right";
let chatLauncherPointerId: number | null = null;
let chatLauncherDragging = false;
let chatLauncherDragged = false;
let chatLauncherDragStartX = 0;
let chatLauncherDragStartY = 0;
let chatState: ChatState = {
  enabled: false,
  messages: [],
  unread: 0,
};
const DEFAULT_NICK_BY_LANG: Record<Lang, string> = {
  pl: "Gracz",
  en: "Player",
};
const DEFAULT_OPPONENT_NAME: Record<Lang, string> = {
  pl: "Przeciwnik",
  en: "Opponent",
};
const CHAT_GIF_LABELS: Record<(typeof CHAT_GIF_IDS)[number], Record<Lang, string>> = {
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

let state: LocalState = {
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
  enemySunkCells: new Set<string>(),
  yourSunkCells: new Set<string>(),
};

const I18N: Record<Lang, Record<string, string>> = {
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
    hintPlacement: "Ustawianie: PPM / scroll / R / podwójny tap = obrót",
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
    chatShortcutHint: "Skróty: / fokus, Enter wysyła, Esc zamyka GIF, klik poza zamyka GIF.",
    chatSendHint: "Enter wysyła wiadomość",
    chatGifToggleHint: "GIF reakcje (Esc zamyka panel)",
    chatMuteHint: "Ustawienie dźwięku zapisuje się lokalnie",
    chatSend: "Wyślij",
    chatHintDisabled: "Czat działa tylko w meczu online PvP.",
    chatHintEnabled: "Czat aktywny: setup / gra / koniec gry (60s).",
    chatEmoji: "Emoji",
    chatGifs: "GIF reakcje",
    chatMute: "Wycisz",
    chatUnmute: "Włącz dźwięk",
    chatOpen: "Pokaż czat",
    chatHide: "Ukryj czat",
    chatMoveHint: "Przeciągnij, aby przenieść do innego rogu",
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
    hintPlacement: "Placement: RMB / scroll / R / double tap = rotate",
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
    chatShortcutHint: "Shortcuts: / focuses chat, Enter sends, Esc closes GIF, click outside closes GIF.",
    chatSendHint: "Press Enter to send",
    chatGifToggleHint: "GIF reactions (Esc closes panel)",
    chatMuteHint: "Sound preference is saved locally",
    chatSend: "Send",
    chatHintDisabled: "Chat is available only in online PvP match.",
    chatHintEnabled: "Chat active: setup / playing / game over (60s).",
    chatEmoji: "Emoji",
    chatGifs: "GIF reactions",
    chatMute: "Mute",
    chatUnmute: "Unmute",
    chatOpen: "Open chat",
    chatHide: "Hide chat",
    chatMoveHint: "Drag to move between corners",
    chatYou: "You",
    chatOpponent: "Opponent",
    chatSystem: "System",
    chatUnread: "Unread: {count}",
  },
};

const formatI18n = (template: string, vars?: Record<string, string | number>): string => {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
};

const t = (key: string, vars?: Record<string, string | number>): string => {
  const template = I18N[language][key] ?? I18N.pl[key] ?? key;
  return formatI18n(template, vars);
};

const getStoredLanguage = (): Lang => {
  try {
    const value = localStorage.getItem(LANGUAGE_KEY);
    return value === "en" ? "en" : "pl";
  } catch {
    return "pl";
  }
};

const storeLanguage = (value: Lang) => {
  try {
    localStorage.setItem(LANGUAGE_KEY, value);
  } catch {
    // Ignore storage issues.
  }
};

const getStoredChatMuted = (): boolean => {
  try {
    return localStorage.getItem(CHAT_MUTED_KEY) === "1";
  } catch {
    return false;
  }
};

const storeChatMuted = (value: boolean) => {
  try {
    localStorage.setItem(CHAT_MUTED_KEY, value ? "1" : "0");
  } catch {
    // Ignore storage issues.
  }
};

const getStoredChatCollapsed = (): boolean | null => {
  try {
    const value = localStorage.getItem(CHAT_COLLAPSED_KEY);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch {
    // Ignore storage issues.
  }
  return null;
};

const storeChatCollapsed = (value: boolean) => {
  try {
    localStorage.setItem(CHAT_COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // Ignore storage issues.
  }
};

const getStoredChatDock = (): ChatDockCorner | null => {
  try {
    const value = localStorage.getItem(CHAT_DOCK_KEY);
    if (
      value === "bottom-right" ||
      value === "bottom-left" ||
      value === "top-right" ||
      value === "top-left"
    ) {
      return value;
    }
  } catch {
    // Ignore storage issues.
  }
  return null;
};

const storeChatDock = (value: ChatDockCorner) => {
  try {
    localStorage.setItem(CHAT_DOCK_KEY, value);
  } catch {
    // Ignore storage issues.
  }
};

const applyNicknameDefaultForLanguage = (nextLanguage: Lang, prevLanguage?: Lang) => {
  const current = nickInput.value.trim();
  const shouldReplace =
    current.length === 0 ||
    current === DEFAULT_NICK_BY_LANG.pl ||
    current === DEFAULT_NICK_BY_LANG.en ||
    (prevLanguage ? current === DEFAULT_NICK_BY_LANG[prevLanguage] : false);
  if (shouldReplace) {
    nickInput.value = DEFAULT_NICK_BY_LANG[nextLanguage];
  }
  nickInput.placeholder = DEFAULT_NICK_BY_LANG[nextLanguage];
};

const translateStatus = (text: string): string => {
  if (language === "pl") return text;
  const readyWord = (value: string): string => (value === "TAK" ? "YES" : "NO");

  const exact: Record<string, string> = {
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

  if (exact[text]) return exact[text];

  let result = text;
  result = result.replace(/^Ustaw następny statek \((\d) maszt\)\.$/, "Place next ship ($1 mast).");
  result = result.replace(/^Orientacja: ([HV]) \((button|PPM|scroll|R)\)\.$/, "Orientation: $1 ($2).");
  result = result.replace(/^Pudło: (.+)\. Tura bota\.$/, "Miss: $1. Bot turn.");
  result = result.replace(/^Trafiony: (.+)\. Oddajesz dalej\.$/, "Hit: $1. Shoot again.");
  result = result.replace(/^Bot pudłuje na (.+)\. Twoja tura\.$/, "Bot misses at $1. Your turn.");
  result = result.replace(/^Bot trafia na (.+)\. Bot kontynuuje\.$/, "Bot hits at $1. Bot continues.");
  result = result.replace(
    /^Gotowość: Ty (TAK|NIE), przeciwnik (TAK|NIE)$/,
    (_match: string, you: string, opponent: string) =>
      `Ready: You ${readyWord(you)}, opponent ${readyWord(opponent)}`,
  );
  result = result.replace(/^Czekanie na przeciwnika \((\d+)s\)\.$/, "Waiting for opponent ($1s).");
  result = result.replace(/^Czekanie na przeciwnika \(max (\d+)s, potem bot\)\.$/, "Waiting for opponent (max $1s, then bot).");
  result = result.replace(
    /^Przeciwnik rozłączył się\. Gra jest zawieszona na (\d+)s na próbę ponownego połączenia\.$/,
    "Opponent disconnected. The game is paused for $1s while waiting for reconnect.",
  );
  result = result.replace(/^Przeciwnik rozłączył się\. Wygrana przyznana\.$/, "Opponent disconnected. Victory awarded.");
  result = result.replace(/^Znaleziono przeciwnika: (.+) \| Ustaw flota i kliknij Start PvA\.$/, "Opponent found: $1 | Place your fleet and click Start PvA.");
  result = result.replace(/^Znaleziono przeciwnika: (.+) \| Gotowe do gry z botem\.$/, "Opponent found: $1 | Ready to play against bot.");
  result = result.replace(/Znaleziono przeciwnika\./g, "Opponent found.");
  result = result.replace(/^Ustaw wszystkie statki\. Brakuje: (.+)$/, "Place all ships. Missing: $1");
  result = result.replace(/^Koniec gry: wygrałeś \((.+)\)! (.+)$/, "Game over: winner ($1)! $2");
  result = result.replace(/^Koniec gry: przegrałeś\. Wygrał (.+)\. (.+)$/, "Game over: you lost. Winner: $1. $2");
  result = result.replace(
    /^Koniec gry\. Wygrałeś! Twoje strzały: (\d+), strzały przeciwnika: (\d+), łącznie: (\d+) tur\.$/,
    "Game over. You won! Your shots: $1, opponent shots: $2, total turns: $3.",
  );
  result = result.replace(
    /^Koniec gry\. Bot wygrał\. Twoje strzały: (\d+), strzały bota: (\d+), łącznie: (\d+) tur\.$/,
    "Game over. Bot won. Your shots: $1, bot shots: $2, total turns: $3.",
  );
  result = result.replace(
    /^Koniec gry: wygrałeś! Twoje strzały: (\d+), strzały przeciwnika: (\d+), łącznie ruchów: (\d+)\.$/,
    "Game over: you won! Your shots: $1, opponent shots: $2, total moves: $3.",
  );
  result = result.replace(
    /^Koniec gry: przegrałeś\. Twoje strzały: (\d+), strzały przeciwnika: (\d+), łącznie ruchów: (\d+)\.$/,
    "Game over: you lost. Your shots: $1, opponent shots: $2, total moves: $3.",
  );
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

const setStatus = (text: string) => {
  statusRaw = text;
  statusEl.textContent = translateStatus(text);
};

const getCurrentPlayerName = (): string => {
  const nick = nickInput.value.trim();
  if (nick.length > 0) return nick;
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

const showWinnerFx = (winnerName: string) => {
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

const queueTimeoutText = (seconds: number): string =>
  language === "en" ? `Queue timeout in: ${seconds}s` : `Pozostało do timeoutu: ${seconds}s`;

const reconnectCountdownText = (seconds: number): string =>
  language === "en"
    ? `Opponent reconnect window: ${seconds}s`
    : `Ponowne połączenie przeciwnika za ${seconds}s`;

const isManualPlacementActive = (): boolean => {
  if (state.phase !== "setup") return false;
  if (state.placement !== "manual") return false;
  if (state.remainingShips.length === 0) return false;
  if (online && onlineReady) return false;
  return true;
};

const getPlacementPreview = (): PlacementPreview | null => {
  if (!isManualPlacementActive() || !hoverCoord) return null;
  const nextType = state.remainingShips[0];
  if (!nextType) return null;
  const previewShip = createShip(
    "__preview__",
    nextType as 4 | 3 | 2 | 1,
    hoverCoord,
    state.orientation,
  );
  return {
    keys: new Set(previewShip.cells.map(coordKey)),
    valid: validatePlacement(state.yourBoard, previewShip),
  };
};

const setPlacementHoverCoord = (coord: Coord | null) => {
  if (!coord && !hoverCoord) return;
  if (coord && hoverCoord && coordEquals(coord, hoverCoord)) return;
  hoverCoord = coord;
  render();
};

const isTypingContext = (element: Element | null): boolean => {
  if (!(element instanceof HTMLElement)) return false;
  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || element.isContentEditable;
};

const rotatePlacementOrientation = (source: "button" | "PPM" | "scroll" | "R" | "tap"): boolean => {
  if (!isManualPlacementActive()) return false;
  state.orientation = state.orientation === "H" ? "V" : "H";
  setStatus(`Orientacja: ${state.orientation} (${source}).`);
  render();
  return true;
};

const getStoredReconnectToken = (): string | null => {
  try {
    return sessionStorage.getItem(RECONNECT_TOKEN_KEY);
  } catch {
    return null;
  }
};

const storeReconnectToken = (value: string | null) => {
  reconnectToken = value;
  try {
    if (value) {
      sessionStorage.setItem(RECONNECT_TOKEN_KEY, value);
    } else {
      sessionStorage.removeItem(RECONNECT_TOKEN_KEY);
    }
  } catch {
    // Storage can be unavailable in some contexts.
  }
};

reconnectToken = getStoredReconnectToken();
language = getStoredLanguage();
chatMuted = getStoredChatMuted();
chatDock = getStoredChatDock() ?? "bottom-right";
const initialChatCollapsed = getStoredChatCollapsed();
chatCollapsed = initialChatCollapsed !== null ? initialChatCollapsed : window.matchMedia("(max-width: 860px)").matches;
applyNicknameDefaultForLanguage(language);

const applyChatDockClasses = () => {
  const cornerClasses: ChatDockCorner[] = ["bottom-right", "bottom-left", "top-right", "top-left"];
  const classNames = cornerClasses.map((corner) => `chat-corner-${corner}`);
  chatPanelEl.classList.remove(...classNames);
  chatLauncherEl.classList.remove(...classNames);
  const selectedClass = `chat-corner-${chatDock}`;
  chatPanelEl.classList.add(selectedClass);
  chatLauncherEl.classList.add(selectedClass);
};

const setChatDock = (nextDock: ChatDockCorner, persist = true) => {
  if (chatDock === nextDock) return;
  chatDock = nextDock;
  if (persist) {
    storeChatDock(chatDock);
  }
  applyChatDockClasses();
};

const setChatCollapsed = (value: boolean, persist = true) => {
  if (chatCollapsed === value) {
    if (persist) {
      storeChatCollapsed(chatCollapsed);
    }
    return;
  }
  chatCollapsed = value;
  if (persist) {
    storeChatCollapsed(chatCollapsed);
  }
};

const toggleChatCollapsed = () => {
  setChatCollapsed(!chatCollapsed);
  if (!chatCollapsed) {
    clearChatUnread();
  }
  render();
};

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
  chatInputEl.title = t("chatShortcutHint");
  chatShortcutHintEl.textContent = t("chatShortcutHint");
  chatSendBtnEl.textContent = t("chatSend");
  chatSendBtnEl.title = t("chatSendHint");
  chatSendBtnEl.setAttribute("aria-label", `${t("chatSend")} - ${t("chatSendHint")}`);
  chatGifToggleEl.textContent = t("chatGifs");
  chatGifToggleEl.title = t("chatGifToggleHint");
  chatGifToggleEl.setAttribute("aria-label", t("chatGifToggleHint"));
  chatMuteBtnEl.textContent = chatMuted ? t("chatUnmute") : t("chatMute");
  chatMuteBtnEl.title = `${chatMuteBtnEl.textContent} - ${t("chatMuteHint")}`;
  chatMuteBtnEl.setAttribute("aria-label", chatMuteBtnEl.title);
  chatLauncherEl.title = chatCollapsed ? t("chatOpen") : t("chatHide");
  chatLauncherEl.setAttribute("aria-label", `${chatLauncherEl.title}. ${t("chatMoveHint")}`);
  chatEmojiButtons.forEach((button) => {
    button.title = `${t("chatEmoji")} ${button.dataset.chatEmoji ?? ""}`.trim();
    button.setAttribute("aria-label", button.title);
  });
  chatGifButtons.forEach((button) => {
    const gifId = button.dataset.chatGif as (typeof CHAT_GIF_IDS)[number] | undefined;
    if (!gifId || !(gifId in CHAT_GIF_LABELS)) return;
    const gifLabel = CHAT_GIF_LABELS[gifId][language];
    button.title = gifLabel;
    button.setAttribute("aria-label", button.title);
    const label = button.querySelector(".chat-gif__label");
    if (label) {
      label.textContent = gifLabel;
    }
    const image = button.querySelector("img");
    if (image) {
      image.alt = gifLabel;
    }
  });
  langPlBtn.classList.toggle("active", language === "pl");
  langEnBtn.classList.toggle("active", language === "en");
};

const isCurrentRoomEvent = (payload?: { roomId?: string | null } | null): boolean => {
  if (!payload?.roomId) return true;
  return payload.roomId === roomId;
};

const toRenderBoard = (board: BoardModel) => {
  const shots = new Set(board.shots);
  const hits = new Set(board.hits ?? []);
  if (hits.size === 0) {
    for (const ship of board.ships) {
      for (const cell of ship.cells) {
        const key = coordKey(cell);
        if (shots.has(key)) hits.add(key);
      }
    }
  }
  const shipByCoord = new Map<string, { id: string; sunk: boolean }>();
  for (const ship of board.ships) {
    const state = { id: ship.id, sunk: ship.sunk };
    for (const cell of ship.cells) {
      shipByCoord.set(coordKey(cell), state);
    }
  }
  return { width: board.width, height: board.height, shots, hits, shipByCoord };
};

const resetToLocalMode = (message: string) => {
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
    enemySunkCells: new Set<string>(),
    yourSunkCells: new Set<string>(),
  };
  setStatus(message);
  render();
};

const isChatEnabled = (): boolean =>
  online &&
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
  if (window.matchMedia("(max-width: 860px)").matches) {
    setChatCollapsed(true);
  }
};

const chatMessageAuthor = (message: ChatMessage): string => {
  if (message.kind === "system") return t("chatSystem");
  if (message.senderId === yourId) return t("chatYou");
  if (message.senderName && message.senderName.trim().length > 0) return message.senderName;
  return t("chatOpponent");
};

const chatMessageBody = (message: ChatMessage): string => {
  if (message.kind === "text") return message.text ?? "";
  if (message.kind === "emoji") return message.emoji ?? "";
  if (message.kind === "gif") {
    const gifId = message.gifId as (typeof CHAT_GIF_IDS)[number] | undefined;
    if (gifId && CHAT_GIF_LABELS[gifId]) return CHAT_GIF_LABELS[gifId][language];
    return "GIF";
  }
  return message.text ?? "";
};

const CHAT_GIF_ASSET_VERSION = "4";
const chatGifSrc = (gifId: string): string => `/assets/chat-gifs/${gifId}.gif?v=${CHAT_GIF_ASSET_VERSION}`;
const refreshChatGifButtons = () => {
  for (const button of chatGifButtons) {
    const gifId = button.dataset.chatGif as (typeof CHAT_GIF_IDS)[number] | undefined;
    if (!gifId) continue;
    const image = button.querySelector("img");
    if (!image) continue;
    image.src = chatGifSrc(gifId);
    image.onerror = () => {
      button.classList.add("chat-gif--broken");
    };
    image.onload = () => {
      button.classList.remove("chat-gif--broken");
    };
  }
};
const isChatNearBottom = (): boolean => {
  const distanceFromBottom = chatListEl.scrollHeight - (chatListEl.scrollTop + chatListEl.clientHeight);
  return distanceFromBottom <= 24;
};

const updateDocumentUnreadBadge = () => {
  if (chatState.unread > 0 && document.hidden) {
    document.title = `(${chatState.unread}) ${baseDocumentTitle}`;
    return;
  }
  document.title = baseDocumentTitle;
};

const updateChatComposerState = () => {
  const hasText = chatInputEl.value.trim().length > 0;
  chatSendBtnEl.disabled = !chatState.enabled || !hasText;
};

const playChatPing = () => {
  if (chatMuted) return;
  try {
    if (!chatAudioCtx) {
      const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      chatAudioCtx = new AudioCtx();
    }
    if (chatAudioCtx.state === "suspended") {
      void chatAudioCtx.resume();
    }
    const osc = chatAudioCtx.createOscillator();
    const gain = chatAudioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(830, chatAudioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(620, chatAudioCtx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, chatAudioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, chatAudioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, chatAudioCtx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(chatAudioCtx.destination);
    osc.start();
    osc.stop(chatAudioCtx.currentTime + 0.15);
  } catch {
    // Best-effort only.
  }
};

const renderChat = () => {
  chatState.enabled = isChatEnabled();
  refreshChatGifButtons();
  const previousScrollTop = chatListEl.scrollTop;
  const shouldStickToBottom = isChatNearBottom();
  applyChatDockClasses();
  chatPanelEl.classList.toggle("chat-panel--collapsed", chatCollapsed);
  document.body.classList.toggle("chat-collapsed", chatCollapsed);
  chatLauncherEl.title = chatCollapsed ? t("chatOpen") : t("chatHide");
  chatLauncherEl.setAttribute("aria-label", `${chatLauncherEl.title}. ${t("chatMoveHint")}`);
  chatLauncherEl.setAttribute("aria-expanded", chatCollapsed ? "false" : "true");
  chatPanelEl.classList.toggle("chat-panel--disabled", !chatState.enabled);
  chatInputEl.disabled = !chatState.enabled;
  chatGifToggleEl.disabled = !chatState.enabled;
  chatMuteBtnEl.disabled = !chatState.enabled;
  chatEmojiButtons.forEach((button) => {
    button.disabled = !chatState.enabled;
  });
  chatGifButtons.forEach((button) => {
    button.disabled = !chatState.enabled;
  });
  chatMuteBtnEl.textContent = chatMuted ? t("chatUnmute") : t("chatMute");
  chatMuteBtnEl.title = `${chatMuteBtnEl.textContent} - ${t("chatMuteHint")}`;
  chatMuteBtnEl.setAttribute("aria-label", chatMuteBtnEl.title);
  chatMuteBtnEl.classList.toggle("chat-panel__toggle--active", chatMuted);
  chatMuteBtnEl.setAttribute("aria-pressed", chatMuted ? "true" : "false");
  chatGifToggleEl.classList.toggle("chat-panel__toggle--active", chatState.enabled && chatGifOpen);
  chatGifToggleEl.setAttribute("aria-expanded", chatState.enabled && chatGifOpen ? "true" : "false");
  chatGifBarEl.hidden = !chatState.enabled || !chatGifOpen;
  chatHintEl.textContent = chatState.enabled ? t("chatHintEnabled") : t("chatHintDisabled");
  chatUnreadEl.textContent = chatState.unread > 0 ? t("chatUnread", { count: chatState.unread }) : "";
  chatUnreadEl.classList.toggle("chat-panel__unread--active", chatState.unread > 0);
  chatLauncherUnreadEl.textContent = chatState.unread > 0 ? String(chatState.unread) : "";
  chatLauncherUnreadEl.classList.toggle("chat-launcher__unread--active", chatState.unread > 0);
  updateDocumentUnreadBadge();
  updateChatComposerState();

  chatListEl.innerHTML = "";
  for (const message of chatState.messages) {
    const item = document.createElement("div");
    item.className = "chat-message";
    if (message.kind === "system") item.classList.add("chat-message--system");
    else item.classList.add(message.senderId === yourId ? "chat-message--you" : "chat-message--opponent");

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
      img.onerror = () => {
        body.textContent = chatMessageBody(message);
      };
      const caption = document.createElement("div");
      caption.className = "chat-message__gif-label";
      caption.textContent = chatMessageBody(message);
      body.appendChild(img);
      body.appendChild(caption);
    } else {
      body.textContent = chatMessageBody(message);
    }
    item.append(head, body);
    chatListEl.appendChild(item);
  }
  if (shouldStickToBottom) {
    chatListEl.scrollTop = chatListEl.scrollHeight;
  } else {
    chatListEl.scrollTop = previousScrollTop;
  }
};

const replaceChatHistory = (messages: ChatMessage[]) => {
  chatState.messages = messages.slice(-80);
  chatState.unread = 0;
};

const appendChatMessage = (message: ChatMessage) => {
  chatState.messages.push(message);
  if (chatState.messages.length > 80) {
    chatState.messages = chatState.messages.slice(-80);
  }
  const incomingFromOpponent = message.kind !== "system" && message.senderId !== yourId;
  if (incomingFromOpponent && (document.hidden || !isChatNearBottom())) {
    chatState.unread += 1;
  }
  if (incomingFromOpponent && chatState.enabled && !document.hidden) {
    playChatPing();
  }
};

const clearChatUnread = () => {
  if (chatState.unread <= 0) return;
  chatState.unread = 0;
  render();
};

const emitChatSend = (payload: ChatSendPayload) => {
  if (!socket || !chatState.enabled || !roomId) return;
  const outgoing: ChatSendPayload = { ...payload, roomId };
  socket.emit("chat:send", outgoing);
};

const drawBoard = (
  container: HTMLDivElement,
  board: BoardModel,
  revealShips: boolean,
  onCell: ((coord: Coord) => void) | null,
  onHover: ((coord: Coord) => void) | null = null,
  preview: PlacementPreview | null = null,
  sunkCells: Set<string> | null = null,
) => {
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
      let cellState: CellState = "empty";
      if (isShot) {
        if (isHit && isSunkCell) {
          cellState = "sunk";
        } else if (isHit) {
          cellState = "hit";
        } else {
          cellState = "miss";
        }
      } else if (revealShips && shipState) {
        cellState = "ship";
      }
      if (
        preview &&
        preview.keys.has(key) &&
        cellState !== "hit" &&
        cellState !== "miss" &&
        cellState !== "sunk"
      ) {
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

const canShootEnemy = () =>
  state.phase === "playing" && !awaitingShot && (online ? yourTurnOnline : state.turn === "you" && state.yourTurn);

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
    } else {
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
  } else if (state.phase === "playing") {
    btnStartLocal.disabled = true;
    btnJoinQueue.disabled = true;
    btnAutoPlace.disabled = true;
    btnClearPlacement.disabled = true;
    btnRotate.disabled = !isManualPlacementActive();
    btnPlayAgainOnline.disabled = true;
    btnFire.disabled = !canShootEnemy();
    shotInput.disabled = !canShootEnemy();
  } else {
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

const shouldAutoFocusShotInput = (): boolean => {
  try {
    return window.matchMedia("(pointer: fine) and (hover: hover) and (min-width: 981px)").matches;
  } catch {
    return false;
  }
};

const render = () => {
  applyStaticTranslations();
  const manualPlacementActive = isManualPlacementActive();
  if (!manualPlacementActive) {
    hoverCoord = null;
  }
  const preview = getPlacementPreview();
  drawBoard(
    boardOwnEl,
    state.yourBoard,
    true,
    online
      ? state.phase === "setup" && !onlineReady
        ? onManualPlace
        : null
      : state.phase === "setup" && state.placement === "manual"
        ? onManualPlace
        : null,
    manualPlacementActive ? setPlacementHoverCoord : null,
    preview,
    state.yourSunkCells,
  );
  drawBoard(
    boardEnemyEl,
    state.enemyBoard,
    false,
    canShootEnemy() ? onFireAtEnemy : null,
    null,
    null,
    state.enemySunkCells,
  );
  modeEl.textContent = online ? "Online" : "PvA";
  orientationBadgeEl.textContent = t("orientation", { orientation: state.orientation });
  orientationBadgeEl.classList.toggle("orientation-active", manualPlacementActive);
  updateReadinessBadge();
  if (online) {
    shotsYourEl.textContent = String(state.shots);
    shotsOpponentEl.textContent = String(state.opponentShots);
    shotsTotalEl.textContent = String(state.shots + state.opponentShots);
  } else {
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
  if (nowCanShoot && !previousCanShoot && shouldAutoFocusShotInput()) {
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
    enemySunkCells: new Set<string>(),
    yourSunkCells: new Set<string>(),
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
    enemySunkCells: new Set<string>(),
    yourSunkCells: new Set<string>(),
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

const asServerBoard = (board: BoardModel) => ({
  width: board.width,
  height: board.height,
  ships: board.ships,
  shots: [...board.shots],
  hits: [...(board.hits ?? [])],
});

const onManualPlace = (coord: Coord) => {
  if (state.phase !== "setup" || state.placement !== "manual" || state.remainingShips.length === 0) {
    return;
  }
  const type = state.remainingShips[0] as 4 | 3 | 2 | 1;
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
  } else {
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
      enemySunkCells: new Set<string>(),
      yourSunkCells: new Set<string>(),
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
  state.enemySunkCells = new Set<string>();
  state.yourSunkCells = new Set<string>();
  setStatus("Gra lokalna rozpoczęta. Twoja tura.");
  resetShotInputState(true);
  render();
};

const finishLocalGame = (winner: Turn) => {
  const opponentShots = state.opponentShots;
  const yourShots = state.shots;
  const totalShots = state.shots + opponentShots;
  state.phase = "over";
  previousCanShoot = false;
  state.yourTurn = false;
  if (winner === "you") {
    showWinnerFx(getCurrentPlayerName());
    setStatus(
      `Koniec gry. Wygrałeś! Twoje strzały: ${yourShots}, strzały przeciwnika: ${opponentShots}, łącznie: ${totalShots} tur.`,
    );
  } else {
    showWinnerFx("Bot");
    setStatus(
      `Koniec gry. Bot wygrał. Twoje strzały: ${yourShots}, strzały bota: ${opponentShots}, łącznie: ${totalShots} tur.`,
    );
  }
  render();
};

const handleAiTurn = () => {
  if (state.phase !== "playing" || state.turn !== "bot") return;
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

const onFireAtEnemy = (coord: Coord): boolean => {
  if (!canShootEnemy()) return false;
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
    } else if (awaitingShot) {
      setStatus("Czekaj na odpowiedź serwera.");
    } else {
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

type PublicState = GameStatePayload;
type PublicTurn = GameTurnPayload;
type PublicOver = GameOverPayload;
type PublicMatchQueued = QueueMatchedPayload;
type PublicQueueQueued = QueueQueuedPayload;
type PublicShotResult = GameShotResultPayload;
type PublicError = GameErrorPayload;
type PublicCancelled = GameCancelledPayload;
type PublicChatHistory = ChatHistoryPayload;
type PublicChatMessage = ChatMessagePayload;
type PlaceShipsPayload = GamePlaceShipsPayload;

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

const startReconnectTimer = (remainingMs: number) => {
  stopQueueTimer();
  stopReconnectTimer();
  reconnectDeadline = Date.now() + Math.max(0, remainingMs);
  if (!queueTimerEl) return;
  reconnectTicker = setInterval(() => {
    const remainingSeconds = Math.max(0, Math.ceil((reconnectDeadline - Date.now()) / 1000));
    if (remainingSeconds <= 0) {
      stopReconnectTimer();
      return;
    }
    queueTimerEl.textContent = reconnectCountdownText(remainingSeconds);
    if (remainingSeconds <= 10) {
      queueTimerEl.classList.add("urgent");
    } else {
      queueTimerEl.classList.remove("urgent");
    }
  }, 1000);
  const firstTick = Math.max(0, Math.ceil((reconnectDeadline - Date.now()) / 1000));
  queueTimerEl.textContent = reconnectCountdownText(firstTick);
  if (firstTick <= 10) queueTimerEl.classList.add("urgent");
};

const clearReconnectCountdown = () => {
  stopReconnectTimer();
};

const startQueueTimer = (payload: PublicQueueQueued) => {
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
      } else {
        queueTimerEl.classList.remove("urgent");
      }
    }
    setStatus(`Czekanie na przeciwnika (${remainingSeconds}s).`);
  }, 1000);
};

const applyOnlineState = (payload: PublicState) => {
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
      setStatus(
        `Koniec gry: wygrałeś! Twoje strzały: ${payload.yourShots}, strzały przeciwnika: ${payload.opponentShots}, łącznie ruchów: ${totalShots}.`,
      );
    } else {
      setStatus(
        `Koniec gry: przegrałeś. Twoje strzały: ${payload.yourShots}, strzały przeciwnika: ${payload.opponentShots}, łącznie ruchów: ${totalShots}.`,
      );
    }
  } else {
    if (state.phase === "setup") {
      const myReady = payload.youReady ?? false;
      const opponentReady = payload.opponentReady ?? false;
      if (myReady && opponentReady) {
        setStatus("Obaj gracze gotowi. Rozpoczyna się gra...");
      } else {
        setStatus(
          `Gotowość: Ty ${myReady ? "TAK" : "NIE"}, przeciwnik ${opponentReady ? "TAK" : "NIE"}`,
        );
      }
    } else {
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
  const payload: SearchJoinPayload = {
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
  if (!socket) return;
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
  if (online) cancelOnline();
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
  if (event.key !== "Enter") return;
  event.preventDefault();
  fireFromInput();
});

chatSendBtnEl.addEventListener("click", () => {
  const text = chatInputEl.value.trim();
  if (!text) return;
  emitChatSend({ kind: "text", text });
  chatInputEl.value = "";
  updateChatComposerState();
});

chatInputEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const text = chatInputEl.value.trim();
  if (!text) return;
  emitChatSend({ kind: "text", text });
  chatInputEl.value = "";
  updateChatComposerState();
});

chatInputEl.addEventListener("input", () => {
  updateChatComposerState();
});

chatGifToggleEl.addEventListener("click", () => {
  chatGifOpen = !chatGifOpen;
  render();
});

chatMuteBtnEl.addEventListener("click", () => {
  chatMuted = !chatMuted;
  storeChatMuted(chatMuted);
  render();
});

chatEmojiButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const emoji = button.dataset.chatEmoji;
    if (!emoji || !CHAT_EMOJI.includes(emoji as (typeof CHAT_EMOJI)[number])) return;
    emitChatSend({ kind: "emoji", emoji });
  });
});

chatGifButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const gifId = button.dataset.chatGif;
    if (!gifId || !CHAT_GIF_IDS.includes(gifId as (typeof CHAT_GIF_IDS)[number])) return;
    emitChatSend({ kind: "gif", gifId });
  });
});

chatLauncherEl.addEventListener("click", () => {
  if (chatLauncherDragged) {
    chatLauncherDragged = false;
    return;
  }
  toggleChatCollapsed();
});

chatLauncherEl.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  chatLauncherPointerId = event.pointerId;
  chatLauncherDragging = true;
  chatLauncherDragged = false;
  chatLauncherDragStartX = event.clientX;
  chatLauncherDragStartY = event.clientY;
  chatLauncherEl.setPointerCapture(event.pointerId);
});

chatLauncherEl.addEventListener("pointermove", (event) => {
  if (!chatLauncherDragging || chatLauncherPointerId !== event.pointerId) return;
  const deltaX = Math.abs(event.clientX - chatLauncherDragStartX);
  const deltaY = Math.abs(event.clientY - chatLauncherDragStartY);
  if (!chatLauncherDragged && deltaX < 6 && deltaY < 6) return;
  const { clientX, clientY } = event;
  const style = chatLauncherEl.style;
  style.left = `${clientX - 26}px`;
  style.top = `${clientY - 26}px`;
  style.right = "auto";
  style.bottom = "auto";
  chatLauncherEl.classList.add("chat-launcher--dragging");
  if (!chatLauncherDragged) {
    chatLauncherDragged = true;
  }
});

const finalizeChatLauncherDrag = (event: PointerEvent) => {
  if (chatLauncherPointerId !== event.pointerId) return;
  chatLauncherDragging = false;
  chatLauncherPointerId = null;
  chatLauncherEl.classList.remove("chat-launcher--dragging");
  chatLauncherEl.style.left = "";
  chatLauncherEl.style.top = "";
  chatLauncherEl.style.right = "";
  chatLauncherEl.style.bottom = "";
  if (!chatLauncherDragged) return;
  const vertical = event.clientY < window.innerHeight / 2 ? "top" : "bottom";
  const horizontal = event.clientX < window.innerWidth / 2 ? "left" : "right";
  setChatDock(`${vertical}-${horizontal}` as ChatDockCorner);
  render();
};

chatLauncherEl.addEventListener("pointerup", finalizeChatLauncherDrag);
chatLauncherEl.addEventListener("pointercancel", () => {
  chatLauncherDragging = false;
  chatLauncherPointerId = null;
  chatLauncherEl.classList.remove("chat-launcher--dragging");
  chatLauncherEl.style.left = "";
  chatLauncherEl.style.top = "";
  chatLauncherEl.style.right = "";
  chatLauncherEl.style.bottom = "";
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    clearChatUnread();
  }
});

window.addEventListener("focus", () => {
  clearChatUnread();
});

chatPanelEl.addEventListener("pointerenter", () => {
  if (chatCollapsed) return;
  clearChatUnread();
});

chatPanelEl.addEventListener("focusin", () => {
  if (chatCollapsed) return;
  clearChatUnread();
});

chatListEl.addEventListener("scroll", () => {
  if (!document.hidden && isChatNearBottom()) {
    clearChatUnread();
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!chatGifOpen) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("#chatGifBar") || target.closest("#chatGifToggle")) return;
  chatGifOpen = false;
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && chatGifOpen) {
    chatGifOpen = false;
    render();
    return;
  }
  if (event.key !== "/") return;
  if (!chatState.enabled || document.hidden) return;
  if (isTypingContext(document.activeElement)) return;
  event.preventDefault();
  if (chatCollapsed) {
    setChatCollapsed(false);
    render();
  }
  chatInputEl.focus();
});

boardOwnEl.addEventListener("mouseleave", () => {
  setPlacementHoverCoord(null);
});

boardOwnEl.addEventListener("contextmenu", (event) => {
  if (!isManualPlacementActive()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!target.closest("button.cell")) return;
  event.preventDefault();
  rotatePlacementOrientation("PPM");
});

boardOwnEl.addEventListener(
  "wheel",
  (event) => {
    if (!isManualPlacementActive()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest("button.cell")) return;
    event.preventDefault();
    rotatePlacementOrientation("scroll");
  },
  { passive: false },
);

boardOwnEl.addEventListener(
  "touchstart",
  (event) => {
    if (!isManualPlacementActive()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest("button.cell")) return;
    const now = Date.now();
    const delta = now - boardTouchLastTapTs;
    boardTouchLastTapTs = now;
    if (delta > 0 && delta < 320) {
      event.preventDefault();
      boardTouchLastTapTs = 0;
      rotatePlacementOrientation("tap");
    }
  },
  { passive: false },
);

document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() !== "r") return;
  if (isTypingContext(document.activeElement)) return;
  if (!isManualPlacementActive()) return;
  event.preventDefault();
  rotatePlacementOrientation("R");
});

const switchLanguage = (nextLanguage: Lang) => {
  if (nextLanguage === language) return;
  const previousLanguage = language;
  const shouldSwitchOpponentDefault =
    opponentName === DEFAULT_OPPONENT_NAME.pl ||
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
  socket.on("queue:queued", (payload?: PublicQueueQueued) => {
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
    } else if (payload?.message) {
      introMessage = payload.message;
    } else if (payload?.reconnectToken) {
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
    const waiting =
      language === "en"
        ? `Waiting for opponent (max ${Math.ceil(queueTimeoutMs / 1000)}s, then bot).`
        : `Czekanie na przeciwnika (max ${Math.ceil(queueTimeoutMs / 1000)}s, potem bot).`;
    setStatus(introMessage ? `${introMessage} ${waiting}` : waiting);
    render();
  });

  socket.on("game:cancelled", (payload: PublicCancelled) => {
    if (!isCurrentRoomEvent(payload)) {
      return;
    }
    isCancelling = false;
    resetToLocalMode(payload?.message ?? "Akcja została anulowana.");
  });

  socket.on("queue:matched", (payload: PublicMatchQueued) => {
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
    } else {
      setStatus(
        `${payload?.message || `Znaleziono przeciwnika: ${payload?.opponent ?? DEFAULT_OPPONENT_NAME[language]}`} | Ustaw flota i kliknij Start PvA.`,
      );
    }
    render();
  });

  socket.on("game:state", (payload: PublicState) => {
    if (payload.roomId !== roomId) {
      return;
    }
    clearReconnectCountdown();
    applyOnlineState(payload);
  });

  socket.on("chat:history", (payload: PublicChatHistory) => {
    if (payload.roomId !== roomId) return;
    replaceChatHistory(Array.isArray(payload.messages) ? payload.messages : []);
    render();
  });

  socket.on("chat:message", (payload: PublicChatMessage) => {
    if (payload.roomId !== roomId) return;
    appendChatMessage(payload.message);
    render();
  });

  socket.on("game:turn", (payload: PublicTurn) => {
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
      } else {
        setStatus(`Koniec gry: przegrałeś. Twoje strzały: ${payload.yourShots}, strzały przeciwnika: ${payload.opponentShots}, łącznie: ${totalShots}.`);
      }
    } else {
      setStatus(yourTurnOnline ? "Twoja tura." : "Czeka na ruch przeciwnika.");
    }
    render();
  });

  socket.on("game:shot_result", (payload: PublicShotResult) => {
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
    } else if (payload.coord) {
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
    if (payload.outcome === "miss") setStatus(`${pretty}: pudło.`);
    if (payload.outcome === "hit") setStatus(`${pretty}: trafiony.`);
    if (payload.outcome === "sink") setStatus(`${pretty}: zatopiony!`);
    if (payload.outcome === "already_shot") setStatus(`${pretty}: już strzelano.`);
    render();
  });

  socket.on("game:error", (payload: PublicError) => {
    if (!isCurrentRoomEvent(payload as { roomId?: string | null })) {
      return;
    }
    if (
      payload.code === "chat_invalid_payload" ||
      payload.code === "chat_rate_limited" ||
      payload.code === "chat_not_allowed" ||
      payload.code === "chat_room_mismatch"
    ) {
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

  socket.on("game:over", (payload: PublicOver) => {
    if (!isCurrentRoomEvent(payload as { roomId?: string | null })) {
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
    const reasonMessage =
      payload.message
        ? payload.message
        : reason === "disconnect"
          ? "Przeciwnik rozłączył się."
          : reason === "manual_cancel"
            ? "Gra anulowana."
            : reason === "inactivity_timeout"
              ? "Gra zakończona z powodu braku aktywności."
              : "";
    const localPlayerName = getCurrentPlayerName();
    const winnerName =
      payload?.winner === yourId
        ? localPlayerName
        : payload?.winner
          ? opponentName
          : "";
    if (winnerName) {
      showWinnerFx(winnerName);
    }
    if (payload?.winner && payload.winner === yourId) {
      setStatus(
        `Koniec gry: wygrałeś (${winnerName})! Twoje strzały: ${payload.yourShots}, strzały przeciwnika: ${payload.opponentShots}, łącznie ruchów: ${totalShots}. ${reasonMessage}`.trim(),
      );
    } else if (payload?.winner === null) {
      setStatus(`Gra zakończona. ${reasonMessage}`.trim());
    } else {
      setStatus(
        `Koniec gry: przegrałeś. Wygrał ${winnerName}. Twoje strzały: ${payload.yourShots}, strzały przeciwnika: ${payload.opponentShots}, łącznie ruchów: ${totalShots}. ${reasonMessage}`.trim(),
      );
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
    const payload: SearchJoinPayload = {
      nickname,
    };
    if (reconnectToken) {
      payload.reconnectToken = reconnectToken;
    }
    socket.emit("search:join", payload);
    if (online || inQueue) {
      setStatus("Próba odzyskania połączenia...");
    } else {
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
  const payload: PlaceShipsPayload = {
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
    enemySunkCells: new Set<string>(),
    yourSunkCells: new Set<string>(),
  };
  setStatus("Gra gotowa. Ustaw statki ręcznie albo startuj losowo.");
  render();
};

init();
