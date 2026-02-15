import "dotenv/config";
import express, { Request, Response } from "express";
import path from "path";
import { createServer } from "http";
import { randomBytes } from "node:crypto";
import { Server, Socket } from "socket.io";
import helmet from "helmet";
import { registerSocketHandlers } from "./socket";
import { createRuntimeServices } from "./runtime";
import { RoomSnapshot } from "./stores/interfaces";
import {
  BoardModel,
  Coord,
  BOARD_SIZE,
  Orientation,
  ShipType,
  createEmptyBoard,
  createAiState,
  coordToKey,
  fireShot,
  inBounds,
  placeFleetRandomly,
  registerAiShot,
  nextShot,
  serializeBoard,
  deserializeBoard,
  validateFleet,
  GamePlaceShipsPayload,
  GameShotPayload,
  SearchJoinPayload,
  SearchCancelPayload,
  GameCancelPayload,
  GameCancelledPayload,
} from "../shared";
import {
  QueueEntry,
  joinQueue,
  leaveQueue,
  parkQueue,
  cleanupParkedQueue,
  getQueueEntry,
  getQueueEntryByToken,
  cleanupExpiredTokens,
  tickTimeouts,
  takeMatch,
  getRoomIdForToken,
  getMatchmakingStats,
  getQueuedPlayerIds,
  getParkedPlayerIds,
  registerRoomToken,
  unregisterRoomToken,
  reserveToken,
} from "./matchmaking";

const PORT = Number(process.env.PORT ?? 3000);

const parseTimeoutMs = (value: string | undefined, fallback: number): number => {
  const sanitized = (value ?? "").replace(/_/g, "");
  const parsed = Number.parseInt(sanitized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const MATCH_TIMEOUT_MS = parseTimeoutMs(process.env.MATCH_TIMEOUT_MS, 60_000);
const ROOM_INACTIVITY_TIMEOUT_MS = parseTimeoutMs(process.env.ROOM_INACTIVITY_TIMEOUT_MS, 10 * 60_000);
const ROOM_RECONNECT_GRACE_MS = parseTimeoutMs(process.env.ROOM_RECONNECT_GRACE_MS, 3_000);
const RECONNECT_TOKEN_TTL_MS = parseTimeoutMs(process.env.RECONNECT_TOKEN_TTL_MS, 60 * 60_000);
const READY_CACHE_MS = parseTimeoutMs(process.env.READY_CACHE_MS, 250);
const SOCKET_PRESENCE_TTL_MS = parseTimeoutMs(process.env.SOCKET_PRESENCE_TTL_MS, 45_000);
const SOCKET_PRESENCE_REFRESH_MS = parseTimeoutMs(process.env.SOCKET_PRESENCE_REFRESH_MS, 15_000);
const SOCKET_MAX_PAYLOAD_BYTES = parseTimeoutMs(process.env.SOCKET_MAX_PAYLOAD_BYTES, 128_000);
const REQUIRE_ORIGIN_HEADER = /^(1|true|yes)$/i.test(process.env.REQUIRE_ORIGIN_HEADER ?? "");
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const TRUST_PROXY_RAW = (process.env.TRUST_PROXY ?? "").trim();
const TRUST_PROXY_ENABLED = TRUST_PROXY_RAW.length > 0 && !/^(0|false|no)$/i.test(TRUST_PROXY_RAW);
const REDIS_REQUIRED = /^(1|true|yes)$/i.test(process.env.REDIS_REQUIRED ?? "");
const DATABASE_REQUIRED = /^(1|true|yes)$/i.test(process.env.DATABASE_REQUIRED ?? "");
const TRUST_PROXY_SETTING: boolean | number | string =
  !TRUST_PROXY_ENABLED
    ? false
    : /^(1|true|yes)$/i.test(TRUST_PROXY_RAW)
      ? true
      : /^\d+$/.test(TRUST_PROXY_RAW)
        ? Number.parseInt(TRUST_PROXY_RAW, 10)
        : TRUST_PROXY_RAW;

const MAINTENANCE_INTERVAL_MS = 250;
const MATCH_TIMEOUT_EFFECTIVE_MS = Math.min(MATCH_TIMEOUT_MS, ROOM_INACTIVITY_TIMEOUT_MS);
const runtimeServices = createRuntimeServices();
const QUEUE_ENTRY_TTL_MS = parseTimeoutMs(
  process.env.QUEUE_ENTRY_TTL_MS,
  Math.max(RECONNECT_TOKEN_TTL_MS, MATCH_TIMEOUT_EFFECTIVE_MS * 2),
);
const QUEUE_PARKED_TTL_MS = parseTimeoutMs(
  process.env.QUEUE_PARKED_TTL_MS,
  Math.max(RECONNECT_TOKEN_TTL_MS, MATCH_TIMEOUT_EFFECTIVE_MS * 2),
);

const normalizeOriginValue = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "*") return "*";
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
};

const parseCorsOrigins = (): string[] => {
  if (!process.env.CORS_ORIGINS) {
    if (process.env.NODE_ENV === "test") {
      return ["*"];
    }
    return ["http://localhost:3000", "http://127.0.0.1:3000"];
  }
  const values = CORS_ORIGINS
    .map((value) => (value.toLowerCase() === "any" ? "*" : value))
    .map(normalizeOriginValue)
    .filter(Boolean);
  if (values.length === 0) return [];
  if (process.env.NODE_ENV === "production" && values.includes("*")) {
    return [];
  }
  return values;
};

const resolveCorsConfig = () => {
  const parsedOrigins = parseCorsOrigins();
  const allowAll = parsedOrigins.includes("*");
  const allowedOrigins = new Set(parsedOrigins.filter((origin) => origin !== "*"));

  const isAllowedOrigin = (originHeader: string | undefined): boolean => {
    if (allowAll) return true;
    if (!originHeader) return !REQUIRE_ORIGIN_HEADER;
    const normalized = normalizeOriginValue(originHeader);
    if (!normalized || normalized === "*") return false;
    return allowedOrigins.has(normalized);
  };

  return {
    allowAll,
    allowedOrigins: [...allowedOrigins],
    isAllowedOrigin,
  };
};

const corsConfig = resolveCorsConfig();
if (process.env.NODE_ENV === "production" && !corsConfig.allowAll && corsConfig.allowedOrigins.length === 0) {
  // eslint-disable-next-line no-console
  console.warn("[security] CORS_ORIGINS is empty in production; socket handshakes will be rejected.");
}

const RATE_LIMITS = {
  SHOT_PER_WINDOW: parseTimeoutMs(process.env.RATE_LIMIT_SHOT_PER_WINDOW, 90),
  JOIN_PER_WINDOW: parseTimeoutMs(process.env.RATE_LIMIT_JOIN_PER_WINDOW, 8),
  RECONNECT_JOIN_PER_WINDOW: parseTimeoutMs(process.env.RATE_LIMIT_RECONNECT_JOIN_PER_WINDOW, 12),
  GAME_CANCEL_PER_WINDOW: parseTimeoutMs(process.env.RATE_LIMIT_GAME_CANCEL_PER_WINDOW, 8),
  SEARCH_CANCEL_PER_WINDOW: parseTimeoutMs(process.env.RATE_LIMIT_SEARCH_CANCEL_PER_WINDOW, 8),
  PLACE_SHIPS_PER_WINDOW: parseTimeoutMs(process.env.RATE_LIMIT_PLACE_SHIPS_PER_WINDOW, 20),
  SHOT_WINDOW_MS: parseTimeoutMs(process.env.RATE_LIMIT_SHOT_WINDOW_MS, 1_000),
  JOIN_WINDOW_MS: parseTimeoutMs(process.env.RATE_LIMIT_JOIN_WINDOW_MS, 1_500),
  PLACE_SHIPS_WINDOW_MS: parseTimeoutMs(process.env.RATE_LIMIT_PLACE_SHIPS_WINDOW_MS, 1_500),
};
const INVALID_INPUT_LIMIT = parseTimeoutMs(process.env.INVALID_INPUT_LIMIT_PER_WINDOW, 12);
const INVALID_INPUT_WINDOW_MS = parseTimeoutMs(process.env.INVALID_INPUT_WINDOW_MS, 10_000);
const INVALID_INPUT_BAN_MS = parseTimeoutMs(process.env.INVALID_INPUT_BAN_MS, 30_000);
type RateState = {
  windowStart: number;
  count: number;
  lastSeen: number;
};
type InvalidInputState = {
  windowStart: number;
  count: number;
  bannedUntil: number;
  lastSeen: number;
};
const actionRate = new Map<string, RateState>();
const invalidInputRate = new Map<string, InvalidInputState>();
let lastPresenceRefreshTs = 0;
const makeRateBucketKey = (identity: string, action: string) => `${identity}::${action}`;
const isRateLimited = (identity: string, action: string, max: number, windowMs: number): boolean => {
  const now = Date.now();
  const key = makeRateBucketKey(identity, action);
  let bucket = actionRate.get(key);
  if (!bucket) {
    bucket = { count: 1, windowStart: now, lastSeen: now };
    actionRate.set(key, bucket);
    return false;
  }

  if (now - bucket.windowStart >= windowMs) {
    bucket.windowStart = now;
    bucket.count = 1;
  } else {
    bucket.count += 1;
  }

  bucket.lastSeen = now;
  return bucket.count > max;
};
const isRateLimitedByIdentity = async (socket: Socket, action: string, max: number, windowMs: number): Promise<boolean> => {
  const socketLimited = isRateLimited(socket.id, action, max, windowMs);
  const ip = socketIpAddress(socket);
  const ipLimited = ip ? isRateLimited(`ip:${ip}`, action, max * 4, windowMs * 4) : false;
  if (socketLimited || ipLimited) return true;
  if (!runtimeServices.redisLimiter.isEnabled) return false;
  const redisSocketLimited = await runtimeServices.redisLimiter.consume(
    `socket:${socket.id}:${action}`,
    max,
    windowMs,
  );
  const redisIpLimited = ip
    ? await runtimeServices.redisLimiter.consume(`ip:${ip}:${action}`, max * 4, windowMs * 4)
    : false;
  return redisSocketLimited || redisIpLimited;
};

const makeInvalidKey = (socket: Socket): string => {
  const ip = socketIpAddress(socket);
  return `${socket.id}::${ip}`;
};

const noteInvalidInput = (socket: Socket): void => {
  const now = Date.now();
  const key = makeInvalidKey(socket);
  const current = invalidInputRate.get(key);
  if (!current) {
    invalidInputRate.set(key, {
      windowStart: now,
      count: 1,
      bannedUntil: 0,
      lastSeen: now,
    });
    return;
  }
  if (now - current.windowStart >= INVALID_INPUT_WINDOW_MS) {
    current.windowStart = now;
    current.count = 1;
  } else {
    current.count += 1;
  }
  current.lastSeen = now;
  if (current.count > INVALID_INPUT_LIMIT) {
    current.bannedUntil = now + INVALID_INPUT_BAN_MS;
    recordSecurityEvent("payload_soft_ban_activated", {
      socketId: socket.id,
      ip: socketIpAddress(socket),
      bannedUntil: current.bannedUntil,
    });
  }
};

const isSoftBanned = (socket: Socket): boolean => {
  const now = Date.now();
  const key = makeInvalidKey(socket);
  const current = invalidInputRate.get(key);
  if (!current) return false;
  if (current.bannedUntil <= now) return false;
  return true;
};

const guardSoftBan = (socket: Socket): boolean => {
  if (!isSoftBanned(socket)) return false;
  recordSecurityEvent("payload_soft_ban_blocked", {
    socketId: socket.id,
    ip: socketIpAddress(socket),
  });
  socket.emit("game:error", {
    code: "soft_ban",
    message: "Zbyt wiele błędnych żądań. Spróbuj ponownie za chwilę.",
  });
  return true;
};

const clearRateState = (socketId: string): void => {
  const prefix = `${socketId}::`;
  for (const key of actionRate.keys()) {
    if (key.startsWith(prefix)) {
      actionRate.delete(key);
    }
  }
};
const clearInvalidInputState = (socketId: string): void => {
  const prefix = `${socketId}::`;
  for (const key of invalidInputRate.keys()) {
    if (key.startsWith(prefix)) {
      invalidInputRate.delete(key);
    }
  }
};
const cleanupRateState = (now = Date.now()): void => {
  const ttlMs = Math.max(
    RATE_LIMITS.SHOT_WINDOW_MS,
    RATE_LIMITS.JOIN_WINDOW_MS,
    RATE_LIMITS.PLACE_SHIPS_WINDOW_MS,
  ) * 8;
  for (const [key, state] of actionRate.entries()) {
    if (now - state.lastSeen > ttlMs) {
      actionRate.delete(key);
    }
  }
};
const cleanupInvalidInputState = (now = Date.now()): void => {
  const ttlMs = Math.max(INVALID_INPUT_WINDOW_MS, INVALID_INPUT_BAN_MS) * 4;
  for (const [key, state] of invalidInputRate.entries()) {
    if (now - state.lastSeen > ttlMs && state.bannedUntil <= now) {
      invalidInputRate.delete(key);
    }
  }
};
const normalizeIp = (value: string | undefined): string => {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^::ffff:/, "");
};
const socketIpAddress = (socket: Socket): string => {
  if (TRUST_PROXY_ENABLED) {
    const xForwarded = socket.handshake.headers["x-forwarded-for"];
    if (typeof xForwarded === "string" && xForwarded.length > 0) {
      const first = normalizeIp(xForwarded.split(",")[0]);
      if (first) return first;
    }
  }
  const direct = normalizeIp(socket.handshake.address);
  return direct || "unknown";
};

const recordSecurityEvent = (eventType: string, payload: Record<string, unknown>): void => {
  runtimeServices.telemetry.recordSecurityEvent(eventType, payload);
};

const recordMatchEvent = (roomId: string, eventType: string, payload: Record<string, unknown>): void => {
  runtimeServices.telemetry.recordMatchEvent(roomId, eventType, payload);
};

const toRoomSnapshot = (room: GameRoom): RoomSnapshot => ({
  roomId: room.roomId,
  vsBot: room.vsBot,
  botId: room.botId,
  phase: room.phase,
  status: room.status,
  players: [...room.players],
  nicknames: room.nicknames,
  turn: room.turn,
  winner: room.winner,
  over: room.over,
  createdAt: room.createdAt,
  lastActionTs: room.lastActionTs,
  boards: Object.fromEntries(
    Object.entries(room.boards).map(([playerId, board]) => [playerId, serializeBoard(board, true)]),
  ),
  reconnectTokens: room.reconnectTokens,
  tokenToPlayerId: room.tokenToPlayerId,
  disconnectedAtByToken: room.disconnectedAtByToken,
  readyPlayers: [...room.readyPlayers],
  shotCounters: room.shotCounters,
});

const persistRoomSnapshot = (room: GameRoom): void => {
  if (!runtimeServices.redisState.isEnabled) return;
  void runtimeServices.redisState.upsertRoomSnapshot(toRoomSnapshot(room));
};

const persistRoomSnapshotNow = async (room: GameRoom): Promise<void> => {
  if (!runtimeServices.redisState.isEnabled) return;
  await runtimeServices.redisState.upsertRoomSnapshot(toRoomSnapshot(room));
};

const persistTokenRoomMap = (token: string, roomId: string): void => {
  if (!runtimeServices.redisState.isEnabled || !token) return;
  void runtimeServices.redisState.mapTokenToRoom(token, roomId, RECONNECT_TOKEN_TTL_MS);
};

const deleteTokenRoomMap = (token: string): void => {
  if (!runtimeServices.redisState.isEnabled || !token) return;
  void runtimeServices.redisState.unmapToken(token);
};

const touchSocketPresence = (socketId: string): void => {
  if (!runtimeServices.redisState.isEnabled || !socketId) return;
  void runtimeServices.redisState.touchSocketPresence(socketId, SOCKET_PRESENCE_TTL_MS);
};

const touchSocketPresenceNow = async (socketId: string): Promise<void> => {
  if (!runtimeServices.redisState.isEnabled || !socketId) return;
  await runtimeServices.redisState.touchSocketPresence(socketId, SOCKET_PRESENCE_TTL_MS);
};

const clearSocketPresence = async (socketId: string): Promise<void> => {
  if (!runtimeServices.redisState.isEnabled || !socketId) return;
  await runtimeServices.redisState.clearSocketPresence(socketId);
};

const isSocketOnline = async (socketId: string): Promise<boolean> => {
  if (!socketId) return false;
  if (io.sockets.sockets.has(socketId)) return true;
  if (!runtimeServices.redisState.isEnabled) return false;
  return runtimeServices.redisState.isSocketPresent(socketId);
};

const shouldIgnoreRemotePresenceAfterGracefulRestart = async (socketId: string): Promise<boolean> => {
  if (!socketId) return false;
  if (io.sockets.sockets.has(socketId)) return false;
  if (SOCKET_PRESENCE_TTL_MS >= 10_000) {
    return true;
  }
  if (!runtimeServices.redisState.isEnabled) return false;
  return runtimeServices.redisState.hasRecentGracefulShutdown();
};

const persistQueueEntry = (entry: QueueEntry): void => {
  if (!runtimeServices.redisQueue.isEnabled) return;
  void runtimeServices.redisQueue.upsertQueueEntry(entry, QUEUE_ENTRY_TTL_MS);
};

const persistQueueEntryNow = async (entry: QueueEntry): Promise<void> => {
  if (!runtimeServices.redisQueue.isEnabled) return;
  await runtimeServices.redisQueue.upsertQueueEntry(entry, QUEUE_ENTRY_TTL_MS);
};

const deleteQueueEntry = (playerId: string, reconnectToken?: string): void => {
  if (!runtimeServices.redisQueue.isEnabled) return;
  void runtimeServices.redisQueue.removeQueueEntry(playerId, reconnectToken);
};

const persistParkedQueueEntry = (entry: QueueEntry): void => {
  if (!runtimeServices.redisQueue.isEnabled) return;
  void runtimeServices.redisQueue.upsertParkedEntry(entry, QUEUE_PARKED_TTL_MS);
};

const deleteParkedQueueEntry = (reconnectToken: string): void => {
  if (!runtimeServices.redisQueue.isEnabled) return;
  void runtimeServices.redisQueue.removeParkedEntry(reconnectToken);
};

const getQueueEntryForPlayerId = async (playerId: string): Promise<QueueEntry | undefined> => {
  const local = getQueueEntry(playerId);
  if (local) return local;
  if (!runtimeServices.redisQueue.isEnabled) return undefined;
  const persisted = await runtimeServices.redisQueue.getQueueEntryByPlayerId(playerId);
  if (!persisted) return undefined;
  const restored = joinQueue(
    playerId,
    persisted.nickname,
    persisted.joinedAt,
    persisted.reconnectToken,
  );
  persistQueueEntry(restored);
  return restored;
};

const getActiveQueueEntryForToken = async (token: string): Promise<QueueEntry | undefined> => {
  const local = getQueueEntryByToken(token);
  if (local) return local;
  if (!runtimeServices.redisQueue.isEnabled) return undefined;
  const persisted = await runtimeServices.redisQueue.getQueueEntryByToken(token);
  if (!persisted) return undefined;
  return persisted;
};

const restoreRoomFromSnapshot = (snapshot: RoomSnapshot): GameRoom => {
  const room: GameRoom = {
    roomId: snapshot.roomId,
    status: snapshot.status,
    players: [...snapshot.players],
    nicknames: { ...snapshot.nicknames },
    boards: Object.fromEntries(
      Object.entries(snapshot.boards).map(([playerId, board]) => [playerId, deserializeBoard(board)]),
    ),
    shotCounters: { ...snapshot.shotCounters },
    turn: snapshot.turn,
    vsBot: snapshot.vsBot,
    botId: snapshot.botId,
    phase: snapshot.phase,
    winner: snapshot.winner,
    over: snapshot.over,
    createdAt: snapshot.createdAt,
    lastActionTs: snapshot.lastActionTs,
    reconnectTokens: { ...snapshot.reconnectTokens },
    tokenToPlayerId: { ...snapshot.tokenToPlayerId },
    disconnectedAtByToken: { ...snapshot.disconnectedAtByToken },
    readyPlayers: new Set(snapshot.readyPlayers),
    aiState: snapshot.vsBot ? createAiState() : undefined,
  };
  return room;
};

const hydrateRoomFromRedis = async (roomId: string): Promise<GameRoom | null> => {
  if (!runtimeServices.redisState.isEnabled) return null;
  const existing = rooms.get(roomId);
  if (existing) return existing;
  const snapshot = await runtimeServices.redisState.getRoomSnapshot(roomId);
  if (!snapshot) return null;
  const restored = restoreRoomFromSnapshot(snapshot);
  rooms.set(restored.roomId, restored);
  for (const token of Object.keys(restored.tokenToPlayerId)) {
    registerRoomToken(token, restored.roomId);
    persistTokenRoomMap(token, restored.roomId);
  }
  for (const playerId of restored.players) {
    if (io.sockets.sockets.has(playerId)) {
      playerRooms.set(playerId, restored.roomId);
    }
  }
  recordMatchEvent(restored.roomId, "room_restored_from_redis", {
    roomId: restored.roomId,
    players: restored.players,
    at: Date.now(),
  });
  return restored;
};

const hydrateRoomFromRedisOnce = async (roomId: string): Promise<GameRoom | null> => {
  const existing = rooms.get(roomId);
  if (existing) return existing;
  const inFlight = roomHydrationInFlight.get(roomId);
  if (inFlight) return inFlight;
  const hydratePromise = (async () => {
    try {
      return await hydrateRoomFromRedis(roomId);
    } finally {
      roomHydrationInFlight.delete(roomId);
    }
  })();
  roomHydrationInFlight.set(roomId, hydratePromise);
  return hydratePromise;
};

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY_SETTING);
const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: Math.max(16_384, SOCKET_MAX_PAYLOAD_BYTES),
  cors: {
    origin: corsConfig.allowAll ? "*" : corsConfig.allowedOrigins,
  },
  allowRequest: (req, callback) => {
    const originHeader = req.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (corsConfig.isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }
    if (process.env.NODE_ENV !== "test") {
      const safeOrigin = typeof origin === "string" ? origin.slice(0, 128) : "unknown";
      const remote = req.socket.remoteAddress ?? "unknown";
      // eslint-disable-next-line no-console
      console.warn(`[security] rejected socket origin origin=${safeOrigin} remote=${remote}`);
      recordSecurityEvent("socket_origin_rejected", {
        origin: safeOrigin,
        ip: remote,
      });
    }
    callback("Origin not allowed", false);
  },
});

type PlayerId = string;
type RoomStatus = "setup" | "active" | "ended" | "cancelled";

interface GameRoom {
  roomId: string;
  status: RoomStatus;
  players: PlayerId[];
  nicknames: Record<PlayerId, string>;
  boards: Record<PlayerId, BoardModel>;
  shotCounters: Record<PlayerId, number>;
  turn: PlayerId;
  vsBot: boolean;
  botId?: PlayerId;
  phase: "setup" | "playing" | "over";
  winner?: PlayerId;
  over: boolean;
  createdAt: number;
  lastActionTs: number;
  reconnectTokens: Record<PlayerId, string>;
  tokenToPlayerId: Record<string, PlayerId>;
  disconnectedAtByToken: Record<string, number>;
  aiState?: ReturnType<typeof createAiState>;
  readyPlayers: Set<PlayerId>;
}

const rooms = new Map<string, GameRoom>();
const playerRooms = new Map<PlayerId, string>();
const roomHydrationInFlight = new Map<string, Promise<GameRoom | null>>();

const PUBLIC_DIR = path.join(process.cwd(), "public");

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(express.json({ limit: "64kb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/assets/shared/:name", (req, res) => {
  const allowedModules = new Set(["game", "ai", "types", "index"]);
  const moduleName = req.params.name.replace(/\.js$/, "");
  if (!moduleName || !allowedModules.has(moduleName)) {
    res.status(404).send("Not found");
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, "assets", "shared", `${moduleName}.js`));
});

const applyNoStoreHeaders = (res: Response): void => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
};

const healthHandler = (_req: Request, res: Response): void => {
  applyNoStoreHeaders(res);
  const stats = getMatchmakingStats();
  res.status(200).json({
    status: "ok",
    uptimeSec: Math.floor(process.uptime()),
    timestamp: Date.now(),
    rooms: {
      active: rooms.size,
      playersBound: playerRooms.size,
    },
    matchmaking: stats,
    runtime: {
      redisQueue: runtimeServices.redisQueue.isEnabled,
      redisState: runtimeServices.redisState.isEnabled,
      redisLimiter: runtimeServices.redisLimiter.isEnabled,
      telemetry: runtimeServices.telemetry.isEnabled,
    },
  });
};

type ReadyDependencyInfo = {
  enabled: boolean;
  reachable: boolean;
};

type ReadyDependencies = {
  redisQueue: ReadyDependencyInfo;
  redisState: ReadyDependencyInfo;
  redisLimiter: ReadyDependencyInfo;
  telemetry: ReadyDependencyInfo;
};

type ReadySnapshot = {
  statusCode: 200 | 503;
  payload: {
    status: "ready" | "not_ready";
    dependencies: ReadyDependencies;
    missing?: string[];
  };
};

let readySnapshotTs = 0;
let readySnapshot: ReadySnapshot | null = null;

const readyHandler = async (_req: Request, res: Response): Promise<void> => {
  applyNoStoreHeaders(res);
  if (READY_CACHE_MS > 0 && readySnapshot && Date.now() - readySnapshotTs <= READY_CACHE_MS) {
    res.status(readySnapshot.statusCode).json(readySnapshot.payload);
    return;
  }

  const [redisQueueReachable, redisStateReachable, redisLimiterReachable, telemetryReachable] = await Promise.all([
    runtimeServices.redisQueue.isEnabled ? runtimeServices.redisQueue.ping() : Promise.resolve(false),
    runtimeServices.redisState.isEnabled ? runtimeServices.redisState.ping() : Promise.resolve(false),
    runtimeServices.redisLimiter.isEnabled ? runtimeServices.redisLimiter.ping() : Promise.resolve(false),
    runtimeServices.telemetry.isEnabled ? runtimeServices.telemetry.ping() : Promise.resolve(false),
  ]);
  const dependencies: ReadyDependencies = {
    redisQueue: {
      enabled: runtimeServices.redisQueue.isEnabled,
      reachable: redisQueueReachable,
    },
    redisState: {
      enabled: runtimeServices.redisState.isEnabled,
      reachable: redisStateReachable,
    },
    redisLimiter: {
      enabled: runtimeServices.redisLimiter.isEnabled,
      reachable: redisLimiterReachable,
    },
    telemetry: {
      enabled: runtimeServices.telemetry.isEnabled,
      reachable: telemetryReachable,
    },
  };
  const missing: string[] = [];
  if (REDIS_REQUIRED) {
    if (!dependencies.redisQueue.enabled || !dependencies.redisQueue.reachable) missing.push("redisQueue");
    if (!dependencies.redisState.enabled || !dependencies.redisState.reachable) missing.push("redisState");
    if (!dependencies.redisLimiter.enabled || !dependencies.redisLimiter.reachable) missing.push("redisLimiter");
  }
  if (DATABASE_REQUIRED && (!dependencies.telemetry.enabled || !dependencies.telemetry.reachable)) {
    missing.push("telemetry");
  }
  if (missing.length > 0) {
    const payload: ReadySnapshot["payload"] = {
      status: "not_ready",
      dependencies,
      missing,
    };
    readySnapshot = {
      statusCode: 503,
      payload,
    };
    readySnapshotTs = Date.now();
    res.status(503).json(payload);
    return;
  }
  const payload: ReadySnapshot["payload"] = {
    status: "ready",
    dependencies,
  };
  readySnapshot = {
    statusCode: 200,
    payload,
  };
  readySnapshotTs = Date.now();
  res.status(200).json(payload);
};

const metricsHandler = (_req: Request, res: Response): void => {
  applyNoStoreHeaders(res);
  const stats = getMatchmakingStats();
  const lines = [
    "# HELP battleship_uptime_seconds Process uptime in seconds.",
    "# TYPE battleship_uptime_seconds gauge",
    `battleship_uptime_seconds ${Math.floor(process.uptime())}`,
    "# HELP battleship_rooms_active Number of active rooms in memory.",
    "# TYPE battleship_rooms_active gauge",
    `battleship_rooms_active ${rooms.size}`,
    "# HELP battleship_players_bound Number of socket-to-room bindings.",
    "# TYPE battleship_players_bound gauge",
    `battleship_players_bound ${playerRooms.size}`,
    "# HELP battleship_matchmaking_queue_size Number of players waiting in queue.",
    "# TYPE battleship_matchmaking_queue_size gauge",
    `battleship_matchmaking_queue_size ${stats.queueSize}`,
    "# HELP battleship_matchmaking_parked_size Number of parked queue entries.",
    "# TYPE battleship_matchmaking_parked_size gauge",
    `battleship_matchmaking_parked_size ${stats.parkedSize}`,
    "# HELP battleship_matchmaking_token_leases Number of active reconnect token leases.",
    "# TYPE battleship_matchmaking_token_leases gauge",
    `battleship_matchmaking_token_leases ${stats.tokenLeaseSize}`,
    "# HELP battleship_runtime_dependency_enabled Runtime dependency health flags.",
    "# TYPE battleship_runtime_dependency_enabled gauge",
    `battleship_runtime_dependency_enabled{name="redisQueue"} ${runtimeServices.redisQueue.isEnabled ? 1 : 0}`,
    `battleship_runtime_dependency_enabled{name="redisState"} ${runtimeServices.redisState.isEnabled ? 1 : 0}`,
    `battleship_runtime_dependency_enabled{name="redisLimiter"} ${runtimeServices.redisLimiter.isEnabled ? 1 : 0}`,
    `battleship_runtime_dependency_enabled{name="telemetry"} ${runtimeServices.telemetry.isEnabled ? 1 : 0}`,
  ];
  res.type("text/plain; charset=utf-8");
  res.status(200).send(`${lines.join("\n")}\n`);
};

app.get("/health", healthHandler);
app.post("/health", healthHandler);
app.get("/ready", readyHandler);
app.post("/ready", readyHandler);
app.get("/metrics", metricsHandler);
app.post("/metrics", metricsHandler);

const makeRoomId = () => `room-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;

const botIdFor = (roomId: string) => `bot-${roomId}`;

const getRoomForPlayer = (playerId: PlayerId): GameRoom | null => {
  const roomId = playerRooms.get(playerId);
  if (!roomId) return null;
  return rooms.get(roomId) ?? null;
};

const ROOM_ID_MAX_LENGTH = 64;
const RECONNECT_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;
const NICKNAME_MAX_LENGTH = 40;
const ROOM_ID_PATTERN = /^room-[a-z0-9]+-[a-z0-9]+$/i;
const SHIP_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_BOARD_DIMENSION = BOARD_SIZE;
const MAX_SHIPS_PER_BOARD = 10;
const MAX_CELLS_PER_SHIP = 10;
const MIN_CELLS_PER_SHIP = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeRelayText = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length === 0 ? "" : trimmed.slice(0, maxLength);
};

const normalizeRoomId = (value: unknown): string => {
  const normalized = normalizeRelayText(value, ROOM_ID_MAX_LENGTH);
  if (!ROOM_ID_PATTERN.test(normalized)) return "";
  return normalized;
};

const normalizeReconnectToken = (token: unknown): string => {
  const normalized = normalizeRelayText(token, 96).trim();
  if (!RECONNECT_TOKEN_PATTERN.test(normalized)) return "";
  return normalized;
};

const sanitizeNickname = (value: unknown): string => {
  const normalized = normalizeRelayText(value, NICKNAME_MAX_LENGTH);
  return normalized.length > 0 ? normalized : "Gracz";
};

const normalizeCoordValue = (value: unknown): number => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isInteger(parsed)) {
        return parsed;
      }
    }
  }
  return Number.NaN;
};

const parseCoord = (value: unknown): Coord | null => {
  if (!isRecord(value)) return null;
  const row = normalizeCoordValue(value.row);
  const col = normalizeCoordValue(value.col);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
  if (row < 0 || col < 0 || row >= MAX_BOARD_DIMENSION || col >= MAX_BOARD_DIMENSION) return null;
  return { row, col };
};

const isShipType = (value: number): value is ShipType => value === 1 || value === 2 || value === 3 || value === 4;
const isOrientation = (value: unknown): value is Orientation =>
  value === "H" || value === "V";

const resolveReconnectToken = (requested?: string): string => reserveToken(requested || undefined);

const getRoomByReconnectToken = async (token?: string): Promise<GameRoom | null> => {
  const normalized = normalizeReconnectToken(token);
  if (!normalized) return null;
  if (runtimeServices.redisState.isEnabled) {
    const redisRoomId = await runtimeServices.redisState.resolveRoomByToken(normalized);
    if (redisRoomId) {
      const existing = rooms.get(redisRoomId);
      if (existing) return existing;
      return hydrateRoomFromRedisOnce(redisRoomId);
    }
  }
  const memoryRoomId = getRoomIdForToken(normalized);
  if (memoryRoomId) {
    const existing = rooms.get(memoryRoomId);
    if (existing) return existing;
    return hydrateRoomFromRedisOnce(memoryRoomId);
  }
  return null;
};

const isReconnectWindowExpired = (room: GameRoom, token: string): boolean => {
  const disconnectedAt = room.disconnectedAtByToken[token];
  if (!disconnectedAt) return false;
  return Date.now() - disconnectedAt > ROOM_RECONNECT_GRACE_MS;
};

const normalizeBoardFromClient = (incoming: unknown): BoardModel => {
  if (!incoming || typeof incoming !== "object") {
    throw new Error("Invalid board payload");
  }

  const raw = incoming as Partial<Record<string, unknown>>;
  const width = Number.parseInt(String(raw.width ?? BOARD_SIZE), 10);
  const height = Number.parseInt(String(raw.height ?? BOARD_SIZE), 10);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > BOARD_SIZE ||
    height > BOARD_SIZE
  ) {
    throw new Error("Invalid board dimensions");
  }

  const rawShips = Array.isArray(raw.ships) ? raw.ships : [];
  if (rawShips.length > MAX_SHIPS_PER_BOARD || rawShips.length === 0) {
    throw new Error("Invalid ship payload");
  }

  const board = createEmptyBoard(width, height);
  const sanitizedShips: BoardModel["ships"] = [];
  const shipIds = new Set<string>();
  for (const [index, shipCandidate] of rawShips.entries()) {
    if (!isRecord(shipCandidate)) {
      throw new Error("Invalid ship payload");
    }

    const shipData = shipCandidate as Partial<Record<string, unknown>>;
    const type = Number.parseInt(String(shipData.type ?? ""), 10);
    if (!isShipType(type)) {
      throw new Error("Invalid ship payload");
    }
    const orientation = shipData.orientation;
    if (!isOrientation(orientation)) {
      throw new Error("Invalid ship payload");
    }
    const rawCells = Array.isArray(shipData.cells) ? shipData.cells : [];
    if (rawCells.length !== type) {
      throw new Error("Invalid ship payload");
    }
    if (rawCells.length > MAX_CELLS_PER_SHIP) {
      throw new Error("Invalid ship payload");
    }

    const cells: Coord[] = [];
    for (const cellCandidate of rawCells) {
      if (!isRecord(cellCandidate)) {
        throw new Error("Invalid ship payload");
      }
      const cellData = cellCandidate as Partial<Record<string, unknown>>;
      const row = normalizeCoordValue(cellData.row);
      const col = normalizeCoordValue(cellData.col);
      if (!Number.isFinite(row) || !Number.isFinite(col)) {
        throw new Error("Invalid ship payload");
      }
      if (row < 0 || col < 0 || row >= height || col >= width) {
        throw new Error("Invalid ship payload");
      }
      cells.push({ row, col });
    }
    if (cells.length !== type) {
      throw new Error("Invalid ship payload");
    }
    const id = typeof shipData.id === "string" && SHIP_ID_PATTERN.test(shipData.id) && shipData.id.length > 0
      ? shipData.id.slice(0, 32)
      : `ship-${index}`;
    if (shipIds.has(id)) {
      throw new Error("Invalid ship payload");
    }
    shipIds.add(id);
    if (new Set(cells.map(coordToKey)).size !== cells.length) {
      throw new Error("Invalid ship payload");
    }

    sanitizedShips.push({
      id,
      type: type as ShipType,
      orientation,
      cells,
      hits: Array(cells.length).fill(false),
      sunk: false,
    });
  }

  if (sanitizedShips.length === 0) {
    throw new Error("Invalid ship payload");
  }
  for (const ship of sanitizedShips) {
    if (ship.cells.every((cell) => inBounds(board, cell)) && ship.cells.length >= MIN_CELLS_PER_SHIP) {
      board.ships.push(ship);
    } else {
      throw new Error("Invalid ship payload");
    }
  }

  return board;
};

const createRoom = (
  participants: PlayerId[],
  vsBot = false,
  reconnectTokens: Record<PlayerId, string> = {},
): GameRoom => {
  const roomId = makeRoomId();
  const roomPlayers = [...participants];
  const botId = vsBot ? botIdFor(roomId) : undefined;
  const boardOwnerIds = [...roomPlayers];
  if (vsBot && botId) boardOwnerIds.push(botId);

  const boards: Record<PlayerId, BoardModel> = {};
  const shotCounters: Record<PlayerId, number> = {};
  for (const playerId of boardOwnerIds) {
    boards[playerId] = placeFleetRandomly(createEmptyBoard());
    shotCounters[playerId] = 0;
  }

  const nicknames: Record<PlayerId, string> = {};
  for (const playerId of roomPlayers) {
    nicknames[playerId] = "Gracz";
  }

  const room: GameRoom = {
    roomId,
    status: "setup",
    players: roomPlayers,
    nicknames,
    boards,
    shotCounters,
    turn: roomPlayers[0],
    vsBot,
    botId,
    phase: "setup",
    over: false,
    createdAt: Date.now(),
    lastActionTs: Date.now(),
    reconnectTokens: {},
    tokenToPlayerId: {},
    disconnectedAtByToken: {},
    readyPlayers: new Set<PlayerId>(vsBot && botId ? [botId] : []),
    aiState: vsBot ? createAiState() : undefined,
  };

  if (vsBot && botId) {
    const token = resolveReconnectToken(reconnectTokens[botId]);
    room.reconnectTokens[botId] = token;
    room.tokenToPlayerId[token] = botId;
    registerRoomToken(token, roomId);
    persistTokenRoomMap(token, roomId);
    room.nicknames[botId] = "Bot";
  }

  for (const playerId of roomPlayers) {
    const reconnectToken = resolveReconnectToken(reconnectTokens[playerId]);
    room.reconnectTokens[playerId] = reconnectToken;
    room.tokenToPlayerId[reconnectToken] = playerId;
    registerRoomToken(reconnectToken, roomId);
    persistTokenRoomMap(reconnectToken, roomId);
  }

  rooms.set(roomId, room);
  for (const playerId of roomPlayers) {
    playerRooms.set(playerId, roomId);
  }
  recordMatchEvent(roomId, "room_created", {
    roomId,
    players: roomPlayers,
    vsBot,
    createdAt: Date.now(),
  });
  persistRoomSnapshot(room);
  return room;
};

const allPlayersInRoom = (room: GameRoom): PlayerId[] =>
  room.vsBot && room.botId ? [...room.players, room.botId] : [...room.players];

const replaceRoomPlayerId = (
  room: GameRoom,
  oldPlayerId: PlayerId,
  newPlayerId: PlayerId,
  nickname?: string,
) => {
  if (oldPlayerId === newPlayerId) {
    room.nicknames[newPlayerId] = nickname || room.nicknames[newPlayerId] || "Gracz";
    playerRooms.set(newPlayerId, room.roomId);
    return;
  }

  const reconnectToken = room.reconnectTokens[oldPlayerId];
  const board = room.boards[oldPlayerId];
  const nicknameValue = room.nicknames[oldPlayerId] || nickname || "Gracz";

  room.players = room.players.map((playerId) => (playerId === oldPlayerId ? newPlayerId : playerId));
  room.nicknames[newPlayerId] = nicknameValue;
  if (nickname) {
    room.nicknames[newPlayerId] = nickname;
  }

  if (reconnectToken) {
    delete room.disconnectedAtByToken[reconnectToken];
    room.reconnectTokens[newPlayerId] = reconnectToken;
    room.tokenToPlayerId[reconnectToken] = newPlayerId;
    delete room.reconnectTokens[oldPlayerId];
  }

  if (board) {
    room.boards[newPlayerId] = board;
    delete room.boards[oldPlayerId];
  }
  if (Object.prototype.hasOwnProperty.call(room.shotCounters, oldPlayerId)) {
    room.shotCounters[newPlayerId] = room.shotCounters[oldPlayerId] ?? 0;
    delete room.shotCounters[oldPlayerId];
  }

  if (room.readyPlayers.delete(oldPlayerId)) {
    room.readyPlayers.add(newPlayerId);
  }

  if (room.turn === oldPlayerId) {
    room.turn = newPlayerId;
  }

  delete room.nicknames[oldPlayerId];
  playerRooms.delete(oldPlayerId);
  playerRooms.set(newPlayerId, room.roomId);
};

const reconnectPlayerFromToken = (
  room: GameRoom,
  token: string,
  newSocketId: string,
  nickname: string,
): boolean => {
  const playerId = room.tokenToPlayerId[normalizeReconnectToken(token)];
  if (!playerId) return false;
  replaceRoomPlayerId(room, playerId, newSocketId, nickname);
  return true;
};

const emitGameStatePersisted = async (room: GameRoom): Promise<void> => {
  await persistRoomSnapshotNow(room);
  emitGameState(room);
};

const startRoomIfReady = (room: GameRoom) => {
  if (room.phase !== "setup" || room.over) return;
  const participants = allPlayersInRoom(room);
  if (room.readyPlayers.size < participants.length) return;
  room.status = "active";
  room.phase = "playing";
  room.turn = room.vsBot && room.botId ? participants[0] : participants[Math.floor(Math.random() * participants.length)];
  room.lastActionTs = Date.now();
  if (room.vsBot && room.botId && room.turn === room.botId) {
    setTimeout(() => runBotTurn(room.roomId), 250);
  }
};

const getOpponentByPlayerId = (room: GameRoom, playerId: PlayerId): PlayerId | undefined => {
  if (room.vsBot && room.botId) {
    return room.players.find((id) => id !== playerId) ?? room.botId;
  }
  return room.players.find((id) => id !== playerId);
};

const getOpponentId = (room: GameRoom, playerId: PlayerId): PlayerId | undefined => {
  return getOpponentByPlayerId(room, playerId);
};

const emitGameState = (room: GameRoom) => {
  const state = (playerId: PlayerId) => {
    const opponentId = getOpponentId(room, playerId) ?? room.botId ?? playerId;
    const youReady = room.readyPlayers.has(playerId);
    const opponentReady = opponentId ? room.readyPlayers.has(opponentId) : false;
    const { yourShots, opponentShots } = shotCountsForPlayer(room, playerId);
    return {
      roomId: room.roomId,
      vsBot: room.vsBot,
      yourTurn: room.turn === playerId,
      turn: room.turn,
      phase: room.phase,
      yourShots,
      opponentShots,
      youReady,
      opponentReady,
      gameOver: room.over,
      winner: room.winner ?? null,
      yourBoard: serializeBoard(room.boards[playerId], true),
      opponentBoard: serializeBoard(room.boards[opponentId], false),
      opponentName: room.nicknames[opponentId] ?? "Przeciwnik",
      opponentId,
      yourId: playerId,
    };
  };

  for (const playerId of room.players) {
    io.to(playerId).emit("game:state", state(playerId));
  }
  for (const playerId of room.players) {
    const { yourShots, opponentShots } = shotCountsForPlayer(room, playerId);
    io.to(playerId).emit("game:turn", {
      roomId: room.roomId,
      turn: room.turn,
      phase: room.phase,
      gameOver: room.over,
      winner: room.winner ?? null,
      yourShots,
      opponentShots,
      yourTurn: room.turn === playerId,
    });
  }
  persistRoomSnapshot(room);
};

const resolveOpponentForDisconnect = (
  room: GameRoom,
  playerId: PlayerId,
): PlayerId | undefined => getOpponentByPlayerId(room, playerId);

const removeRoom = (room: GameRoom) => {
  for (const token of Object.keys(room.tokenToPlayerId)) {
    unregisterRoomToken(token);
    deleteTokenRoomMap(token);
  }
  for (const playerId of room.players) {
    playerRooms.delete(playerId);
    clearRateState(playerId);
  }
  rooms.delete(room.roomId);
  if (runtimeServices.redisState.isEnabled) {
    void runtimeServices.redisState.deleteRoomSnapshot(room.roomId);
  }
};

const resolveDisconnectedWinner = (
  room: GameRoom,
  disconnectedPlayerId: PlayerId,
): PlayerId | null => {
  const opponent = resolveOpponentForDisconnect(room, disconnectedPlayerId);
  if (!opponent) return null;
  if (room.vsBot && room.botId && opponent === room.botId) return opponent;
  return playerRooms.has(opponent) ? opponent : null;
};

const shotCountsForPlayer = (room: GameRoom, playerId: PlayerId) => {
  const opponentId = getOpponentId(room, playerId) ?? room.botId ?? playerId;
  return {
    yourShots: room.shotCounters[playerId] ?? 0,
    opponentShots: opponentId ? (room.shotCounters[opponentId] ?? 0) : 0,
  };
};

const reasonMessage = (reason: string) =>
  reason === "manual_cancel"
    ? "Gra anulowana przez gracza."
    : reason === "disconnect"
      ? "Przeciwnik rozłączył się."
      : reason === "inactivity_timeout"
        ? "Gra zakończona z powodu braku aktywności."
        : "Koniec gry.";

const emitGameOver = (
  room: GameRoom,
  winner: PlayerId | null,
  reason: "normal" | "manual_cancel" | "disconnect" | "inactivity_timeout",
  message?: string,
) => {
  for (const playerId of room.players) {
    const { yourShots, opponentShots } = shotCountsForPlayer(room, playerId);
    io.to(playerId).emit("game:over", {
      roomId: room.roomId,
      winner,
      phase: room.phase,
      yourShots,
      opponentShots,
      totalShots: yourShots + opponentShots,
      reason,
      message: message ?? reasonMessage(reason),
    });
  }
};

const recordNoWinnerSummary = (
  room: GameRoom,
  status: "manual_cancel" | "disconnect" | "inactivity_timeout",
): void => {
  runtimeServices.telemetry.recordMatchSummary({
    roomId: room.roomId,
    mode: room.vsBot ? "pva" : "online",
    status,
    winnerPlayerId: null,
    startedAt: room.createdAt,
    endedAt: Date.now(),
    players: room.players.map((playerId) => ({
      playerId,
      nickname: room.nicknames[playerId] ?? "Gracz",
      shots: room.shotCounters[playerId] ?? 0,
      isWinner: false,
    })),
  });
};

const endGame = (
  room: GameRoom,
  winner: PlayerId,
  reason: "normal" | "manual_cancel" | "disconnect" | "inactivity_timeout" = "normal",
  message?: string,
) => {
  if (room.over || room.status === "ended") return;
  room.over = true;
  room.status = "ended";
  room.phase = "over";
  room.winner = winner;
  runtimeServices.telemetry.recordMatchSummary({
    roomId: room.roomId,
    mode: room.vsBot ? "pva" : "online",
    status: reason,
    winnerPlayerId: winner,
    startedAt: room.createdAt,
    endedAt: Date.now(),
    players: room.players.map((playerId) => ({
      playerId,
      nickname: room.nicknames[playerId] ?? "Gracz",
      shots: room.shotCounters[playerId] ?? 0,
      isWinner: playerId === winner,
    })),
  });
  recordMatchEvent(room.roomId, "game_over", {
    roomId: room.roomId,
    winner,
    reason,
    message: message ?? reasonMessage(reason),
    shotCounters: room.shotCounters,
    finishedAt: Date.now(),
  });
  emitGameState(room);
  emitGameOver(room, winner, reason, message);
  removeRoom(room);
};

const processQueueTimeoutEntry = (entry: QueueEntry): void => {
  deleteQueueEntry(entry.playerId, entry.reconnectToken);
  leaveQueue(entry.playerId);
  const socket = io.sockets.sockets.get(entry.playerId);
  if (!socket) return;
  const room = createRoom([entry.playerId], true, { [entry.playerId]: entry.reconnectToken });
  socket.join(room.roomId);
  socket.emit("queue:matched", {
    roomId: room.roomId,
    opponent: "Bot",
    reconnectToken: room.reconnectTokens[entry.playerId],
    vsBot: true,
    message: "Timeout kolejki. Gra z botem.",
    youReady: false,
    opponentReady: true,
  });
  recordMatchEvent(room.roomId, "queue_timeout_fallback_bot", {
    roomId: room.roomId,
    playerId: entry.playerId,
    timeoutMs: MATCH_TIMEOUT_EFFECTIVE_MS,
    at: Date.now(),
  });
  emitGameState(room);
};

const resolveQueueTimeout = async () => {
  if (runtimeServices.redisQueue.isEnabled) {
    const cutoff = Date.now() - MATCH_TIMEOUT_EFFECTIVE_MS;
    const entries = await runtimeServices.redisQueue.takeTimedOutEntries(cutoff, 100);
    for (const entry of entries) {
      processQueueTimeoutEntry(entry);
    }
    return;
  }

  tickTimeouts(MATCH_TIMEOUT_EFFECTIVE_MS, (entry) => {
    processQueueTimeoutEntry(entry);
  });
};

const tryMatchmaking = async () => {
  const redisMatch = runtimeServices.redisQueue.isEnabled ? await runtimeServices.redisQueue.takeMatch() : null;
  const match = redisMatch ?? takeMatch();
  if (!match) return;
  const [first, second] = match;
  deleteQueueEntry(first.playerId, first.reconnectToken);
  deleteQueueEntry(second.playerId, second.reconnectToken);
  leaveQueue(first.playerId);
  leaveQueue(second.playerId);

  const room = createRoom(
    [first.playerId, second.playerId],
    false,
    {
      [first.playerId]: first.reconnectToken,
      [second.playerId]: second.reconnectToken,
    },
  );
  io.sockets.sockets.get(first.playerId)?.join(room.roomId);
  io.sockets.sockets.get(second.playerId)?.join(room.roomId);
  room.nicknames[first.playerId] = first.nickname;
  room.nicknames[second.playerId] = second.nickname;

  io.to(first.playerId).emit("queue:matched", {
    roomId: room.roomId,
    opponent: second.nickname,
    reconnectToken: room.reconnectTokens[first.playerId],
    vsBot: false,
    message: "Znaleziono przeciwnika.",
    youReady: false,
    opponentReady: false,
  });
  io.to(second.playerId).emit("queue:matched", {
    roomId: room.roomId,
    opponent: first.nickname,
    reconnectToken: room.reconnectTokens[second.playerId],
    vsBot: false,
    message: "Znaleziono przeciwnika.",
    youReady: false,
    opponentReady: false,
  });
  recordMatchEvent(room.roomId, "queue_matched", {
    roomId: room.roomId,
    players: [first.playerId, second.playerId],
    at: Date.now(),
  });

  emitGameState(room);
};

const runBotTurn = (roomId: string) => {
  const room = rooms.get(roomId);
  if (!room || room.over || room.phase !== "playing" || !room.vsBot || !room.botId) return;
  const botId = room.botId;
  if (room.turn !== botId) return;
  const humanId = room.players[0];
  const state = room.aiState ?? createAiState();
  room.aiState = state;
  const board = room.boards[humanId];
  const fire = () => {
    if (room.over || room.turn !== botId) return;
    const shot = nextShot(board, state);
    if (shot.row < 0 || shot.col < 0) {
      room.turn = humanId;
      emitGameState(room);
      return;
    }
    const result = fireShot(board, shot);
    room.lastActionTs = Date.now();
    registerAiShot(board, state, shot, result.outcome);
    if (result.outcome === "miss" || result.outcome === "hit" || result.outcome === "sink") {
      room.shotCounters[botId] = (room.shotCounters[botId] ?? 0) + 1;
    }
    io.to(humanId).emit("game:shot_result", {
      roomId,
      shooter: botId,
      coord: shot,
      outcome: result.outcome,
      shipId: result.shipId,
      gameOver: result.gameOver,
    });
    recordMatchEvent(room.roomId, "shot_result", {
      roomId: room.roomId,
      shooter: botId,
      target: humanId,
      coord: shot,
      outcome: result.outcome,
      shipId: result.shipId ?? null,
      gameOver: Boolean(result.gameOver),
      at: Date.now(),
    });
    if (result.gameOver) {
      endGame(room, botId);
      return;
    }
    if (result.outcome === "miss") {
      room.turn = humanId;
      emitGameState(room);
      return;
    }
    emitGameState(room);
    setTimeout(fire, 250);
  };
  setTimeout(fire, 250);
};

const onSearchJoin = async (socket: Socket, payload: SearchJoinPayload) => {
  if (guardSoftBan(socket)) return;
  await touchSocketPresenceNow(socket.id);
  if (await isRateLimitedByIdentity(socket, "search_join", RATE_LIMITS.JOIN_PER_WINDOW, RATE_LIMITS.JOIN_WINDOW_MS)) {
    socket.emit("game:error", { message: "Za dużo żądań do kolejki. Spróbuj ponownie za chwilę." });
    return;
  }

  const nickname = sanitizeNickname(payload.nickname);
  const normalizedToken = normalizeReconnectToken(payload.reconnectToken);
  if (
    normalizedToken &&
    await isRateLimitedByIdentity(
      socket,
      "reconnect_join",
      RATE_LIMITS.RECONNECT_JOIN_PER_WINDOW,
      RATE_LIMITS.JOIN_WINDOW_MS,
    )
  ) {
    socket.emit("game:error", { message: "Za dużo prób reconnect. Spróbuj ponownie za chwilę." });
    return;
  }
  let reconnectMessage: string | undefined;
  if (getRoomForPlayer(socket.id)) {
    socket.emit("game:error", { message: "Jesteś już w grze. Wyjdź do menu przed dołączeniem." });
    return;
  }
  const roomFromReconnect = normalizedToken ? await getRoomByReconnectToken(normalizedToken) : null;
  if (roomFromReconnect && !roomFromReconnect.over) {
    const currentPlayerId = roomFromReconnect.tokenToPlayerId[normalizedToken];
    if (currentPlayerId) {
      let ownerOnline = await isSocketOnline(currentPlayerId);
      if (ownerOnline && await shouldIgnoreRemotePresenceAfterGracefulRestart(currentPlayerId)) {
        ownerOnline = false;
      }
      if (ownerOnline && currentPlayerId !== socket.id) {
        recordSecurityEvent("reconnect_token_active_conflict", {
          socketId: socket.id,
          ip: socketIpAddress(socket),
          token: normalizedToken,
          roomId: roomFromReconnect.roomId,
        });
        socket.emit("game:error", {
          message: "Token reconnecta jest już używany w aktywnej sesji.",
          code: "reconnect_token_expired",
        });
        return;
      }
      if (!isReconnectWindowExpired(roomFromReconnect, normalizedToken)) {
        const wasDisconnected = !ownerOnline;
        const reconnected = reconnectPlayerFromToken(
          roomFromReconnect,
          normalizedToken,
          socket.id,
          nickname,
        );
        if (reconnected) {
          socket.join(roomFromReconnect.roomId);
          if (wasDisconnected) {
            const message = `Przeciwnik wrócił do gry. Gra została wznowiona.`;
            const opponent = getOpponentByPlayerId(roomFromReconnect, currentPlayerId);
            if (opponent && opponent !== roomFromReconnect.botId) {
              io.to(opponent).emit("game:error", {
                roomId: roomFromReconnect.roomId,
                code: "reconnect_restored",
                message,
              });
            }
            io.to(socket.id).emit("game:error", {
              roomId: roomFromReconnect.roomId,
              code: "reconnect_restored",
              message: "Połączenie z grą przywrócone.",
            });
          }
          deleteParkedQueueEntry(normalizedToken);
          deleteQueueEntry(socket.id, normalizedToken);
          await emitGameStatePersisted(roomFromReconnect);
          if (
            roomFromReconnect.vsBot &&
            roomFromReconnect.botId &&
            roomFromReconnect.phase === "playing" &&
            roomFromReconnect.turn === roomFromReconnect.botId
          ) {
            setTimeout(() => runBotTurn(roomFromReconnect.roomId), 200);
          }
          return;
        }
        reconnectMessage = "Token reconnecta jest nieaktualny.";
      } else {
        unregisterRoomToken(normalizedToken);
        deleteTokenRoomMap(normalizedToken);
        deleteParkedQueueEntry(normalizedToken);
        deleteQueueEntry(socket.id, normalizedToken);
        delete roomFromReconnect.disconnectedAtByToken[normalizedToken];
        delete roomFromReconnect.tokenToPlayerId[normalizedToken];
        delete roomFromReconnect.reconnectTokens[currentPlayerId];
        reconnectMessage = "Token reconnecta stracił ważność. Tworzę nową kolejkę.";
      }
    }
  }
  let queued = await getQueueEntryForPlayerId(socket.id);
  if (!queued && normalizedToken) {
    const recoveredParked = runtimeServices.redisQueue.isEnabled
      ? await runtimeServices.redisQueue.getParkedEntryByToken(normalizedToken)
      : null;
    if (recoveredParked) {
      queued = joinQueue(
        socket.id,
        recoveredParked.nickname || nickname,
        recoveredParked.joinedAt,
        recoveredParked.reconnectToken,
      );
      await persistQueueEntryNow(queued);
      deleteParkedQueueEntry(recoveredParked.reconnectToken);
      reconnectMessage = reconnectMessage ?? "Odzyskano połączenie z kolejką.";
    } else {
      const activeQueueEntry = await getActiveQueueEntryForToken(normalizedToken);
      if (activeQueueEntry) {
        let ownerOnline = await isSocketOnline(activeQueueEntry.playerId);
        if (ownerOnline && await shouldIgnoreRemotePresenceAfterGracefulRestart(activeQueueEntry.playerId)) {
          ownerOnline = false;
        }
        if (!ownerOnline) {
          deleteQueueEntry(activeQueueEntry.playerId, activeQueueEntry.reconnectToken);
          leaveQueue(activeQueueEntry.playerId);
          queued = joinQueue(
            socket.id,
            activeQueueEntry.nickname || nickname,
            activeQueueEntry.joinedAt,
            activeQueueEntry.reconnectToken,
          );
          await persistQueueEntryNow(queued);
          reconnectMessage = reconnectMessage ?? "Odzyskano połączenie z kolejką.";
        } else {
          recordSecurityEvent("queue_token_active_conflict", {
            socketId: socket.id,
            ip: socketIpAddress(socket),
            token: normalizedToken,
            queuePlayerId: activeQueueEntry.playerId,
            at: Date.now(),
          });
          socket.emit("game:error", {
            message: "Token reconnecta jest już używany w aktywnej sesji.",
            code: "reconnect_token_expired",
          });
          return;
        }
      }
    }
  }
  if (queued && !normalizedToken) {
    queued.nickname = nickname;
    await persistQueueEntryNow(queued);
    socket.emit("queue:queued", {
      playerId: socket.id,
      joinedAt: queued.joinedAt,
      timeoutMs: MATCH_TIMEOUT_EFFECTIVE_MS,
      reconnectToken: queued.reconnectToken,
      recovered: false,
    });
    return;
  }

  const entry = joinQueue(socket.id, nickname, Date.now(), normalizedToken);
  await persistQueueEntryNow(entry);
  const wasRecovered = Boolean(normalizedToken && entry.reconnectToken === normalizedToken);
  socket.emit("queue:queued", {
    playerId: socket.id,
    joinedAt: entry.joinedAt,
    timeoutMs: MATCH_TIMEOUT_EFFECTIVE_MS,
    reconnectToken: entry.reconnectToken,
    recovered: wasRecovered,
    message: wasRecovered
      ? "Odzyskano token sesji."
      : reconnectMessage
        ? reconnectMessage
      : normalizedToken
        ? "Nie znaleziono aktywnej gry ani kolejki z tym tokenem. Tworzę nową kolejkę."
        : undefined,
  });
  await tryMatchmaking();
};

const onSearchCancel = async (socket: Socket, _payload: SearchCancelPayload) => {
  if (guardSoftBan(socket)) return;
  if (await isRateLimitedByIdentity(socket, "search_cancel", RATE_LIMITS.SEARCH_CANCEL_PER_WINDOW, RATE_LIMITS.JOIN_WINDOW_MS)) {
    socket.emit("game:error", { message: "Za dużo żądań anulowania. Spróbuj ponownie za chwilę." });
    return;
  }
  const room = getRoomForPlayer(socket.id);
  if (room) {
    await onGameCancel(socket, {});
    return;
  }

  const queueEntry = await getQueueEntryForPlayerId(socket.id);
  if (queueEntry) {
    leaveQueue(socket.id);
    deleteQueueEntry(queueEntry.playerId, queueEntry.reconnectToken);
    const payload: GameCancelledPayload = {
      roomId: getRoomForPlayer(socket.id)?.roomId,
      reason: "queue_cancelled",
      message: "Anulowano oczekiwanie w kolejce.",
    };
    socket.emit("game:cancelled", payload);
  } else {
    socket.emit("game:cancelled", {
      reason: "search_cancelled",
      message: "Brak aktywnego oczekiwania w kolejce.",
    });
  }
};

const onGamePlaceShips = async (socket: Socket, payload: GamePlaceShipsPayload) => {
  if (guardSoftBan(socket)) return;
  const room = getRoomForPlayer(socket.id);
  if (!room || room.over) return;
  if (await isRateLimitedByIdentity(socket, "game_place_ships", RATE_LIMITS.PLACE_SHIPS_PER_WINDOW, RATE_LIMITS.PLACE_SHIPS_WINDOW_MS)) {
    socket.emit("game:error", { message: "Zbyt wiele ustawień statków. Poczekaj chwilę." });
    return;
  }
  if (payload.roomId !== undefined) {
    const requestedRoomId = normalizeRoomId(payload.roomId);
    if (!requestedRoomId || requestedRoomId !== room.roomId) {
      socket.emit("game:error", { message: "Nieprawidłowy pokój." });
      return;
    }
  }
  if (normalizeRoomId(room.roomId) !== room.roomId) {
    socket.emit("game:error", { message: "Nieprawidłowy pokój." });
    return;
  }
  if (room.phase !== "setup") {
    socket.emit("game:error", { message: "Pozycjonowanie statków jest niedostępne podczas gry." });
    return;
  }
  if (!payload?.board) {
    socket.emit("game:error", { message: "Brak planszy w danych." });
    return;
  }
  let parsed: BoardModel;
  try {
    parsed = normalizeBoardFromClient(payload.board);
  } catch {
    socket.emit("game:error", { message: "Nieprawidłowe dane ustawienia statków." });
    return;
  }
  if (!validateFleet(parsed)) {
    socket.emit("game:error", { message: "Nieprawidłowe ustawienie statków." });
    return;
  }
  room.boards[socket.id] = parsed;
  room.lastActionTs = Date.now();
  room.readyPlayers.add(socket.id);
  startRoomIfReady(room);
  await emitGameStatePersisted(room);
};

const onGameShot = async (socket: Socket, payload: GameShotPayload) => {
  if (guardSoftBan(socket)) return;
  if (await isRateLimitedByIdentity(socket, "game_shot", RATE_LIMITS.SHOT_PER_WINDOW, RATE_LIMITS.SHOT_WINDOW_MS)) {
    socket.emit("game:error", { message: "Zbyt wiele strzałów. Poczekaj chwilę." });
    return;
  }
  const room = getRoomForPlayer(socket.id);
  if (!room || room.over) {
    socket.emit("game:error", { message: "Brak aktywnej gry." });
    return;
  }
  if (payload.roomId !== undefined) {
    const requestedRoomId = normalizeRoomId(payload.roomId);
    if (!requestedRoomId || requestedRoomId !== room.roomId) {
      socket.emit("game:error", { message: "Nieprawidłowe id pokoju." });
      return;
    }
  }
  if (!normalizeRoomId(room.roomId)) {
    socket.emit("game:error", { message: "Nieprawidłowe id pokoju." });
    return;
  }
  if (room.turn !== socket.id) {
    socket.emit("game:error", { message: "Nie jest Twoja tura." });
    return;
  }
  if (room.vsBot && room.botId && room.turn === room.botId) {
    socket.emit("game:error", { message: "Tura bota." });
    return;
  }
  const targetId = getOpponentId(room, socket.id);
  if (!targetId) {
    socket.emit("game:error", { message: "Brak celu strzału." });
    return;
  }
  const coord = parseCoord(payload.coord);
  if (!coord) {
    socket.emit("game:error", { message: "Błędne współrzędne." });
    return;
  }
  if (room.phase !== "playing") {
    socket.emit("game:error", { message: "Rozpocznij po ustawieniu wszystkich statków." });
    return;
  }
  const result = fireShot(room.boards[targetId], coord);
  if (result.outcome === "already_shot" || result.outcome === "invalid") {
    socket.emit("game:error", {
      message:
        result.outcome === "already_shot"
          ? "To pole zostało już trafione."
          : "Niewłaściwe pole.",
    });
    return;
  }
  room.shotCounters[socket.id] = (room.shotCounters[socket.id] ?? 0) + 1;
  room.lastActionTs = Date.now();
  io.to(room.roomId).emit("game:shot_result", {
    roomId: room.roomId,
    shooter: socket.id,
    coord,
    outcome: result.outcome,
    shipId: result.shipId,
    gameOver: result.gameOver,
  });
  recordMatchEvent(room.roomId, "shot_result", {
    roomId: room.roomId,
    shooter: socket.id,
    target: targetId,
    coord,
    outcome: result.outcome,
    shipId: result.shipId ?? null,
    gameOver: Boolean(result.gameOver),
    at: Date.now(),
  });
  if (result.outcome === "miss") {
    room.turn = targetId;
    await emitGameStatePersisted(room);
    if (room.vsBot && room.turn === room.botId) {
      runBotTurn(room.roomId);
    }
    return;
  }
  if (result.gameOver) {
    endGame(room, socket.id);
    return;
  }
  await emitGameStatePersisted(room);
};

const onGameCancel = async (socket: Socket, _payload: GameCancelPayload) => {
  if (guardSoftBan(socket)) return;
  if (await isRateLimitedByIdentity(socket, "game_cancel", RATE_LIMITS.GAME_CANCEL_PER_WINDOW, RATE_LIMITS.JOIN_WINDOW_MS)) {
    socket.emit("game:error", { message: "Za dużo żądań anulowania. Spróbuj ponownie za chwilę." });
    return;
  }

  const room = getRoomForPlayer(socket.id);
  if (room) {
    io.to(room.roomId).emit("game:cancelled", {
      roomId: room.roomId,
      reason: "manual_cancel",
      message: "Gra anulowana przez gracza.",
    });
    const winner = resolveOpponentForDisconnect(room, socket.id);
    if (winner) {
      room.status = "cancelled";
      recordMatchEvent(room.roomId, "game_cancelled", {
        roomId: room.roomId,
        cancelledBy: socket.id,
        winner,
        reason: "manual_cancel",
        at: Date.now(),
      });
      endGame(room, winner, "manual_cancel");
      return;
    } else {
      room.over = true;
      room.status = "cancelled";
      room.phase = "over";
      recordNoWinnerSummary(room, "manual_cancel");
      emitGameOver(room, null, "manual_cancel");
      emitGameState(room);
    }
    removeRoom(room);
    return;
  }

  const queueEntry = await getQueueEntryForPlayerId(socket.id);
  if (queueEntry) {
    leaveQueue(socket.id);
    deleteQueueEntry(queueEntry.playerId, queueEntry.reconnectToken);
    const queueRoom = getRoomForPlayer(socket.id);
    socket.emit("game:cancelled", {
      roomId: queueRoom?.roomId,
      reason: "queue_cancelled",
      message: "Anulowano oczekiwanie w kolejce.",
    });
    return;
  }

  socket.emit("game:error", { message: "Brak aktywnej gry." });
  socket.emit("game:cancelled", {
    reason: "search_cancelled",
    message: "Brak aktywnej gry.",
  });
};

const onDisconnect = async (socket: Socket) => {
  await clearSocketPresence(socket.id);
  if (shutdownRequested) {
    return;
  }
  const parkedEntry = parkQueue(socket.id);
  if (parkedEntry) {
    if (runtimeServices.redisQueue.isEnabled) {
      await runtimeServices.redisQueue.removeQueueEntry(parkedEntry.playerId, parkedEntry.reconnectToken);
      await runtimeServices.redisQueue.upsertParkedEntry(parkedEntry, QUEUE_PARKED_TTL_MS);
    }
  } else {
    const queueEntry = await getQueueEntryForPlayerId(socket.id);
    if (queueEntry) {
      leaveQueue(socket.id);
      if (runtimeServices.redisQueue.isEnabled) {
        await runtimeServices.redisQueue.removeQueueEntry(queueEntry.playerId, queueEntry.reconnectToken);
        await runtimeServices.redisQueue.upsertParkedEntry(queueEntry, QUEUE_PARKED_TTL_MS);
      }
    }
  }
  const room = getRoomForPlayer(socket.id);
  if (room && !room.over) {
    const opponent = resolveOpponentForDisconnect(room, socket.id);
    const disconnectToken = room.reconnectTokens[socket.id];
    if (disconnectToken) {
      room.disconnectedAtByToken[disconnectToken] = Date.now();
      playerRooms.delete(socket.id);
      if (opponent && opponent !== room.botId) {
        const timeoutSeconds = Math.ceil(ROOM_RECONNECT_GRACE_MS / 1000);
        io.to(opponent).emit("game:error", {
          roomId: room.roomId,
          code: "reconnect_grace",
          remainingMs: ROOM_RECONNECT_GRACE_MS,
          message: `Przeciwnik rozłączył się. Gra jest zawieszona na ${timeoutSeconds}s na próbę ponownego połączenia.`,
        });
      }
      recordMatchEvent(room.roomId, "player_disconnected_grace", {
        roomId: room.roomId,
        playerId: socket.id,
        token: disconnectToken,
        at: Date.now(),
      });
      await persistRoomSnapshotNow(room);
      return;
    }
    if (opponent) {
      io.to(opponent).emit("game:error", {
        roomId: room.roomId,
        message: "Przeciwnik rozłączył się. Wygrana przyznana.",
      });
      endGame(room, opponent, "disconnect");
      return;
    }
    room.over = true;
    room.status = "ended";
    room.phase = "over";
    recordNoWinnerSummary(room, "disconnect");
    emitGameOver(room, null, "disconnect");
    emitGameState(room);
    removeRoom(room);
  }
  clearRateState(socket.id);
  clearInvalidInputState(socket.id);
};

const cleanupDisconnectedPlayers = () => {
  for (const room of rooms.values()) {
    if (room.over) continue;
    for (const [token, disconnectedAt] of Object.entries(room.disconnectedAtByToken)) {
      if (Date.now() - disconnectedAt < ROOM_RECONNECT_GRACE_MS) continue;
      const playerId = room.tokenToPlayerId[token];
      if (!playerId) {
        delete room.disconnectedAtByToken[token];
        continue;
      }
      const winner = resolveDisconnectedWinner(room, playerId);
      if (winner) {
        recordMatchEvent(room.roomId, "disconnect_timeout_winner", {
          roomId: room.roomId,
          disconnectedPlayerId: playerId,
          winner,
          at: Date.now(),
        });
        endGame(
          room,
          winner,
          "disconnect",
          `Przeciwnik nie wrócił w ${Math.ceil(ROOM_RECONNECT_GRACE_MS / 1000)}s. Gra zakończona.`,
        );
      } else {
        room.over = true;
        room.status = "ended";
        room.phase = "over";
        room.winner = undefined;
        recordNoWinnerSummary(room, "disconnect");
        recordMatchEvent(room.roomId, "disconnect_timeout_no_winner", {
          roomId: room.roomId,
          disconnectedPlayerId: playerId,
          at: Date.now(),
        });
        emitGameOver(room, null, "disconnect", "Gra zakończona z powodu braku połączenia.");
        removeRoom(room);
      }
      break;
    }
  }
};

const cleanupInactiveRooms = () => {
  const now = Date.now();
  const staleRooms: GameRoom[] = [];
  for (const room of rooms.values()) {
    if (room.over) continue;
    if (now - room.lastActionTs >= ROOM_INACTIVITY_TIMEOUT_MS) {
      staleRooms.push(room);
    }
  }

  for (const room of staleRooms) {
    if (room.over) continue;
    room.over = true;
    room.status = "ended";
    room.phase = "over";
    recordNoWinnerSummary(room, "inactivity_timeout");
    io.to(room.roomId).emit("game:error", {
      message: "Gra zakończona z powodu braku aktywności.",
    });
    recordMatchEvent(room.roomId, "room_inactivity_timeout", {
      roomId: room.roomId,
      at: Date.now(),
    });
    emitGameOver(room, null, "inactivity_timeout");
    removeRoom(room);
  }
};

registerSocketHandlers(io, {
  onConnect: (socket) => {
    touchSocketPresence(socket.id);
  },
  onSearchJoin,
  onSearchCancel,
  onGamePlaceShips,
  onGameShot,
  onGameCancel,
  onDisconnect,
  onInvalidInput: (socket, eventName) => {
    noteInvalidInput(socket);
    recordSecurityEvent("invalid_payload", {
      socketId: socket.id,
      ip: socketIpAddress(socket),
      eventName,
      at: Date.now(),
    });
  },
});

const maintenanceTimer = setInterval(() => {
  const now = Date.now();
  if (runtimeServices.redisState.isEnabled && now - lastPresenceRefreshTs >= SOCKET_PRESENCE_REFRESH_MS) {
    lastPresenceRefreshTs = now;
    for (const socketId of io.sockets.sockets.keys()) {
      touchSocketPresence(socketId);
    }
  }
  void resolveQueueTimeout();
  cleanupParkedQueue(MATCH_TIMEOUT_EFFECTIVE_MS);
  cleanupExpiredTokens();
  cleanupRateState();
  cleanupInvalidInputState();
  cleanupInactiveRooms();
  cleanupDisconnectedPlayers();
}, MAINTENANCE_INTERVAL_MS);

const serverInstance = httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});

let shutdownRequested = false;
const shutdown = async (signal: string) => {
  if (shutdownRequested) return;
  shutdownRequested = true;
  // eslint-disable-next-line no-console
  console.log(`Shutting down (${signal})...`);
  clearInterval(maintenanceTimer);
  if (runtimeServices.redisState.isEnabled) {
    await runtimeServices.redisState.markGracefulShutdown(10_000);
  }
  const presenceToClear = new Set<string>(io.sockets.sockets.keys());
  for (const room of rooms.values()) {
    for (const playerId of room.players) {
      presenceToClear.add(playerId);
    }
  }
  for (const queuedPlayerId of getQueuedPlayerIds()) {
    presenceToClear.add(queuedPlayerId);
  }
  for (const parkedPlayerId of getParkedPlayerIds()) {
    presenceToClear.add(parkedPlayerId);
  }
  if (presenceToClear.size > 0) {
    await Promise.allSettled([...presenceToClear].map((socketId) => clearSocketPresence(socketId)));
  }
  io.close();
  await new Promise<void>((resolve) => {
    serverInstance.close(() => resolve());
  });
  await runtimeServices.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
