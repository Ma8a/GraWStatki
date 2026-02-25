import { createClient, RedisClientType } from "redis";
import { withTimeout } from "./withTimeout";

export interface PersistedQueueEntry {
  playerId: string;
  nickname: string;
  joinedAt: number;
  reconnectToken: string;
}

export interface RuntimeRedisQueue {
  isEnabled: boolean;
  upsertQueueEntry: (entry: PersistedQueueEntry, ttlMs: number) => Promise<void>;
  removeQueueEntry: (playerId: string, reconnectToken?: string) => Promise<void>;
  upsertParkedEntry: (entry: PersistedQueueEntry, ttlMs: number) => Promise<void>;
  removeParkedEntry: (reconnectToken: string) => Promise<void>;
  getQueueEntryByPlayerId: (playerId: string) => Promise<PersistedQueueEntry | null>;
  getQueueEntryByToken: (reconnectToken: string) => Promise<PersistedQueueEntry | null>;
  getParkedEntryByToken: (reconnectToken: string) => Promise<PersistedQueueEntry | null>;
  takeMatch: () => Promise<[PersistedQueueEntry, PersistedQueueEntry] | null>;
  takeTimedOutEntries: (cutoffJoinedAt: number, limit: number) => Promise<PersistedQueueEntry[]>;
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
}

const NOOP: RuntimeRedisQueue = {
  isEnabled: false,
  upsertQueueEntry: async () => undefined,
  removeQueueEntry: async () => undefined,
  upsertParkedEntry: async () => undefined,
  removeParkedEntry: async () => undefined,
  getQueueEntryByPlayerId: async () => null,
  getQueueEntryByToken: async () => null,
  getParkedEntryByToken: async () => null,
  takeMatch: async () => null,
  takeTimedOutEntries: async () => [],
  ping: async () => false,
  close: async () => undefined,
};

const safeLog = (scope: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[redis-queue] ${scope} failed: ${message}`);
};

const redisPrefixRaw = (process.env.REDIS_KEY_PREFIX ?? "").trim().replace(/:+$/g, "");
const redisPrefix = redisPrefixRaw ? `${redisPrefixRaw}:` : "";
const prefixed = (key: string): string => `${redisPrefix}${key}`;

const QUEUE_HASH = prefixed("queue:entries");
const QUEUE_JOINED_ZSET = prefixed("queue:joined");
const queueTokenKey = (token: string): string => prefixed(`queue:token:${token}`);
const parkedTokenKey = (token: string): string => prefixed(`queue:parked:${token}`);

const TAKE_MATCH_SCRIPT = `
local zkey = KEYS[1]
local hkey = KEYS[2]
local queueTokenPrefix = KEYS[3]
local parkedTokenPrefix = KEYS[4]

local ids = redis.call('ZRANGE', zkey, 0, 1)
if #ids < 2 then
  return {}
end

local raw1 = redis.call('HGET', hkey, ids[1])
local raw2 = redis.call('HGET', hkey, ids[2])
if (not raw1) or (not raw2) then
  if ids[1] then
    redis.call('HDEL', hkey, ids[1])
    redis.call('ZREM', zkey, ids[1])
  end
  if ids[2] then
    redis.call('HDEL', hkey, ids[2])
    redis.call('ZREM', zkey, ids[2])
  end
  return {}
end

local e1 = cjson.decode(raw1)
local e2 = cjson.decode(raw2)

redis.call('HDEL', hkey, ids[1], ids[2])
redis.call('ZREM', zkey, ids[1], ids[2])
if e1 and e1.reconnectToken then
  redis.call('DEL', queueTokenPrefix .. e1.reconnectToken)
  redis.call('DEL', parkedTokenPrefix .. e1.reconnectToken)
end
if e2 and e2.reconnectToken then
  redis.call('DEL', queueTokenPrefix .. e2.reconnectToken)
  redis.call('DEL', parkedTokenPrefix .. e2.reconnectToken)
end

return { raw1, raw2 }
`;

const TAKE_TIMEOUTS_SCRIPT = `
local zkey = KEYS[1]
local hkey = KEYS[2]
local queueTokenPrefix = KEYS[3]
local parkedTokenPrefix = KEYS[4]
local cutoff = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

local ids = redis.call('ZRANGEBYSCORE', zkey, '-inf', cutoff, 'LIMIT', 0, limit)
if #ids == 0 then
  return {}
end

local out = {}
for i = 1, #ids do
  local id = ids[i]
  local raw = redis.call('HGET', hkey, id)
  redis.call('HDEL', hkey, id)
  redis.call('ZREM', zkey, id)
  if raw then
    local decoded = cjson.decode(raw)
    if decoded and decoded.reconnectToken then
      redis.call('DEL', queueTokenPrefix .. decoded.reconnectToken)
      redis.call('DEL', parkedTokenPrefix .. decoded.reconnectToken)
    end
    table.insert(out, raw)
  end
end
return out
`;

const parseEntry = (raw: string | null | undefined): PersistedQueueEntry | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedQueueEntry;
    if (!parsed?.playerId || !parsed?.reconnectToken) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const createRuntimeRedisQueue = (): RuntimeRedisQueue => {
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

  const upsertQueueEntry = async (entry: PersistedQueueEntry, ttlMs: number): Promise<void> => {
    try {
      await ensureConnected();
      const pipeline = client.multi();
      pipeline.hSet(QUEUE_HASH, entry.playerId, JSON.stringify(entry));
      pipeline.zAdd(QUEUE_JOINED_ZSET, { score: entry.joinedAt, value: entry.playerId });
      pipeline.set(queueTokenKey(entry.reconnectToken), entry.playerId, { PX: Math.max(1_000, ttlMs) });
      pipeline.del(parkedTokenKey(entry.reconnectToken));
      await pipeline.exec();
    } catch (error) {
      safeLog("upsert_queue_entry", error);
    }
  };

  const removeQueueEntry = async (playerId: string, reconnectToken?: string): Promise<void> => {
    try {
      await ensureConnected();
      let token = reconnectToken;
      if (!token) {
        const raw = await client.hGet(QUEUE_HASH, playerId);
        const parsed = parseEntry(raw);
        token = parsed?.reconnectToken;
      }
      const pipeline = client.multi();
      pipeline.hDel(QUEUE_HASH, playerId);
      pipeline.zRem(QUEUE_JOINED_ZSET, playerId);
      if (token) {
        pipeline.del(queueTokenKey(token));
        pipeline.del(parkedTokenKey(token));
      }
      await pipeline.exec();
    } catch (error) {
      safeLog("remove_queue_entry", error);
    }
  };

  const upsertParkedEntry = async (entry: PersistedQueueEntry, ttlMs: number): Promise<void> => {
    try {
      await ensureConnected();
      const pipeline = client.multi();
      pipeline.hDel(QUEUE_HASH, entry.playerId);
      pipeline.zRem(QUEUE_JOINED_ZSET, entry.playerId);
      pipeline.del(queueTokenKey(entry.reconnectToken));
      pipeline.set(parkedTokenKey(entry.reconnectToken), JSON.stringify(entry), {
        PX: Math.max(1_000, ttlMs),
      });
      await pipeline.exec();
    } catch (error) {
      safeLog("upsert_parked_entry", error);
    }
  };

  const removeParkedEntry = async (reconnectToken: string): Promise<void> => {
    try {
      await ensureConnected();
      await client.del(parkedTokenKey(reconnectToken));
    } catch (error) {
      safeLog("remove_parked_entry", error);
    }
  };

  const getQueueEntryByToken = async (reconnectToken: string): Promise<PersistedQueueEntry | null> => {
    try {
      await ensureConnected();
      const playerId = await client.get(queueTokenKey(reconnectToken));
      if (!playerId) return null;
      const raw = await client.hGet(QUEUE_HASH, playerId);
      return parseEntry(raw);
    } catch (error) {
      safeLog("get_queue_entry_by_token", error);
      return null;
    }
  };

  const getQueueEntryByPlayerId = async (playerId: string): Promise<PersistedQueueEntry | null> => {
    try {
      await ensureConnected();
      const raw = await client.hGet(QUEUE_HASH, playerId);
      return parseEntry(raw);
    } catch (error) {
      safeLog("get_queue_entry_by_player", error);
      return null;
    }
  };

  const getParkedEntryByToken = async (reconnectToken: string): Promise<PersistedQueueEntry | null> => {
    try {
      await ensureConnected();
      const raw = await client.get(parkedTokenKey(reconnectToken));
      return parseEntry(raw);
    } catch (error) {
      safeLog("get_parked_entry_by_token", error);
      return null;
    }
  };

  const takeMatch = async (): Promise<[PersistedQueueEntry, PersistedQueueEntry] | null> => {
    try {
      await ensureConnected();
      const result = await client.eval(TAKE_MATCH_SCRIPT, {
        keys: [QUEUE_JOINED_ZSET, QUEUE_HASH, `${queueTokenKey("")}`, `${parkedTokenKey("")}`],
      });
      if (!Array.isArray(result) || result.length < 2) return null;
      const first = parseEntry(typeof result[0] === "string" ? result[0] : null);
      const second = parseEntry(typeof result[1] === "string" ? result[1] : null);
      if (!first || !second) return null;
      return [first, second];
    } catch (error) {
      safeLog("take_match", error);
      return null;
    }
  };

  const takeTimedOutEntries = async (cutoffJoinedAt: number, limit: number): Promise<PersistedQueueEntry[]> => {
    try {
      await ensureConnected();
      const safeLimit = Math.max(1, Math.min(200, limit));
      const result = await client.eval(TAKE_TIMEOUTS_SCRIPT, {
        keys: [QUEUE_JOINED_ZSET, QUEUE_HASH, `${queueTokenKey("")}`, `${parkedTokenKey("")}`],
        arguments: [String(cutoffJoinedAt), String(safeLimit)],
      });
      if (!Array.isArray(result)) return [];
      const parsed = result
        .map((raw) => (typeof raw === "string" ? parseEntry(raw) : null))
        .filter((entry): entry is PersistedQueueEntry => Boolean(entry));
      return parsed;
    } catch (error) {
      safeLog("take_timeouts", error);
      return [];
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
    upsertQueueEntry,
    removeQueueEntry,
    upsertParkedEntry,
    removeParkedEntry,
    getQueueEntryByPlayerId,
    getQueueEntryByToken,
    getParkedEntryByToken,
    takeMatch,
    takeTimedOutEntries,
    ping,
    close: async () => {
      if (client.isOpen) {
        await client.quit();
      }
    },
  };
};
