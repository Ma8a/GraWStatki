import {
  BOARD_SIZE,
  BoardModel,
  Coord,
  Orientation,
  REQUIRED_FLEET,
  Ship,
  ShipType,
  ShotResult,
  SerializedBoard,
  STANDARD_FLEET,
} from "./types.js";

export const coordToKey = (coord: Coord): string => `${coord.row},${coord.col}`;

export const keyToCoord = (key: string): Coord => {
  const [row, col] = key.split(",").map((value) => parseInt(value, 10));
  return { row, col };
};

export const createEmptyBoard = (width = BOARD_SIZE, height = BOARD_SIZE): BoardModel => ({
  width,
  height,
  ships: [],
  shots: new Set<string>(),
});

export const cloneBoard = (board: BoardModel): BoardModel => ({
  width: board.width,
  height: board.height,
  ships: board.ships.map((ship) => ({
    ...ship,
    cells: ship.cells.map((c) => ({ row: c.row, col: c.col })),
    hits: [...ship.hits],
  })),
  shots: new Set(Array.from(board.shots)),
  hits: board.hits ? new Set(board.hits) : undefined,
});

const coordEquals = (a: Coord, b: Coord): boolean => a.row === b.row && a.col === b.col;

export const inBounds = (board: BoardModel, coord: Coord): boolean =>
  coord.row >= 0 && coord.col >= 0 && coord.row < board.height && coord.col < board.width;

export const generateShipCells = (start: Coord, type: ShipType, orientation: Orientation): Coord[] => {
  const cells: Coord[] = [];
  if (orientation === "H") {
    for (let i = 0; i < type; i += 1) {
      cells.push({ row: start.row, col: start.col + i });
    }
  } else {
    for (let i = 0; i < type; i += 1) {
      cells.push({ row: start.row + i, col: start.col });
    }
  }
  return cells;
};

export const createShip = (id: string, type: ShipType, start: Coord, orientation: Orientation): Ship => ({
  id,
  type,
  orientation,
  cells: generateShipCells(start, type, orientation),
  hits: Array(type).fill(false),
  sunk: false,
});

export const validatePlacement = (board: BoardModel, ship: Ship): boolean => {
  if (ship.cells.length !== ship.type || ship.type <= 0) return false;
  const shipCells = ship.cells;
  const hasDuplicate = new Set(shipCells.map(coordToKey)).size !== shipCells.length;
  if (hasDuplicate) return false;

  for (const cell of shipCells) {
    if (!inBounds(board, cell)) return false;
  }

  for (const existing of board.ships) {
    for (const candidate of shipCells) {
      // exact hit
      for (const current of existing.cells) {
        if (coordEquals(candidate, current)) return false;
      }

      // adjacency (including diagonals)
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const adjacent = { row: candidate.row + dr, col: candidate.col + dc };
          if (!inBounds(board, adjacent)) continue;
          for (const current of existing.cells) {
            if (coordEquals(adjacent, current)) return false;
          }
        }
      }
    }
  }
  return true;
};

export const placeFleetRandomly = (board: BoardModel, fleet: readonly ShipType[] = STANDARD_FLEET): BoardModel => {
  const nextBoard = cloneBoard(board);
  nextBoard.ships = [];
  const orientationValues: Orientation[] = ["H", "V"];
  let shipIndex = 0;

  for (const type of fleet) {
    const id = `ship-${shipIndex++}`;
    let placed = false;
    for (let attempt = 0; attempt < 8000; attempt += 1) {
      const orientation = orientationValues[Math.floor(Math.random() * 2)];
      const maxRow = orientation === "H" ? nextBoard.height : Math.max(1, nextBoard.height - type + 1);
      const maxCol = orientation === "V" ? nextBoard.width : Math.max(1, nextBoard.width - type + 1);
      const row = Math.floor(Math.random() * maxRow);
      const col = Math.floor(Math.random() * maxCol);
      const ship = createShip(id, type, { row, col }, orientation);
      if (validatePlacement(nextBoard, ship)) {
        nextBoard.ships.push(ship);
        placed = true;
        break;
      }
    }
    if (!placed) {
      throw new Error("Nie można rozstawić całej floty losowo");
    }
  }
  return nextBoard;
};

export const isFleetSunk = (board: BoardModel): boolean =>
  board.ships.length > 0 && board.ships.every((ship) => ship.sunk);

const isShipCell = (board: BoardModel, coord: Coord): Ship | null => {
  const lookupKey = coordToKey(coord);
  for (const ship of board.ships) {
    const idx = ship.cells.findIndex((cell) => coordToKey(cell) === lookupKey);
    if (idx >= 0) return ship;
  }
  return null;
};

export const fireShot = (board: BoardModel, coord: Coord): ShotResult => {
  if (!inBounds(board, coord)) {
    return { outcome: "invalid" };
  }

  const key = coordToKey(coord);
  if (board.shots.has(key)) {
    return { outcome: "already_shot" };
  }

  board.shots.add(key);
  const ship = isShipCell(board, coord);
  if (!ship) {
    return { outcome: "miss" };
  }

  const hitIndex = ship.cells.findIndex((cell) => coordToKey(cell) === key);
  if (hitIndex >= 0) {
    ship.hits[hitIndex] = true;
  }

  const sunk = ship.hits.every((part) => part);
  ship.sunk = sunk;
  if (sunk && isFleetSunk(board)) {
    return { outcome: "sink", shipId: ship.id, gameOver: true };
  }
  return { outcome: sunk ? "sink" : "hit", shipId: ship.id, gameOver: isFleetSunk(board) };
};

export const serializeBoard = (board: BoardModel, revealShips = false): SerializedBoard => {
  const shots = Array.from(board.shots.values());
  const shotSet = board.shots;
  const hits = board.ships.flatMap((ship) => ship.cells.filter((cell) => shotSet.has(coordToKey(cell))).map(coordToKey));
  const sunkCells = board.ships
    .filter((ship) => ship.sunk)
    .flatMap((ship) => ship.cells.map(coordToKey));
  return {
    width: board.width,
    height: board.height,
    ships: revealShips ? board.ships : [],
    shots,
    hits,
    sunkCells,
  };
};

export const deserializeBoard = (serialized: SerializedBoard): BoardModel => ({
  width: serialized.width,
  height: serialized.height,
  ships: serialized.ships ?? [],
  shots: new Set(serialized.shots ?? []),
  hits: new Set(serialized.hits ?? []),
});

export const validateFleet = (board: BoardModel): boolean => {
  if (board.ships.length !== 10) return false;
  const expected = { ...REQUIRED_FLEET };
  const placed = cloneBoard(createEmptyBoard(board.width, board.height));
  for (const ship of board.ships) {
    if (!Object.prototype.hasOwnProperty.call(expected, ship.type)) return false;
    if (ship.cells.length !== ship.type || ship.hits.length !== ship.type) return false;
    if (expected[ship.type] <= 0) return false;
    if (!validatePlacement(placed, ship)) return false;
    placed.ships.push(ship);
    expected[ship.type] -= 1;
  }
  return Object.values(expected).every((count) => count === 0);
};
