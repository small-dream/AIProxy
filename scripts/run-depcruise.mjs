import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(
  new URL("../apps/desktop/node_modules/dependency-cruiser/bin/dependency-cruise.mjs", import.meta.url),
);
const cwd = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
  cwd,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
