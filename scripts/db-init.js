const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const connectionString = (process.env.DATABASE_URL || "").trim();
if (!connectionString) {
  console.error("DATABASE_URL is not set. Skipping schema init.");
  process.exit(1);
}

const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
const schemaSql = fs.readFileSync(schemaPath, "utf8");

const run = async () => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(schemaSql);
    console.log("Schema applied successfully.");
  } finally {
    await client.end();
  }
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Schema init failed: ${message}`);
  process.exit(1);
});
