#!/usr/bin/env node
// Stage the standalone, distribution-ready Orca companion plugin (`orchestration-panel`).
//
//   node scripts/build-plugin.mjs   → dist-plugin/
//
// Layout (Orca plugin archive limits: <= 2,000 files, <= 50 MiB, zero node_modules):
//
//   dist-plugin/
//     orca-plugin.json   ← versioned manifest; Orca loads the TypeScript worker
//     src/**             ← readable worker code, shipped once
//     panel/**           ← Vite SPA build with `VITE_BASE=./` for Orca's HTML panel
//     README.md, LICENSE ← plugin documentation & license
//
// Validate the staged directory against the installed Orca runtime:
//   orca-ide plugin validate ./dist-plugin --json
//   orca-ide plugin inspect ./dist-plugin --json

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PLUGIN_FILES = 2_000;
const MAX_PLUGIN_BYTES = 50 * 1024 * 1024;
const PLUGIN_SIZE_BUDGET = 3 * 1024 * 1024; // Local regression guard, not a catalog limit.
const PLUGIN_FILE_SIZE_BUDGET = 1024 * 1024; // Keep every shipped file under 1 MiB.
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const FORBIDDEN_EXTENSIONS = new Set([
  ".ttf",
  ".otf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".node",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".wasm",
]);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(root, "plugin");
const outDir = join(root, "dist-plugin");
const manifest = JSON.parse(readFileSync(join(pluginDir, "orca-plugin.json"), "utf8"));
const version = (process.env.PKG_VERSION ?? manifest.version ?? "0.1.0").replace(/^v/, "").trim();
const pluginRepo = (process.env.ORCA_PLUGIN_REPO || "yyq19990828/orchestration-panel").trim();

if (!SEMVER_RE.test(version)) {
  throw new Error(`Invalid plugin version "${version}" (expected semver like 0.1.0 or 1.0.0-rc.1).`);
}
if (!REPO_SLUG_RE.test(pluginRepo)) {
  throw new Error(`Invalid ORCA_PLUGIN_REPO "${pluginRepo}" (expected owner/repo).`);
}
if (typeof manifest.id !== "string" || manifest.id.startsWith("orca-")) {
  throw new Error(`Invalid plugin id "${manifest.id}": must be a non-empty string without reserved "orca-" prefix.`);
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}

function inspectAndMeasureTree(dir, relPrefix = "") {
  let files = 0;
  let bytes = 0;
  let maxFileBytes = 0;
  let maxFilePath = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlinks are forbidden in Orca plugin distributions: ${full}`);
    }
    if (stat.isDirectory()) {
      const sub = inspectAndMeasureTree(full, rel);
      files += sub.files;
      bytes += sub.bytes;
      if (sub.maxFileBytes > maxFileBytes) {
        maxFileBytes = sub.maxFileBytes;
        maxFilePath = sub.maxFilePath;
      }
    } else if (stat.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        throw new Error(`Forbidden file extension "${ext}" in Orca plugin distribution: ${full}`);
      }
      files += 1;
      bytes += stat.size;
      if (stat.size > maxFileBytes) {
        maxFileBytes = stat.size;
        maxFilePath = rel;
      }
    }
  }
  return { files, bytes, maxFileBytes, maxFilePath };
}

function renderTemplate(raw, vars) {
  return raw.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

// 1. Reset staging and build the HTML panel and embedded backend server -------
run(process.execPath, [join(root, "scripts", "build-plugin-panel.mjs"), "--dist"]);

// 2. Copy non-test worker sources and listing assets. The worker is already
// TypeScript in dev; the production host supports the same entrypoint.
const srcDir = join(pluginDir, dirname(manifest.main));
if (existsSync(srcDir)) {
  const outSrcDir = join(outDir, dirname(manifest.main));
  mkdirSync(outSrcDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.mts")) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".mts")) continue;
    cpSync(join(srcDir, entry.name), join(outSrcDir, entry.name));
  }
}

const assetsDir = join(pluginDir, "assets");
if (existsSync(assetsDir)) {
  cpSync(assetsDir, join(outDir, "assets"), { recursive: true, dereference: false });
}

// 3. Emit production manifest + standalone README + icon + LICENSE ------------
const prodManifest = {
  ...manifest,
  version,
};
writeFileSync(join(outDir, "orca-plugin.json"), JSON.stringify(prodManifest, null, 2) + "\n");

if (existsSync(join(pluginDir, "icon.png"))) {
  cpSync(join(pluginDir, "icon.png"), join(outDir, "icon.png"));
}
const distReadmePath = join(pluginDir, "DIST_README.md");
if (existsSync(distReadmePath)) {
  const rendered = renderTemplate(readFileSync(distReadmePath, "utf8"), {
    PLUGIN_REPO: pluginRepo,
    VERSION: version,
  });
  if (/\{\{[A-Z0-9_]+\}\}/.test(rendered)) {
    throw new Error("Unreplaced template placeholder remains in rendered dist-plugin/README.md.");
  }
  writeFileSync(join(outDir, "README.md"), rendered);
} else if (existsSync(join(pluginDir, "README.md"))) {
  cpSync(join(pluginDir, "README.md"), join(outDir, "README.md"));
}
if (existsSync(join(root, "LICENSE"))) {
  cpSync(join(root, "LICENSE"), join(outDir, "LICENSE"));
}

// 4. Enforce required files, Orca archive limits, and our release size budget.
const requiredPaths = [
  "orca-plugin.json",
  prodManifest.main,
  "server/index.mjs",
  "server/skill/SKILL.md",
  "panel/index.html",
  "README.md",
  "LICENSE",
  "icon.png",
  ...(prodManifest.cover?.path ? [prodManifest.cover.path] : []),
  ...(Array.isArray(prodManifest.screenshots)
    ? prodManifest.screenshots.map((s) => s?.path).filter(Boolean)
    : []),
];
for (const rel of requiredPaths) {
  const target = join(outDir, rel);
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`Missing required file in dist-plugin: ${rel}`);
  }
}

const { files, bytes, maxFileBytes, maxFilePath } = inspectAndMeasureTree(outDir);
if (files > MAX_PLUGIN_FILES) {
  throw new Error(`dist-plugin has ${files} files, exceeding Orca's ${MAX_PLUGIN_FILES}-file limit.`);
}
if (bytes > MAX_PLUGIN_BYTES) {
  throw new Error(`dist-plugin is ${bytes} bytes, exceeding Orca's ${MAX_PLUGIN_BYTES}-byte limit.`);
}
if (bytes > PLUGIN_SIZE_BUDGET) {
  throw new Error(`dist-plugin is ${bytes} bytes, exceeding the local ${PLUGIN_SIZE_BUDGET}-byte release budget.`);
}
if (maxFileBytes > PLUGIN_FILE_SIZE_BUDGET) {
  throw new Error(
    `dist-plugin/${maxFilePath} is ${maxFileBytes} bytes, exceeding the local ${PLUGIN_FILE_SIZE_BUDGET}-byte per-file budget.`,
  );
}

const kb = (bytes / 1024).toFixed(1);
const maxKb = (maxFileBytes / 1024).toFixed(1);
console.log(`\n✅ Staged Orca plugin → dist-plugin/ (id=${prodManifest.id}, version=${version}, repo=${pluginRepo})`);
console.log(`   Payload size: ${files} files, ${kb} KiB (local budget: ${PLUGIN_SIZE_BUDGET / 1024} KiB)`);
console.log(`   Max file:     ${maxKb} KiB (${maxFilePath}; per-file budget: ${PLUGIN_FILE_SIZE_BUDGET / 1024} KiB)`);
console.log(`   Validate:     orca-ide plugin validate ./dist-plugin --json`);
console.log(`   Inspect:      orca-ide plugin inspect ./dist-plugin --json`);
