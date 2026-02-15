const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

let nextPort = 37_000;
const randomPort = () => {
  const selected = nextPort;
  nextPort += 1;
  if (nextPort >= 39_000) {
    nextPort = 37_000;
  }
  return selected;
};
const REDIS_TEST_NAMESPACE = `health:${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;

const waitForServer = (proc, port, timeoutMs = 5_000) =>
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

const requestEndpoint = async (port, endpoint, method) => {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method });
  const contentType = String(response.headers.get("content-type") ?? "");
  const cacheControl = String(response.headers.get("cache-control") ?? "");
  const pragma = String(response.headers.get("pragma") ?? "");
  const expires = String(response.headers.get("expires") ?? "");
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    contentType,
    cacheControl,
    pragma,
    expires,
    text,
    json,
  };
};

const assertReadyDependenciesShape = (dependencies) => {
  assert.equal(typeof dependencies, "object");
  assert.notEqual(dependencies, null);
  for (const key of ["redisQueue", "redisState", "redisLimiter", "telemetry"]) {
    const value = dependencies[key];
    assert.equal(typeof value, "object");
    assert.notEqual(value, null);
    assert.equal(typeof value.enabled, "boolean");
    assert.equal(typeof value.reachable, "boolean");
  }
};

const assertJsonContentType = (response) => {
  assert.equal(response.contentType.includes("application/json"), true);
};

const assertNoStoreHeaders = (response) => {
  assert.equal(response.cacheControl.includes("no-store"), true);
  assert.equal(response.pragma.toLowerCase().includes("no-cache"), true);
  assert.equal(response.expires, "0");
};

test("GET /health returns OK payload", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  try {
    const result = await requestEndpoint(port, "/health", "GET");
    assert.equal(result.status, 200);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "ok");
    assert.equal(typeof result.json?.uptimeSec, "number");
    assert.equal(typeof result.json?.timestamp, "number");
  } finally {
    await server.close();
  }
});

test("POST /health returns OK payload", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  try {
    const result = await requestEndpoint(port, "/health", "POST");
    assert.equal(result.status, 200);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "ok");
  } finally {
    await server.close();
  }
});

test("GET /ready returns ready payload when dependencies are optional", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_REQUIRED: "0",
    DATABASE_REQUIRED: "0",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "GET");
    assert.equal(result.status, 200);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "ready");
    assertReadyDependenciesShape(result.json?.dependencies);
  } finally {
    await server.close();
  }
});

test("GET /ready returns 200 when redis is required and reachable", async (t) => {
  const redisUrl = (process.env.REDIS_URL ?? "").trim();
  if (!redisUrl) {
    t.skip("REDIS_URL not configured");
    return;
  }
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_URL: redisUrl,
    REDIS_REQUIRED: "1",
    DATABASE_REQUIRED: "0",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "GET");
    assert.equal(result.status, 200);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(result.json.dependencies.redisQueue.reachable, true);
    assert.equal(result.json.dependencies.redisState.reachable, true);
    assert.equal(result.json.dependencies.redisLimiter.reachable, true);
  } finally {
    await server.close();
  }
});

test("POST /ready returns 200 when redis is required and reachable", async (t) => {
  const redisUrl = (process.env.REDIS_URL ?? "").trim();
  if (!redisUrl) {
    t.skip("REDIS_URL not configured");
    return;
  }
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_URL: redisUrl,
    REDIS_REQUIRED: "1",
    DATABASE_REQUIRED: "0",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "POST");
    assert.equal(result.status, 200);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(result.json.dependencies.redisQueue.reachable, true);
    assert.equal(result.json.dependencies.redisState.reachable, true);
    assert.equal(result.json.dependencies.redisLimiter.reachable, true);
  } finally {
    await server.close();
  }
});

test("GET /ready returns 200 when database is required and reachable", async (t) => {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    t.skip("DATABASE_URL not configured");
    return;
  }
  const port = randomPort();
  const server = await startTestServer(port, {
    DATABASE_URL: databaseUrl,
    REDIS_REQUIRED: "0",
    DATABASE_REQUIRED: "1",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "GET");
    assert.equal(result.status, 200);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(result.json.dependencies.telemetry.reachable, true);
  } finally {
    await server.close();
  }
});

test("POST /ready returns 200 when database is required and reachable", async (t) => {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    t.skip("DATABASE_URL not configured");
    return;
  }
  const port = randomPort();
  const server = await startTestServer(port, {
    DATABASE_URL: databaseUrl,
    REDIS_REQUIRED: "0",
    DATABASE_REQUIRED: "1",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "POST");
    assert.equal(result.status, 200);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(result.json.dependencies.telemetry.reachable, true);
  } finally {
    await server.close();
  }
});

test("GET /ready returns 503 when redis is required but not configured", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_URL: "",
    REDIS_REQUIRED: "1",
    DATABASE_REQUIRED: "0",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "GET");
    assert.equal(result.status, 503);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "not_ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(Array.isArray(result.json?.missing), true);
    assert.equal(result.json.missing.includes("redisQueue"), true);
    assert.equal(result.json.missing.includes("redisState"), true);
    assert.equal(result.json.missing.includes("redisLimiter"), true);
  } finally {
    await server.close();
  }
});

test("POST /ready returns 503 when redis is required but not configured", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_URL: "",
    REDIS_REQUIRED: "1",
    DATABASE_REQUIRED: "0",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "POST");
    assert.equal(result.status, 503);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "not_ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(Array.isArray(result.json?.missing), true);
    assert.equal(result.json.missing.includes("redisQueue"), true);
    assert.equal(result.json.missing.includes("redisState"), true);
    assert.equal(result.json.missing.includes("redisLimiter"), true);
  } finally {
    await server.close();
  }
});

test("GET /ready returns 503 when redis is configured but unreachable", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_URL: "redis://203.0.113.1:6379",
    READY_PING_TIMEOUT_MS: "120",
    REDIS_REQUIRED: "1",
    DATABASE_REQUIRED: "0",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "GET");
    assert.equal(result.status, 503);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "not_ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(result.json.missing.includes("redisQueue"), true);
    assert.equal(result.json.missing.includes("redisState"), true);
    assert.equal(result.json.missing.includes("redisLimiter"), true);
  } finally {
    await server.close();
  }
});

test("POST /ready returns 503 when redis is configured but unreachable", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_URL: "redis://203.0.113.1:6379",
    READY_PING_TIMEOUT_MS: "120",
    REDIS_REQUIRED: "1",
    DATABASE_REQUIRED: "0",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "POST");
    assert.equal(result.status, 503);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "not_ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(result.json.missing.includes("redisQueue"), true);
    assert.equal(result.json.missing.includes("redisState"), true);
    assert.equal(result.json.missing.includes("redisLimiter"), true);
  } finally {
    await server.close();
  }
});

test("GET /ready returns 503 when database is configured but unreachable", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    DATABASE_URL: "postgres://battleship:battleship@203.0.113.2:5432/battleship",
    DB_CONNECT_TIMEOUT_MS: "120",
    READY_PING_TIMEOUT_MS: "120",
    REDIS_REQUIRED: "0",
    DATABASE_REQUIRED: "1",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "GET");
    assert.equal(result.status, 503);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "not_ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(result.json.missing.includes("telemetry"), true);
  } finally {
    await server.close();
  }
});

test("POST /ready returns 503 when database is configured but unreachable", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    DATABASE_URL: "postgres://battleship:battleship@203.0.113.2:5432/battleship",
    DB_CONNECT_TIMEOUT_MS: "120",
    READY_PING_TIMEOUT_MS: "120",
    REDIS_REQUIRED: "0",
    DATABASE_REQUIRED: "1",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "POST");
    assert.equal(result.status, 503);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "not_ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(result.json.missing.includes("telemetry"), true);
  } finally {
    await server.close();
  }
});

test("GET /ready returns full missing set when redis and database are both required and unavailable", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_URL: "",
    DATABASE_URL: "",
    REDIS_REQUIRED: "1",
    DATABASE_REQUIRED: "1",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "GET");
    assert.equal(result.status, 503);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "not_ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(result.json.missing.includes("redisQueue"), true);
    assert.equal(result.json.missing.includes("redisState"), true);
    assert.equal(result.json.missing.includes("redisLimiter"), true);
    assert.equal(result.json.missing.includes("telemetry"), true);
  } finally {
    await server.close();
  }
});

test("POST /ready returns full missing set when redis and database are both required and unavailable", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_URL: "",
    DATABASE_URL: "",
    REDIS_REQUIRED: "1",
    DATABASE_REQUIRED: "1",
  });
  try {
    const result = await requestEndpoint(port, "/ready", "POST");
    assert.equal(result.status, 503);
    assertJsonContentType(result);
    assert.equal(result.json?.status, "not_ready");
    assertReadyDependenciesShape(result.json?.dependencies);
    assert.equal(result.json.missing.includes("redisQueue"), true);
    assert.equal(result.json.missing.includes("redisState"), true);
    assert.equal(result.json.missing.includes("redisLimiter"), true);
    assert.equal(result.json.missing.includes("telemetry"), true);
  } finally {
    await server.close();
  }
});

test("GET and POST /ready return 200 when redis and database are both required and reachable", async (t) => {
  const redisUrl = (process.env.REDIS_URL ?? "").trim();
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!redisUrl || !databaseUrl) {
    t.skip("REDIS_URL or DATABASE_URL not configured");
    return;
  }
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_URL: redisUrl,
    DATABASE_URL: databaseUrl,
    REDIS_REQUIRED: "1",
    DATABASE_REQUIRED: "1",
  });
  try {
    const getResult = await requestEndpoint(port, "/ready", "GET");
    const postResult = await requestEndpoint(port, "/ready", "POST");
    assert.equal(getResult.status, 200);
    assert.equal(postResult.status, 200);
    assertJsonContentType(getResult);
    assertJsonContentType(postResult);
    assert.equal(getResult.json?.status, "ready");
    assert.equal(postResult.json?.status, "ready");
    assertReadyDependenciesShape(getResult.json?.dependencies);
    assertReadyDependenciesShape(postResult.json?.dependencies);
    assert.equal(getResult.json.dependencies.redisQueue.reachable, true);
    assert.equal(getResult.json.dependencies.redisState.reachable, true);
    assert.equal(getResult.json.dependencies.redisLimiter.reachable, true);
    assert.equal(getResult.json.dependencies.telemetry.reachable, true);
    assert.equal(postResult.json.dependencies.redisQueue.reachable, true);
    assert.equal(postResult.json.dependencies.redisState.reachable, true);
    assert.equal(postResult.json.dependencies.redisLimiter.reachable, true);
    assert.equal(postResult.json.dependencies.telemetry.reachable, true);
  } finally {
    await server.close();
  }
});

test("GET /metrics returns text payload with gauges", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  try {
    const result = await requestEndpoint(port, "/metrics", "GET");
    assert.equal(result.status, 200);
    assert.equal(result.contentType.includes("text/plain"), true);
    assert.equal(result.contentType.includes("application/json"), false);
    assert.equal(result.text.includes("battleship_uptime_seconds"), true);
    assert.equal(result.text.includes("battleship_rooms_active"), true);
    assert.equal(result.text.includes("battleship_matchmaking_queue_size"), true);
  } finally {
    await server.close();
  }
});

test("POST /metrics returns text payload with gauges", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  try {
    const result = await requestEndpoint(port, "/metrics", "POST");
    assert.equal(result.status, 200);
    assert.equal(result.contentType.includes("text/plain"), true);
    assert.equal(result.text.includes("battleship_runtime_dependency_enabled"), true);
  } finally {
    await server.close();
  }
});

test("operational endpoints expose no-store cache headers", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  try {
    const health = await requestEndpoint(port, "/health", "GET");
    const ready = await requestEndpoint(port, "/ready", "GET");
    const metrics = await requestEndpoint(port, "/metrics", "GET");
    for (const response of [health, ready, metrics]) {
      assertNoStoreHeaders(response);
    }
  } finally {
    await server.close();
  }
});

test("operational POST endpoints expose no-store cache headers", async () => {
  const port = randomPort();
  const server = await startTestServer(port);
  try {
    const health = await requestEndpoint(port, "/health", "POST");
    const ready = await requestEndpoint(port, "/ready", "POST");
    const metrics = await requestEndpoint(port, "/metrics", "POST");
    for (const response of [health, ready, metrics]) {
      assertNoStoreHeaders(response);
    }
  } finally {
    await server.close();
  }
});

test("ready 503 responses expose no-store cache headers", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_URL: "",
    REDIS_REQUIRED: "1",
    DATABASE_REQUIRED: "0",
  });
  try {
    const getResult = await requestEndpoint(port, "/ready", "GET");
    const postResult = await requestEndpoint(port, "/ready", "POST");
    assert.equal(getResult.status, 503);
    assert.equal(postResult.status, 503);
    assertNoStoreHeaders(getResult);
    assertNoStoreHeaders(postResult);
  } finally {
    await server.close();
  }
});

test("ready cache keeps not_ready status for repeated probes when dependency is unavailable", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_URL: "redis://203.0.113.1:6379",
    REDIS_REQUIRED: "1",
    DATABASE_REQUIRED: "0",
    READY_PING_TIMEOUT_MS: "120",
    READY_CACHE_MS: "1500",
  });
  try {
    const first = await requestEndpoint(port, "/ready", "GET");
    const second = await requestEndpoint(port, "/ready", "GET");
    const third = await requestEndpoint(port, "/ready", "POST");

    for (const response of [first, second, third]) {
      assert.equal(response.status, 503);
      assertJsonContentType(response);
      assert.equal(response.json?.status, "not_ready");
      assertReadyDependenciesShape(response.json?.dependencies);
      assert.equal(Array.isArray(response.json?.missing), true);
      assert.equal(response.json.missing.includes("redisQueue"), true);
      assert.equal(response.json.missing.includes("redisState"), true);
      assert.equal(response.json.missing.includes("redisLimiter"), true);
    }
  } finally {
    await server.close();
  }
});

test("ready cache keeps ready status for repeated probes when dependencies are optional", async () => {
  const port = randomPort();
  const server = await startTestServer(port, {
    REDIS_REQUIRED: "0",
    DATABASE_REQUIRED: "0",
    READY_CACHE_MS: "1500",
  });
  try {
    const first = await requestEndpoint(port, "/ready", "GET");
    const second = await requestEndpoint(port, "/ready", "GET");
    const third = await requestEndpoint(port, "/ready", "POST");

    for (const response of [first, second, third]) {
      assert.equal(response.status, 200);
      assertJsonContentType(response);
      assert.equal(response.json?.status, "ready");
      assertReadyDependenciesShape(response.json?.dependencies);
    }
  } finally {
    await server.close();
  }
});
