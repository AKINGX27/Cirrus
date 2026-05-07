export function selectedWranglerConfig() {
  const backend = (process.env.CIRRUS_DEPLOY_TARGET || process.env.STORAGE_BACKEND || "r2").trim().toLowerCase();
  const configByBackend = {
    r2: "wrangler.jsonc",
    s3: "wrangler.s3.jsonc",
  };
  const config = configByBackend[backend];

  if (!config) {
    console.error("STORAGE_BACKEND must be either r2 or s3.");
    process.exit(1);
  }

  return config;
}
