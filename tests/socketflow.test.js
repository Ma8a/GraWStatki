const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const socketClientBundle = require("../node_modules/socket.io/client-dist/socket.io.js");
const socketConnect = typeof socketClientBundle === "function" ? socketClientBundle : socketClientBundle.io;
const {
  createEmptyBoard,
  placeFleetRandomly,
} = require("../dist/server/shared/game.js");

const waitForServer = (proc, port, timeoutMs = 6_000) =>
  new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout.off("data", onData);
      proc.stderr.off("data", onData);
    };
    const onData = (chunk) => {
      if (done) return;
      const text = String(chunk);
      if (text.includes(`Server listening on http://localhost:${port}`)) {
        done = true;
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      done = true;
      cleanup();
      reject(new Error(`Server startup timeout (${port})`));
    }, timeoutMs);

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.once("exit", () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("Server exited before readiness"));
    });
  });

const startTestServer = async (port, extraEnv = {}) => {
  const proc = spawn("node", [path.join(__dirname, "../dist/server/server/index.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      REDIS_URL: "",
      DATABASE_URL: "",
      REDIS_REQUIRED: "0",
      DATABASE_REQUIRED: "0",
      REDIS_KEY_PREFIX: `${REDIS_TEST_NAMESPACE}:${port}`,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(proc, port);
  return {
    proc,
    close: () =>
      new Promise((resolve) => {
        if (proc.killed) {
          resolve();
          return;
        }
        proc.once("exit", () => resolve());
        proc.kill();
      }),
  };
};

const EVENT_BUFFER_LIMIT = 64;

const getSocketEventBuffer = (socket) =>
  socket && socket.__eventBuffer instanceof Map ? socket.__eventBuffer : null;

const takeBufferedEvent = (socket, event, predicate) => {
  const eventBuffer = getSocketEventBuffer(socket);
  if (!eventBuffer) return { found: false };
  const queue = eventBuffer.get(event);
  if (!Array.isArray(queue) || queue.length === 0) return { found: false };

  for (let index = 0; index < queue.length; index += 1) {
    const payload = queue[index];
    if (predicate(payload)) {
      queue.splice(index, 1);
      return { found: true, payload };
    }
  }

  return { found: false };
};

const clearBufferedEvents = (socket, event) => {
  const eventBuffer = getSocketEventBuffer(socket);
  if (!eventBuffer) return;
  eventBuffer.set(event, []);
};

const waitForEvent = (socket, event, timeoutMs = 5_000) =>
  new Promise((resolve, reject) => {
    const buffered = takeBufferedEvent(socket, event, () => true);
    if (buffered.found) {
      resolve(buffered.payload);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for "${event}"`));
    }, timeoutMs);
    const handler = (payload) => {
      cleanup();
      resolve(payload);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, handler);
    };
    socket.once(event, handler);
  });

const requestSocketIoPollingHandshake = (port, options = {}) =>
  new Promise((resolve, reject) => {
    const headers = {};
    if (typeof options.origin === "string" && options.origin.length > 0) {
      headers.Origin = options.origin;
    }
    if (typeof options.host === "string" && options.host.length > 0) {
      headers.Host = options.host;
    }
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: `/socket.io/?EIO=4&transport=polling&t=${Date.now().toString(36)}`,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });

const waitForConnectError = (socket, timeoutMs = 5_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for "connect_error"'));
    }, timeoutMs);
    const handler = (error) => {
      cleanup();
      resolve(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect_error", handler);
    };
    socket.once("connect_error", handler);
  });

const createClient = (port, options = {}) => {
  const socketOptions = {
    transports: ["websocket"],
    forceNew: true,
    multiplex: false,
  };
  if (Array.isArray(options.transports) && options.transports.length > 0) {
    socketOptions.transports = options.transports;
  }
  if (typeof options.reconnection === "boolean") {
    socketOptions.reconnection = options.reconnection;
  }
  if (typeof options.origin === "string" && options.origin.length > 0) {
    socketOptions.transportOptions = {
      websocket: {
        extraHeaders: {
          origin: options.origin,
          Origin: options.origin,
        },
      },
      polling: {
        extraHeaders: {
          origin: options.origin,
          Origin: options.origin,
        },
      },
    };
  }
  const socket = socketConnect(`http://127.0.0.1:${port}`, socketOptions);
  const eventBuffer = new Map();
  socket.__eventBuffer = eventBuffer;
  socket.onAny((event, payload) => {
    const queue = eventBuffer.get(event) ?? [];
    queue.push(payload);
    if (queue.length > EVENT_BUFFER_LIMIT) {
      queue.shift();
    }
    eventBuffer.set(event, queue);
  });
  return socket;
};

let nextPort = 36_000;
const randomPort = () => {
  const selected = nextPort;
  nextPort += 1;
  if (nextPort >= 38_000) {
    nextPort = 36_000;
  }
  return selected;
};
const REDIS_TEST_NAMESPACE = `socketflow:${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForEventFiltered = (socket, event, predicate, timeoutMs = 5_000) =>
  new Promise((resolve, reject) => {
    const buffered = takeBufferedEvent(socket, event, predicate);
    if (buffered.found) {
      resolve(buffered.payload);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      const eventBuffer = getSocketEventBuffer(socket);
      const bufferSummary = eventBuffer
        ? JSON.stringify(
            Object.fromEntries(
              ["queue:queued", "game:error", "game:state", "queue:matched", event]
                .map((name) => [name, (eventBuffer.get(name) || []).slice(-2)]),
            ),
          )
        : "no-buffer";
      reject(new Error(`Timeout waiting for filtered "${event}" | buffered=${bufferSummary}`));
    }, timeoutMs);

    const handler = (payload) => {
      if (predicate(payload)) {
        cleanup();
        resolve(payload);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, handler);
    };

    socket.on(event, handler);
  });

const hasNonEmptyMessage = (payload) =>
  typeof payload?.message === "string" && payload.message.length > 0;

const waitForEvents = (socket, event, predicate, count, timeoutMs = 5_000) =>
  Promise.all(
    Array.from({ length: count }, () => waitForEventFiltered(socket, event, predicate, timeoutMs)),
  );

const asServerBoard = (board) => ({
  width: board.width,
  height: board.height,
  ships: board.ships,
  shots: [],
});

const coordKey = (coord) => `${coord.row},${coord.col}`;
const buildShipCells = (board) => {
  const set = new Set();
  for (const ship of board.ships) {
    for (const cell of ship.cells) {
      set.add(coordKey(cell));
    }
  }
  return set;
};

const findEmptyCoord = (shipCells, width, height) => {
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const key = coordKey({ row, col });
      if (!shipCells.has(key)) {
        return { row, col };
      }
    }
  }
  return { row: -1, col: -1 };
};

const setupPlayingRoom = async (socketA, socketB, nickA = "Alpha", nickB = "Beta") => {
  const aMatched = waitForEventFiltered(
    socketA,
    "queue:matched",
    (payload) => payload.vsBot === false,
    4_000,
  );
  const bMatched = waitForEventFiltered(
    socketB,
    "queue:matched",
    (payload) => payload.vsBot === false,
    4_000,
  );

  socketA.emit("search:join", { nickname: nickA });
  socketB.emit("search:join", { nickname: nickB });

  const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
  assert.equal(aMatch.roomId, bMatch.roomId);
  const roomId = aMatch.roomId;

  const boardA = placeFleetRandomly(createEmptyBoard());
  const boardB = placeFleetRandomly(createEmptyBoard());
  socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
  socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

  const [stateA, stateB] = await Promise.all([
    waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    ),
    waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    ),
  ]);

  return { roomId, aMatch, bMatch, boardA, boardB, stateA, stateB };
};

test("socket handshake accepts allowed origin and rejects disallowed origin", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    CORS_ORIGINS: "http://allowed.example",
    REQUIRE_ORIGIN_HEADER: "1",
  });

  try {
    const allowed = await requestSocketIoPollingHandshake(port, {
      origin: "http://allowed.example",
    });
    const blocked = await requestSocketIoPollingHandshake(port, {
      origin: "http://blocked.example",
    });
    const missing = await requestSocketIoPollingHandshake(port);

    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body.includes("sid"), true);
    assert.equal(blocked.statusCode === 400 || blocked.statusCode === 403, true);
    assert.equal(missing.statusCode === 400 || missing.statusCode === 403, true);
  } finally {
    await server.close();
  }
});

test("socket handshake without origin is allowed when host is in CORS_ORIGINS", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    CORS_ORIGINS: "https://grawstatki.devos.uk,https://battleship.devos.uk",
    REQUIRE_ORIGIN_HEADER: "1",
  });

  try {
    const allowedPrimaryHost = await requestSocketIoPollingHandshake(port, {
      host: "grawstatki.devos.uk",
    });
    const allowedSecondaryHost = await requestSocketIoPollingHandshake(port, {
      host: "battleship.devos.uk:443",
    });
    const blockedHost = await requestSocketIoPollingHandshake(port, {
      host: "blocked.example",
    });

    assert.equal(allowedPrimaryHost.statusCode, 200);
    assert.equal(allowedPrimaryHost.body.includes("sid"), true);
    assert.equal(allowedSecondaryHost.statusCode, 200);
    assert.equal(allowedSecondaryHost.body.includes("sid"), true);
    assert.equal(blockedHost.statusCode === 400 || blockedHost.statusCode === 403, true);
  } finally {
    await server.close();
  }
});

test("socket handshake accepts second configured production origin", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    CORS_ORIGINS: "https://grawstatki.devos.uk,https://battleship.devos.uk",
    REQUIRE_ORIGIN_HEADER: "1",
  });

  try {
    const secondary = await requestSocketIoPollingHandshake(port, {
      origin: "https://battleship.devos.uk",
    });
    assert.equal(secondary.statusCode, 200);
    assert.equal(secondary.body.includes("sid"), true);
  } finally {
    await server.close();
  }
});

test("socket handshake allows any origin when CORS_ORIGINS is wildcard", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    CORS_ORIGINS: "*",
  });
  const socketA = createClient(port, {
    origin: "http://random-a.example",
    reconnection: false,
  });
  const socketB = createClient(port, {
    origin: "https://random-b.example",
    reconnection: false,
  });

  try {
    await Promise.all([
      waitForEvent(socketA, "connect", 3_000),
      waitForEvent(socketB, "connect", 3_000),
    ]);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("socket handshake allows missing origin header when whitelist is configured", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    CORS_ORIGINS: "http://allowed.example",
  });
  const socket = createClient(port, {
    reconnection: false,
  });

  try {
    await waitForEvent(socket, "connect", 3_000);
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("socket.io client without origin is rejected when REQUIRE_ORIGIN_HEADER is enabled", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    CORS_ORIGINS: "http://allowed.example",
    REQUIRE_ORIGIN_HEADER: "1",
  });
  const socket = createClient(port, {
    reconnection: false,
    transports: ["polling"],
  });

  try {
    const [connected, connectError] = await Promise.all([
      waitForEvent(socket, "connect", 1_500).then(() => true).catch(() => false),
      waitForConnectError(socket, 3_000).then((error) => error).catch(() => null),
    ]);
    assert.equal(connected, false);
    assert.equal(typeof connectError?.message, "string");
    assert.equal(connectError.message.length > 0, true);
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("socket.io client with disallowed origin is rejected when REQUIRE_ORIGIN_HEADER is enabled", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    CORS_ORIGINS: "http://allowed.example",
    REQUIRE_ORIGIN_HEADER: "1",
  });
  const socket = createClient(port, {
    origin: "http://blocked.example",
    reconnection: false,
    transports: ["polling"],
  });

  try {
    const [connected, connectError] = await Promise.all([
      waitForEvent(socket, "connect", 1_500).then(() => true).catch(() => false),
      waitForConnectError(socket, 3_000).then((error) => error).catch(() => null),
    ]);
    assert.equal(connected, false);
    assert.equal(typeof connectError?.message, "string");
    assert.equal(connectError.message.length > 0, true);
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("matchmaking emits queue:matched to both players when two players join queue", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEvent(socketA, "queue:matched", 4_000);
    const bMatched = waitForEvent(socketB, "queue:matched", 4_000);

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aPayload, bPayload] = await Promise.all([aMatched, bMatched]);
    assert.equal(aPayload.vsBot, false);
    assert.equal(bPayload.vsBot, false);
    assert.equal(aPayload.roomId, bPayload.roomId);
    assert.equal(typeof aPayload.reconnectToken, "string");
    assert.equal(typeof bPayload.reconnectToken, "string");
    assert.equal(aPayload.reconnectToken.length > 0, true);
    assert.equal(bPayload.reconnectToken.length > 0, true);
    assert.equal(typeof aPayload.message, "string");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("queue timeout falls back to bot when no opponent found", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "300" });

  const socketA = createClient(port);

  try {
    const matched = waitForEvent(socketA, "queue:matched", 4_000);
    socketA.emit("search:join", { nickname: "Solo" });
    const payload = await matched;

    assert.equal(payload.vsBot, true);
    assert.equal(payload.opponent, "Bot");
    assert.equal(typeof payload.reconnectToken, "string");
    assert.equal(payload.reconnectToken.length > 0, true);
    assert.equal(payload.message.includes("Timeout kolejki"), true);
    assert.equal(typeof payload.roomId, "string");
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("search:cancel emits game:cancelled when player aborts queue", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "10_000" });

  const socketA = createClient(port);

  try {
    const queued = waitForEvent(socketA, "queue:queued", 2_000);
    socketA.emit("search:join", { nickname: "Solo" });
    await queued;

    const cancelled = waitForEvent(socketA, "game:cancelled", 2_000);
    socketA.emit("search:cancel");
    const payload = await cancelled;
    assert.equal(payload.reason, "queue_cancelled");
    assert.equal(payload.message.includes("Anulowano"), true);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("search:cancel outside queue returns search_cancelled", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "10_000" });
  const socketA = createClient(port);

  try {
    const cancelled = waitForEventFiltered(
      socketA,
      "game:cancelled",
      (payload) => payload.reason === "search_cancelled",
      2_000,
    );
    socketA.emit("search:cancel");
    const payload = await cancelled;
    assert.equal(payload.reason, "search_cancelled");
    assert.equal(payload.message.includes("Brak aktywnego"), true);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("search:cancel during active game behaves as manual cancel", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    const cancelledA = waitForEventFiltered(
      socketA,
      "game:cancelled",
      (payload) => payload.roomId === roomId && payload.reason === "manual_cancel",
      4_000,
    );
    const cancelledB = waitForEventFiltered(
      socketB,
      "game:cancelled",
      (payload) => payload.roomId === roomId && payload.reason === "manual_cancel",
      4_000,
    );
    const overA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId && payload.reason === "manual_cancel",
      6_000,
    );
    const overB = waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload.roomId === roomId && payload.reason === "manual_cancel",
      6_000,
    );

    socketA.emit("search:cancel");

    const [cancelA, cancelB, endA, endB] = await Promise.all([
      cancelledA,
      cancelledB,
      overA,
      overB,
    ]);
    assert.equal(cancelA.message, "Gra anulowana przez gracza.");
    assert.equal(cancelB.message, "Gra anulowana przez gracza.");
    assert.equal(endA.winner, socketB.id);
    assert.equal(endB.winner, socketB.id);
    assert.equal(endA.reason, "manual_cancel");
    assert.equal(endB.reason, "manual_cancel");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:cancel outside game returns game:error", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "10_000" });
  const socketA = createClient(port);

  try {
    const errorPayload = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => typeof payload?.message === "string",
      2_000,
    );
    socketA.emit("game:cancel");
    const payload = await errorPayload;
    assert.equal(payload.message, "Brak aktywnej gry.");
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("game:cancel emits game:cancelled when used during queue wait", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "10_000" });

  const socketA = createClient(port);

  try {
    const queued = waitForEventFiltered(
      socketA,
      "queue:queued",
      () => true,
      3_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    const queuePayload = await queued;

    const cancelled = waitForEventFiltered(
      socketA,
      "game:cancelled",
      (payload) => payload.reason === "queue_cancelled",
      3_000,
    );
    socketA.emit("game:cancel");

    const payload = await cancelled;
    assert.equal(payload.reason, "queue_cancelled");
    assert.equal(payload.message.includes("Anulowano oczekiwanie"), true);
    assert.equal(payload.roomId, undefined);
    assert.equal(typeof queuePayload.playerId, "string");
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("search:cancel allows player to join queue again", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "10_000" });

  const socketA = createClient(port);

  try {
    const firstQueued = waitForEventFiltered(
      socketA,
      "queue:queued",
      () => true,
      3_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    const firstPayload = await firstQueued;
    const firstJoinedAt = firstPayload.joinedAt;

    const cancelled = waitForEventFiltered(
      socketA,
      "game:cancelled",
      (payload) => payload.reason === "queue_cancelled",
      3_000,
    );
    socketA.emit("search:cancel");
    await cancelled;

    const secondQueued = waitForEventFiltered(
      socketA,
      "queue:queued",
      () => true,
      3_000,
    );
    socketA.emit("search:join", { nickname: "Solo2" });
    const secondPayload = await secondQueued;

    assert.equal(firstPayload.playerId, secondPayload.playerId);
    assert.ok(secondPayload.joinedAt >= firstJoinedAt);
    assert.equal(secondPayload.timeoutMs, firstPayload.timeoutMs);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("can join queue again after game over", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    const cancelledA = waitForEventFiltered(
      socketA,
      "game:cancelled",
      (payload) => payload.roomId === roomId,
      4_000,
    );
    const cancelledB = waitForEventFiltered(
      socketB,
      "game:cancelled",
      (payload) => payload.roomId === roomId,
      4_000,
    );
    const overA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId,
      6_000,
    );
    const overB = waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload.roomId === roomId,
      6_000,
    );

    socketA.emit("game:cancel");

    const [cancelPayloadA, cancelPayloadB, overPayloadA, overPayloadB] = await Promise.all([
      cancelledA,
      cancelledB,
      overA,
      overB,
    ]);
    assert.equal(cancelPayloadA.reason, "manual_cancel");
    assert.equal(cancelPayloadB.reason, "manual_cancel");
    assert.equal(overPayloadA.reason, "manual_cancel");
    assert.equal(overPayloadB.reason, "manual_cancel");

    const queuedAfterOver = waitForEventFiltered(
      socketA,
      "queue:queued",
      () => true,
      4_000,
    );
    socketA.emit("search:join", { nickname: "Alpha-Rejoin" });
    const queuePayload = await queuedAfterOver;
    assert.equal(typeof queuePayload.playerId, "string");
    assert.equal(queuePayload.timeoutMs, 60_000);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("online shot by player not on turn returns game:error", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "TurnA" });
    socketB.emit("search:join", { nickname: "TurnB" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const stateA = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    const stateB = await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    const notTurnClient = stateA.yourTurn ? socketB : socketA;
    const errorPayload = waitForEventFiltered(
      notTurnClient,
      "game:error",
      (payload) => payload?.message === "Nie jest Twoja tura.",
      4_000,
    );

    notTurnClient.emit("game:shot", { roomId, coord: { row: 0, col: 0 } });
    const payload = await errorPayload;
    assert.equal(payload.message, "Nie jest Twoja tura.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("queue timeout env with underscore parses as full number", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "1_000" });
  const socketA = createClient(port);

  try {
    const queued = waitForEventFiltered(
      socketA,
      "queue:queued",
      () => true,
      2_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    await queued;
    const earlyMatched = await waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === true,
      120,
    ).then(() => true).catch(() => false);
    assert.equal(earlyMatched, false);

    const matched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === true,
      4_000,
    );
    const payload = await matched;
    assert.equal(payload.vsBot, true);
    assert.equal(payload.message.includes("Timeout kolejki"), true);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("queue:queued timeout uses effective minimum of match timeout and room inactivity timeout", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    MATCH_TIMEOUT_MS: "30_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "1_500",
  });
  const socketA = createClient(port);

  try {
    const queued = waitForEventFiltered(
      socketA,
      "queue:queued",
      () => true,
      2_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    const queuedPayload = await queued;
    assert.equal(queuedPayload.timeoutMs, 1_500);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("queue fallback to bot uses effective minimum timeout", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    MATCH_TIMEOUT_MS: "5_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "1_500",
  });
  const socketA = createClient(port);

  try {
    const queued = waitForEventFiltered(
      socketA,
      "queue:queued",
      (payload) => typeof payload?.timeoutMs === "number",
      2_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    const queuedPayload = await queued;
    assert.equal(queuedPayload.timeoutMs, 1_500);

    const before = Date.now();
    const matched = await Promise.race([
      waitForEventFiltered(
        socketA,
        "queue:matched",
        (payload) => payload.vsBot === true,
        3_000,
      ).then(() => "matched"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 3_500)),
    ]);
    const elapsed = Date.now() - before;
    assert.equal(matched, "matched");
    assert.equal(elapsed <= 3_000, true);
    assert.equal(elapsed >= 1_000, true);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("room inactivity timeout env with underscore parses as full number", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    MATCH_TIMEOUT_MS: "30_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "1_000",
  });
  const socketA = createClient(port);

  try {
    const matched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === true,
      4_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    const matchPayload = await matched;
    assert.equal(matchPayload.vsBot, true);

    const boardA = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId: matchPayload.roomId, board: asServerBoard(boardA) });

    await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === matchPayload.roomId && payload.phase === "playing",
      8_000,
    );

    const tooEarly = await waitForEventFiltered(
      socketA,
      "game:over",
      () => true,
      700,
    ).then(() => true).catch(() => false);
    assert.equal(tooEarly, false);

    const overPayload = await waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.reason === "inactivity_timeout",
      4_000,
    );
    assert.equal(overPayload.reason, "inactivity_timeout");
    assert.equal(overPayload.winner, null);
    assert.equal(overPayload.roomId, matchPayload.roomId);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("search:join while already queued returns existing queue entry", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "10_000" });

  const socketA = createClient(port);

  try {
    const firstQueued = waitForEvent(socketA, "queue:queued", 4_000);
    socketA.emit("search:join", { nickname: "Solo" });
    const firstPayload = await firstQueued;

    const secondQueued = waitForEventFiltered(
      socketA,
      "queue:queued",
      (payload) => typeof payload?.joinedAt === "number",
      4_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    const secondPayload = await secondQueued;

    assert.equal(firstPayload.playerId, secondPayload.playerId);
    assert.equal(firstPayload.joinedAt, secondPayload.joinedAt);
    assert.equal(firstPayload.timeoutMs, secondPayload.timeoutMs);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("bot fallback room can accept first shot after setup", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "300" });

  const socketA = createClient(port);

  try {
    const matched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === true,
      4_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    const payload = await matched;
    assert.equal(payload.opponent, "Bot");
    const roomId = payload.roomId;

    const board = placeFleetRandomly(createEmptyBoard());
    const statePlaying = waitForEventFiltered(
      socketA,
      "game:state",
      (eventPayload) => eventPayload.roomId === roomId && eventPayload.phase === "playing",
      8_000,
    );
    socketA.emit("game:place_ships", {
      roomId,
      board: asServerBoard(board),
    });

    await statePlaying;

    const shotResult = waitForEventFiltered(
      socketA,
      "game:shot_result",
      (eventPayload) => eventPayload.roomId === roomId && eventPayload.shooter === socketA.id,
      4_000,
    );
    socketA.emit("game:shot", { roomId, coord: { row: 0, col: 0 } });

    const result = await shotResult;
    const expectedYourTurn = result.outcome === "miss" ? false : true;
    const turnPayload = await waitForEventFiltered(
      socketA,
      "game:turn",
      (eventPayload) =>
        eventPayload.roomId === roomId &&
        !eventPayload.gameOver &&
        eventPayload.yourTurn === expectedYourTurn &&
        (eventPayload.yourShots + eventPayload.opponentShots >= 1),
      8_000,
    );
    assert.ok(["miss", "hit", "sink"].includes(result.outcome));
    assert.equal(turnPayload.yourTurn, expectedYourTurn);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("server sanitizes submitted board state (ignores client-side hits/sunk flags)", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const cleanBoardA = placeFleetRandomly(createEmptyBoard());
    const cleanBoardB = placeFleetRandomly(createEmptyBoard());
    const boardAForServer = {
      ...cleanBoardA,
      ships: cleanBoardA.ships.map((ship, index) => ({
        ...ship,
        id: ship.id || `ship-${index}`,
        hits: new Array(ship.cells.length).fill(true),
        sunk: true,
      })),
    };

    const type2Ship = cleanBoardA.ships.find((ship) => ship.type === 2);
    assert.ok(type2Ship, "Expected a 2-cell ship in generated fleet");
    const targetCell = type2Ship.cells[0];

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardAForServer) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(cleanBoardB) });

    const stateA = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    if (stateA.turn === socketA.id) {
      const boardCellsB = buildShipCells(cleanBoardB);
      const miss = findEmptyCoord(boardCellsB, cleanBoardB.width, cleanBoardB.height);
      assert.ok(miss.row >= 0 && miss.col >= 0, "Expected an empty coordinate on B board");

      const aShot = waitForEventFiltered(
        socketA,
        "game:shot_result",
        (payload) =>
          payload.roomId === roomId &&
          payload.shooter === socketA.id &&
          payload.coord?.row === miss.row &&
          payload.coord?.col === miss.col,
        4_000,
      );
      const aTurn = waitForEventFiltered(
        socketA,
        "game:turn",
        (payload) => payload.roomId === roomId && payload.yourTurn === false && payload.turn === socketB.id,
        4_000,
      );
      socketA.emit("game:shot", { roomId, coord: miss });
      const firstA = await aShot;
      assert.equal(firstA.outcome, "miss");
      await aTurn;
    }

    const bShot = waitForEventFiltered(
      socketB,
      "game:shot_result",
      (payload) =>
        payload.roomId === roomId &&
        payload.shooter === socketB.id &&
        payload.coord?.row === targetCell.row &&
        payload.coord?.col === targetCell.col,
      6_000,
    );
    socketB.emit("game:shot", { roomId, coord: targetCell });
    const shotResult = await bShot;
    assert.equal(shotResult.outcome, "hit");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("server sanitizes submitted shot history (treats any provided shots as empty)", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    const boardCellSetA = buildShipCells(boardA);
    const boardBCellSet = buildShipCells(boardB);
    const targetCoord = boardCellSetA.values().next().value;
    assert.ok(targetCoord, "Expected target coordinate from board A");

    const [targetRow, targetCol] = targetCoord.split(",").map((value) => Number.parseInt(value, 10));
    const craftedBoardA = {
      ...boardA,
      shots: [{ row: targetRow, col: targetCol }],
    };

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(craftedBoardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const [stateA, stateB] = await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    const shooter = stateA.turn === socketB.id ? socketB : socketA;
    const targetShooterIsB = shooter === socketB;

    if (!targetShooterIsB) {
      const empty = findEmptyCoord(boardBCellSet, boardA.width, boardA.height);
      assert.ok(empty.row >= 0 && empty.col >= 0);
      const turnAfter = waitForEventFiltered(
        socketA,
        "game:turn",
        (payload) =>
          payload.roomId === roomId &&
          payload.turn === socketB.id &&
          (payload.yourShots + payload.opponentShots >= 1),
        4_000,
      );
      const miss = waitForEventFiltered(
        socketA,
        "game:shot_result",
        (payload) =>
          payload.roomId === roomId &&
          payload.shooter === socketA.id &&
          payload.coord?.row === empty.row &&
          payload.coord?.col === empty.col,
        4_000,
      );
      socketA.emit("game:shot", { roomId, coord: empty });
      await miss;
      await turnAfter;
    }

    const shot = waitForEventFiltered(
      socketB,
      "game:shot_result",
      (payload) => payload.roomId === roomId && payload.shooter === socketB.id && payload.coord?.row === targetRow && payload.coord?.col === targetCol,
      8_000,
    );

    socketB.emit("game:shot", { roomId, coord: { row: targetRow, col: targetCol } });
    const shotResult = await shot;
    assert.equal(shotResult.outcome, "hit");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:place_ships rejects malformed payload types and then accepts valid board", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const malformedPayloads = [null, "bad", 123, true, []];
    for (const payload of malformedPayloads) {
      const errorPayload = waitForEventFiltered(
        socketA,
        "game:error",
        (eventPayload) => eventPayload?.message === "Nieprawidłowe dane ustawienia statków.",
        2_000,
      );
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        socketA.emit("game:place_ships", { roomId, ...payload });
      } else {
        socketA.emit("game:place_ships", payload);
      }
      const response = await errorPayload;
      assert.equal(response.message, "Nieprawidłowe dane ustawienia statków.");
    }

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const stateA = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    const stateB = await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    assert.equal(stateA.phase, "playing");
    assert.equal(stateB.phase, "playing");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:place_ships accepts oversized shot history payload arrays", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "300" });

  const socket = createClient(port);

  try {
    const matched = waitForEventFiltered(
      socket,
      "queue:matched",
      (payload) => payload.vsBot === true,
      4_000,
    );
    socket.emit("search:join", { nickname: "Alpha" });
    const match = await matched;
    const roomId = match.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const shotNoise = Array.from({ length: 1_200 }, (_, index) => `r${index},c${index}`);

    const boardANoisy = {
      width: boardA.width,
      height: boardA.height,
      ships: boardA.ships,
      shots: shotNoise,
      hits: shotNoise,
    };

    const state = waitForEventFiltered(
      socket,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      10_000,
    );
    socket.emit("game:place_ships", { roomId, board: boardANoisy });

    const resolved = await state;
    assert.equal(resolved.phase, "playing");
    assert.equal(typeof resolved.yourBoard.shots, "object");
    assert.equal(typeof resolved.opponentBoard.shots, "object");
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("online shot flow keeps turn on hit and passes after miss", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEvent(socketA, "queue:matched", 4_000);
    const bMatched = waitForEvent(socketB, "queue:matched", 4_000);

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    const boardShipSetA = buildShipCells(boardA);
    const boardShipSetB = buildShipCells(boardB);

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const aPlaying = waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    const bPlaying = waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const [stateA, stateB] = await Promise.all([aPlaying, bPlaying]);
    const shooterSocket = stateA.turn === socketA.id ? socketA : socketB;
    const waitingSocket = shooterSocket === socketA ? socketB : socketA;
    const targetBoard = shooterSocket === socketA ? boardB : boardA;
    const targetSet = shooterSocket === socketA ? boardShipSetB : boardShipSetA;

    const firstShipCell = Array.from(targetSet)[0];
    assert.ok(typeof firstShipCell === "string");
    const [hitRow, hitCol] = firstShipCell.split(",").map((value) => Number.parseInt(value, 10));
    const hit = { row: hitRow, col: hitCol };

    const empty = findEmptyCoord(targetSet, targetBoard.width, targetBoard.height);
    assert.ok(empty.row >= 0 && empty.col >= 0);

    const shooterHit = waitForEventFiltered(
      shooterSocket,
      "game:shot_result",
      (payload) => payload.shooter === shooterSocket.id && payload.coord?.row === hit.row && payload.coord?.col === hit.col,
      4_000,
    );
    shooterSocket.emit("game:shot", { roomId, coord: hit });
    const hitResult = await shooterHit;
    assert.equal(hitResult.outcome === "hit" || hitResult.outcome === "sink", true);

    const shooterTurnAfterHit = waitForEventFiltered(
      shooterSocket,
      "game:turn",
      (payload) =>
        payload.roomId === roomId &&
        payload.yourTurn === true &&
        (payload.yourShots + payload.opponentShots >= 1),
      4_000,
    );
    const waitingTurnAfterHit = waitForEventFiltered(
      waitingSocket,
      "game:turn",
      (payload) =>
        payload.roomId === roomId &&
        payload.yourTurn === false &&
        (payload.yourShots + payload.opponentShots >= 1),
      4_000,
    );
    const [turnShooterAfterHit, turnWaitingAfterHit] = await Promise.all([
      shooterTurnAfterHit,
      waitingTurnAfterHit,
    ]);
    assert.equal(turnShooterAfterHit.yourTurn, true);
    assert.equal(turnWaitingAfterHit.yourTurn, false);

    const shooterMiss = waitForEventFiltered(
      shooterSocket,
      "game:shot_result",
      (payload) =>
        payload.shooter === shooterSocket.id && payload.coord?.row === empty.row && payload.coord?.col === empty.col,
      4_000,
    );
    shooterSocket.emit("game:shot", { roomId, coord: empty });
    const missResult = await shooterMiss;
    assert.equal(missResult.outcome, "miss");

    const shooterTurnAfterMiss = waitForEventFiltered(
      shooterSocket,
      "game:turn",
      (payload) =>
        payload.roomId === roomId &&
        payload.yourTurn === false &&
        (payload.yourShots + payload.opponentShots >= 2),
      4_000,
    );
    const waitingTurnAfterMiss = waitForEventFiltered(
      waitingSocket,
      "game:turn",
      (payload) =>
        payload.roomId === roomId &&
        payload.yourTurn === true &&
        (payload.yourShots + payload.opponentShots >= 2),
      4_000,
    );
    const [turnShooterAfterMiss, turnWaitingAfterMiss] = await Promise.all([
      shooterTurnAfterMiss,
      waitingTurnAfterMiss,
    ]);
    assert.equal(turnShooterAfterMiss.yourTurn, false);
    assert.equal(turnWaitingAfterMiss.yourTurn, true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("online game ends after all ships of opponent are sunk, and rejects further shots", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    const boardShipSetA = buildShipCells(boardA);
    const boardShipSetB = buildShipCells(boardB);

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const stateA = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const shooterSocket = stateA.turn === socketA.id ? socketA : socketB;
    const targetSet = shooterSocket === socketA ? boardShipSetB : boardShipSetA;
    const shooterCoords = Array.from(targetSet).map((entry) => {
      const [row, col] = entry.split(",").map((value) => Number.parseInt(value, 10));
      return { row, col };
    });
    const waitForShooterShot = (coord) =>
      waitForEventFiltered(
        shooterSocket,
        "game:shot_result",
        (payload) =>
          payload.roomId === roomId &&
          payload.shooter === shooterSocket.id &&
          payload.coord?.row === coord.row &&
          payload.coord?.col === coord.col,
        4_000,
      );

    let gameOverPayload = null;
    for (const coord of shooterCoords) {
      const awaitResult = waitForShooterShot(coord);
      shooterSocket.emit("game:shot", { roomId, coord });
      const shotResult = await awaitResult;
      if (shotResult.outcome === "sink" && shotResult.gameOver) {
        gameOverPayload = shotResult;
        break;
      }
    }

    assert.ok(gameOverPayload !== null, "Expected game to finish after all target hits");

    const overWinner = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId,
      6_000,
    );
    const overLoser = waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload.roomId === roomId,
      6_000,
    );
    const [overA, overB] = await Promise.all([overWinner, overLoser]);

    assert.equal(overA.winner, overB.winner);
    assert.equal(overA.winner, shooterSocket === socketA ? socketA.id : socketB.id);
    assert.equal(overA.totalShots, overA.yourShots + overA.opponentShots);
    assert.equal(overB.totalShots, overB.yourShots + overB.opponentShots);
    assert.equal(overA.totalShots, overB.totalShots);

    const loserSocket = shooterSocket === socketA ? socketB : socketA;
    const blockedError = waitForEventFiltered(
      loserSocket,
      "game:error",
      () => true,
      4_000,
    );
    loserSocket.emit("game:shot", { roomId, coord: { row: 0, col: 0 } });
    const errorPayload = await blockedError;
    assert.equal(errorPayload.message, "Brak aktywnej gry.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("can rejoin queue after game ends normally", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    const boardShipSetA = buildShipCells(boardA);
    const boardShipSetB = buildShipCells(boardB);

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const stateA = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const shooterSocket = stateA.turn === socketA.id ? socketA : socketB;
    const targetSet = shooterSocket === socketA ? boardShipSetB : boardShipSetA;
    const targetCoords = Array.from(targetSet).map((entry) => {
      const [row, col] = entry.split(",").map((value) => Number.parseInt(value, 10));
      return { row, col };
    });
    let gameOverReceived = false;
    const waitForShooterShot = (coord) =>
      waitForEventFiltered(
        shooterSocket,
        "game:shot_result",
        (payload) =>
          payload.roomId === roomId &&
          payload.shooter === shooterSocket.id &&
          payload.coord?.row === coord.row &&
          payload.coord?.col === coord.col,
        4_000,
      );

    for (const coord of targetCoords) {
      const shotResultPromise = waitForShooterShot(coord);
      shooterSocket.emit("game:shot", { roomId, coord });
      const shotResult = await shotResultPromise;
      if (shotResult.outcome === "sink" && shotResult.gameOver) {
        gameOverReceived = true;
        break;
      }
    }

    assert.equal(gameOverReceived, true, "Expected game to finish after all target hits");

    const overA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId,
      6_000,
    );
    const overB = waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload.roomId === roomId,
      6_000,
    );
    const [overPayloadA, overPayloadB] = await Promise.all([overA, overB]);

    assert.equal(overPayloadA.reason, "normal");
    assert.equal(overPayloadB.reason, "normal");

    const queued = waitForEventFiltered(
      socketA,
      "queue:queued",
      () => true,
      4_000,
    );
    socketA.emit("search:join", { nickname: "Alpha-Again" });
    const queuedPayload = await queued;
    assert.equal(typeof queuedPayload.playerId, "string");
    assert.equal(queuedPayload.playerId, socketA.id);
    assert.equal(queuedPayload.timeoutMs, 60_000);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("opponent disconnect ends game and grants victory to remaining player", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    const overPayloadA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId,
      6_000,
    );

    socketB.disconnect();

    const resultA = await overPayloadA;
    assert.equal(resultA.winner, socketA.id);
    assert.equal(resultA.reason, "disconnect");
    assert.equal(typeof resultA.message, "string");
    assert.equal(resultA.message.length > 0, true);
    assert.equal(resultA.totalShots, resultA.yourShots + resultA.opponentShots);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("manual cancel in active online game ends match and grants victory to remaining player", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    const cancelledPayload = waitForEventFiltered(
      socketB,
      "game:cancelled",
      (payload) => payload.roomId === roomId,
      4_000,
    );
    const overPayloadA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId,
      6_000,
    );
    const overPayloadB = waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload.roomId === roomId,
      6_000,
    );

    socketA.emit("game:cancel");

    const [cancelPayload, resultA, resultB] = await Promise.all([
      cancelledPayload,
      overPayloadA,
      overPayloadB,
    ]);
    assert.equal(cancelPayload.reason, "manual_cancel");
    assert.equal(cancelPayload.message.includes("Gra anulowana"), true);
    assert.equal(resultA.totalShots, resultA.yourShots + resultA.opponentShots);
    assert.equal(resultB.totalShots, resultB.yourShots + resultB.opponentShots);
    assert.equal(resultA.totalShots, resultB.totalShots);
    assert.equal(resultA.winner, socketB.id);
    assert.equal(resultA.reason, "manual_cancel");
    assert.equal(resultA.message.includes("Gra anulowana"), true);
    assert.equal(resultB.winner, socketB.id);
    assert.equal(resultB.reason, "manual_cancel");
    assert.equal(resultB.message.includes("Gra anulowana"), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("manual cancel during bot game ends with manual_cancel and bot wins", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    MATCH_TIMEOUT_MS: "250",
    ROOM_INACTIVITY_TIMEOUT_MS: "30_000",
  });

  const socketA = createClient(port);

  try {
    const matched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === true,
      4_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    const matchPayload = await matched;
    assert.equal(matchPayload.vsBot, true);

    const boardA = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId: matchPayload.roomId, board: asServerBoard(boardA) });

    await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === matchPayload.roomId && payload.phase === "playing",
      8_000,
    );

    const cancelledPayload = waitForEventFiltered(
      socketA,
      "game:cancelled",
      (payload) => payload.roomId === matchPayload.roomId,
      4_000,
    );
    const overPayload = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === matchPayload.roomId,
      6_000,
    );

    socketA.emit("game:cancel");

    const [cancelResult, overResult] = await Promise.all([cancelledPayload, overPayload]);
    assert.equal(cancelResult.reason, "manual_cancel");
    assert.equal(typeof cancelResult.message, "string");
    assert.equal(overResult.reason, "manual_cancel");
    assert.equal(overResult.winner.startsWith("bot-"), true);
    assert.equal(overResult.totalShots, overResult.yourShots + overResult.opponentShots);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("manual cancel during setup after one player is ready ends game with manual_cancel", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });

    const readyPayload = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.youReady === true && payload.opponentReady === false,
      6_000,
    );
    assert.equal(readyPayload.roomId, roomId);

    const cancelPayload = waitForEventFiltered(
      socketA,
      "game:cancelled",
      (payload) => payload.roomId === roomId,
      4_000,
    );
    const overPayloadA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId && payload.reason === "manual_cancel",
      6_000,
    );
    const overPayloadB = waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload.roomId === roomId && payload.reason === "manual_cancel",
      6_000,
    );

    socketA.emit("game:cancel");

    const [cancelResult, resultA, resultB] = await Promise.all([
      cancelPayload,
      overPayloadA,
      overPayloadB,
    ]);

    assert.equal(cancelResult.reason, "manual_cancel");
    assert.equal(cancelResult.roomId, roomId);
    assert.equal(resultA.winner, socketB.id);
    assert.equal(resultB.winner, socketB.id);
    assert.equal(resultA.message.includes("Gra anulowana"), true);
    assert.equal(resultB.message.includes("Gra anulowana"), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("cannot enter queue while already in active room", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    const errorPayload = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.message?.includes("w grze"),
      2_000,
    );
    socketA.emit("search:join", { nickname: "Alpha2" });
    const error = await errorPayload;
    assert.equal(typeof error.message, "string");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("online duplicate shot on same field is rejected with game:error", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    const boardShipSetA = buildShipCells(boardA);
    const boardShipSetB = buildShipCells(boardB);

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const stateA = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const shooterSocket = stateA.turn === socketA.id ? socketA : socketB;
    const targetBoard = shooterSocket === socketA ? boardB : boardA;
    const targetShip = targetBoard.ships.find((ship) => ship.type > 1);
    assert.ok(targetShip, "Expected a multi-cell ship on target board");
    const firstShot = targetShip.cells[0];
    const secondShot = targetShip.cells[1] ?? targetShip.cells[0];
    assert.ok(secondShot, "Expected second unique ship cell");

    const firstTurn = waitForEventFiltered(
      shooterSocket,
      "game:turn",
      (payload) => payload.roomId === roomId,
      4_000,
    );

    const firstShotResult = waitForEventFiltered(
      shooterSocket,
      "game:shot_result",
      (payload) =>
        payload.roomId === roomId &&
        payload.shooter === shooterSocket.id &&
        payload.coord?.row === firstShot.row &&
        payload.coord?.col === firstShot.col,
      5_000,
    );
    shooterSocket.emit("game:shot", { roomId, coord: firstShot });
    const firstShotOutcome = await firstShotResult;
    const firstTurnPayload = await firstTurn;
    const shotsAfterFirst = firstTurnPayload.yourShots;
    assert.notEqual(firstShotOutcome.outcome, "miss");

    const duplicateError = waitForEventFiltered(
      shooterSocket,
      "game:error",
      (payload) => payload?.message === "To pole zostało już trafione.",
      5_000,
    );
    shooterSocket.emit("game:shot", { roomId, coord: firstShot });

    const errorPayload = await duplicateError;
    assert.equal(errorPayload.message, "To pole zostało już trafione.");

    const secondTurn = waitForEventFiltered(
      shooterSocket,
      "game:turn",
      (payload) => payload.roomId === roomId && payload.yourShots === shotsAfterFirst + 1,
      5_000,
    );
    shooterSocket.emit("game:shot", { roomId, coord: secondShot });
    const secondTurnPayload = await secondTurn;
    assert.equal(secondTurnPayload.yourShots, shotsAfterFirst + 1);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:place_ships is rejected once game has started", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    const duplicatePlacementError = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.message === "Pozycjonowanie statków jest niedostępne podczas gry.",
      4_000,
    );
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });

    const errorPayload = await duplicatePlacementError;
    assert.equal(errorPayload.message, "Pozycjonowanie statków jest niedostępne podczas gry.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:shot with invalid roomId is rejected with game:error", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "300" });
  const socketA = createClient(port);

  try {
    const matched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === true,
      4_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    const payload = await matched;
    const roomId = payload.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    await waitForEventFiltered(
      socketA,
      "game:state",
      (eventPayload) => eventPayload.roomId === roomId && eventPayload.phase === "playing",
      6_000,
    );

    const invalidShotError = waitForEventFiltered(
      socketA,
      "game:error",
      (eventPayload) => eventPayload?.message === "Nieprawidłowe id pokoju.",
      4_000,
    );
    socketA.emit("game:shot", {
      roomId: `${roomId}-invalid`,
      coord: { row: 0, col: 0 },
    });

    const errorPayload = await invalidShotError;
    assert.equal(errorPayload.message, "Nieprawidłowe id pokoju.");
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("game:shot with non-integer coord is rejected with game:error", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const stateA = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const activeShooter = stateA.turn === socketA.id ? socketA : socketB;

    const errorPayload = waitForEventFiltered(
      activeShooter,
      "game:error",
      (eventPayload) => eventPayload?.message === "Błędne współrzędne.",
      4_000,
    );
    activeShooter.emit("game:shot", {
      roomId,
      coord: { row: 1.5, col: 2.7 },
    });

    const payload = await errorPayload;
    assert.equal(payload.message, "Błędne współrzędne.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:shot with string coord is rejected with game:error", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const stateA = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const activeShooter = stateA.turn === socketA.id ? socketA : socketB;

    const errorPayload = waitForEventFiltered(
      activeShooter,
      "game:error",
      (eventPayload) => eventPayload?.message === "Błędne współrzędne.",
      4_000,
    );
    activeShooter.emit("game:shot", {
      roomId,
      coord: { row: "A", col: "5" },
    });

    const payload = await errorPayload;
    assert.equal(payload.message, "Błędne współrzędne.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:shot with missing coord field is rejected with game:error", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const state = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const activeShooter = state.turn === socketA.id ? socketA : socketB;

    const errorPayload = waitForEventFiltered(
      activeShooter,
      "game:error",
      (payload) => payload?.message === "Błędne współrzędne.",
      4_000,
    );
    activeShooter.emit("game:shot", { roomId });
    const response = await errorPayload;
    assert.equal(response.message, "Błędne współrzędne.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:shot out of bounds is rejected with game:error", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const stateA = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const activeShooter = stateA.turn === socketA.id ? socketA : socketB;

    const errorPayload = waitForEventFiltered(
      activeShooter,
      "game:error",
      (eventPayload) => eventPayload?.message === "Błędne współrzędne.",
      4_000,
    );
    activeShooter.emit("game:shot", { roomId, coord: { row: 10, col: 0 } });
    const payload = await errorPayload;
    assert.equal(payload.message, "Błędne współrzędne.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:shot before game start is rejected with game:error", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });

    const setupState = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "setup" && payload.youReady === true,
      6_000,
    );
    const activeShooter = setupState.turn === socketA.id ? socketA : socketB;

    const setupShotError = waitForEventFiltered(
      activeShooter,
      "game:error",
      (payload) => payload?.message === "Rozpocznij po ustawieniu wszystkich statków.",
      4_000,
    );
    activeShooter.emit("game:shot", { roomId, coord: { row: 0, col: 0 } });

    const errorPayload = await setupShotError;
    assert.equal(errorPayload.message, "Rozpocznij po ustawieniu wszystkich statków.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:place_ships with invalid roomId is rejected with game:error", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "300" });
  const socketA = createClient(port);

  try {
    const matched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === true,
      4_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    const payload = await matched;
    const roomId = payload.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const badRoomError = waitForEventFiltered(
      socketA,
      "game:error",
      (eventPayload) => eventPayload?.message === "Nieprawidłowy pokój.",
      4_000,
    );
    socketA.emit("game:place_ships", {
      roomId: `${roomId}-invalid`,
      board: asServerBoard(boardA),
    });

    const errorPayload = await badRoomError;
    assert.equal(errorPayload.message, "Nieprawidłowy pokój.");
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("game:place_ships ignores invalid board payloads and keeps accepting valid placement", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const invalidBoards = [null, "invalid", 123, true, { ships: [] }, { width: "x", height: "y", ships: [] }, {}];

    for (const boardPayload of invalidBoards) {
      const errorPayload = waitForEventFiltered(
        socketA,
        "game:error",
        (payload) => payload?.message === "Nieprawidłowe dane ustawienia statków.",
        2_500,
      );
      socketA.emit("game:place_ships", { roomId, board: boardPayload });
      const err = await errorPayload;
      assert.equal(err.message, "Nieprawidłowe dane ustawienia statków.");
    }

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const stateA = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    const stateB = await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    assert.equal(stateA.phase, "playing");
    assert.equal(stateB.phase, "playing");
    assert.equal(stateA.roomId, roomId);
    assert.equal(stateB.roomId, roomId);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:place_ships accepts valid placement after malformed payload", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "300" });

  const socket = createClient(port);

  try {
    const matched = waitForEventFiltered(
      socket,
      "queue:matched",
      (payload) => payload.vsBot === true,
      4_000,
    );
    socket.emit("search:join", { nickname: "Solo" });
    const match = await matched;
    const roomId = match.roomId;

    const invalidPayload = waitForEventFiltered(
      socket,
      "game:error",
      (payload) => payload?.message === "Nieprawidłowe dane ustawienia statków.",
      2_500,
    );
    socket.emit("game:place_ships", {
      roomId,
      board: "invalid-board",
    });
    const invalidPayloadResult = await invalidPayload;
    assert.equal(invalidPayloadResult.message, "Nieprawidłowe dane ustawienia statków.");

    const playingState = waitForEventFiltered(
      socket,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    const validBoard = placeFleetRandomly(createEmptyBoard());
    socket.emit("game:place_ships", { roomId, board: asServerBoard(validBoard) });
    const statePayload = await playingState;
    assert.equal(statePayload.phase, "playing");
    assert.equal(statePayload.roomId, roomId);
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("game:place_ships invalid payload type flood returns validation error and still accepts valid placement", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "300" });
  const socket = createClient(port);

  try {
    const matched = waitForEventFiltered(
      socket,
      "queue:matched",
      (payload) => payload.vsBot === true,
      4_000,
    );
    socket.emit("search:join", { nickname: "Solo" });
    const match = await matched;
    const roomId = match.roomId;

    const invalidPayloads = [null, "invalid-type", 123, true, []];
    for (const payload of invalidPayloads) {
      const errorPayload = waitForEventFiltered(
        socket,
        "game:error",
        (eventPayload) => eventPayload?.message === "Nieprawidłowe dane ustawienia statków.",
        2_500,
      );
      socket.emit("game:place_ships", payload);
      const response = await errorPayload;
      assert.equal(response.message, "Nieprawidłowe dane ustawienia statków.");
    }

    const board = placeFleetRandomly(createEmptyBoard());
    const state = waitForEventFiltered(
      socket,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    socket.emit("game:place_ships", { roomId, board: asServerBoard(board) });
    const playingState = await state;

    assert.equal(playingState.roomId, roomId);
    assert.equal(playingState.phase, "playing");
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("game:place_ships is rate limited during burst", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    MATCH_TIMEOUT_MS: "300",
    RATE_LIMIT_PLACE_SHIPS_PER_WINDOW: "5",
    RATE_LIMIT_PLACE_SHIPS_WINDOW_MS: "1_500",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const matchedA = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const matchedB = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    socketA.emit("search:join", { nickname: "BurstCaptain" });
    socketB.emit("search:join", { nickname: "Opponent" });
    const [match] = await Promise.all([matchedA, matchedB]);
    const roomId = match.roomId;
    const boardA = placeFleetRandomly(createEmptyBoard());

    const rateLimitError = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.message === "Zbyt wiele ustawień statków. Poczekaj chwilę.",
      5_000,
    );

    for (let i = 0; i < 120; i += 1) {
      socketA.emit("game:place_ships", {
        roomId,
        board: asServerBoard(boardA),
      });
    }

    const payload = await rateLimitError;
    assert.equal(payload.message, "Zbyt wiele ustawień statków. Poczekaj chwilę.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:place_ships rate limit resets after window expires", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    MATCH_TIMEOUT_MS: "300",
    RATE_LIMIT_PLACE_SHIPS_PER_WINDOW: "5",
    RATE_LIMIT_PLACE_SHIPS_WINDOW_MS: "800",
  });
  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const matchedA = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const matchedB = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    socketB.emit("search:join", { nickname: "Opponent" });
    const [match] = await Promise.all([matchedA, matchedB]);
    assert.equal(match.vsBot, false);
    const roomId = match.roomId;
    const board = placeFleetRandomly(createEmptyBoard());

    const rateLimitError = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.message === "Zbyt wiele ustawień statków. Poczekaj chwilę.",
      5_000,
    );

    for (let index = 0; index < 7; index += 1) {
      socketA.emit("game:place_ships", {
        roomId,
        board: asServerBoard(board),
      });
    }

    await rateLimitError;

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    clearBufferedEvents(socketA, "game:error");
    clearBufferedEvents(socketA, "game:state");

    const afterWindowState = waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "setup" && payload.youReady === true,
      2_500,
    );
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(board) });
    const stateAfterWindow = await afterWindowState;
    assert.equal(stateAfterWindow.roomId, roomId);
    assert.equal(stateAfterWindow.phase, "setup");
    assert.equal(stateAfterWindow.youReady, true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("room without activity ends with inactivity timeout and game:over reason", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    MATCH_TIMEOUT_MS: "30_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "300",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      6_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      6_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    socketB.emit("search:join", { nickname: "Opponent" });
    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    assert.equal(aMatch.vsBot, false);
    assert.equal(bMatch.vsBot, false);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    const [overPayloadA, overPayloadB] = await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:over",
        (payload) => payload.roomId === roomId,
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:over",
        (payload) => payload.roomId === roomId,
        8_000,
      ),
    ]);
    assert.equal(overPayloadA.reason, "inactivity_timeout");
    assert.equal(overPayloadB.reason, "inactivity_timeout");
    assert.equal(overPayloadA.winner, null);
    assert.equal(overPayloadB.winner, null);
    assert.equal(overPayloadA.roomId, roomId);
    assert.equal(overPayloadB.roomId, roomId);
    assert.equal(overPayloadA.totalShots, overPayloadA.yourShots + overPayloadA.opponentShots);
    assert.equal(overPayloadB.totalShots, overPayloadB.yourShots + overPayloadB.opponentShots);
    assert.equal(typeof overPayloadA.message, "string");
    assert.equal(overPayloadB.message, overPayloadA.message);
    assert.equal(overPayloadA.message.includes("braku aktywności"), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("shooting after game over is rejected with no active game error", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    const boardShipSetA = buildShipCells(boardA);
    const boardShipSetB = buildShipCells(boardB);

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const [stateA, stateB] = await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);
    assert.equal(stateA.roomId, stateB.roomId);

    const shooterSocket = stateA.turn === socketA.id ? socketA : socketB;
    const targetSet = shooterSocket === socketA ? boardShipSetB : boardShipSetA;
    const targetCoords = Array.from(targetSet).map((entry) => {
      const [row, col] = entry.split(",").map((value) => Number.parseInt(value, 10));
      return { row, col };
    });

    for (const coord of targetCoords) {
      const shotResult = waitForEventFiltered(
        shooterSocket,
        "game:shot_result",
        (payload) =>
          payload.roomId === roomId &&
          payload.shooter === shooterSocket.id &&
          payload.coord?.row === coord.row &&
          payload.coord?.col === coord.col,
        4_000,
      );
      shooterSocket.emit("game:shot", { roomId, coord });
      const result = await shotResult;
      if (result.outcome === "sink" && result.gameOver) {
        break;
      }
    }

    const overPayload = await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:over",
        (payload) => payload.roomId === roomId,
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:over",
        (payload) => payload.roomId === roomId,
        8_000,
      ),
    ]);

    assert.equal(overPayload[0].roomId, roomId);
    assert.equal(overPayload[0].roomId, overPayload[1].roomId);

    const loserSocket = overPayload[0].winner === socketA.id ? socketB : socketA;
    const postOverError = waitForEventFiltered(
      loserSocket,
      "game:error",
      (payload) => payload?.message === "Brak aktywnej gry.",
      4_000,
    );
    loserSocket.emit("game:shot", { roomId, coord: { row: 0, col: 0 } });
    const errorPayload = await postOverError;
    assert.equal(errorPayload.message, "Brak aktywnej gry.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("search:join invalid payload type flood always returns input validation error and still allows normal join", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);

  try {
    const invalidPayloads = [null, "invalid-type", 123, true, []];
    for (const payload of invalidPayloads) {
      const errorPayload = waitForEventFiltered(
        socketA,
        "game:error",
        (eventPayload) => eventPayload?.message === "Nieprawidłowe dane dołączenia.",
        2_000,
      );
      socketA.emit("search:join", payload);
      const response = await errorPayload;
      assert.equal(response.message, "Nieprawidłowe dane dołączenia.");
    }

    const queued = waitForEventFiltered(
      socketA,
      "queue:queued",
      () => true,
      2_000,
    );
    socketA.emit("search:join", { nickname: "Tester" });
    const queuedPayloadSecond = await queued;
    assert.equal(queuedPayloadSecond.playerId, socketA.id);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("search:join accepts valid payload after malformed flood", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socket = createClient(port);

  try {
    const malformedPayloads = [null, "bad", 123, true, []];
    for (const payload of malformedPayloads) {
      const errorPayload = waitForEventFiltered(
        socket,
        "game:error",
        (eventPayload) => eventPayload?.message === "Nieprawidłowe dane dołączenia.",
        2_000,
      );
      socket.emit("search:join", payload);
      const response = await errorPayload;
      assert.equal(response.message, "Nieprawidłowe dane dołączenia.");
    }

    const floodWithToken = waitForEventFiltered(
      socket,
      "game:error",
      (eventPayload) => eventPayload?.message === "Nieprawidłowe dane dołączenia.",
      2_000,
    );
    socket.emit("search:join", { nickname: 12345, reconnectToken: null });
    const malformedResponse = await floodWithToken;
    assert.equal(malformedResponse.message, "Nieprawidłowe dane dołączenia.");

    const queuedPayloadPromise = waitForEventFiltered(
      socket,
      "queue:queued",
      (payload) => payload.playerId === socket.id,
      4_000,
    );
    socket.emit("search:join", { nickname: "Clean", reconnectToken: "tok-123456" });
    const queuedPayload = await queuedPayloadPromise;
    assert.equal(queuedPayload.playerId, socket.id);
    assert.equal(typeof queuedPayload.reconnectToken, "string");
    assert.equal(hasNonEmptyMessage(queuedPayload), true);
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("search:join accepts missing nickname as default and still joins queue", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);

  try {
    const queuedPayloadPromise = waitForEventFiltered(
      socketA,
      "queue:queued",
      (payload) => payload.playerId === socketA.id,
      2_000,
    );
    socketA.emit("search:join", { reconnectToken: "token-no-nickname" });
    const queuedPayload = await queuedPayloadPromise;
    assert.equal(queuedPayload.playerId, socketA.id);

    const queuedSecond = waitForEventFiltered(
      socketA,
      "queue:queued",
      () => true,
      2_000,
    );
    socketA.emit("search:join", { nickname: "Tester" });
    const secondQueuedPayload = await queuedSecond;
    assert.equal(secondQueuedPayload.playerId, socketA.id);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("search:join caps oversized payload fields while still joining queue", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socket = createClient(port);

  try {
    const longNickname = `${"A".repeat(400)}${"🛳️".repeat(200)}`;
    const longToken = `${"q-".repeat(200)}${"bad token with spaces".repeat(20)}`;
    const queuedPayloadPromise = waitForEventFiltered(
      socket,
      "queue:queued",
      (payload) => payload.playerId === socket.id,
      4_000,
    );
    socket.emit("search:join", { nickname: longNickname, reconnectToken: longToken });
    const queuedPayload = await queuedPayloadPromise;

    assert.equal(queuedPayload.playerId, socket.id);
    assert.equal(typeof queuedPayload.reconnectToken, "string");
    assert.equal(queuedPayload.reconnectToken.length <= 96, true);
    assert.equal(queuedPayload.message.length > 0, true);
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("search:join preserves long valid reconnectToken up to reconnect limit", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socket = createClient(port);

  try {
    const candidateToken = `q-${"a".repeat(60)}`;
    const queuedPayloadPromise = waitForEventFiltered(
      socket,
      "queue:queued",
      (payload) => payload.playerId === socket.id,
      4_000,
    );
    socket.emit("search:join", { nickname: "Tester", reconnectToken: candidateToken });
    const queuedPayload = await queuedPayloadPromise;

    assert.equal(queuedPayload.reconnectToken, candidateToken);
    assert.equal(queuedPayload.reconnectToken.length <= 96, true);
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("search:cancel invalid payload flood returns validation error and still accepts valid payload", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);

  try {
    const invalidPayloads = [null, "invalid-type", 123, true, []];
    for (const payload of invalidPayloads) {
      const errorPayload = waitForEventFiltered(
        socketA,
        "game:error",
        (eventPayload) => eventPayload?.message === "Nieprawidłowe dane anulowania.",
        2_000,
      );
      socketA.emit("search:cancel", payload);
      const response = await errorPayload;
      assert.equal(response.message, "Nieprawidłowe dane anulowania.");
    }

    const cancelledPayload = waitForEventFiltered(
      socketA,
      "game:cancelled",
      (payload) => payload.reason === "search_cancelled",
      2_000,
    );
    socketA.emit("search:cancel", {});
    const response = await cancelledPayload;
    assert.equal(response.reason, "search_cancelled");
    assert.equal(response.message.includes("Brak aktywnego"), true);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("game:cancel invalid payload flood returns validation error and still accepts valid payload", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);

  try {
    const invalidPayloads = [null, "invalid-type", 123, true, []];
    for (const payload of invalidPayloads) {
      const errorPayload = waitForEventFiltered(
        socketA,
        "game:error",
        (eventPayload) => eventPayload?.message === "Nieprawidłowe dane anulowania gry.",
        2_000,
      );
      socketA.emit("game:cancel", payload);
      const response = await errorPayload;
      assert.equal(response.message, "Nieprawidłowe dane anulowania gry.");
    }

    const cancelledPayload = waitForEventFiltered(
      socketA,
      "game:cancelled",
      (payload) => payload.reason === "search_cancelled",
      2_000,
    );
    socketA.emit("game:cancel", {});
    const response = await cancelledPayload;
    assert.equal(response.reason, "search_cancelled");
    assert.equal(response.message.includes("Brak aktywnej"), true);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("search:cancel enforces per-socket rate limit under burst", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);

  try {
    const rateLimited = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.message === "Za dużo żądań anulowania. Spróbuj ponownie za chwilę.",
      4_000,
    );

    for (let index = 0; index < 20; index += 1) {
      socketA.emit("search:cancel", {});
    }

    await rateLimited;
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("game:cancel enforces per-socket rate limit under burst", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);

  try {
    const rateLimited = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.message === "Za dużo żądań anulowania. Spróbuj ponownie za chwilę.",
      4_000,
    );

    for (let index = 0; index < 20; index += 1) {
      socketA.emit("game:cancel");
    }

    await rateLimited;
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("game:cancel rate limit resets after window expires", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);

  try {
    for (let index = 0; index < 20; index += 1) {
      socketA.emit("game:cancel");
    }

    await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.message === "Za dużo żądań anulowania. Spróbuj ponownie za chwilę.",
      4_000,
    );

    await new Promise((resolve) => setTimeout(resolve, 1_800));

    const cancelledPayload = waitForEventFiltered(
      socketA,
      "game:cancelled",
      (payload) => payload.reason === "search_cancelled",
      4_000,
    );
    socketA.emit("game:cancel");
    const response = await cancelledPayload;
    assert.equal(response.reason, "search_cancelled");
    assert.equal(response.message.includes("Brak aktywnej"), true);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("search:cancel rate limit resets after window expires", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);

  try {
    for (let index = 0; index < 20; index += 1) {
      socketA.emit("search:cancel", {});
    }

    await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.message === "Za dużo żądań anulowania. Spróbuj ponownie za chwilę.",
      4_000,
    );

    await new Promise((resolve) => setTimeout(resolve, 1_800));

    const cancelledPayload = waitForEventFiltered(
      socketA,
      "game:cancelled",
      (payload) => payload.reason === "search_cancelled",
      4_000,
    );
    socketA.emit("search:cancel");
    const response = await cancelledPayload;
    assert.equal(response.reason, "search_cancelled");
    assert.equal(response.message.includes("Brak aktywnego"), true);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("search:join enforces rate limit under burst", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);

  try {
    const firstQueued = waitForEventFiltered(
      socketA,
      "queue:queued",
      () => true,
      2_000,
    );
    socketA.emit("search:join", { nickname: "BurstPlayer" });
    const firstQueuedPayload = await firstQueued;
    assert.equal(firstQueuedPayload.playerId, socketA.id);

    const rateLimited = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.message === "Za dużo żądań do kolejki. Spróbuj ponownie za chwilę.",
      2_000,
    );

    const burstCount = 20;
    for (let index = 0; index < burstCount; index += 1) {
      socketA.emit("search:join", { nickname: `BurstPlayer-${index}` });
    }

    await rateLimited;
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("search:join rate limit resets after window expires", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);

  try {
    const initialQueued = waitForEventFiltered(
      socketA,
      "queue:queued",
      (payload) => payload.playerId === socketA.id,
      2_000,
    );
    socketA.emit("search:join", { nickname: "BurstStarter" });
    const firstQueued = await initialQueued;
    assert.equal(firstQueued.playerId, socketA.id);

    for (let index = 0; index < 20; index += 1) {
      socketA.emit("search:join", { nickname: `Burst-${index}` });
    }

    const limitError = await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.message === "Za dużo żądań do kolejki. Spróbuj ponownie za chwilę.",
      4_000,
    );
    assert.equal(limitError.message, "Za dużo żądań do kolejki. Spróbuj ponownie za chwilę.");

    await new Promise((resolve) => setTimeout(resolve, 1800));

    const queuedAfterWindow = waitForEventFiltered(
      socketA,
      "queue:queued",
      (payload) => payload.playerId === socketA.id,
      4_000,
    );
    socketA.emit("search:join", { nickname: "AfterWindow" });
    const secondQueued = await queuedAfterWindow;

    assert.equal(secondQueued.playerId, socketA.id);
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("game:shot invalid payload type flood returns validation errors and then accepts valid shot", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    const boardCellsB = buildShipCells(boardB);

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const state = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const shooterSocket = state.turn === socketA.id ? socketA : socketB;
    const invalidPayloads = [null, "invalid-type", 123, true, []];

    for (const payload of invalidPayloads) {
      const errorPayload = waitForEventFiltered(
        shooterSocket,
        "game:error",
        (eventPayload) => eventPayload?.message === "Nieprawidłowe dane strzału.",
        2_000,
      );
      shooterSocket.emit("game:shot", payload);
      const response = await errorPayload;
      assert.equal(response.message, "Nieprawidłowe dane strzału.");
    }

    const empty = findEmptyCoord(boardCellsB, boardB.width, boardB.height);
    assert.ok(empty.row >= 0 && empty.col >= 0);
    const target = state.turn === socketA.id ? { row: empty.row, col: empty.col } : { row: 0, col: 0 };
    const shotPayload = waitForEventFiltered(
      shooterSocket,
      "game:shot_result",
      (eventPayload) =>
        eventPayload.shooter === shooterSocket.id &&
        eventPayload.roomId === roomId &&
        eventPayload.coord?.row === target.row &&
        eventPayload.coord?.col === target.col,
      4_000,
    );
    shooterSocket.emit("game:shot", { roomId, coord: target });
    const shotResult = await shotPayload;
    assert.ok(["miss", "hit", "sink"].includes(shotResult.outcome));
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:shot malformed payload flood does not block a valid shot before rate limit", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const state = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const shooterSocket = state.turn === socketA.id ? socketA : socketB;
    const invalidErrors = waitForEvents(
      shooterSocket,
      "game:error",
      (payload) => payload?.message === "Nieprawidłowe dane strzału.",
      20,
      5_000,
    );

    for (let i = 0; i < 20; i += 1) {
      shooterSocket.emit("game:shot", i % 2 === 0 ? i : { row: "x", col: "y" });
    }
    await invalidErrors;

    const target = { row: 0, col: 0 };
    const shotResult = waitForEventFiltered(
      shooterSocket,
      "game:shot_result",
      (payload) =>
        payload.shooter === shooterSocket.id &&
        payload.roomId === roomId &&
        payload.coord?.row === target.row &&
        payload.coord?.col === target.col,
      6_000,
    );
    shooterSocket.emit("game:shot", { roomId, coord: target });
    const resultPayload = await shotResult;
    assert.equal(resultPayload.shooter, shooterSocket.id);
    assert.ok(["miss", "hit", "sink"].includes(resultPayload.outcome));
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:shot with malformed coord payload types returns coordinate error and still accepts a valid shot", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    const boardCellsB = buildShipCells(boardB);
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const state = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const shooterSocket = state.turn === socketA.id ? socketA : socketB;
    const malformedPayloads = [
      { coord: { row: "0", col: 1 } },
      { coord: { row: 1.5, col: 2 } },
      { coord: { row: true, col: false } },
      { coord: { row: 0, col: null } },
      { coord: {} },
    ];

    for (const payload of malformedPayloads) {
      const errorPayload = waitForEventFiltered(
        shooterSocket,
        "game:error",
        (eventPayload) => eventPayload?.message === "Błędne współrzędne.",
        2_000,
      );
      shooterSocket.emit("game:shot", { roomId, ...payload });
      const response = await errorPayload;
      assert.equal(response.message, "Błędne współrzędne.");
    }

    const miss = findEmptyCoord(boardCellsB, boardB.width, boardB.height);
    assert.ok(miss.row >= 0 && miss.col >= 0);
    const shotPayload = waitForEventFiltered(
      shooterSocket,
      "game:shot_result",
      (eventPayload) =>
        eventPayload.shooter === shooterSocket.id &&
        eventPayload.roomId === roomId &&
        eventPayload.coord?.row === miss.row &&
        eventPayload.coord?.col === miss.col,
      4_000,
    );
    shooterSocket.emit("game:shot", { roomId, coord: miss });
    const shotResult = await shotPayload;
    assert.ok(["miss", "hit", "sink"].includes(shotResult.outcome));
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:shot enforces per-socket rate limit under burst", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    RATE_LIMIT_SHOT_PER_WINDOW: "20",
    RATE_LIMIT_SHOT_WINDOW_MS: "1_200",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    const state = await waitForEventFiltered(
      socketA,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );
    await waitForEventFiltered(
      socketB,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      8_000,
    );

    const notYourTurnSocket = state.turn === socketA.id ? socketB : socketA;
    const attempts = 200;
    const rateLimitError = waitForEventFiltered(
      notYourTurnSocket,
      "game:error",
      (payload) => payload?.message === "Zbyt wiele strzałów. Poczekaj chwilę.",
      8_000,
    );

    for (let i = 0; i < attempts; i += 1) {
      notYourTurnSocket.emit("game:shot", {
        roomId,
        coord: { row: 0, col: i % boardA.width },
      });
    }

    const payload = await rateLimitError;
    assert.equal(payload.message, "Zbyt wiele strzałów. Poczekaj chwilę.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("search:join with active foreign reconnect token is rejected with reconnect_token_expired", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const foreignToken = bMatch.reconnectToken;
    assert.equal(typeof foreignToken, "string");

    const reconnectError = waitForEventFiltered(
      socketSpy,
      "game:error",
      (payload) => payload.code === "reconnect_token_expired",
      4_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken: foreignToken });
    const errorPayload = await reconnectError;
    assert.equal(errorPayload.code, "reconnect_token_expired");
    assert.equal(hasNonEmptyMessage(errorPayload), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("search:join with active queue reconnect token is rejected while owner is online", async () => {
  const port = randomPort();
  const server = await startTestServer(port);

  const socketA = createClient(port);
  const socketSpy = createClient(port);

  try {
    const queuedA = waitForEventFiltered(
      socketA,
      "queue:queued",
      (payload) => typeof payload?.reconnectToken === "string",
      4_000,
    );
    const reconnectToken = "tok-active-queue-123456";
    socketA.emit("search:join", { nickname: "Owner", reconnectToken });
    const queuePayload = await queuedA;
    assert.equal(queuePayload.reconnectToken, reconnectToken);

    const reconnectError = waitForEventFiltered(
      socketSpy,
      "game:error",
      (payload) => payload.code === "reconnect_token_expired",
      4_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken });
    const errorPayload = await reconnectError;
    assert.equal(errorPayload.code, "reconnect_token_expired");
    assert.equal(hasNonEmptyMessage(errorPayload), true);
  } finally {
    socketA.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test(
  "active queue reconnect token can be recovered after server restart when previous owner is offline",
  { skip: !process.env.REDIS_URL },
  async () => {
    const port = randomPort();
    const redisUrl = process.env.REDIS_URL;
    const env = { REDIS_URL: redisUrl };

    const serverA = await startTestServer(port, env);
    const socketOwner = createClient(port, { reconnection: false });

    let reconnectToken = "";
    try {
      const queuedOwner = waitForEventFiltered(
        socketOwner,
        "queue:queued",
        (payload) => typeof payload?.reconnectToken === "string",
        4_000,
      );
      socketOwner.emit("search:join", { nickname: "Owner", reconnectToken: "tok-restart-recover-123" });
      const ownerQueuedPayload = await queuedOwner;
      reconnectToken = ownerQueuedPayload.reconnectToken;
      assert.equal(typeof reconnectToken, "string");
      assert.equal(reconnectToken.length > 0, true);
    } finally {
      socketOwner.disconnect();
      await serverA.close();
    }

    const serverB = await startTestServer(port, env);
    const socketRecovered = createClient(port, { reconnection: false });
    try {
      const queuedRecovered = waitForEventFiltered(
        socketRecovered,
        "queue:queued",
        (payload) => typeof payload?.reconnectToken === "string",
        4_000,
      );
      socketRecovered.emit("search:join", { nickname: "Recovered", reconnectToken });
      const recoveredPayload = await queuedRecovered;
      assert.equal(recoveredPayload.reconnectToken, reconnectToken);
      assert.equal(Boolean(recoveredPayload.recovered), true);
      assert.equal(hasNonEmptyMessage(recoveredPayload), true);
    } finally {
      socketRecovered.disconnect();
      await serverB.close();
    }
  },
);

test(
  "recovered queue entry can be cancelled after restart when queue state exists only in redis",
  { skip: !process.env.REDIS_URL },
  async () => {
    const port = randomPort();
    const redisUrl = process.env.REDIS_URL;
    const env = { REDIS_URL: redisUrl };

    const serverA = await startTestServer(port, env);
    const socketOwner = createClient(port, { reconnection: false });

    let reconnectToken = "";
    try {
      const queuedOwner = waitForEventFiltered(
        socketOwner,
        "queue:queued",
        (payload) => typeof payload?.reconnectToken === "string",
        4_000,
      );
      socketOwner.emit("search:join", { nickname: "Owner", reconnectToken: "tok-restart-cancel-123" });
      const ownerQueuedPayload = await queuedOwner;
      reconnectToken = ownerQueuedPayload.reconnectToken;
      assert.equal(typeof reconnectToken, "string");
      assert.equal(reconnectToken.length > 0, true);
    } finally {
      socketOwner.disconnect();
      await serverA.close();
    }

    const serverB = await startTestServer(port, env);
    const socketRecovered = createClient(port, { reconnection: false });
    try {
      const queuedRecovered = waitForEventFiltered(
        socketRecovered,
        "queue:queued",
        (payload) => payload?.reconnectToken === reconnectToken,
        4_000,
      );
      socketRecovered.emit("search:join", { nickname: "Recovered", reconnectToken });
      const recoveredPayload = await queuedRecovered;
      assert.equal(recoveredPayload.reconnectToken, reconnectToken);

      const cancelled = waitForEventFiltered(
        socketRecovered,
        "game:cancelled",
        (payload) => payload?.reason === "queue_cancelled",
        4_000,
      );
      socketRecovered.emit("search:cancel");
      const cancelledPayload = await cancelled;
      assert.equal(cancelledPayload.reason, "queue_cancelled");
      assert.equal(hasNonEmptyMessage(cancelledPayload), true);
    } finally {
      socketRecovered.disconnect();
      await serverB.close();
    }
  },
);

test("search:join with valid active reconnect token restores disconnected player", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { ROOM_RECONNECT_GRACE_MS: "3_000" });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;
    const reconnectToken = bMatch.reconnectToken;
    assert.equal(typeof reconnectToken, "string");

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    socketB.disconnect();

    await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      2_000,
    );

    const restoreSpy = waitForEventFiltered(
      socketSpy,
      "game:error",
      (payload) => payload.code === "reconnect_restored",
      4_000,
    );
    const restoredState = waitForEventFiltered(
      socketSpy,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      4_000,
    );

    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken });

    const restorePayload = await restoreSpy;
    const statePayload = await restoredState;
    assert.equal(restorePayload.code, "reconnect_restored");
    assert.equal(statePayload.roomId, roomId);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("reconnect restores sunkCells for disconnected player board state", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { ROOM_RECONNECT_GRACE_MS: "3_000" });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketRecovered = createClient(port);

  try {
    const { roomId, aMatch, bMatch, boardA, boardB, stateA } = await setupPlayingRoom(
      socketA,
      socketB,
      "Alpha",
      "Beta",
    );

    const shooter = stateA.yourTurn ? socketA : socketB;
    const defender = stateA.yourTurn ? socketB : socketA;
    const reconnectToken = stateA.yourTurn ? bMatch.reconnectToken : aMatch.reconnectToken;
    const defenderBoard = stateA.yourTurn ? boardB : boardA;
    assert.equal(typeof reconnectToken, "string");
    assert.equal(reconnectToken.length > 0, true);

    const singleMastShip = defenderBoard.ships.find((ship) => ship.type === 1);
    assert.ok(singleMastShip, "Expected at least one single-mast ship on defender board");
    const sunkCoord = singleMastShip.cells[0];

    const sunkResult = waitForEventFiltered(
      shooter,
      "game:shot_result",
      (payload) =>
        payload.roomId === roomId &&
        payload.shooter === shooter.id &&
        payload.outcome === "sink" &&
        payload.coord?.row === sunkCoord.row &&
        payload.coord?.col === sunkCoord.col,
      4_000,
    );
    shooter.emit("game:shot", { roomId, coord: { row: sunkCoord.row, col: sunkCoord.col } });
    await sunkResult;

    defender.disconnect();

    await waitForEventFiltered(
      shooter,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      3_000,
    );

    const restoredSignal = waitForEventFiltered(
      socketRecovered,
      "game:error",
      (payload) => payload.code === "reconnect_restored",
      4_000,
    );
    const restoredState = waitForEventFiltered(
      socketRecovered,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      4_000,
    );

    socketRecovered.emit("search:join", { nickname: "Recovered", reconnectToken });

    const signalPayload = await restoredSignal;
    const statePayload = await restoredState;
    assert.equal(signalPayload.code, "reconnect_restored");
    assert.equal(statePayload.roomId, roomId);
    assert.ok(Array.isArray(statePayload.yourBoard?.sunkCells));
    assert.equal(statePayload.yourBoard.sunkCells.includes(coordKey(sunkCoord)), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketRecovered.disconnect();
    await server.close();
  }
});

test("reconnect restores server-authoritative shot counters for disconnected player", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { ROOM_RECONNECT_GRACE_MS: "3_000" });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketRecovered = createClient(port);

  try {
    const { roomId, aMatch, bMatch, boardA, boardB, stateA } = await setupPlayingRoom(
      socketA,
      socketB,
      "Alpha",
      "Beta",
    );

    const shooter = stateA.yourTurn ? socketA : socketB;
    const defender = stateA.yourTurn ? socketB : socketA;
    const reconnectToken = stateA.yourTurn ? bMatch.reconnectToken : aMatch.reconnectToken;
    const defenderBoard = stateA.yourTurn ? boardB : boardA;
    assert.equal(typeof reconnectToken, "string");
    assert.equal(reconnectToken.length > 0, true);

    const defenderShipCells = buildShipCells(defenderBoard);
    const empty = findEmptyCoord(defenderShipCells, defenderBoard.width, defenderBoard.height);
    assert.ok(empty.row >= 0 && empty.col >= 0);

    const shotResult = waitForEventFiltered(
      shooter,
      "game:shot_result",
      (payload) =>
        payload.roomId === roomId &&
        payload.shooter === shooter.id &&
        payload.coord?.row === empty.row &&
        payload.coord?.col === empty.col,
      4_000,
    );
    const shooterStateAfterShot = waitForEventFiltered(
      shooter,
      "game:state",
      (payload) =>
        payload.roomId === roomId &&
        payload.phase === "playing" &&
        payload.yourShots === 1 &&
        payload.opponentShots === 0,
      4_000,
    );

    shooter.emit("game:shot", { roomId, coord: empty });
    await shotResult;
    await shooterStateAfterShot;

    defender.disconnect();

    await waitForEventFiltered(
      shooter,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      3_000,
    );

    const restoredSignal = waitForEventFiltered(
      socketRecovered,
      "game:error",
      (payload) => payload.code === "reconnect_restored",
      4_000,
    );
    const restoredState = waitForEventFiltered(
      socketRecovered,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      4_000,
    );

    socketRecovered.emit("search:join", { nickname: "Recovered", reconnectToken });

    const signalPayload = await restoredSignal;
    const statePayload = await restoredState;
    assert.equal(signalPayload.code, "reconnect_restored");
    assert.equal(statePayload.roomId, roomId);
    assert.equal(statePayload.yourShots, 0);
    assert.equal(statePayload.opponentShots, 1);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketRecovered.disconnect();
    await server.close();
  }
});

test("after reconnect next game:turn keeps counters consistent on both clients", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { ROOM_RECONNECT_GRACE_MS: "3_000" });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketRecovered = createClient(port);

  try {
    const { roomId, aMatch, bMatch, boardA, boardB } = await setupPlayingRoom(
      socketA,
      socketB,
      "Alpha",
      "Beta",
    );

    const reconnectToken = bMatch.reconnectToken;
    assert.equal(typeof reconnectToken, "string");
    assert.equal(reconnectToken.length > 0, true);

    socketB.disconnect();

    await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      3_000,
    );

    const restoredSignal = waitForEventFiltered(
      socketRecovered,
      "game:error",
      (payload) => payload.code === "reconnect_restored",
      4_000,
    );
    const restoredStatePromise = waitForEventFiltered(
      socketRecovered,
      "game:state",
      (payload) => payload.roomId === roomId && payload.phase === "playing",
      4_000,
    );

    socketRecovered.emit("search:join", { nickname: "Recovered", reconnectToken });

    const signalPayload = await restoredSignal;
    const restoredState = await restoredStatePromise;
    assert.equal(signalPayload.code, "reconnect_restored");
    assert.equal(restoredState.roomId, roomId);

    clearBufferedEvents(socketA, "game:turn");
    clearBufferedEvents(socketRecovered, "game:turn");

    const shooter = restoredState.turn === socketA.id ? socketA : socketRecovered;
    const targetBoard = shooter === socketA ? boardB : boardA;
    const targetShipCells = buildShipCells(targetBoard);
    const empty = findEmptyCoord(targetShipCells, targetBoard.width, targetBoard.height);
    assert.ok(empty.row >= 0 && empty.col >= 0);

    const shotResult = waitForEventFiltered(
      shooter,
      "game:shot_result",
      (payload) =>
        payload.roomId === roomId &&
        payload.shooter === shooter.id &&
        payload.coord?.row === empty.row &&
        payload.coord?.col === empty.col,
      4_000,
    );
    const turnA = waitForEventFiltered(
      socketA,
      "game:turn",
      (payload) =>
        payload.roomId === roomId &&
        payload.phase === "playing" &&
        (payload?.yourShots ?? 0) + (payload?.opponentShots ?? 0) === 1,
      4_000,
    );
    const turnRecovered = waitForEventFiltered(
      socketRecovered,
      "game:turn",
      (payload) =>
        payload.roomId === roomId &&
        payload.phase === "playing" &&
        (payload?.yourShots ?? 0) + (payload?.opponentShots ?? 0) === 1,
      4_000,
    );

    shooter.emit("game:shot", { roomId, coord: empty });
    await shotResult;
    const [turnPayloadA, turnPayloadRecovered] = await Promise.all([turnA, turnRecovered]);

    if (shooter === socketA) {
      assert.equal(turnPayloadA.yourShots, 1);
      assert.equal(turnPayloadA.opponentShots, 0);
      assert.equal(turnPayloadRecovered.yourShots, 0);
      assert.equal(turnPayloadRecovered.opponentShots, 1);
    } else {
      assert.equal(turnPayloadRecovered.yourShots, 1);
      assert.equal(turnPayloadRecovered.opponentShots, 0);
      assert.equal(turnPayloadA.yourShots, 0);
      assert.equal(turnPayloadA.opponentShots, 1);
    }
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketRecovered.disconnect();
    await server.close();
  }
});

test(
  "active game reconnect token restores room state after server restart (redis)",
  { skip: !process.env.REDIS_URL },
  async () => {
    const port = randomPort();
    const redisUrl = process.env.REDIS_URL;
    const env = {
      REDIS_URL: redisUrl,
      ROOM_RECONNECT_GRACE_MS: "10_000",
      ROOM_INACTIVITY_TIMEOUT_MS: "60_000",
    };

    const serverA = await startTestServer(port, env);
    const socketA = createClient(port, { reconnection: false });
    const socketB = createClient(port, { reconnection: false });

    let reconnectToken = "";
    let roomId = "";

    try {
      const aMatched = waitForEventFiltered(
        socketA,
        "queue:matched",
        (payload) => payload.vsBot === false,
        4_000,
      );
      const bMatched = waitForEventFiltered(
        socketB,
        "queue:matched",
        (payload) => payload.vsBot === false,
        4_000,
      );

      socketA.emit("search:join", { nickname: "Alpha" });
      socketB.emit("search:join", { nickname: "Beta" });

      const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
      roomId = aMatch.roomId;
      reconnectToken = bMatch.reconnectToken;
      assert.equal(aMatch.roomId, bMatch.roomId);
      assert.equal(typeof reconnectToken, "string");
      assert.equal(reconnectToken.length > 0, true);

      const boardA = placeFleetRandomly(createEmptyBoard());
      const boardB = placeFleetRandomly(createEmptyBoard());
      socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
      socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

      await Promise.all([
        waitForEventFiltered(
          socketA,
          "game:state",
          (payload) => payload.roomId === roomId && payload.phase === "playing",
          8_000,
        ),
        waitForEventFiltered(
          socketB,
          "game:state",
          (payload) => payload.roomId === roomId && payload.phase === "playing",
          8_000,
        ),
      ]);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
      await serverA.close();
    }

    const serverB = await startTestServer(port, env);
    const socketRecovered = createClient(port, { reconnection: false });
    try {
      const restoredSignal = waitForEventFiltered(
        socketRecovered,
        "game:error",
        (payload) => payload?.code === "reconnect_restored",
        6_000,
      );
      const restoredState = waitForEventFiltered(
        socketRecovered,
        "game:state",
        (payload) => payload?.roomId === roomId && payload?.phase === "playing",
        6_000,
      );

      socketRecovered.emit("search:join", { nickname: "Recovered", reconnectToken });

      const signalPayload = await restoredSignal;
      const statePayload = await restoredState;
      assert.equal(signalPayload.code, "reconnect_restored");
      assert.equal(statePayload.roomId, roomId);
      assert.equal(statePayload.phase, "playing");
      assert.equal(statePayload.gameOver, false);
      assert.equal(hasNonEmptyMessage(signalPayload), true);
    } finally {
      socketRecovered.disconnect();
      await serverB.close();
    }
  },
);

test("reconnect with stale reconnect token falls back to queue:queued", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    ROOM_RECONNECT_GRACE_MS: "200",
    MATCH_TIMEOUT_MS: "10_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "30_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;
    const staleToken = bMatch.reconnectToken;
    assert.equal(typeof staleToken, "string");

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    socketB.disconnect();

    await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      2_000,
    );
    await waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId && payload.reason === "disconnect",
      4_000,
    );

    const queued = waitForEventFiltered(
      socketSpy,
      "queue:queued",
      () => true,
      4_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken: staleToken });
    const queuePayload = await queued;
    assert.equal(queuePayload.playerId, socketSpy.id);
    assert.equal(queuePayload.reconnectToken, staleToken);
    assert.equal(queuePayload.roomId, undefined);
    assert.equal(hasNonEmptyMessage(queuePayload), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("reconnect token is rejected as stale when room ends due inactivity during disconnect grace", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    MATCH_TIMEOUT_MS: "10_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "1_200",
    ROOM_RECONNECT_GRACE_MS: "3_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;
    const reconnectToken = bMatch.reconnectToken;
    assert.equal(typeof reconnectToken, "string");

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    const overPayloadA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) =>
        payload.roomId === roomId &&
        (payload.reason === "inactivity_timeout" || payload.reason === "disconnect"),
      4_000,
    );

    const gracePayload = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      2_000,
    );

    socketB.disconnect();

    const [grace, overA] = await Promise.all([gracePayload, overPayloadA]);
    assert.equal(grace.roomId, roomId);
    assert.equal(overA.roomId, roomId);

    const queued = waitForEventFiltered(
      socketSpy,
      "queue:queued",
      () => true,
      4_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken });
    const queuePayload = await queued;
    assert.equal(queuePayload.playerId, socketSpy.id);
    assert.equal(queuePayload.reconnectToken, reconnectToken);
    assert.equal(queuePayload.roomId, undefined);
    assert.equal(hasNonEmptyMessage(queuePayload), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

  test("stale reconnect token after inactivity timeout falls back to queue:queued", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    MATCH_TIMEOUT_MS: "10_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "300",
    ROOM_RECONNECT_GRACE_MS: "500",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;
    const staleToken = aMatch.reconnectToken;
    assert.equal(typeof staleToken, "string");

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    const overA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId && payload.reason === "inactivity_timeout",
      8_000,
    );
    const overB = waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload.roomId === roomId && payload.reason === "inactivity_timeout",
      8_000,
    );
    const [overPayloadA, overPayloadB] = await Promise.all([overA, overB]);
    assert.equal(overPayloadA.roomId, roomId);
    assert.equal(overPayloadB.roomId, roomId);
    assert.equal(overPayloadA.reason, "inactivity_timeout");
    assert.equal(overPayloadB.reason, "inactivity_timeout");

    const queued = waitForEventFiltered(
      socketSpy,
      "queue:queued",
      () => true,
      4_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken: staleToken });
    const queuePayload = await queued;
    assert.equal(queuePayload.playerId, socketSpy.id);
    assert.equal(queuePayload.reconnectToken, staleToken);
    assert.equal(queuePayload.roomId, undefined);
    assert.equal(hasNonEmptyMessage(queuePayload), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("stale reconnect token after inactivity + large reconnect grace falls back to queue:queued", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    ROOM_RECONNECT_GRACE_MS: "10_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "900",
    MATCH_TIMEOUT_MS: "10_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const { roomId, bMatch } = await setupPlayingRoom(socketA, socketB);
    const staleToken = bMatch.reconnectToken;
    assert.equal(typeof staleToken, "string");

    socketB.disconnect();

    await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      2_000,
    );

    await sleep(1_400);

    const queuePayloadPromise = waitForEventFiltered(
      socketSpy,
      "queue:queued",
      () => true,
      6_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken: staleToken });
    const queuedPayload = await queuePayloadPromise;

    assert.equal(queuedPayload.playerId, socketSpy.id);
    assert.equal(queuedPayload.reconnectToken, staleToken);
    assert.equal(queuedPayload.roomId, undefined);
    assert.equal(hasNonEmptyMessage(queuedPayload), true);
    assert.equal(typeof queuedPayload.message, "string");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("reconnect token from ended room falls back to queue:queued", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    ROOM_INACTIVITY_TIMEOUT_MS: "300",
    MATCH_TIMEOUT_MS: "10_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const { roomId, bMatch } = await setupPlayingRoom(socketA, socketB);
    const finishedToken = bMatch.reconnectToken;
    assert.equal(typeof finishedToken, "string");

    const overA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId && payload.reason === "inactivity_timeout",
      8_000,
    );
    const overB = waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload.roomId === roomId && payload.reason === "inactivity_timeout",
      8_000,
    );
    const [overPayloadA, overPayloadB] = await Promise.all([overA, overB]);
    assert.equal(overPayloadA.reason, "inactivity_timeout");
    assert.equal(overPayloadB.reason, "inactivity_timeout");
    assert.equal(overPayloadA.roomId, roomId);
    assert.equal(overPayloadB.roomId, roomId);

    const queued = waitForEventFiltered(
      socketSpy,
      "queue:queued",
      () => true,
      4_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken: finishedToken });
    const queuePayload = await queued;
    assert.equal(queuePayload.playerId, socketSpy.id);
    assert.equal(queuePayload.reconnectToken, finishedToken);
    assert.equal(queuePayload.roomId, undefined);
    assert.equal(hasNonEmptyMessage(queuePayload), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("stale reconnect token after disconnect grace still resolves to queue:queued", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    ROOM_RECONNECT_GRACE_MS: "180",
    ROOM_INACTIVITY_TIMEOUT_MS: "1_000",
    MATCH_TIMEOUT_MS: "10_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;
    const staleToken = bMatch.reconnectToken;
    assert.equal(typeof staleToken, "string");

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());
    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    socketB.disconnect();

    await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      2_000,
    );
    await waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId && payload.reason === "disconnect",
      5_000,
    );

    const queued = waitForEventFiltered(
      socketSpy,
      "queue:queued",
      () => true,
      4_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken: staleToken });
    const queuePayload = await queued;

    assert.equal(queuePayload.playerId, socketSpy.id);
    assert.equal(queuePayload.reconnectToken, staleToken);
    assert.equal(queuePayload.roomId, undefined);
    assert.equal(hasNonEmptyMessage(queuePayload), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("stale reconnect token after grace window emits queue:queued with non-empty fallback message", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    ROOM_RECONNECT_GRACE_MS: "300",
    MATCH_TIMEOUT_MS: "10_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const { roomId, bMatch } = await setupPlayingRoom(socketA, socketB);
    const staleToken = bMatch.reconnectToken;
    assert.equal(typeof staleToken, "string");

    socketB.disconnect();

    await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      4_000,
    );

    await sleep(500);

    const queuePayloadPromise = waitForEventFiltered(
      socketSpy,
      "queue:queued",
      () => true,
      6_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken: staleToken });
    const queuePayload = await queuePayloadPromise;

    assert.equal(queuePayload.playerId, socketSpy.id);
    assert.equal(queuePayload.reconnectToken, staleToken);
    assert.equal(queuePayload.roomId, undefined);
    assert.equal(hasNonEmptyMessage(queuePayload), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("stale reconnect token after disconnect grace + inactivity timeout emits queue:queued", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    ROOM_RECONNECT_GRACE_MS: "250",
    ROOM_INACTIVITY_TIMEOUT_MS: "300",
    MATCH_TIMEOUT_MS: "10_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const aMatched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );
    const bMatched = waitForEventFiltered(
      socketB,
      "queue:matched",
      (payload) => payload.vsBot === false,
      4_000,
    );

    socketA.emit("search:join", { nickname: "Alpha" });
    socketB.emit("search:join", { nickname: "Beta" });

    const [aMatch, bMatch] = await Promise.all([aMatched, bMatched]);
    assert.equal(aMatch.roomId, bMatch.roomId);
    const roomId = aMatch.roomId;
    const staleToken = aMatch.reconnectToken;
    assert.equal(typeof staleToken, "string");

    const boardA = placeFleetRandomly(createEmptyBoard());
    const boardB = placeFleetRandomly(createEmptyBoard());

    socketA.emit("game:place_ships", { roomId, board: asServerBoard(boardA) });
    socketB.emit("game:place_ships", { roomId, board: asServerBoard(boardB) });

    await Promise.all([
      waitForEventFiltered(
        socketA,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
      waitForEventFiltered(
        socketB,
        "game:state",
        (payload) => payload.roomId === roomId && payload.phase === "playing",
        8_000,
      ),
    ]);

    socketA.disconnect();

    await waitForEventFiltered(
      socketB,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      2_000,
    );
    const overPayload = await waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload.roomId === roomId && (payload.reason === "inactivity_timeout" || payload.reason === "disconnect"),
      6_000,
    );
    assert.equal(overPayload.roomId, roomId);

    await sleep(350);

    const queuePayloadPromise = waitForEventFiltered(
      socketSpy,
      "queue:queued",
      () => true,
      6_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken: staleToken });
    const queuedPayload = await queuePayloadPromise;

    assert.equal(queuedPayload.playerId, socketSpy.id);
    assert.equal(queuedPayload.reconnectToken, staleToken);
    assert.equal(queuedPayload.roomId, undefined);
    assert.equal(hasNonEmptyMessage(queuedPayload), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("stale reconnect token after inactivity while reconnect window remains open emits queue:queued", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    ROOM_RECONNECT_GRACE_MS: "3_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "600",
    MATCH_TIMEOUT_MS: "10_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const { roomId, bMatch } = await setupPlayingRoom(socketA, socketB);
    const staleToken = bMatch.reconnectToken;
    assert.equal(typeof staleToken, "string");

    socketB.disconnect();

    await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      2_000,
    );

    await waitForEventFiltered(
      socketA,
      "game:over",
      (payload) =>
        payload.roomId === roomId &&
        (payload.reason === "inactivity_timeout" || payload.reason === "disconnect"),
      5_000,
    );

    const queuePayloadPromise = waitForEventFiltered(
      socketSpy,
      "queue:queued",
      () => true,
      6_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken: staleToken });
    const queuePayload = await queuePayloadPromise;

    assert.equal(queuePayload.playerId, socketSpy.id);
    assert.equal(queuePayload.reconnectToken, staleToken);
    assert.equal(queuePayload.roomId, undefined);
    assert.equal(hasNonEmptyMessage(queuePayload), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("search:join rejects malformed payload type", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socket = createClient(port);

  try {
    const errorPayload = waitForEventFiltered(
      socket,
      "game:error",
      (payload) => payload?.message === "Nieprawidłowe dane dołączenia.",
      2_000,
    );
    socket.emit("search:join", 123);
    const payload = await errorPayload;
    assert.equal(payload.message, "Nieprawidłowe dane dołączenia.");
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("search:join is rate limited during burst", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socket = createClient(port);

  try {
    const rateLimitError = waitForEventFiltered(
      socket,
      "game:error",
      (payload) => payload?.message === "Za dużo żądań do kolejki. Spróbuj ponownie za chwilę.",
      3_000,
    );

    for (let i = 0; i < 12; i += 1) {
      socket.emit("search:join", { nickname: `User${i}` });
    }

    const payload = await rateLimitError;
    assert.equal(payload.message, "Za dużo żądań do kolejki. Spróbuj ponownie za chwilę.");
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("game:shot rejects malformed payload types and invalid coordinate payloads", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const { roomId, stateA } = await setupPlayingRoom(socketA, socketB);

    const shooter = stateA.yourTurn ? socketA : socketB;

    const invalidTypePayload = waitForEventFiltered(
      shooter,
      "game:error",
      (payload) => payload?.message === "Nieprawidłowe dane strzału.",
      2_000,
    );
    shooter.emit("game:shot", 123);
    const invalidTypeResult = await invalidTypePayload;
    assert.equal(invalidTypeResult.message, "Nieprawidłowe dane strzału.");

    const invalidCoordPayload = waitForEventFiltered(
      shooter,
      "game:error",
      (payload) => payload?.message === "Błędne współrzędne.",
      2_000,
    );
    shooter.emit("game:shot", {
      roomId,
      coord: {
        row: "x",
        col: "y",
      },
    });
    const invalidCoordResult = await invalidCoordPayload;
    assert.equal(invalidCoordResult.message, "Błędne współrzędne.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:shot is rate limited during burst", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const { roomId, stateA } = await setupPlayingRoom(socketA, socketB);

    const shooter = stateA.yourTurn ? socketA : socketB;

    const rateLimitError = waitForEventFiltered(
      shooter,
      "game:error",
      (payload) => payload?.message === "Zbyt wiele strzałów. Poczekaj chwilę.",
      5_000,
    );

    for (let i = 0; i < 120; i += 1) {
      shooter.emit("game:shot", {
        roomId,
        coord: {
          row: i % 10,
          col: Math.floor(i / 10) % 10,
        },
      });
    }

    const payload = await rateLimitError;
    assert.equal(payload.message, "Zbyt wiele strzałów. Poczekaj chwilę.");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:shot rate limit resets after window expires", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const { roomId, boardA, boardB, stateA } = await setupPlayingRoom(socketA, socketB);
    const boardCellsA = buildShipCells(boardA);
    const boardCellsB = buildShipCells(boardB);

    const shooter = stateA.yourTurn ? socketA : socketB;
    const targetBoardCells = shooter === socketA ? boardCellsB : boardCellsA;
    const emptyCoord = findEmptyCoord(targetBoardCells, boardA.width, boardA.height);
    assert.ok(emptyCoord.row >= 0 && emptyCoord.col >= 0);

    const rateLimitError = waitForEventFiltered(
      shooter,
      "game:error",
      (payload) => payload?.message === "Zbyt wiele strzałów. Poczekaj chwilę.",
      5_000,
    );

    for (let index = 0; index < 110; index += 1) {
      shooter.emit("game:shot", {
        roomId,
        coord: { row: `bad-${index}`, col: index },
      });
    }

    await rateLimitError;

    await new Promise((resolve) => setTimeout(resolve, 1_800));

    const shotResult = waitForEventFiltered(
      shooter,
      "game:shot_result",
      (payload) =>
        payload.roomId === roomId &&
        payload.shooter === shooter.id &&
        payload.coord?.row === emptyCoord.row &&
        payload.coord?.col === emptyCoord.col,
      4_000,
    );
    shooter.emit("game:shot", {
      roomId,
      coord: { row: emptyCoord.row, col: emptyCoord.col },
    });
    await shotResult;
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("stale reconnect token with reconnect_grace and inactivity overlap still returns queue:queued", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    ROOM_RECONNECT_GRACE_MS: "1_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "500",
    MATCH_TIMEOUT_MS: "10_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const { roomId, aMatch } = await setupPlayingRoom(socketA, socketB);
    const staleToken = aMatch.reconnectToken;
    assert.equal(typeof staleToken, "string");

    socketB.disconnect();

    await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      2_000,
    );

    const overPayload = await waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId && (payload.reason === "inactivity_timeout" || payload.reason === "disconnect"),
      6_000,
    );
    assert.equal(overPayload.roomId, roomId);

    const queuePayloadPromise = waitForEventFiltered(
      socketSpy,
      "queue:queued",
      (payload) => payload.playerId === socketSpy.id,
      6_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken: staleToken });
    const queuePayload = await queuePayloadPromise;

    assert.equal(queuePayload.playerId, socketSpy.id);
    assert.equal(queuePayload.reconnectToken, staleToken);
    assert.equal(queuePayload.roomId, undefined);
    assert.equal(hasNonEmptyMessage(queuePayload), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("search:join malformed payload flood returns validation errors and then accepts valid join", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socket = createClient(port);

  try {
    const malformedPayloads = [
      null,
      "invalid",
      123,
      [],
      true,
      { nickname: 123 },
    ];

    for (const payload of malformedPayloads) {
      const errorPayload = waitForEventFiltered(
        socket,
        "game:error",
        (eventPayload) => eventPayload?.message === "Nieprawidłowe dane dołączenia.",
        2_000,
      );
      socket.emit("search:join", payload);
      const response = await errorPayload;
      assert.equal(response.message, "Nieprawidłowe dane dołączenia.");
    }

    const queued = waitForEventFiltered(socket, "queue:queued", () => true, 4_000);
    socket.emit("search:join", { nickname: "Recovered" });
    const queuedPayload = await queued;
    assert.equal(queuedPayload.playerId, socket.id);
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test("game:shot malformed payload flood accepts valid shot after flood", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const { roomId, boardB, stateA } = await setupPlayingRoom(socketA, socketB);
    const boardCellsB = buildShipCells(boardB);

    const shooterSocket = stateA.yourTurn ? socketA : socketB;

    const malformedShots = [
      "bad",
      123,
      true,
      { coord: { row: "x", col: "y" } },
      {},
      { roomId: "bad-room", coord: { row: 0, col: 0 } },
    ];

    for (const payload of malformedShots) {
      const errorPayload = waitForEventFiltered(
        shooterSocket,
        "game:error",
        (eventPayload) =>
          eventPayload?.message === "Nieprawidłowe dane strzału." ||
          eventPayload?.message === "Błędne współrzędne.",
        2_000,
      );
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        shooterSocket.emit("game:shot", { roomId, ...payload });
      } else {
        shooterSocket.emit("game:shot", payload);
      }
      const response = await errorPayload;
      assert.ok(
        response.message === "Nieprawidłowe dane strzału." || response.message === "Błędne współrzędne.",
      );
    }

    const empty = findEmptyCoord(boardCellsB, boardB.width, boardB.height);
    assert.ok(empty.row >= 0 && empty.col >= 0);
    const shotResult = waitForEventFiltered(
      shooterSocket,
      "game:shot_result",
      (eventPayload) =>
        eventPayload?.roomId === roomId &&
        eventPayload?.shooter === shooterSocket.id &&
        eventPayload?.coord?.row === empty.row &&
        eventPayload?.coord?.col === empty.col,
      4_000,
    );
    shooterSocket.emit("game:shot", { roomId, coord: empty });
    const resultPayload = await shotResult;
    assert.ok(["miss", "hit", "sink"].includes(resultPayload.outcome));
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("game:shot rate limit is enforced under burst", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const { roomId, stateA } = await setupPlayingRoom(socketA, socketB);

    const shooterSocket = stateA.yourTurn ? socketA : socketB;
    const rateLimitError = waitForEventFiltered(
      shooterSocket,
      "game:error",
      (payload) => payload?.message === "Zbyt wiele strzałów. Poczekaj chwilę.",
      8_000,
    );

    for (let attempt = 0; attempt < 130; attempt += 1) {
      shooterSocket.emit("game:shot", {
        roomId,
        coord: { row: attempt % 10, col: Math.floor(attempt / 10) % 10 },
      });
    }

    await rateLimitError;
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("stale reconnect token after reconnect_grace + inactivity_timeout queues player with non-empty fallback message", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    ROOM_RECONNECT_GRACE_MS: "900",
    ROOM_INACTIVITY_TIMEOUT_MS: "450",
    MATCH_TIMEOUT_MS: "10_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);
  const socketSpy = createClient(port);

  try {
    const { roomId, bMatch } = await setupPlayingRoom(socketA, socketB);
    const staleToken = bMatch.reconnectToken;
    assert.equal(typeof staleToken, "string");

    socketB.disconnect();

    await waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload.code === "reconnect_grace",
      3_000,
    );
    await waitForEventFiltered(
      socketA,
      "game:over",
      (payload) =>
        payload.roomId === roomId &&
        (payload.reason === "inactivity_timeout" || payload.reason === "disconnect"),
      6_000,
    );

    const queuePayloadPromise = waitForEventFiltered(
      socketSpy,
      "queue:queued",
      (payload) => payload.playerId === socketSpy.id,
      6_000,
    );
    socketSpy.emit("search:join", { nickname: "Spy", reconnectToken: staleToken });
    const queuePayload = await queuePayloadPromise;

    assert.equal(queuePayload.playerId, socketSpy.id);
    assert.equal(queuePayload.reconnectToken, staleToken);
    assert.equal(queuePayload.roomId, undefined);
    assert.equal(hasNonEmptyMessage(queuePayload), true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    socketSpy.disconnect();
    await server.close();
  }
});

test("online game over then new online game starts with reset shot counters", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    MATCH_TIMEOUT_MS: "10_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const { roomId: roomId1, stateA: playingA1 } = await setupPlayingRoom(socketA, socketB);

    const shooter = playingA1.yourTurn ? socketA : socketB;
    const shotResult = waitForEventFiltered(
      shooter,
      "game:shot_result",
      (payload) => payload.roomId === roomId1 && payload.coord?.row === 0 && payload.coord?.col === 0,
      4_000,
    );
    shooter.emit("game:shot", { roomId: roomId1, coord: { row: 0, col: 0 } });
    await shotResult;

    const overA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId1 && payload.reason === "manual_cancel",
      4_000,
    );
    const overB = waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload.roomId === roomId1 && payload.reason === "manual_cancel",
      4_000,
    );
    socketA.emit("game:cancel", { roomId: roomId1 });
    await Promise.all([overA, overB]);

    const { stateA: playingA2, stateB: playingB2 } = await setupPlayingRoom(
      socketA,
      socketB,
      "Alpha-2",
      "Beta-2",
    );

    assert.equal(playingA2.yourShots, 0);
    assert.equal(playingA2.opponentShots, 0);
    assert.equal(playingB2.yourShots, 0);
    assert.equal(playingB2.opponentShots, 0);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("online game over then new online game starts with cleared sunkCells and counters", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    MATCH_TIMEOUT_MS: "10_000",
  });

  const socketA = createClient(port);
  const socketB = createClient(port);

  try {
    const { roomId: roomId1, boardA, boardB, stateA: playingA1 } = await setupPlayingRoom(socketA, socketB);
    const shooter = playingA1.yourTurn ? socketA : socketB;
    const defenderBoard = playingA1.yourTurn ? boardB : boardA;

    assert.ok(defenderBoard, "Expected defender board to exist");
    const singleMastShip = defenderBoard.ships.find((ship) => ship.type === 1);
    assert.ok(singleMastShip, "Expected at least one single-mast ship");
    const sinkCoord = singleMastShip.cells[0];

    const sinkResult = waitForEventFiltered(
      shooter,
      "game:shot_result",
      (payload) =>
        payload.roomId === roomId1 &&
        payload.shooter === shooter.id &&
        payload.outcome === "sink" &&
        payload.coord?.row === sinkCoord.row &&
        payload.coord?.col === sinkCoord.col,
      4_000,
    );
    shooter.emit("game:shot", { roomId: roomId1, coord: sinkCoord });
    await sinkResult;

    const overA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload.roomId === roomId1 && payload.reason === "manual_cancel",
      4_000,
    );
    const overB = waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload.roomId === roomId1 && payload.reason === "manual_cancel",
      4_000,
    );
    socketA.emit("game:cancel", { roomId: roomId1 });
    await Promise.all([overA, overB]);

    const { stateA: playingA2, stateB: playingB2 } = await setupPlayingRoom(
      socketA,
      socketB,
      "Alpha-reset",
      "Beta-reset",
    );

    assert.equal(playingA2.yourShots, 0);
    assert.equal(playingA2.opponentShots, 0);
    assert.equal(playingB2.yourShots, 0);
    assert.equal(playingB2.opponentShots, 0);
    assert.ok(Array.isArray(playingA2.yourBoard?.sunkCells));
    assert.ok(Array.isArray(playingA2.opponentBoard?.sunkCells));
    assert.ok(Array.isArray(playingB2.yourBoard?.sunkCells));
    assert.ok(Array.isArray(playingB2.opponentBoard?.sunkCells));
    assert.equal(playingA2.yourBoard.sunkCells.length, 0);
    assert.equal(playingA2.opponentBoard.sunkCells.length, 0);
    assert.equal(playingB2.yourBoard.sunkCells.length, 0);
    assert.equal(playingB2.opponentBoard.sunkCells.length, 0);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("queue reconnect token is blocked by stale redis presence and recovers after presence ttl", async (t) => {
  const redisUrl = (process.env.REDIS_URL ?? "").trim();
  if (!redisUrl) {
    t.skip("REDIS_URL not configured");
    return;
  }

  const port = randomPort();
  const sharedEnv = {
    REDIS_URL: redisUrl,
    MATCH_TIMEOUT_MS: "10_000",
    SOCKET_PRESENCE_TTL_MS: "2500",
    SOCKET_PRESENCE_REFRESH_MS: "400",
  };

  const serverA = await startTestServer(port, sharedEnv);
  const owner = createClient(port, { reconnection: false });

  let reconnectToken = "";
  try {
    const queued = waitForEventFiltered(owner, "queue:queued", () => true, 4_000);
    owner.emit("search:join", { nickname: "Owner" });
    const queuePayload = await queued;
    reconnectToken = queuePayload.reconnectToken;
    assert.equal(typeof reconnectToken, "string");
    assert.equal(reconnectToken.length > 0, true);
  } finally {
    await new Promise((resolve) => {
      serverA.proc.once("exit", () => resolve());
      serverA.proc.kill("SIGKILL");
    });
    owner.disconnect();
  }

  const serverB = await startTestServer(port, sharedEnv);
  const attacker = createClient(port, { reconnection: false });

  try {
    const conflict = waitForEventFiltered(
      attacker,
      "game:error",
      (payload) => payload?.code === "reconnect_token_expired",
      5_000,
    );
    attacker.emit("search:join", { nickname: "Attacker", reconnectToken });
    const conflictPayload = await conflict;
    assert.equal(conflictPayload.code, "reconnect_token_expired");

    await sleep(3_600);

    const recovered = waitForEventFiltered(
      attacker,
      "queue:queued",
      (payload) => payload?.playerId === attacker.id,
      6_000,
    );
    attacker.emit("search:join", { nickname: "Attacker", reconnectToken });
    const recoveredPayload = await recovered;
    assert.equal(recoveredPayload.playerId, attacker.id);
    assert.equal(recoveredPayload.reconnectToken, reconnectToken);
  } finally {
    attacker.disconnect();
    await serverB.close();
  }
});

test("active game reconnect token is blocked by stale redis presence and restores after ttl", async (t) => {
  const redisUrl = (process.env.REDIS_URL ?? "").trim();
  if (!redisUrl) {
    t.skip("REDIS_URL not configured");
    return;
  }

  const port = randomPort();
  const sharedEnv = {
    REDIS_URL: redisUrl,
    MATCH_TIMEOUT_MS: "10_000",
    ROOM_RECONNECT_GRACE_MS: "15_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "60_000",
    SOCKET_PRESENCE_TTL_MS: "2500",
    SOCKET_PRESENCE_REFRESH_MS: "400",
  };

  const serverA = await startTestServer(port, sharedEnv);
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  let reconnectToken = "";
  let roomId = "";
  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    reconnectToken = setup.bMatch.reconnectToken;
    roomId = setup.roomId;
    assert.equal(typeof reconnectToken, "string");
    assert.equal(reconnectToken.length > 0, true);
    assert.equal(typeof roomId, "string");
    assert.equal(roomId.length > 0, true);
  } finally {
    await new Promise((resolve) => {
      serverA.proc.once("exit", () => resolve());
      serverA.proc.kill("SIGKILL");
    });
    socketA.disconnect();
    socketB.disconnect();
  }

  const serverB = await startTestServer(port, sharedEnv);
  const attacker = createClient(port, { reconnection: false });

  try {
    const conflict = waitForEventFiltered(
      attacker,
      "game:error",
      (payload) => payload?.code === "reconnect_token_expired",
      5_000,
    );
    attacker.emit("search:join", { nickname: "Recovered", reconnectToken });
    const conflictPayload = await conflict;
    assert.equal(conflictPayload.code, "reconnect_token_expired");

    await sleep(3_600);

    const restoredSignal = waitForEventFiltered(
      attacker,
      "game:error",
      (payload) => payload?.code === "reconnect_restored",
      6_000,
    );
    const restoredState = waitForEventFiltered(
      attacker,
      "game:state",
      (payload) => payload?.roomId === roomId && payload?.phase === "playing",
      6_000,
    );

    attacker.emit("search:join", { nickname: "Recovered", reconnectToken });

    const signalPayload = await restoredSignal;
    const statePayload = await restoredState;
    assert.equal(signalPayload.code, "reconnect_restored");
    assert.equal(statePayload.roomId, roomId);
    assert.equal(statePayload.phase, "playing");
    assert.equal(statePayload.gameOver, false);
  } finally {
    attacker.disconnect();
    await serverB.close();
  }
});

test("active game reconnect token restores immediately after graceful restart", async (t) => {
  const redisUrl = (process.env.REDIS_URL ?? "").trim();
  if (!redisUrl) {
    t.skip("REDIS_URL not configured");
    return;
  }

  const port = randomPort();
  const sharedEnv = {
    REDIS_URL: redisUrl,
    MATCH_TIMEOUT_MS: "10_000",
    ROOM_RECONNECT_GRACE_MS: "15_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "60_000",
    SOCKET_PRESENCE_TTL_MS: "20000",
    SOCKET_PRESENCE_REFRESH_MS: "400",
  };

  const serverA = await startTestServer(port, sharedEnv);
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  let reconnectToken = "";
  let roomId = "";
  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    reconnectToken = setup.bMatch.reconnectToken;
    roomId = setup.roomId;
    assert.equal(typeof reconnectToken, "string");
    assert.equal(reconnectToken.length > 0, true);
    assert.equal(typeof roomId, "string");
    assert.equal(roomId.length > 0, true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await serverA.close();
  }

  const serverB = await startTestServer(port, sharedEnv);
  const recovered = createClient(port, { reconnection: false });

  try {
    const reconnectSignal = waitForEventFiltered(
      recovered,
      "game:error",
      (payload) =>
        payload?.code === "reconnect_restored" ||
        payload?.code === "reconnect_token_expired",
      5_000,
    );
    const restoredState = waitForEventFiltered(
      recovered,
      "game:state",
      (payload) => payload?.roomId === roomId && payload?.phase === "playing",
      6_000,
    );

    recovered.emit("search:join", { nickname: "Recovered", reconnectToken });

    const signalPayload = await reconnectSignal;
    const statePayload = await restoredState;
    assert.equal(signalPayload.code, "reconnect_restored");
    assert.equal(statePayload.roomId, roomId);
    assert.equal(statePayload.phase, "playing");
    assert.equal(statePayload.gameOver, false);
  } finally {
    recovered.disconnect();
    await serverB.close();
  }
});

test("after graceful restart and reconnect of both players first turn counters stay consistent", async (t) => {
  const redisUrl = (process.env.REDIS_URL ?? "").trim();
  if (!redisUrl) {
    t.skip("REDIS_URL not configured");
    return;
  }

  const port = randomPort();
  const sharedEnv = {
    REDIS_URL: redisUrl,
    MATCH_TIMEOUT_MS: "10_000",
    ROOM_RECONNECT_GRACE_MS: "15_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "60_000",
    SOCKET_PRESENCE_TTL_MS: "20_000",
    SOCKET_PRESENCE_REFRESH_MS: "400",
  };

  const serverA = await startTestServer(port, sharedEnv);
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  let tokenA = "";
  let tokenB = "";
  let roomId = "";
  let boardA;
  let boardB;
  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    tokenA = setup.aMatch.reconnectToken;
    tokenB = setup.bMatch.reconnectToken;
    roomId = setup.roomId;
    boardA = setup.boardA;
    boardB = setup.boardB;
    assert.equal(typeof tokenA, "string");
    assert.equal(tokenA.length > 0, true);
    assert.equal(typeof tokenB, "string");
    assert.equal(tokenB.length > 0, true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await serverA.close();
  }

  const serverB = await startTestServer(port, sharedEnv);
  const recoveredA = createClient(port, { reconnection: false });
  const recoveredB = createClient(port, { reconnection: false });

  try {
    const restoredSignalA = waitForEventFiltered(
      recoveredA,
      "game:error",
      (payload) =>
        payload?.code === "reconnect_restored" || payload?.code === "reconnect_token_expired",
      6_000,
    );
    const restoredSignalB = waitForEventFiltered(
      recoveredB,
      "game:error",
      (payload) =>
        payload?.code === "reconnect_restored" || payload?.code === "reconnect_token_expired",
      6_000,
    );
    const restoredStateA = waitForEventFiltered(
      recoveredA,
      "game:state",
      (payload) => payload?.roomId === roomId && payload?.phase === "playing",
      6_000,
    );
    const restoredStateB = waitForEventFiltered(
      recoveredB,
      "game:state",
      (payload) => payload?.roomId === roomId && payload?.phase === "playing",
      6_000,
    );

    recoveredA.emit("search:join", { nickname: "Alpha-R", reconnectToken: tokenA });
    recoveredB.emit("search:join", { nickname: "Beta-R", reconnectToken: tokenB });

    const signalA = await restoredSignalA;
    const signalB = await restoredSignalB;
    const stateA = await restoredStateA;
    const stateB = await restoredStateB;
    assert.equal(signalA.code, "reconnect_restored");
    assert.equal(signalB.code, "reconnect_restored");
    assert.equal(stateA.roomId, roomId);
    assert.equal(stateB.roomId, roomId);

    clearBufferedEvents(recoveredA, "game:turn");
    clearBufferedEvents(recoveredB, "game:turn");

    const resolveShooterFromTurn = () => {
      const candidateTurns = [stateA.turn, stateB.turn].filter(
        (turnId) => turnId === recoveredA.id || turnId === recoveredB.id,
      );
      if (candidateTurns.length > 0) {
        const winnerTurn = candidateTurns[candidateTurns.length - 1];
        return winnerTurn === recoveredA.id ? recoveredA : recoveredB;
      }
      return stateA.yourTurn ? recoveredA : recoveredB;
    };
    const shooter = resolveShooterFromTurn();
    const targetBoard = shooter === recoveredA ? boardB : boardA;
    const targetShipCells = buildShipCells(targetBoard);
    const empty = findEmptyCoord(targetShipCells, targetBoard.width, targetBoard.height);
    assert.ok(empty.row >= 0 && empty.col >= 0);

    const shotResult = waitForEventFiltered(
      shooter,
      "game:shot_result",
      (payload) =>
        payload?.roomId === roomId &&
        payload?.shooter === shooter.id &&
        payload?.coord?.row === empty.row &&
        payload?.coord?.col === empty.col,
      4_000,
    );
    const turnA = waitForEventFiltered(
      recoveredA,
      "game:turn",
      (payload) =>
        payload?.roomId === roomId &&
        payload?.phase === "playing" &&
        (payload?.yourShots ?? 0) + (payload?.opponentShots ?? 0) === 1,
      4_000,
    );
    const turnB = waitForEventFiltered(
      recoveredB,
      "game:turn",
      (payload) =>
        payload?.roomId === roomId &&
        payload?.phase === "playing" &&
        (payload?.yourShots ?? 0) + (payload?.opponentShots ?? 0) === 1,
      4_000,
    );

    shooter.emit("game:shot", { roomId, coord: empty });
    await shotResult;
    const [turnPayloadA, turnPayloadB] = await Promise.all([turnA, turnB]);

    if (shooter === recoveredA) {
      assert.equal(turnPayloadA.yourShots, 1);
      assert.equal(turnPayloadA.opponentShots, 0);
      assert.equal(turnPayloadB.yourShots, 0);
      assert.equal(turnPayloadB.opponentShots, 1);
    } else {
      assert.equal(turnPayloadB.yourShots, 1);
      assert.equal(turnPayloadB.opponentShots, 0);
      assert.equal(turnPayloadA.yourShots, 0);
      assert.equal(turnPayloadA.opponentShots, 1);
    }
  } finally {
    recoveredA.disconnect();
    recoveredB.disconnect();
    await serverB.close();
  }
});

test("queue reconnect token restores immediately after graceful restart", async (t) => {
  const redisUrl = (process.env.REDIS_URL ?? "").trim();
  if (!redisUrl) {
    t.skip("REDIS_URL not configured");
    return;
  }

  const port = randomPort();
  const sharedEnv = {
    REDIS_URL: redisUrl,
    MATCH_TIMEOUT_MS: "10_000",
    SOCKET_PRESENCE_TTL_MS: "20_000",
    SOCKET_PRESENCE_REFRESH_MS: "400",
  };

  const serverA = await startTestServer(port, sharedEnv);
  const owner = createClient(port, { reconnection: false });
  let reconnectToken = "";

  try {
    const queued = waitForEventFiltered(owner, "queue:queued", () => true, 4_000);
    owner.emit("search:join", { nickname: "Owner" });
    const queuePayload = await queued;
    reconnectToken = queuePayload.reconnectToken;
    assert.equal(typeof reconnectToken, "string");
    assert.equal(reconnectToken.length > 0, true);
  } finally {
    await serverA.close();
    owner.disconnect();
  }

  const serverB = await startTestServer(port, sharedEnv);
  const recovered = createClient(port, { reconnection: false });

  try {
    clearBufferedEvents(recovered, "game:error");
    const queued = waitForEventFiltered(
      recovered,
      "queue:queued",
      (payload) => payload?.playerId === recovered.id,
      6_000,
    );
    recovered.emit("search:join", { nickname: "Recovered", reconnectToken });
    const payload = await queued;

    assert.equal(payload.playerId, recovered.id);
    assert.equal(payload.reconnectToken, reconnectToken);
    assert.equal(Boolean(payload.recovered), true);

    const conflict = takeBufferedEvent(
      recovered,
      "game:error",
      (eventPayload) => eventPayload?.code === "reconnect_token_expired",
    );
    assert.equal(conflict.found, false);
  } finally {
    recovered.disconnect();
    await serverB.close();
  }
});

test("sunkCells survive graceful restart and reconnect for both perspectives", async (t) => {
  const redisUrl = (process.env.REDIS_URL ?? "").trim();
  if (!redisUrl) {
    t.skip("REDIS_URL not configured");
    return;
  }

  const port = randomPort();
  const sharedEnv = {
    REDIS_URL: redisUrl,
    MATCH_TIMEOUT_MS: "10_000",
    ROOM_RECONNECT_GRACE_MS: "15_000",
    ROOM_INACTIVITY_TIMEOUT_MS: "60_000",
    SOCKET_PRESENCE_TTL_MS: "20_000",
    SOCKET_PRESENCE_REFRESH_MS: "400",
  };

  const serverA = await startTestServer(port, sharedEnv);
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  let tokenA = "";
  let tokenB = "";
  let roomId = "";
  let defenderWasA = false;
  let sunkCoord = { row: -1, col: -1 };

  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    tokenA = setup.aMatch.reconnectToken;
    tokenB = setup.bMatch.reconnectToken;
    roomId = setup.roomId;

    const shooter = setup.stateA.yourTurn ? socketA : socketB;
    const defender = shooter === socketA ? socketB : socketA;
    defenderWasA = defender === socketA;
    const defenderBoard = defenderWasA ? setup.boardA : setup.boardB;

    const singleMast = defenderBoard.ships.find((ship) => ship.type === 1);
    assert.ok(singleMast, "Expected at least one single-mast ship on defender board");
    sunkCoord = { row: singleMast.cells[0].row, col: singleMast.cells[0].col };

    const sinkResult = waitForEventFiltered(
      shooter,
      "game:shot_result",
      (payload) =>
        payload?.roomId === roomId &&
        payload?.shooter === shooter.id &&
        payload?.outcome === "sink" &&
        payload?.coord?.row === sunkCoord.row &&
        payload?.coord?.col === sunkCoord.col,
      4_000,
    );
    shooter.emit("game:shot", { roomId, coord: sunkCoord });
    await sinkResult;
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await serverA.close();
  }

  const serverB = await startTestServer(port, sharedEnv);
  const recoveredA = createClient(port, { reconnection: false });
  const recoveredB = createClient(port, { reconnection: false });

  try {
    const reconnectSignalA = waitForEventFiltered(
      recoveredA,
      "game:error",
      (payload) =>
        payload?.code === "reconnect_restored" || payload?.code === "reconnect_token_expired",
      6_000,
    );
    const reconnectSignalB = waitForEventFiltered(
      recoveredB,
      "game:error",
      (payload) =>
        payload?.code === "reconnect_restored" || payload?.code === "reconnect_token_expired",
      6_000,
    );
    const restoredStateA = waitForEventFiltered(
      recoveredA,
      "game:state",
      (payload) => payload?.roomId === roomId && payload?.phase === "playing",
      6_000,
    );
    const restoredStateB = waitForEventFiltered(
      recoveredB,
      "game:state",
      (payload) => payload?.roomId === roomId && payload?.phase === "playing",
      6_000,
    );

    recoveredA.emit("search:join", { nickname: "Alpha-R", reconnectToken: tokenA });
    recoveredB.emit("search:join", { nickname: "Beta-R", reconnectToken: tokenB });

    const signalPayloadA = await reconnectSignalA;
    const signalPayloadB = await reconnectSignalB;
    const statePayloadA = await restoredStateA;
    const statePayloadB = await restoredStateB;
    assert.equal(signalPayloadA.code, "reconnect_restored");
    assert.equal(signalPayloadB.code, "reconnect_restored");
    assert.equal(statePayloadA.roomId, roomId);
    assert.equal(statePayloadB.roomId, roomId);

    const sunkKey = coordKey(sunkCoord);
    const defenderState = defenderWasA ? statePayloadA : statePayloadB;
    const attackerState = defenderWasA ? statePayloadB : statePayloadA;

    assert.ok(Array.isArray(defenderState.yourBoard?.sunkCells));
    assert.ok(Array.isArray(attackerState.opponentBoard?.sunkCells));
    assert.equal(defenderState.yourBoard.sunkCells.includes(sunkKey), true);
    assert.equal(attackerState.opponentBoard.sunkCells.includes(sunkKey), true);
  } finally {
    recoveredA.disconnect();
    recoveredB.disconnect();
    await serverB.close();
  }
});

test("chat:send text in online PvP is broadcast to both players", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    const roomId = setup.roomId;
    const text = "Target locked.";

    const chatA = waitForEventFiltered(
      socketA,
      "chat:message",
      (payload) =>
        payload?.roomId === roomId &&
        payload?.message?.kind === "text" &&
        payload?.message?.text === text,
      4_000,
    );
    const chatB = waitForEventFiltered(
      socketB,
      "chat:message",
      (payload) =>
        payload?.roomId === roomId &&
        payload?.message?.kind === "text" &&
        payload?.message?.text === text,
      4_000,
    );

    socketA.emit("chat:send", { roomId, kind: "text", text });
    const [payloadA, payloadB] = await Promise.all([chatA, chatB]);
    assert.equal(payloadA.message.senderId, socketA.id);
    assert.equal(payloadB.message.senderId, socketA.id);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("chat:send with invalid gif id is rejected with chat_invalid_payload", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    const roomId = setup.roomId;
    const chatError = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.code === "chat_invalid_payload",
      4_000,
    );
    socketA.emit("chat:send", { roomId, kind: "gif", gifId: "pwned_payload" });
    const payload = await chatError;
    assert.equal(payload.code, "chat_invalid_payload");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("chat:send is rejected in PvA bot room", async () => {
  const port = randomPort();
  const server = await startTestServer(port, { MATCH_TIMEOUT_MS: "300" });
  const socketA = createClient(port, { reconnection: false });

  try {
    const matched = waitForEventFiltered(
      socketA,
      "queue:matched",
      (payload) => payload?.vsBot === true,
      4_000,
    );
    socketA.emit("search:join", { nickname: "Solo" });
    const payload = await matched;
    const roomId = payload.roomId;
    const error = waitForEventFiltered(
      socketA,
      "game:error",
      (eventPayload) => eventPayload?.code === "chat_not_allowed",
      4_000,
    );
    socketA.emit("chat:send", { roomId, kind: "text", text: "hello bot?" });
    const chatError = await error;
    assert.equal(chatError.code, "chat_not_allowed");
  } finally {
    socketA.disconnect();
    await server.close();
  }
});

test("chat:send is rate limited under burst", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    RATE_LIMIT_CHAT_PER_WINDOW: "2",
    RATE_LIMIT_CHAT_WINDOW_MS: "2_000",
  });
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    const roomId = setup.roomId;

    const limited = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.code === "chat_rate_limited",
      4_000,
    );
    socketA.emit("chat:send", { roomId, kind: "text", text: "m1" });
    socketA.emit("chat:send", { roomId, kind: "text", text: "m2" });
    socketA.emit("chat:send", { roomId, kind: "text", text: "m3" });
    const payload = await limited;
    assert.equal(payload.code, "chat_rate_limited");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("chat:send with URL is rejected with chat_invalid_payload", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    CHAT_BLOCK_LINKS: "true",
  });
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    const roomId = setup.roomId;
    const error = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.code === "chat_invalid_payload",
      4_000,
    );
    socketA.emit("chat:send", { roomId, kind: "text", text: "https://example.com/boom" });
    const payload = await error;
    assert.equal(payload.code, "chat_invalid_payload");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("chat:send with only control/format chars is rejected with chat_invalid_payload", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    const roomId = setup.roomId;
    const error = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.code === "chat_invalid_payload",
      4_000,
    );
    socketA.emit("chat:send", { roomId, kind: "text", text: "\u200b\u200d\u2060" });
    const payload = await error;
    assert.equal(payload.code, "chat_invalid_payload");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("chat:send cooldown blocks second message sent too quickly", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    CHAT_MIN_INTERVAL_MS: "1_200",
    RATE_LIMIT_CHAT_PER_WINDOW: "20",
    RATE_LIMIT_CHAT_WINDOW_MS: "2_000",
  });
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    const roomId = setup.roomId;
    const firstDelivered = waitForEventFiltered(
      socketA,
      "chat:message",
      (payload) =>
        payload?.roomId === roomId &&
        payload?.message?.kind === "text" &&
        payload?.message?.text === "first-fast",
      4_000,
    );
    socketA.emit("chat:send", { roomId, kind: "text", text: "first-fast" });
    await firstDelivered;

    const limited = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.code === "chat_rate_limited",
      4_000,
    );
    socketA.emit("chat:send", { roomId, kind: "text", text: "second-fast" });
    const payload = await limited;
    assert.equal(payload.code, "chat_rate_limited");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("chat:send duplicate spam is rejected inside duplicate window", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    CHAT_MIN_INTERVAL_MS: "20",
    CHAT_DUPLICATE_WINDOW_MS: "4_000",
    CHAT_MAX_SIMILAR_IN_WINDOW: "2",
    RATE_LIMIT_CHAT_PER_WINDOW: "20",
    RATE_LIMIT_CHAT_WINDOW_MS: "2_000",
  });
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    const roomId = setup.roomId;
    const text = "same-msg";
    const firstTwo = waitForEvents(
      socketA,
      "chat:message",
      (payload) =>
        payload?.roomId === roomId &&
        payload?.message?.kind === "text" &&
        payload?.message?.text === text,
      2,
      4_000,
    );
    socketA.emit("chat:send", { roomId, kind: "text", text });
    await sleep(40);
    socketA.emit("chat:send", { roomId, kind: "text", text });
    await firstTwo;
    await sleep(40);

    const limited = waitForEventFiltered(
      socketA,
      "game:error",
      (payload) => payload?.code === "chat_rate_limited",
      4_000,
    );
    socketA.emit("chat:send", { roomId, kind: "text", text });
    const payload = await limited;
    assert.equal(payload.code, "chat_rate_limited");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("chat:send accepts different text messages in normal pace", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    CHAT_MIN_INTERVAL_MS: "100",
    CHAT_DUPLICATE_WINDOW_MS: "5_000",
    CHAT_MAX_SIMILAR_IN_WINDOW: "2",
    RATE_LIMIT_CHAT_PER_WINDOW: "20",
    RATE_LIMIT_CHAT_WINDOW_MS: "2_000",
  });
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    const roomId = setup.roomId;
    const seen = waitForEvents(
      socketA,
      "chat:message",
      (payload) =>
        payload?.roomId === roomId &&
        payload?.message?.kind === "text" &&
        (payload?.message?.text === "alpha-one" || payload?.message?.text === "alpha-two"),
      2,
      4_000,
    );
    socketA.emit("chat:send", { roomId, kind: "text", text: "alpha-one" });
    await sleep(160);
    socketA.emit("chat:send", { roomId, kind: "text", text: "alpha-two" });
    const payloads = await seen;
    assert.equal(payloads.length, 2);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});

test("chat history is replayed after reconnect", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    ROOM_RECONNECT_GRACE_MS: "8_000",
  });
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });
  let recoveredB = null;

  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    const roomId = setup.roomId;
    const reconnectTokenB = setup.bMatch.reconnectToken;
    assert.equal(typeof reconnectTokenB, "string");
    assert.equal(reconnectTokenB.length > 0, true);

    const firstMsg = "Keep formation.";
    const secondMsg = "Roger that.";
    const chatSeenA = waitForEvents(
      socketA,
      "chat:message",
      (payload) => payload?.roomId === roomId,
      2,
      4_000,
    );
    const chatSeenB = waitForEvents(
      socketB,
      "chat:message",
      (payload) => payload?.roomId === roomId,
      2,
      4_000,
    );
    socketA.emit("chat:send", { roomId, kind: "text", text: firstMsg });
    socketB.emit("chat:send", { roomId, kind: "text", text: secondMsg });
    await Promise.all([chatSeenA, chatSeenB]);

    socketB.disconnect();
    recoveredB = createClient(port, { reconnection: false });
    const restoredState = waitForEventFiltered(
      recoveredB,
      "game:state",
      (payload) => payload?.roomId === roomId && payload?.phase === "playing",
      6_000,
    );
    const history = waitForEventFiltered(
      recoveredB,
      "chat:history",
      (payload) =>
        payload?.roomId === roomId &&
        payload?.replayed === true &&
        Array.isArray(payload?.messages) &&
        payload.messages.some((message) => message?.text === firstMsg) &&
        payload.messages.some((message) => message?.text === secondMsg),
      6_000,
    );
    recoveredB.emit("search:join", { nickname: "Beta-R", reconnectToken: reconnectTokenB });
    await restoredState;
    const replay = await history;
    assert.equal(replay.replayed, true);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    if (recoveredB) recoveredB.disconnect();
    await server.close();
  }
});

test("chat remains available in over phase and closes after post-game ttl", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    POST_GAME_CHAT_TTL_MS: "900",
  });
  const socketA = createClient(port, { reconnection: false });
  const socketB = createClient(port, { reconnection: false });

  try {
    const setup = await setupPlayingRoom(socketA, socketB, "Alpha", "Beta");
    const roomId = setup.roomId;

    const overA = waitForEventFiltered(
      socketA,
      "game:over",
      (payload) => payload?.roomId === roomId,
      4_000,
    );
    const overB = waitForEventFiltered(
      socketB,
      "game:over",
      (payload) => payload?.roomId === roomId,
      4_000,
    );
    socketA.emit("game:cancel", { roomId });
    await Promise.all([overA, overB]);

    const overChat = waitForEventFiltered(
      socketB,
      "chat:message",
      (payload) =>
        payload?.roomId === roomId &&
        payload?.message?.kind === "text" &&
        payload?.message?.text === "GG",
      4_000,
    );
    socketB.emit("chat:send", { roomId, kind: "text", text: "GG" });
    await overChat;

    await sleep(1_500);
    const blocked = waitForEventFiltered(
      socketB,
      "game:error",
      (payload) => payload?.code === "chat_not_allowed",
      4_000,
    );
    socketB.emit("chat:send", { roomId, kind: "text", text: "Still there?" });
    const payload = await blocked;
    assert.equal(payload.code, "chat_not_allowed");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await server.close();
  }
});
