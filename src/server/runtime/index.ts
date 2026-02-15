import { createRuntimeRedisLimiter, RuntimeRedisLimiter } from "./redisLimiter";
import { createRuntimeRedisQueue, RuntimeRedisQueue } from "./redisQueue";
import { createRuntimeRedisState, RuntimeRedisState } from "./redisState";
import { createRuntimeTelemetry, RuntimeTelemetry } from "./telemetry";

export interface RuntimeServices {
  telemetry: RuntimeTelemetry;
  redisLimiter: RuntimeRedisLimiter;
  redisQueue: RuntimeRedisQueue;
  redisState: RuntimeRedisState;
  close: () => Promise<void>;
}

export const createRuntimeServices = (): RuntimeServices => {
  const telemetry = createRuntimeTelemetry();
  const redisLimiter = createRuntimeRedisLimiter();
  const redisQueue = createRuntimeRedisQueue();
  const redisState = createRuntimeRedisState();

  return {
    telemetry,
    redisLimiter,
    redisQueue,
    redisState,
    close: async () => {
      await Promise.allSettled([
        telemetry.close(),
        redisLimiter.close(),
        redisQueue.close(),
        redisState.close(),
      ]);
    },
  };
};
