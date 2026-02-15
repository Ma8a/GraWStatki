const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { Client } = require("pg");

const runRetentionScript = async (extraEnv = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "../scripts/db-retention.js")], {
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });

test("db-retention dry-run reports candidates and delete mode removes only stale rows", async (t) => {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    t.skip("DATABASE_URL not configured");
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const marker = `retention_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const roomOld = `${marker}_room_old`;
  const roomNew = `${marker}_room_new`;
  const playerOld = `${marker}_player_old`;
  const playerNew = `${marker}_player_new`;
  const now = Date.now();
  const staleTs = new Date(now - 40 * 24 * 60 * 60 * 1000);
  const freshTs = new Date(now - 2 * 24 * 60 * 60 * 1000);

  const cleanup = async () => {
    await client.query("DELETE FROM match_events WHERE room_id = ANY($1::text[])", [[roomOld, roomNew]]);
    await client.query("DELETE FROM security_events WHERE payload->>'marker' = $1", [marker]);
    await client.query("DELETE FROM matches WHERE room_id = ANY($1::text[])", [[roomOld, roomNew]]);
  };

  try {
    await cleanup();

    const oldMatch = await client.query(
      `
        INSERT INTO matches (room_id, mode, status, winner_player_id, started_at, ended_at)
        VALUES ($1, 'online', 'normal', $2, $3, $4)
        RETURNING id
      `,
      [roomOld, playerOld, staleTs, staleTs],
    );
    const newMatch = await client.query(
      `
        INSERT INTO matches (room_id, mode, status, winner_player_id, started_at, ended_at)
        VALUES ($1, 'online', 'normal', $2, $3, $4)
        RETURNING id
      `,
      [roomNew, playerNew, freshTs, freshTs],
    );

    await client.query(
      `
        INSERT INTO match_players (match_id, player_id, nickname, shots, is_winner)
        VALUES
          ($1, $2, 'Old', 7, true),
          ($3, $4, 'New', 3, false)
      `,
      [oldMatch.rows[0].id, playerOld, newMatch.rows[0].id, playerNew],
    );

    await client.query(
      `
        INSERT INTO match_events (room_id, event_type, payload, created_at)
        VALUES
          ($1, 'shot_result', $2::jsonb, $3),
          ($4, 'shot_result', $5::jsonb, $6)
      `,
      [
        roomOld,
        JSON.stringify({ marker, freshness: "old" }),
        staleTs,
        roomNew,
        JSON.stringify({ marker, freshness: "new" }),
        freshTs,
      ],
    );

    await client.query(
      `
        INSERT INTO security_events (event_type, ip, socket_id, payload, created_at)
        VALUES
          ('invalid_payload', '127.0.0.1', 'old_socket', $1::jsonb, $2),
          ('invalid_payload', '127.0.0.1', 'new_socket', $3::jsonb, $4)
      `,
      [
        JSON.stringify({ marker, freshness: "old" }),
        staleTs,
        JSON.stringify({ marker, freshness: "new" }),
        freshTs,
      ],
    );

    const dryRun = await runRetentionScript({
      DATABASE_URL: databaseUrl,
      MATCH_EVENTS_RETENTION_DAYS: "30",
      SECURITY_EVENTS_RETENTION_DAYS: "30",
      MATCHES_RETENTION_DAYS: "30",
      DB_RETENTION_DRY_RUN: "true",
    });
    assert.equal(dryRun.code, 0, dryRun.stderr || dryRun.stdout);
    assert.match(dryRun.stdout, /DRY-RUN retention summary:/);

    const countsAfterDryRun = await client.query(
      `
        SELECT
          (SELECT COUNT(*)::int FROM match_events WHERE room_id = $1) AS old_events,
          (SELECT COUNT(*)::int FROM match_events WHERE room_id = $2) AS new_events,
          (SELECT COUNT(*)::int FROM security_events WHERE payload->>'marker' = $3 AND payload->>'freshness' = 'old') AS old_security,
          (SELECT COUNT(*)::int FROM security_events WHERE payload->>'marker' = $3 AND payload->>'freshness' = 'new') AS new_security,
          (SELECT COUNT(*)::int FROM matches WHERE room_id = $1) AS old_matches,
          (SELECT COUNT(*)::int FROM matches WHERE room_id = $2) AS new_matches
      `,
      [roomOld, roomNew, marker],
    );
    assert.equal(countsAfterDryRun.rows[0].old_events, 1);
    assert.equal(countsAfterDryRun.rows[0].new_events, 1);
    assert.equal(countsAfterDryRun.rows[0].old_security, 1);
    assert.equal(countsAfterDryRun.rows[0].new_security, 1);
    assert.equal(countsAfterDryRun.rows[0].old_matches, 1);
    assert.equal(countsAfterDryRun.rows[0].new_matches, 1);

    const deleteRun = await runRetentionScript({
      DATABASE_URL: databaseUrl,
      MATCH_EVENTS_RETENTION_DAYS: "30",
      SECURITY_EVENTS_RETENTION_DAYS: "30",
      MATCHES_RETENTION_DAYS: "30",
      DB_RETENTION_DRY_RUN: "false",
    });
    assert.equal(deleteRun.code, 0, deleteRun.stderr || deleteRun.stdout);
    assert.match(deleteRun.stdout, /DELETE retention summary:/);

    const countsAfterDelete = await client.query(
      `
        SELECT
          (SELECT COUNT(*)::int FROM match_events WHERE room_id = $1) AS old_events,
          (SELECT COUNT(*)::int FROM match_events WHERE room_id = $2) AS new_events,
          (SELECT COUNT(*)::int FROM security_events WHERE payload->>'marker' = $3 AND payload->>'freshness' = 'old') AS old_security,
          (SELECT COUNT(*)::int FROM security_events WHERE payload->>'marker' = $3 AND payload->>'freshness' = 'new') AS new_security,
          (SELECT COUNT(*)::int FROM matches WHERE room_id = $1) AS old_matches,
          (SELECT COUNT(*)::int FROM matches WHERE room_id = $2) AS new_matches
      `,
      [roomOld, roomNew, marker],
    );
    assert.equal(countsAfterDelete.rows[0].old_events, 0);
    assert.equal(countsAfterDelete.rows[0].new_events, 1);
    assert.equal(countsAfterDelete.rows[0].old_security, 0);
    assert.equal(countsAfterDelete.rows[0].new_security, 1);
    assert.equal(countsAfterDelete.rows[0].old_matches, 0);
    assert.equal(countsAfterDelete.rows[0].new_matches, 1);

    const playersCount = await client.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE player_id = $1)::int AS old_players,
          COUNT(*) FILTER (WHERE player_id = $2)::int AS new_players
        FROM match_players
      `,
      [playerOld, playerNew],
    );
    assert.equal(playersCount.rows[0].old_players, 0);
    assert.equal(playersCount.rows[0].new_players, 1);
  } finally {
    await cleanup();
    await client.end();
  }
});
