import { spawnSync } from "node:child_process";
import { selectedWranglerConfig } from "./config.mjs";

const result = spawnSync("npx", ["wrangler", "deploy", "--experimental-provision", "--config", selectedWranglerConfig()], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
