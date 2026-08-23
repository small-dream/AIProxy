import { spawnSync } from "node:child_process";

const bin = new URL(
  "../apps/desktop/node_modules/dependency-cruiser/bin/dependency-cruise.mjs",
  import.meta.url,
);
const result = spawnSync(process.execPath, [bin.pathname, ...process.argv.slice(2)], {
  cwd: new URL("../apps/desktop", import.meta.url),
  stdio: "inherit",
});

process.exit(result.status ?? 1);
