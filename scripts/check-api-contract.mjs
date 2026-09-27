#!/usr/bin/env node

// Cross-checks the IPC contract between three sources:
//   1. Rust backend: commands registered in `tauri::generate_handler![]`
//      (apps/desktop/src-tauri/src/main.rs) and events emitted via
//      `emit` / `emit_to` / `emit_all` string literals (src-tauri + crates).
//   2. Frontend: events subscribed via `listen(...)` in
//      apps/desktop/src/services/events.
//   3. Docs: commands and events recorded in docs/API_SPEC.md.
//
// Hard failures (exit 1):
//   - a command is registered in Rust but nowhere documented in API_SPEC.md
//   - the frontend subscribes to an event the backend never emits
// Everything else (documented-but-unregistered commands, emitted-but-
// undocumented events, ...) is reported as a warning: the regex extraction
// is intentionally simple, and a warning beats a false-positive failure.
//
// Uses only Node built-ins so it behaves identically on Windows, macOS, and
// Linux. Run via `pnpm check:api-contract`.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MAIN_RS = path.join(repoRoot, "apps/desktop/src-tauri/src/main.rs");
const API_SPEC = path.join(repoRoot, "docs/API_SPEC.md");
const RUST_EVENT_DIRS = [
  path.join(repoRoot, "apps/desktop/src-tauri/src"),
  path.join(repoRoot, "crates"),
];
const FRONTEND_EVENTS_DIR = path.join(repoRoot, "apps/desktop/src/services/events");

// Known pre-existing gaps that must not fail the build while they are being
// addressed separately. Each entry is re-validated on every run: once the
// underlying code/docs change lands, the script asks for the entry to be
// removed. Example entry: KNOWN_UNEMITTED_LISTENS.add("some-event") when the
// frontend subscribes to an event whose backend emission is still in flight.
const KNOWN_UNEMITTED_LISTENS = new Set();
const KNOWN_UNDOCUMENTED_COMMANDS = new Set();

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function collectFiles(dir, extension, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "target" || entry.name === "node_modules") continue;
      collectFiles(child, extension, acc);
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      acc.push(child);
    }
  }
  return acc;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

// --- Extraction -------------------------------------------------------------

function extractRegisteredCommands() {
  const source = readFile(MAIN_RS);
  const handlerMatch = source.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!handlerMatch) {
    console.error("[check-api-contract] FAIL: could not locate generate_handler![] in main.rs");
    process.exit(1);
  }
  return uniqueSorted(
    [...handlerMatch[1].matchAll(/commands::([a-z][a-z0-9_]*)/g)].map((m) => m[1]),
  );
}

// Markdown docs are processed line by line: fenced code blocks (```) would
// otherwise throw off naive backtick pairing across the whole document.
function* specLines(spec) {
  yield* spec.split("\n");
}

function extractDocumentedCommands(spec) {
  const documented = new Set();
  for (const line of specLines(spec)) {
    // Heading form: `### \`start_proxy\`` or `### set_menu_locale`, possibly
    // with a trailing annotation (`— 已实现`). The lookahead keeps kebab-case
    // event headings (`### \`session-upsert\``) from matching partially.
    const heading = line.match(/^###\s+`?([a-z][a-z0-9_]*)(?=`|\s|$)/);
    if (heading) {
      documented.add(heading[1]);
    }
    // Signature form used by the later appendix sections: `name(...) -> ...`.
    for (const match of line.matchAll(/`([a-z][a-z0-9_]*)\s*\(/g)) {
      documented.add(match[1]);
    }
  }
  return documented;
}

function extractDocumentedCommandHeadings(spec) {
  // Only `### name` headings count for the reverse (doc -> code) check; inline
  // signature mentions are too noisy (field names, helper functions). All
  // commands are snake_case, so a name without "_" is a section heading.
  const headings = new Set();
  for (const line of specLines(spec)) {
    // Entries explicitly documented as not implemented / superseded (e.g.
    // `repeat_session`, `save_breakpoint_rule`) are intentional, not drift.
    if (line.includes("暂未") || line.includes("替代")) continue;
    const match = line.match(/^###\s+`?([a-z][a-z0-9_]*)(?=`|\s|$)/);
    if (match && match[1].includes("_")) {
      headings.add(match[1]);
    }
  }
  return uniqueSorted(headings);
}

function extractDocumentedEvents(spec) {
  // Events use kebab-case (`session-upsert`); filter backticked tokens to
  // that shape so prose like `menu-locale.json` does not leak in.
  const events = new Set();
  for (const line of specLines(spec)) {
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const token = match[1];
      if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(token)) {
        events.add(token);
      }
    }
  }
  return events;
}

function extractEmittedEvents() {
  const events = [];
  for (const dir of RUST_EVENT_DIRS) {
    for (const file of collectFiles(dir, ".rs")) {
      const source = readFile(file);
      for (const match of source.matchAll(/\bemit(?:_all|_to)?\(\s*"([^"]+)"/g)) {
        events.push(match[1]);
      }
    }
  }
  return uniqueSorted(events);
}

function extractListenedEvents() {
  const events = [];
  for (const file of collectFiles(FRONTEND_EVENTS_DIR, ".ts")) {
    const source = readFile(file);
    for (const match of source.matchAll(/\blisten(?:<[^>]*>)?\(\s*"([^"]+)"/g)) {
      events.push(match[1]);
    }
  }
  return uniqueSorted(events);
}

// --- Comparison -------------------------------------------------------------

const registeredCommands = extractRegisteredCommands();
const spec = readFile(API_SPEC);
const documentedCommands = extractDocumentedCommands(spec);
const documentedCommandHeadings = extractDocumentedCommandHeadings(spec);
const documentedEvents = extractDocumentedEvents(spec);
const emittedEvents = extractEmittedEvents();
const listenedEvents = extractListenedEvents();

const failures = [];
const warnings = [];

const undocumentedCommands = registeredCommands.filter(
  (name) => !documentedCommands.has(name) && !KNOWN_UNDOCUMENTED_COMMANDS.has(name),
);
if (undocumentedCommands.length > 0) {
  failures.push(
    `Commands registered in main.rs but missing from docs/API_SPEC.md:\n  - ${undocumentedCommands.join("\n  - ")}`,
  );
}
for (const name of registeredCommands) {
  if (!documentedCommands.has(name) && KNOWN_UNDOCUMENTED_COMMANDS.has(name)) {
    warnings.push(`Known gap: command "${name}" is registered but not yet documented in API_SPEC.md.`);
  }
}
for (const name of KNOWN_UNDOCUMENTED_COMMANDS) {
  if (documentedCommands.has(name)) {
    warnings.push(
      `"${name}" is now documented; remove it from KNOWN_UNDOCUMENTED_COMMANDS in scripts/check-api-contract.mjs.`,
    );
  }
}

const unemittedListens = listenedEvents.filter((name) => !emittedEvents.includes(name));
const unexpectedUnemitted = unemittedListens.filter((name) => !KNOWN_UNEMITTED_LISTENS.has(name));
if (unexpectedUnemitted.length > 0) {
  failures.push(
    `Events subscribed by the frontend (services/events) but never emitted by the backend:\n  - ${unexpectedUnemitted.join("\n  - ")}`,
  );
}
for (const name of unemittedListens) {
  if (KNOWN_UNEMITTED_LISTENS.has(name)) {
    warnings.push(`Known gap: frontend subscribes to "${name}" but the backend never emits it.`);
  }
}
for (const name of KNOWN_UNEMITTED_LISTENS) {
  if (emittedEvents.includes(name)) {
    warnings.push(
      `"${name}" is now emitted by the backend; remove it from KNOWN_UNEMITTED_LISTENS in scripts/check-api-contract.mjs.`,
    );
  }
}

const staleDocCommands = documentedCommandHeadings.filter(
  (name) => !registeredCommands.includes(name),
);
if (staleDocCommands.length > 0) {
  warnings.push(
    `Commands documented in API_SPEC.md but not registered in main.rs (may be intentional, e.g. "暂未实现"):\n  - ${staleDocCommands.join("\n  - ")}`,
  );
}

const unheardEvents = emittedEvents.filter(
  (name) => !listenedEvents.includes(name) && !documentedEvents.has(name),
);
if (unheardEvents.length > 0) {
  warnings.push(
    `Events emitted by the backend with no frontend listener and no API_SPEC.md entry:\n  - ${unheardEvents.join("\n  - ")}`,
  );
}

// --- Report -----------------------------------------------------------------

console.log(
  `[check-api-contract] commands: ${registeredCommands.length} registered / ${documentedCommands.size} documented; events: ${emittedEvents.length} emitted / ${listenedEvents.length} listened / ${documentedEvents.size} documented`,
);
for (const warning of warnings) {
  console.warn(`[check-api-contract] WARN: ${warning}`);
}
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[check-api-contract] FAIL: ${failure}`);
  }
  process.exit(1);
}
console.log("[check-api-contract] OK");
