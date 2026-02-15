const { spawn } = require("node:child_process");

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/run-with-local-env.js <command> [args...]");
  process.exit(1);
}

const env = { ...process.env };
if (!env.REDIS_URL) {
  env.REDIS_URL = "redis://127.0.0.1:6379";
}
if (!env.DATABASE_URL) {
  env.DATABASE_URL = "postgres://battleship:battleship@127.0.0.1:5432/battleship";
}

const child = spawn(args[0], args.slice(1), {
  stdio: "inherit",
  shell: true,
  env,
});

child.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start command: ${message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
