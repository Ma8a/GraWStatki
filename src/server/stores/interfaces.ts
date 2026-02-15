import { ChatMessage, SerializedBoard } from "../../shared";

export type RoomPhase = "setup" | "playing" | "over";
export type RoomStatus = "setup" | "active" | "ended" | "cancelled";

export interface RoomSnapshot {
  roomId: string;
  vsBot: boolean;
  botId?: string;
  phase: RoomPhase;
  status: RoomStatus;
  players: string[];
  nicknames: Record<string, string>;
  turn: string;
  winner?: string;
  over: boolean;
  createdAt: number;
  lastActionTs: number;
  boards: Record<string, SerializedBoard>;
  reconnectTokens: Record<string, string>;
  tokenToPlayerId: Record<string, string>;
  disconnectedAtByToken: Record<string, number>;
  readyPlayers: string[];
  shotCounters: Record<string, number>;
  chatMessages?: ChatMessage[];
  chatSeq?: number;
  postGameExpiresAt?: number;
}

export interface RoomStore {
  get(roomId: string): Promise<RoomSnapshot | null> | RoomSnapshot | null;
  set(room: RoomSnapshot): Promise<void> | void;
  delete(roomId: string): Promise<void> | void;
}

export interface QueueStore {
  enqueue(playerId: string, reconnectToken: string): Promise<void> | void;
  dequeue(playerId: string): Promise<void> | void;
}

export interface ReconnectTokenService {
  reserve(preferred?: string): Promise<string> | string;
  resolveRoom(token: string): Promise<string | null> | string | null;
  invalidate(token: string): Promise<void> | void;
}

export interface DistributedRateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<boolean> | boolean;
}

export interface GameEventAuditStore {
  storeMatchEvent(event: {
    roomId: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: number;
  }): Promise<void> | void;
}
