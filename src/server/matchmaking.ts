import { randomBytes, randomInt } from "node:crypto";

export interface QueueEntry {
  playerId: string;
  nickname: string;
  joinedAt: number;
  reconnectToken: string;
}

type PlayerId = string;

type TokenKind = "queue" | "parked" | "room";

type TokenLease = {
  expiresAt: number;
  kind: TokenKind;
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const RECONNECT_TOKEN_TTL_MS = parsePositiveInt(process.env.RECONNECT_TOKEN_TTL_MS, 60 * 60_000);
const MAX_RECONNECT_TOKEN_LENGTH = 96;
const TOKEN_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_NICKNAME_LENGTH = 64;

const queue = new Map<PlayerId, QueueEntry>();
const parkedQueue = new Map<string, QueueEntry>();
const tokenToPlayer = new Map<string, string>();
const tokenToRoomId = new Map<string, string>();
const tokenLeases = new Map<string, TokenLease>();

export const getMatchmakingStats = () => ({
  queueSize: queue.size,
  parkedSize: parkedQueue.size,
  tokenLeaseSize: tokenLeases.size,
});

export const getQueuedPlayerIds = (): string[] => [...queue.keys()];

export const getParkedPlayerIds = (): string[] =>
  [...parkedQueue.values()].map((entry) => entry.playerId).filter((playerId) => typeof playerId === "string" && playerId.length > 0);

export const cleanupExpiredTokens = (now = Date.now()): number => {
  const initial = tokenLeases.size;
  for (const [token, lease] of tokenLeases.entries()) {
    if (lease.expiresAt > now) continue;
    tokenLeases.delete(token);

    const playerId = tokenToPlayer.get(token);
    if (playerId) {
      const queueEntry = queue.get(playerId);
      if (queueEntry?.reconnectToken === token) {
        queue.delete(playerId);
      }
      const parkedEntry = parkedQueue.get(token);
      if (parkedEntry?.reconnectToken === token) {
        parkedQueue.delete(token);
      }
      tokenToPlayer.delete(token);
      continue;
    }

    tokenToRoomId.delete(token);
  }
  return initial - tokenLeases.size;
};

const touchTokenLease = (token: string): void => {
  tokenLeases.set(token, {
    expiresAt: Date.now() + RECONNECT_TOKEN_TTL_MS,
    kind: tokenToPlayer.has(token) ? "queue" : tokenToRoomId.has(token) ? "room" : "parked",
  });
};

const normalizeToken = (value?: string): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_RECONNECT_TOKEN_LENGTH) return "";
  if (!TOKEN_PATTERN.test(trimmed)) return "";
  return trimmed;
};

const normalizeNickname = (nickname: string): string => {
  if (typeof nickname === "string") {
    const trimmed = nickname.trim();
    if (trimmed.length > 0) return trimmed.slice(0, MAX_NICKNAME_LENGTH);
  }
  return "Gracz";
};

const makeToken = (): string => `q-${randomBytes(24).toString("base64url")}`;

export const isTokenUsed = (requestedToken?: string): boolean => {
  cleanupExpiredTokens();
  const requested = normalizeToken(requestedToken);
  if (!requested) return false;
  return tokenToPlayer.has(requested) || parkedQueue.has(requested) || tokenToRoomId.has(requested);
};

export const reserveToken = (requestedToken?: string): string => {
  cleanupExpiredTokens();
  const requested = normalizeToken(requestedToken);
  if (requested && !isTokenUsed(requested)) {
    tokenLeases.set(requested, { expiresAt: Date.now() + RECONNECT_TOKEN_TTL_MS, kind: "room" });
    return requested;
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const generated = makeToken();
    if (!isTokenUsed(generated)) {
      tokenLeases.set(generated, { expiresAt: Date.now() + RECONNECT_TOKEN_TTL_MS, kind: "room" });
      return generated;
    }
  }
  throw new Error("Unable to reserve reconnect token");
};

const syncToken = (entry: QueueEntry): void => {
  tokenToPlayer.set(entry.reconnectToken, entry.playerId);
  tokenToRoomId.delete(entry.reconnectToken);
  touchTokenLease(entry.reconnectToken);
};

const unsyncToken = (entry: QueueEntry): void => {
  tokenToPlayer.delete(entry.reconnectToken);
  tokenToRoomId.delete(entry.reconnectToken);
  tokenLeases.delete(entry.reconnectToken);
};

export const joinQueue = (
  playerId: string,
  nickname: string,
  joinedAt = Date.now(),
  reconnectToken?: string,
): QueueEntry => {
  const existing = queue.get(playerId);
  if (existing) {
    existing.nickname = normalizeNickname(nickname);
    return existing;
  }

  const normalizedToken = normalizeToken(reconnectToken);
  const parked = normalizedToken ? parkedQueue.get(normalizedToken) : undefined;
  if (parked) {
    parkedQueue.delete(normalizedToken);
    tokenLeases.delete(normalizedToken);
    const restored: QueueEntry = {
      playerId,
      nickname: normalizeNickname(nickname),
      joinedAt: parked.joinedAt,
      reconnectToken: parked.reconnectToken,
    };
    queue.set(playerId, restored);
    syncToken(restored);
    return restored;
  }

  const entry: QueueEntry = {
    playerId,
    nickname: normalizeNickname(nickname),
    joinedAt,
    reconnectToken: reserveToken(normalizedToken),
  };
  queue.set(playerId, entry);
  syncToken(entry);
  return entry;
};

export const registerRoomToken = (token: string, roomId: string): void => {
  const normalized = normalizeToken(token);
  if (!normalized) return;
  tokenToRoomId.set(normalized, roomId);
  tokenToPlayer.delete(normalized);
  touchTokenLease(normalized);
};

export const unregisterRoomToken = (token: string): void => {
  const normalized = normalizeToken(token);
  if (!normalized) return;
  tokenToPlayer.delete(normalized);
  tokenToRoomId.delete(normalized);
  tokenLeases.delete(normalized);
};

export const getRoomIdForToken = (token?: string): string | undefined => {
  cleanupExpiredTokens();
  const normalized = normalizeToken(token);
  if (!normalized) return undefined;
  return tokenToRoomId.get(normalized);
};

export const leaveQueue = (playerId: string): boolean => {
  const entry = queue.get(playerId);
  if (!entry) return false;

  queue.delete(playerId);
  unsyncToken(entry);
  return true;
};

export const parkQueue = (playerId: string): QueueEntry | undefined => {
  const entry = queue.get(playerId);
  if (!entry) return undefined;

  queue.delete(playerId);
  unsyncToken(entry);
  parkedQueue.set(entry.reconnectToken, {
    ...entry,
    playerId,
  });
  touchTokenLease(entry.reconnectToken);
  return entry;
};

export const hasInQueue = (playerId: string): boolean => queue.has(playerId);

export const getQueueEntry = (playerId: string): QueueEntry | undefined => queue.get(playerId);

export const getQueueEntryByToken = (token: string): QueueEntry | undefined => {
  cleanupExpiredTokens();
  const normalized = normalizeToken(token);
  if (!normalized) return undefined;
  const playerId = tokenToPlayer.get(normalized);
  return playerId ? queue.get(playerId) : undefined;
};

export const cleanupParkedQueue = (timeoutMs: number): number => {
  const now = Date.now();
  let removed = 0;
  for (const [token, entry] of parkedQueue.entries()) {
    if (now - entry.joinedAt >= timeoutMs) {
      parkedQueue.delete(token);
      tokenLeases.delete(token);
      tokenToPlayer.delete(token);
      removed += 1;
    }
  }
  return removed;
};

export const takeMatch = (): [QueueEntry, QueueEntry] | null => {
  const entries = [...queue.values()];
  if (entries.length < 2) {
    return null;
  }
  const shuffled = [...entries];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const first = shuffled[0];
  const second = shuffled[1];
  if (!first || !second) return null;
  queue.delete(first.playerId);
  queue.delete(second.playerId);
  unsyncToken(first);
  unsyncToken(second);
  return [first, second];
};

export const tickTimeouts = (timeoutMs: number, onTimeout: (entry: QueueEntry) => void): void => {
  const now = Date.now();
  for (const [playerId, entry] of queue.entries()) {
    if (now - entry.joinedAt >= timeoutMs) {
      queue.delete(playerId);
      unsyncToken(entry);
      onTimeout(entry);
    }
  }
};
