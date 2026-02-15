export const BOARD_SIZE = 10;

export type Coord = {
  row: number;
  col: number;
};

export type Orientation = "H" | "V";

export type ShipType = 4 | 3 | 2 | 1;

export interface Ship {
  id: string;
  type: ShipType;
  orientation: Orientation;
  cells: Coord[];
  hits: boolean[];
  sunk: boolean;
}

export interface BoardModel {
  width: number;
  height: number;
  ships: Ship[];
  shots: Set<string>;
  hits?: Set<string>;
}

export type ShotOutcome = "miss" | "hit" | "sink" | "invalid" | "already_shot";

export interface ShotResult {
  outcome: ShotOutcome;
  shipId?: string;
  gameOver?: boolean;
}

export interface SerializedBoard {
  width: number;
  height: number;
  ships: Ship[];
  shots: string[];
  hits: string[];
  sunkCells?: string[];
}

export const STANDARD_FLEET: ShipType[] = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

export const REQUIRED_FLEET: Record<ShipType, number> = {
  1: 4,
  2: 3,
  3: 2,
  4: 1,
};

export interface QueueQueuedPayload {
  playerId: string;
  joinedAt: number;
  timeoutMs: number;
  reconnectToken?: string;
  recovered?: boolean;
  message?: string;
}

export type GameErrorCode =
  | "reconnect_grace"
  | "reconnect_restored"
  | "reconnect_token_expired"
  | "invalid_payload"
  | "soft_ban"
  | "general";

export interface GameErrorPayload {
  message: string;
  roomId?: string;
  code?: GameErrorCode;
  remainingMs?: number;
}

export interface QueueMatchedPayload {
  roomId: string;
  opponent: string;
  reconnectToken?: string;
  vsBot: boolean;
  message: string;
  youReady: boolean;
  opponentReady: boolean;
}

export interface GameStatePayload {
  roomId: string;
  vsBot: boolean;
  yourTurn: boolean;
  turn: string;
  yourShots: number;
  opponentShots: number;
  phase: "setup" | "playing" | "over";
  youReady: boolean;
  opponentReady: boolean;
  gameOver: boolean;
  winner: string | null;
  yourBoard: SerializedBoard;
  opponentBoard: SerializedBoard;
  opponentName: string;
  opponentId?: string;
  yourId: string;
}

export interface GameTurnPayload {
  roomId: string;
  turn: string;
  yourShots: number;
  opponentShots: number;
  yourTurn: boolean;
  phase: "setup" | "playing" | "over";
  gameOver: boolean;
  winner?: string | null;
}

export interface GameShotResultPayload {
  roomId: string;
  shooter: string;
  coord: Coord;
  outcome: ShotOutcome;
  shipId?: string;
  gameOver?: boolean;
}

export interface GameOverPayload {
  roomId: string;
  winner: string | null;
  phase: "over";
  yourShots: number;
  opponentShots: number;
  totalShots: number;
  reason?: "normal" | "disconnect" | "manual_cancel" | "inactivity_timeout";
  message?: string;
}

export interface GameCancelledPayload {
  roomId?: string;
  reason:
    | "queue_cancelled"
    | "manual_cancel"
    | "disconnect"
    | "search_cancelled";
  message: string;
}

export interface SearchJoinPayload {
  nickname?: string;
  reconnectToken?: string;
}

export interface SearchCancelPayload {
  roomId?: string;
}

export interface GamePlaceShipsPayload {
  roomId?: string;
  board: SerializedBoard;
}

export interface GameShotPayload {
  roomId?: string;
  coord: Coord;
}

export interface GameCancelPayload {
  roomId?: string;
}
