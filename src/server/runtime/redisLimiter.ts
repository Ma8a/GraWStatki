import { createClient, RedisClientType } from "redis";
import { withTimeout } from "./withTimeout";

export interface RuntimeRedisLimiter {
  isEnabled: boolean;
  consume: (key: string, limit: number, windowMs: number) => Promise<boolean>;
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
}

const NOOP: RuntimeRedisLimiter = {
  isEnabled: false,
  consume: async () => false,
  ping: async () => false,
  close: async () => undefined,
};

const safeLog = (scope: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.warn(`[redis] ${scope} failed: ${message}`);
};

const redisPrefixRaw = (process.env.REDIS_KEY_PREFIX ?? "").trim().replace(/:+$/g, "");
const redisPrefix = redisPrefixRaw ? `${redisPrefixRaw}:` : "";
const prefixed = (key: string): string => `${redisPrefix}${key}`;

export const createRuntimeRedisLimiter = (): RuntimeRedisLimiter => {
  const url = (process.env.REDIS_URL ?? "").trim();
  if (!url) {
    return NOOP;
  }

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

  const consume = async (key: string, limit: number, windowMs: number): Promise<boolean> => {
    try {
      await ensureConnected();
      const now = Date.now();
      const rateKey = prefixed(`rate:${key}`);
      const count = await client.incr(rateKey);
      if (count === 1) {
        await client.pExpire(rateKey, Math.max(250, windowMs));
      }
      if (count > limit) {
        return true;
      }
      const stampKey = prefixed(`rate_stamp:${key}`);
      await client.set(stampKey, String(now), { PX: Math.max(250, windowMs) });
      return false;
    } catch (error) {
      safeLog("consume", error);
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
    consume,
    ping,
    close: async () => {
      if (client.isOpen) {
        await client.quit();
      }
    },
  };
};
