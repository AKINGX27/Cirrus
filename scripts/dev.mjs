import { spawnSync } from "node:child_process";
import { selectedWranglerConfig } from "./config.mjs";

const result = spawnSync("npx", ["wrangler", "dev", "--config", selectedWranglerConfig(), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
