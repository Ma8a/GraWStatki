const { Client } = require("pg");
require("dotenv").config();

const parseBool = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const parseDays = (envName, fallback) => {
  const raw = String(process.env[envName] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${envName} must be a positive integer (days).`);
  }
  return parsed;
};

const connectionString = String(process.env.DATABASE_URL ?? "").trim();
if (!connectionString) {
  console.error("DATABASE_URL is not set. Cannot run retention cleanup.");
  process.exit(1);
}

const dryRun = parseBool(process.env.DB_RETENTION_DRY_RUN);
const retention = {
  matchEventsDays: parseDays("MATCH_EVENTS_RETENTION_DAYS", 30),
  securityEventsDays: parseDays("SECURITY_EVENTS_RETENTION_DAYS", 30),
  matchesDays: parseDays("MATCHES_RETENTION_DAYS", 90),
};

const runDelete = async (client, sql, days) => {
  const result = await client.query(sql, [days]);
  return Number(result.rowCount ?? 0);
};

const runCount = async (client, sql, days) => {
  const result = await client.query(sql, [days]);
  const row = result.rows[0];
  return Number(row?.count ?? 0);
};

const run = async () => {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query("BEGIN");

    const operations = dryRun
      ? [
          {
            label: "match_events",
            sql: "SELECT COUNT(*)::int AS count FROM match_events WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')",
            days: retention.matchEventsDays,
            mode: "count",
          },
          {
            label: "security_events",
            sql: "SELECT COUNT(*)::int AS count FROM security_events WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')",
            days: retention.securityEventsDays,
            mode: "count",
          },
          {
            label: "matches",
            sql: "SELECT COUNT(*)::int AS count FROM matches WHERE ended_at IS NOT NULL AND ended_at < NOW() - ($1::int * INTERVAL '1 day')",
            days: retention.matchesDays,
            mode: "count",
          },
        ]
      : [
          {
            label: "match_events",
            sql: "DELETE FROM match_events WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')",
            days: retention.matchEventsDays,
            mode: "delete",
          },
          {
            label: "security_events",
            sql: "DELETE FROM security_events WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')",
            days: retention.securityEventsDays,
            mode: "delete",
          },
          {
            label: "matches",
            sql: "DELETE FROM matches WHERE ended_at IS NOT NULL AND ended_at < NOW() - ($1::int * INTERVAL '1 day')",
            days: retention.matchesDays,
            mode: "delete",
          },
        ];

    const summary = {};
    for (const op of operations) {
      summary[op.label] =
        op.mode === "count"
          ? await runCount(client, op.sql, op.days)
          : await runDelete(client, op.sql, op.days);
    }

    await client.query("COMMIT");

    const modeLabel = dryRun ? "DRY-RUN" : "DELETE";
    console.log(
      `${modeLabel} retention summary: match_events=${summary.match_events}, security_events=${summary.security_events}, matches=${summary.matches}`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Retention cleanup failed: ${message}`);
  process.exit(1);
});
