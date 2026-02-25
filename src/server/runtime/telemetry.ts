import { Pool } from "pg";
import { withTimeout } from "./withTimeout";

type JsonValue = Record<string, unknown>;

export interface RuntimeTelemetry {
  isEnabled: boolean;
  recordSecurityEvent: (eventType: string, payload: JsonValue) => void;
  recordMatchEvent: (roomId: string, eventType: string, payload: JsonValue) => void;
  recordMatchSummary: (payload: {
    roomId: string;
    mode: "pva" | "online";
    status: string;
    winnerPlayerId: string | null;
    startedAt: number;
    endedAt: number;
    players: Array<{
      playerId: string;
      nickname: string;
      shots: number;
      isWinner: boolean;
    }>;
  }) => void;
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
}

const NOOP: RuntimeTelemetry = {
  isEnabled: false,
  recordSecurityEvent: () => undefined,
  recordMatchEvent: () => undefined,
  recordMatchSummary: () => undefined,
  ping: async () => false,
  close: async () => undefined,
};

const safeLog = (scope: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[telemetry] ${scope} failed: ${message}`);
};

export const createRuntimeTelemetry = (): RuntimeTelemetry => {
  const connectionString = (process.env.DATABASE_URL ?? "").trim();
  if (!connectionString) {
    return NOOP;
  }

  const pool = new Pool({
    connectionString,
    max: Number.parseInt(process.env.DB_POOL_MAX ?? "8", 10) || 8,
    idleTimeoutMillis: Number.parseInt(process.env.DB_IDLE_TIMEOUT_MS ?? "10000", 10) || 10000,
    connectionTimeoutMillis: Number.parseInt(process.env.DB_CONNECT_TIMEOUT_MS ?? "3000", 10) || 3000,
  });
  const pingTimeoutMs = Math.max(
    100,
    Number.parseInt(process.env.READY_PING_TIMEOUT_MS ?? "800", 10) || 800,
  );

  const insertSecurity = `
    INSERT INTO security_events (event_type, ip, socket_id, payload, created_at)
    VALUES ($1, $2, $3, $4::jsonb, NOW())
  `;
  const insertMatch = `
    INSERT INTO match_events (room_id, event_type, payload, created_at)
    VALUES ($1, $2, $3::jsonb, NOW())
  `;
  const upsertMatch = `
    INSERT INTO matches (room_id, mode, status, winner_player_id, started_at, ended_at)
    VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0))
    ON CONFLICT (room_id) DO UPDATE SET
      mode = EXCLUDED.mode,
      status = EXCLUDED.status,
      winner_player_id = EXCLUDED.winner_player_id,
      ended_at = EXCLUDED.ended_at
    RETURNING id
  `;
  const deletePlayers = `DELETE FROM match_players WHERE match_id = $1`;
  const insertPlayer = `
    INSERT INTO match_players (match_id, player_id, nickname, shots, is_winner)
    VALUES ($1, $2, $3, $4, $5)
  `;

  return {
    isEnabled: true,
    recordSecurityEvent: (eventType, payload) => {
      const ip = typeof payload.ip === "string" ? payload.ip : null;
      const socketId = typeof payload.socketId === "string" ? payload.socketId : null;
      pool
        .query(insertSecurity, [eventType, ip, socketId, JSON.stringify(payload)])
        .catch((error) => safeLog("security_event_insert", error));
    },
    recordMatchEvent: (roomId, eventType, payload) => {
      pool
        .query(insertMatch, [roomId, eventType, JSON.stringify(payload)])
        .catch((error) => safeLog("match_event_insert", error));
    },
    recordMatchSummary: (payload) => {
      pool
        .query(upsertMatch, [
          payload.roomId,
          payload.mode,
          payload.status,
          payload.winnerPlayerId,
          payload.startedAt,
          payload.endedAt,
        ])
        .then(async (result) => {
          const matchId = result.rows[0]?.id;
          if (!matchId) return;
          await pool.query(deletePlayers, [matchId]);
          for (const player of payload.players) {
            await pool.query(insertPlayer, [
              matchId,
              player.playerId,
              player.nickname,
              player.shots,
              player.isWinner,
            ]);
          }
        })
        .catch((error) => safeLog("match_summary_upsert", error));
    },
    ping: async () => {
      try {
        await withTimeout(pool.query("SELECT 1"), pingTimeoutMs);
        return true;
      } catch {
        return false;
      }
    },
    close: async () => {
      await pool.end();
    },
  };
};
