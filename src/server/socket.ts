import { Server, Socket } from "socket.io";
import {
  BOARD_SIZE,
  CHAT_EMOJI,
  CHAT_GIF_IDS,
  ChatSendPayload,
  Coord,
  GameCancelPayload,
  GamePlaceShipsPayload,
  GameShotPayload,
  Orientation,
  SearchCancelPayload,
  SearchJoinPayload,
  SerializedBoard,
  ShipType,
} from "../shared";

export interface GameSocketHandlers {
  onConnect?: (socket: Socket) => void | Promise<void>;
  onSearchJoin: (socket: Socket, payload: SearchJoinPayload) => void | Promise<void>;
  onSearchCancel: (socket: Socket, payload: SearchCancelPayload) => void | Promise<void>;
  onGamePlaceShips: (socket: Socket, payload: GamePlaceShipsPayload) => void | Promise<void>;
  onGameShot: (socket: Socket, payload: GameShotPayload) => void | Promise<void>;
  onGameCancel: (socket: Socket, payload: GameCancelPayload) => void | Promise<void>;
  onChatSend: (socket: Socket, payload: ChatSendPayload) => void | Promise<void>;
  onDisconnect: (socket: Socket) => void | Promise<void>;
  onInvalidInput?: (socket: Socket, eventName: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_RECONNECT_TOKEN_LENGTH = 96;
const MAX_NICKNAME_LENGTH = 40;
const MAX_ROOM_ID_LENGTH = 64;
const MAX_SHOT_LIST_ENTRIES = BOARD_SIZE * BOARD_SIZE;
const MAX_SHOT_KEY_LENGTH = 8;
const MAX_CHAT_TEXT_LENGTH = 240;

const normalizeString = (value: unknown, maxLength: number, fallback = ""): string => {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (text.length === 0) return fallback;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
};

const normalizeOptionalString = (value: unknown, maxLength = MAX_NICKNAME_LENGTH): string | undefined => {
  const text = normalizeString(value, maxLength, "");
  return text.length > 0 ? text : undefined;
};

const normalizeRoomId = (value: unknown): string | undefined => {
  const roomId = normalizeString(value, MAX_ROOM_ID_LENGTH, "");
  return roomId;
};

const normalizeInteger = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[-+]?\d+$/.test(trimmed)) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
};

const normalizeFiniteNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return Number.NaN;
};

const normalizeShots = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const maxEntries = Math.max(0, MAX_SHOT_LIST_ENTRIES);
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => (entry.length > MAX_SHOT_KEY_LENGTH ? entry.slice(0, MAX_SHOT_KEY_LENGTH) : entry))
    .slice(0, maxEntries);
};

const isShipType = (value: number): value is ShipType => value === 1 || value === 2 || value === 3 || value === 4;
const isOrientation = (value: unknown): value is Orientation => value === "H" || value === "V";
const isChatKind = (value: unknown): value is "text" | "emoji" | "gif" =>
  value === "text" || value === "emoji" || value === "gif";

const normalizeBoardCandidate = (payload: unknown): SerializedBoard | null => {
  if (!isRecord(payload)) return null;

  const width = normalizeInteger(payload.width) ?? BOARD_SIZE;
  const height = normalizeInteger(payload.height) ?? BOARD_SIZE;
  if (width <= 0 || height <= 0 || width > BOARD_SIZE || height > BOARD_SIZE) return null;

  if (!Array.isArray(payload.ships) || payload.ships.length === 0 || payload.ships.length > 10) return null;

  const ships: GamePlaceShipsPayload["board"]["ships"] = [];
  const seenIds = new Set<string>();
  for (const [index, shipCandidate] of payload.ships.entries()) {
    if (!isRecord(shipCandidate)) return null;

    const type = normalizeInteger(shipCandidate.type);
    if (type === undefined || !isShipType(type)) return null;

    const orientation = shipCandidate.orientation;
    if (!isOrientation(orientation)) return null;

    if (!Array.isArray(shipCandidate.cells) || shipCandidate.cells.length !== type) return null;

    const cells: Coord[] = [];
    for (const cell of shipCandidate.cells) {
      if (!isRecord(cell)) return null;
      const row = normalizeInteger(cell.row);
      const col = normalizeInteger(cell.col);
      if (
        row === undefined ||
        col === undefined ||
        row < 0 ||
        col < 0 ||
        row >= height ||
        col >= width
      ) {
        return null;
      }
      cells.push({ row, col });
    }

    if (cells.length !== type) return null;
    const normalizedId =
      typeof shipCandidate.id === "string" && shipCandidate.id.length > 0 ? shipCandidate.id.slice(0, 32) : `ship-${index}`;
    if (seenIds.has(normalizedId)) return null;
    seenIds.add(normalizedId);

    ships.push({
      id: normalizedId,
      type,
      orientation,
      cells,
      hits: Array.from({ length: cells.length }, () => false),
      sunk: false,
    });
  }

  const shots = Array.isArray(payload.shots)
    ? normalizeShots(payload.shots)
    : [];
  const hits = Array.isArray(payload.hits)
    ? normalizeShots(payload.hits)
    : [];

  return { width, height, ships, shots, hits };
};

const parseSearchJoinPayload = (payload: unknown): SearchJoinPayload | null => {
  if (payload === undefined) return {};
  if (!isRecord(payload)) return null;
  if (Object.prototype.hasOwnProperty.call(payload, "nickname") && typeof payload.nickname !== "string") {
    return null;
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "reconnectToken") &&
    payload.reconnectToken !== undefined &&
    typeof payload.reconnectToken !== "string"
  ) {
    return null;
  }
  return {
    nickname: normalizeOptionalString(payload.nickname, MAX_NICKNAME_LENGTH),
    reconnectToken: normalizeOptionalString(payload.reconnectToken, MAX_RECONNECT_TOKEN_LENGTH),
  };
};

const parseSearchCancelPayload = (payload: unknown): SearchCancelPayload | null => {
  if (payload === undefined) return {};
  if (!isRecord(payload)) return null;
  return {
    roomId: normalizeRoomId(payload.roomId),
  };
};

const parseGamePlaceShipsPayload = (payload: unknown): GamePlaceShipsPayload | null => {
  if (!isRecord(payload)) return null;
  const board = normalizeBoardCandidate(payload.board);
  if (!board) return null;
  return {
    roomId: normalizeRoomId(payload.roomId),
    board,
  };
};

const parseGameShotPayload = (payload: unknown): GameShotPayload | null => {
  if (!isRecord(payload)) return null;
  const coordValue = payload.coord;
  const coord = {
    row: isRecord(coordValue) ? normalizeFiniteNumber(coordValue.row) : Number.NaN,
    col: isRecord(coordValue) ? normalizeFiniteNumber(coordValue.col) : Number.NaN,
  };
  return {
    roomId: normalizeRoomId(payload.roomId),
    coord,
  };
};

const parseGameCancelPayload = (payload: unknown): GameCancelPayload | null => {
  if (payload === undefined) return {};
  if (!isRecord(payload)) return null;
  return {
    roomId: normalizeRoomId(payload.roomId),
  };
};

const parseChatSendPayload = (payload: unknown): ChatSendPayload | null => {
  if (!isRecord(payload)) return null;
  if (!isChatKind(payload.kind)) return null;
  const kind = payload.kind;
  const roomId = normalizeRoomId(payload.roomId);
  if (kind === "text") {
    if (typeof payload.text !== "string") return null;
    const text = payload.text.trim();
    if (text.length === 0 || text.length > MAX_CHAT_TEXT_LENGTH) return null;
    return {
      roomId,
      kind,
      text,
    };
  }
  if (kind === "emoji") {
    if (typeof payload.emoji !== "string") return null;
    if (!CHAT_EMOJI.includes(payload.emoji as (typeof CHAT_EMOJI)[number])) return null;
    return {
      roomId,
      kind,
      emoji: payload.emoji,
    };
  }
  if (typeof payload.gifId !== "string") return null;
  if (!CHAT_GIF_IDS.includes(payload.gifId as (typeof CHAT_GIF_IDS)[number])) return null;
  return {
    roomId,
    kind,
    gifId: payload.gifId,
  };
};

type PayloadParser<T> = (payload: unknown) => T | null;

const safeHandle = <T>(
  socket: Socket,
  eventName: string,
  handlers: GameSocketHandlers,
  parser: PayloadParser<T>,
  handler: (payload: T) => void | Promise<void>,
  payload: unknown,
  invalidMessage?: string,
  invalidCode = "invalid_payload",
): Promise<void> => {
  const parsed = parser(payload === undefined ? {} : payload);
  if (parsed === null) {
    handlers.onInvalidInput?.(socket, eventName);
    socket.emit("game:error", {
      code: invalidCode,
      message: invalidMessage ?? "Nieprawidłowe dane wejściowe.",
    });
    return Promise.resolve();
  }
  return Promise.resolve(handler(parsed)).catch(() => {
    socket.emit("game:error", { message: "Nie udało się obsłużyć zdarzenia." });
  });
};

export const registerSocketHandlers = (io: Server, handlers: GameSocketHandlers): void => {
  io.on("connection", (socket) => {
    if (handlers.onConnect) {
      void handlers.onConnect(socket);
    }

    socket.on("search:join", (payload) => {
      void safeHandle(
        socket,
        "search:join",
        handlers,
        parseSearchJoinPayload,
        (body) => handlers.onSearchJoin(socket, body),
        payload,
        "Nieprawidłowe dane dołączenia.",
      );
    });

    socket.on("search:cancel", (payload) => {
      void safeHandle(
        socket,
        "search:cancel",
        handlers,
        parseSearchCancelPayload,
        (body) => handlers.onSearchCancel(socket, body),
        payload,
        "Nieprawidłowe dane anulowania.",
      );
    });

    socket.on("game:place_ships", (payload) => {
      void safeHandle(
        socket,
        "game:place_ships",
        handlers,
        parseGamePlaceShipsPayload,
        (body) => handlers.onGamePlaceShips(socket, body),
        payload,
        "Nieprawidłowe dane ustawienia statków.",
      );
    });

    socket.on("game:shot", (payload) => {
      void safeHandle(
        socket,
        "game:shot",
        handlers,
        parseGameShotPayload,
        (body) => handlers.onGameShot(socket, body),
        payload,
        "Nieprawidłowe dane strzału.",
      );
    });

    socket.on("game:cancel", (payload) => {
      void safeHandle(
        socket,
        "game:cancel",
        handlers,
        parseGameCancelPayload,
        (body) => handlers.onGameCancel(socket, body),
        payload,
        "Nieprawidłowe dane anulowania gry.",
      );
    });

    socket.on("chat:send", (payload) => {
      void safeHandle(
        socket,
        "chat:send",
        handlers,
        parseChatSendPayload,
        (body) => handlers.onChatSend(socket, body),
        payload,
        "Nieprawidłowe dane czatu.",
        "chat_invalid_payload",
      );
    });

    socket.on("disconnect", () => {
      void handlers.onDisconnect(socket);
    });
  });
};
