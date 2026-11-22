#!/usr/bin/env node
/**
 * Build local dev assets inside `plugin/` so Orca can run the plugin completely
 * self-contained (zero manual terminal required):
 *   1. `plugin/panel/`         — Vite SPA with relative paths (`VITE_BASE=./`)
 *   2. `plugin/server/index.mjs` — esbuild zero-dep bundle of `server/src/index.ts`
 *      spawned lazily by `plugin/src/worker.ts` when no external viewer runs.
 * Pass --dist to build the same assets in a fresh `dist-plugin/` staging tree.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { stageSkill } from "./stage-skill.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "web");
const stageDist = process.argv[2] === "--dist";
const outputRoot = join(root, stageDist ? "dist-plugin" : "plugin");
const panelOutDir = join(outputRoot, "panel");
const serverOutDir = join(outputRoot, "server");

function assertDirectory(dir, missingOk = false) {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat?.isDirectory()) return true;
  if (!stat && missingOk) return false;
  throw new Error(`Expected a real directory (not a symbolic link): ${dir}`);
}

function checkPublicAssets(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      checkPublicAssets(path);
    } else if (!entry.isFile()) {
      throw new Error(`Expected a regular public asset (not a symbolic link): ${path}`);
    }
  }
}

assertDirectory(outputRoot, stageDist);
assertDirectory(panelOutDir, true);
assertDirectory(serverOutDir, true);
assertDirectory(webDir);
const publicDir = join(webDir, "public");
// Vite follows links when copying public assets. Check the entire tree first.
if (assertDirectory(publicDir, true)) checkPublicAssets(publicDir);

const viteBin = [webDir, root]
  .map((dir) => join(dir, "node_modules", "vite", "bin", "vite.js"))
  .find((bin) => existsSync(bin));
if (!viteBin) {
  throw new Error("Local Vite installation not found. Run npm ci from the repository root.");
}

// Start with a fresh panel so Vite never clears or writes through old entries.
rmSync(stageDist ? outputRoot : panelOutDir, { recursive: true, force: true });
execFileSync(process.execPath, [viteBin, "build", "--outDir", panelOutDir], {
  cwd: webDir,
  stdio: "inherit",
  env: { ...process.env, VITE_BASE: "./" },
});
const panelEntry = join(panelOutDir, "index.html");
if (!existsSync(panelEntry)) throw new Error(`Vite build produced no ${panelEntry}`);

if (!stageDist) rmSync(serverOutDir, { recursive: true, force: true });
mkdirSync(serverOutDir, { recursive: true });

// Keep the embedded loopback server readable (unminified) and well under 1 MiB
// per file by replacing two large transitive Express lookup tables that the
// local UTF-8 JSON / SPA server does not need:
//   - `iconv-lite` (~490 KiB of legacy encodings pulled in by body-parser/raw-body)
//   - `mime-db` + `mime/types.json` (~166 KiB of exotic extensions pulled in by express/send)
const CURATED_MIME_TYPES = {
  "text/html": ["html", "htm"],
  "text/css": ["css"],
  "application/javascript": ["js", "mjs"],
  "text/javascript": ["js", "mjs"],
  "application/json": ["json", "map"],
  "text/plain": ["txt", "log"],
  "text/markdown": ["md"],
  "text/csv": ["csv"],
  "text/event-stream": [],
  "image/svg+xml": ["svg"],
  "image/png": ["png"],
  "image/jpeg": ["jpeg", "jpg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "image/avif": ["avif"],
  "image/x-icon": ["ico"],
  "font/woff": ["woff"],
  "font/woff2": ["woff2"],
  "application/xml": ["xml"],
  "application/wasm": ["wasm"],
  "application/octet-stream": ["bin"],
  "application/x-www-form-urlencoded": [],
  "multipart/form-data": [],
};

const CURATED_MIME_DB = Object.fromEntries(
  Object.entries(CURATED_MIME_TYPES).map(([type, extensions]) => {
    const entry = {};
    if (extensions.length) entry.extensions = extensions;
    if (
      type.startsWith("text/") ||
      type.includes("json") ||
      type.includes("javascript") ||
      type.includes("xml")
    ) {
      entry.charset = "UTF-8";
      entry.compressible = true;
    }
    return [type, entry];
  }),
);

const ICONV_UTF8_SHIM = `
const { StringDecoder } = require("node:string_decoder");

function normalizeEncoding(encoding) {
  const key = String(encoding || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key === "utf8") return "utf8";
  if (key === "ascii") return "ascii";
  if (key === "latin1" || key === "iso88591" || key === "binary") return "latin1";
  if (key === "utf16le" || key === "ucs2") return "utf16le";
  return null;
}

exports.encodingExists = function encodingExists(encoding) {
  return normalizeEncoding(encoding) !== null;
};

exports.getDecoder = function getDecoder(encoding, options) {
  const normalized = normalizeEncoding(encoding);
  if (!normalized) {
    // Prefix matches raw-body's ICONV_ENCODING_MESSAGE_REGEXP for HTTP 415.
    throw new Error("Encoding not recognized: '" + encoding + "' (searched as: '" + encoding + "')");
  }
  const decoder = new StringDecoder(normalized);
  let stripBom = normalized === "utf8" && !(options && options.stripBOM === false);
  return {
    write(chunk) {
      let out = decoder.write(chunk);
      if (stripBom && out.length > 0) {
        stripBom = false;
        if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
      }
      return out;
    },
    end() {
      let out = decoder.end();
      if (stripBom && out.length > 0) {
        stripBom = false;
        if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
      }
      return out;
    },
  };
};

exports.decode = function decode(buf, encoding, options) {
  const decoder = exports.getDecoder(encoding, options);
  const input = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return decoder.write(input) + decoder.end();
};
`.trimStart();

const slimServerPlugin = {
  name: "slim-plugin-server",
  setup(esbuild) {
    esbuild.onResolve({ filter: /^iconv-lite$/ }, () => ({
      path: "iconv-lite",
      namespace: "orca-plugin-shim",
    }));
    esbuild.onResolve({ filter: /^mime-db$/ }, () => ({
      path: "mime-db",
      namespace: "orca-plugin-shim",
    }));
    esbuild.onResolve({ filter: /^\.\/types\.json$/ }, (args) => {
      if (/[\\/]mime[\\/]/.test(args.importer)) {
        return { path: "mime-types-json", namespace: "orca-plugin-shim" };
      }
      return null;
    });
    esbuild.onLoad({ filter: /^iconv-lite$/, namespace: "orca-plugin-shim" }, () => ({
      contents: ICONV_UTF8_SHIM,
      loader: "js",
    }));
    esbuild.onLoad({ filter: /^mime-db$/, namespace: "orca-plugin-shim" }, () => ({
      contents: JSON.stringify(CURATED_MIME_DB),
      loader: "json",
    }));
    esbuild.onLoad({ filter: /^mime-types-json$/, namespace: "orca-plugin-shim" }, () => ({
      contents: JSON.stringify(CURATED_MIME_TYPES),
      loader: "json",
    }));
  },
};

await build({
  entryPoints: [join(root, "server", "src", "index.ts")],
  outdir: serverOutDir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  platform: "node",
  target: "node22",
  format: "esm",
  legalComments: "none",
  tsconfig: join(root, "server", "tsconfig.json"),
  external: ["./generated/webAssets"],
  banner: {
    js: `import{createRequire as __cr}from "node:module";const require=__cr(import.meta.url);`,
  },
  plugins: [slimServerPlugin],
});
stageSkill(join(root, "skill"), join(serverOutDir, "skill"));
