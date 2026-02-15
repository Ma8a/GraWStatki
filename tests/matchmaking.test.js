const assert = require("node:assert/strict");
const test = require("node:test");

const { joinQueue, hasInQueue, leaveQueue, takeMatch, tickTimeouts } = require("../dist/server/matchmaking.js");

test("matchmaking pairs two players in one match", () => {
  leaveQueue("p1");
  leaveQueue("p2");
  joinQueue("p1", "Ala");
  joinQueue("p2", "Olek");

  assert.equal(hasInQueue("p1"), true);
  assert.equal(hasInQueue("p2"), true);

  const match = takeMatch();
  assert.ok(Array.isArray(match));
  assert.equal(match?.length, 2);
  const players = match ? match.map((entry) => entry.playerId).sort() : [];
  assert.deepEqual(players, ["p1", "p2"]);
  assert.equal(hasInQueue("p1"), false);
  assert.equal(hasInQueue("p2"), false);
});

test("matchmaking matches random remaining players when queue grows", () => {
  ["a1", "a2", "a3"].forEach((id) => leaveQueue(id));
  joinQueue("a1", "Player 1");
  joinQueue("a2", "Player 2");
  joinQueue("a3", "Player 3");

  const firstMatch = takeMatch();
  const secondMatch = takeMatch();

  assert.equal(firstMatch?.length, 2);
  assert.equal(secondMatch, null);
});

test("queue timeout resolves to callback with expired entries", () => {
  ["t1", "t2"].forEach((id) => leaveQueue(id));
  const now = Date.now();
  joinQueue("t1", "Timeout 1", now - 120_000);
  joinQueue("t2", "Timeout 2", now - 1_000);
  const expired = [];
  tickTimeouts(60_000, (entry) => {
    expired.push(entry.playerId);
  });
  expired.sort();
  assert.deepEqual(expired, ["t1"]);
  assert.equal(hasInQueue("t1"), false);
  assert.equal(hasInQueue("t2"), true);
});
