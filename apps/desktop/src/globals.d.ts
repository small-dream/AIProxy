/**
 * App version injected at build time by `vite.config.ts` (`define`) from
 * `apps/desktop/package.json`.
 *
 * It backs the fallbacks used outside the Tauri runtime (browser preview, unit
 * tests) and the HAR `creator.version` metadata, so neither drifts from the
 * released version.
 */
declare const __APP_VERSION__: string;
