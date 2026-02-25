import { createClient, RedisClientType } from "redis";
import { RoomSnapshot } from "../stores/interfaces";
import { withTimeout } from "./withTimeout";

export interface RuntimeRedisState {
  isEnabled: boolean;
  upsertRoomSnapshot: (room: RoomSnapshot) => Promise<void>;
  getRoomSnapshot: (roomId: string) => Promise<RoomSnapshot | null>;
  deleteRoomSnapshot: (roomId: string) => Promise<void>;
  mapTokenToRoom: (token: string, roomId: string, ttlMs: number) => Promise<void>;
  unmapToken: (token: string) => Promise<void>;
  resolveRoomByToken: (token: string) => Promise<string | null>;
  touchSocketPresence: (socketId: string, ttlMs: number) => Promise<void>;
  clearSocketPresence: (socketId: string) => Promise<void>;
  isSocketPresent: (socketId: string) => Promise<boolean>;
  markGracefulShutdown: (ttlMs: number) => Promise<void>;
  hasRecentGracefulShutdown: () => Promise<boolean>;
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
}

const NOOP: RuntimeRedisState = {
  isEnabled: false,
  upsertRoomSnapshot: async () => undefined,
  getRoomSnapshot: async () => null,
  deleteRoomSnapshot: async () => undefined,
  mapTokenToRoom: async () => undefined,
  unmapToken: async () => undefined,
  resolveRoomByToken: async () => null,
  touchSocketPresence: async () => undefined,
  clearSocketPresence: async () => undefined,
  isSocketPresent: async () => false,
  markGracefulShutdown: async () => undefined,
  hasRecentGracefulShutdown: async () => false,
  ping: async () => false,
  close: async () => undefined,
};

const safeLog = (scope: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[redis-state] ${scope} failed: ${message}`);
};

const redisPrefixRaw = (process.env.REDIS_KEY_PREFIX ?? "").trim().replace(/:+$/g, "");
const redisPrefix = redisPrefixRaw ? `${redisPrefixRaw}:` : "";
const prefixed = (key: string): string => `${redisPrefix}${key}`;

const roomKey = (roomId: string): string => prefixed(`room:snapshot:${roomId}`);
const tokenKey = (token: string): string => prefixed(`room:token:${token}`);
const socketPresenceKey = (socketId: string): string => prefixed(`socket:presence:${socketId}`);
const gracefulShutdownKey = (): string => prefixed("server:graceful_shutdown");

export const createRuntimeRedisState = (): RuntimeRedisState => {
  const url = (process.env.REDIS_URL ?? "").trim();
  if (!url) return NOOP;

  const client: RedisClientType = createClient({ url });
  client.on("error", (error) => safeLog("client_error", error));
  const pingTimeoutMs = Math.max(
    100,
    Number.parseInt(process.env.READY_PING_TIMEOUT_MS ?? "800", 10) || 800,
  );
  let connectPromise: Promise<unknown> | null = null;
  const ensureConnected = async (): Promise<void> => {
    if (client.isOpen) return;
    if (!connectPromise) {
      connectPromise = client.connect().catch((error) => {
        connectPromise = null;
        throw error;
      });
    }
    await withTimeout(connectPromise, pingTimeoutMs);
  };

  const upsertRoomSnapshot = async (room: RoomSnapshot): Promise<void> => {
    try {
      await ensureConnected();
      await client.set(roomKey(room.roomId), JSON.stringify(room), {
        PX: Math.max(5_000, Number.parseInt(process.env.ROOM_SNAPSHOT_TTL_MS ?? "1800000", 10) || 1_800_000),
      });
    } catch (error) {
      safeLog("upsert_room_snapshot", error);
    }
  };

  const deleteRoomSnapshot = async (roomId: string): Promise<void> => {
    try {
      await ensureConnected();
      await client.del(roomKey(roomId));
    } catch (error) {
      safeLog("delete_room_snapshot", error);
    }
  };

  const getRoomSnapshot = async (roomId: string): Promise<RoomSnapshot | null> => {
    try {
      await ensureConnected();
      const payload = await client.get(roomKey(roomId));
      if (!payload) return null;
      const parsed = JSON.parse(payload) as RoomSnapshot;
      return parsed;
    } catch (error) {
      safeLog("get_room_snapshot", error);
      return null;
    }
  };

  const mapTokenToRoom = async (token: string, roomId: string, ttlMs: number): Promise<void> => {
    try {
      await ensureConnected();
      await client.set(tokenKey(token), roomId, {
        PX: Math.max(1_000, ttlMs),
      });
    } catch (error) {
      safeLog("map_token_to_room", error);
    }
  };

  const unmapToken = async (token: string): Promise<void> => {
    try {
      await ensureConnected();
      await client.del(tokenKey(token));
    } catch (error) {
      safeLog("unmap_token", error);
    }
  };

  const resolveRoomByToken = async (token: string): Promise<string | null> => {
    try {
      await ensureConnected();
      const roomId = await client.get(tokenKey(token));
      return roomId ?? null;
    } catch (error) {
      safeLog("resolve_room_by_token", error);
      return null;
    }
  };

  const touchSocketPresence = async (socketId: string, ttlMs: number): Promise<void> => {
    if (!socketId) return;
    try {
      await ensureConnected();
      await client.set(socketPresenceKey(socketId), "1", {
        PX: Math.max(1_000, ttlMs),
      });
    } catch (error) {
      safeLog("touch_socket_presence", error);
    }
  };

  const clearSocketPresence = async (socketId: string): Promise<void> => {
    if (!socketId) return;
    try {
      await ensureConnected();
      await client.del(socketPresenceKey(socketId));
    } catch (error) {
      safeLog("clear_socket_presence", error);
    }
  };

  const isSocketPresent = async (socketId: string): Promise<boolean> => {
    if (!socketId) return false;
    try {
      await ensureConnected();
      const exists = await client.exists(socketPresenceKey(socketId));
      return exists === 1;
    } catch (error) {
      safeLog("is_socket_present", error);
      return false;
    }
  };

  const markGracefulShutdown = async (ttlMs: number): Promise<void> => {
    try {
      await ensureConnected();
      await client.set(gracefulShutdownKey(), "1", { PX: Math.max(1_000, ttlMs) });
    } catch (error) {
      safeLog("mark_graceful_shutdown", error);
    }
  };

  const hasRecentGracefulShutdown = async (): Promise<boolean> => {
    try {
      await ensureConnected();
      const exists = await client.exists(gracefulShutdownKey());
      return exists === 1;
    } catch (error) {
      safeLog("has_recent_graceful_shutdown", error);
      return false;
    }
  };

  const ping = async (): Promise<boolean> => {
    try {
      await ensureConnected();
      const response = await withTimeout(client.ping(), pingTimeoutMs);
      return response === "PONG";
    } catch {
      return false;
    }
  };

  return {
    isEnabled: true,
    upsertRoomSnapshot,
    getRoomSnapshot,
    deleteRoomSnapshot,
    mapTokenToRoom,
    unmapToken,
    resolveRoomByToken,
    touchSocketPresence,
    clearSocketPresence,
    isSocketPresent,
    markGracefulShutdown,
    hasRecentGracefulShutdown,
    ping,
    close: async () => {
      if (client.isOpen) {
        await client.quit();
      }
    },
  };
};
