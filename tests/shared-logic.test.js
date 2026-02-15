const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createEmptyBoard,
  createShip,
  validatePlacement,
  placeFleetRandomly,
  fireShot,
  isFleetSunk,
  validateFleet,
} = require("../dist/server/shared/game.js");
const { createAiState, nextShot, registerAiShot } = require("../dist/server/shared/ai.js");
const { parseBoardCoordInput } = require("../dist/server/shared/coords.js");

const coordKey = (coord) => `${coord.row},${coord.col}`;

test("validate placement rejects overlaps and touching", () => {
  const board = createEmptyBoard();
  const first = createShip("ship-1", 4, { row: 1, col: 1 }, "H");
  assert.ok(validatePlacement(board, first));
  board.ships.push(first);

  const overlap = createShip("ship-2", 2, { row: 1, col: 2 }, "V");
  assert.equal(validatePlacement(board, overlap), false);

  const touchingSide = createShip("ship-3", 1, { row: 1, col: 5 }, "H");
  assert.equal(validatePlacement(board, touchingSide), false);

  const touchingCorner = createShip("ship-4", 1, { row: 0, col: 0 }, "H");
  assert.equal(validatePlacement(board, touchingCorner), false);

  const valid = createShip("ship-5", 1, { row: 5, col: 8 }, "V");
  assert.equal(validatePlacement(board, valid), true);
});

test("fleet validator accepts valid fleet and rejects invalid sizes", () => {
  const validBoard = placeFleetRandomly(createEmptyBoard());
  assert.equal(validateFleet(validBoard), true);
  assert.equal(validBoard.ships.length, 10);

  const invalidBoard = createEmptyBoard();
  invalidBoard.ships.push(createShip("ship-1", 4, { row: 0, col: 0 }, "H"));
  assert.equal(validateFleet(invalidBoard), false);
});

test("fireShot updates outcomes and detects sink/game over", () => {
  const board = createEmptyBoard();
  board.ships.push(createShip("ship-1", 2, { row: 3, col: 3 }, "H"));
  board.ships.push(createShip("ship-2", 1, { row: 0, col: 0 }, "H"));

  let result = fireShot(board, { row: 0, col: 1 });
  assert.equal(result.outcome, "miss");

  result = fireShot(board, { row: 3, col: 3 });
  assert.equal(result.outcome, "hit");
  assert.equal(result.shipId, "ship-1");

  result = fireShot(board, { row: 3, col: 3 });
  assert.equal(result.outcome, "already_shot");

  result = fireShot(board, { row: 3, col: 4 });
  assert.equal(result.outcome, "sink");
  assert.equal(result.shipId, "ship-1");
  assert.equal(isFleetSunk(board), false);

  result = fireShot(board, { row: 0, col: 0 });
  assert.equal(result.outcome, "sink");
  assert.equal(isFleetSunk(board), true);
  assert.equal(result.gameOver, true);
});

test("fireShot keeps shot counter stable for already_shot coordinates", () => {
  const board = createEmptyBoard();
  board.ships.push(createShip("ship-1", 1, { row: 2, col: 2 }, "H"));

  let result = fireShot(board, { row: 2, col: 2 });
  assert.equal(result.outcome, "sink");
  assert.equal(board.shots.size, 1);

  result = fireShot(board, { row: 2, col: 2 });
  assert.equal(result.outcome, "already_shot");
  assert.equal(board.shots.size, 1);

  const miss = fireShot(board, { row: 0, col: 0 });
  assert.equal(miss.outcome, "miss");
  assert.equal(board.shots.size, 2);

  const repeatMiss = fireShot(board, { row: 0, col: 0 });
  assert.equal(repeatMiss.outcome, "already_shot");
  assert.equal(board.shots.size, 2);
});

test("AI never repeats shots on the same board", () => {
  const board = createEmptyBoard(2, 2);
  const aiState = createAiState();
  const seen = new Set();

  for (let i = 0; i < 4; i += 1) {
    const shot = nextShot(board, aiState);
    const key = coordKey(shot);
    assert.ok(!seen.has(key), `AI repeated shot ${key}`);
    seen.add(key);
    registerAiShot(board, aiState, shot, "miss");
  }

  const last = nextShot(board, aiState);
  assert.equal(last.row, -1);
  assert.equal(last.col, -1);
});

test("parses coordinate input (A1..J10) correctly", () => {
  assert.deepEqual(parseBoardCoordInput("A1"), { row: 0, col: 0 });
  assert.deepEqual(parseBoardCoordInput("j10"), { row: 9, col: 9 });
  assert.deepEqual(parseBoardCoordInput("B 7"), { row: 6, col: 1 });
  assert.equal(parseBoardCoordInput(""), null);
  assert.equal(parseBoardCoordInput("K1"), null);
  assert.equal(parseBoardCoordInput("A11"), null);
  assert.equal(parseBoardCoordInput("A0"), null);
  assert.equal(parseBoardCoordInput("Z9"), null);
});
