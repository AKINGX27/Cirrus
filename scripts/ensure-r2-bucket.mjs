import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function stripJsonComments(input) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function run(args) {
  return spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const config = JSON.parse(stripJsonComments(readFileSync("wrangler.jsonc", "utf8")));
const buckets = Array.isArray(config.r2_buckets) ? config.r2_buckets : [];

for (const bucket of buckets) {
  const name = bucket.bucket_name;
  if (!name) continue;

  process.stdout.write(`Ensuring R2 bucket "${name}" exists...\n`);
  const result = run(["r2", "bucket", "create", name]);
  const output = `${result.stdout}\n${result.stderr}`;

  if (result.status === 0) {
    process.stdout.write(result.stdout);
    continue;
  }

  if (/already exists|already own|exists/i.test(output)) {
    process.stdout.write(`R2 bucket "${name}" already exists.\n`);
    continue;
  }

  process.stderr.write(output);
  process.exit(result.status || 1);
}
