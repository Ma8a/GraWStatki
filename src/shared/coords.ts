import { Coord } from "./types.js";

const BOARD_LABELS = "ABCDEFGHIJ";

const isBetween = (value: number, min: number, max: number): boolean => value >= min && value <= max;

export const parseBoardCoordInput = (value: string): Coord | null => {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, "");
  const match = normalized.match(/^([A-J])([1-9]|10)$/);
  if (!match) return null;

  const col = BOARD_LABELS.indexOf(match[1]);
  if (col < 0) return null;

  const row = Number.parseInt(match[2], 10) - 1;
  if (!Number.isFinite(row) || !isBetween(row, 0, 9)) return null;

  return { row, col };
};
