#!/usr/bin/env node
/**
 * Assembles the payload tree that inno-setup/setup.iss packages, and verifies it.
 *
 * Why this exists: the repository is source-only (.gitignore excludes **\/bin/
 * and **\/obj/), so the installer can never be built from a checkout. The thing
 * that actually runs is a *distribution* tree — ~510 DLLs plus Metamod's stubs
 * and a packed botprofile.vpk — most of which is third-party and none of which is
 * compiled here. Rebuilding every one of those is neither necessary nor possible
 * (the four native plugins have no source in this repository at all).
 *
 * So the practical flow is: take an existing distribution tree as the base, then
 * overlay the DLLs you actually rebuilt. That is what this script does, and then
 * it refuses to hand over a tree that is missing anything CS2 needs to start.
 *
 *   node inno-setup/tools/assemble-payload.mjs \
 *     --base "D:\build\CS2BotImprover" --out inno-setup\payload \
 *     --panel "D:\build\Panel.exe"
 *
 * The same overlay logic also drives --deploy, which pushes the rebuilt DLLs
 * straight into a live game install instead of into a package. That is the
 * fast loop while developing:
 *
 *   node inno-setup/tools/assemble-payload.mjs --write-solution addons\plugins.slnx
 *   dotnet build addons\plugins.slnx -c Release        (or build in Visual Studio)
 *   node inno-setup/tools/assemble-payload.mjs --deploy
 *
 * Options
 *   --base <dir>     Distribution tree to start from: the extracted contents of
 *                    the official CS2BotImprover.zip. Must contain gameinfo.gi.
 *   --out <dir>      Where to write the payload. Default: inno-setup/payload.
 *                    Wiped first, so the result never carries stale files.
 *   --panel <exe>    Packaged Panel application, published as Panel.exe.
 *   --deploy         Copy the rebuilt assemblies straight into a CS2 install
 *                    instead of assembling a payload. Adds and updates, and
 *                    withdraws only files an earlier deploy of its own wrote that
 *                    this build no longer contains — it can never take a working
 *                    install apart. Use it with --build for a one-command loop.
 *   --game <dir>     Game folder to deploy into: …\game\csgo (either that or the
 *                    CS2 root, or a Steam library). Auto-detected from the
 *                    registry, libraryfolders.vdf and the usual drive layouts
 *                    when omitted. Detection is not read-only: with a real CS2
 *                    install present, `--deploy` without --game writes to it.
 *                    Add --dry-run to look without touching anything.
 *   --dry-run        Report what --deploy would copy, update and withdraw, then
 *                    stop without writing. Works with --deploy only.
 *   --build          Run `dotnet build -c Release` over every buildable project
 *                    before collecting. Without it, existing bin/Release output
 *                    is collected, which is what you want after building in VS.
 *                    Also stages the missing libs/ references first. Works
 *                    without --base, in which case it just compiles and stops.
 *   --stage-references
 *                    Only stage the libs/ references described below, then stop.
 *                    Run this once before building in Visual Studio.
 *   --fix-references
 *                    Repair <ProjectReference> entries that point at a folder that
 *                    does not exist, by pointing them at where the project really
 *                    lives. Opt-in, because it edits source files. See the note in
 *                    checkReferences() for why this is not done automatically.
 *   --write-solution <path>
 *                    Write a .slnx listing exactly the projects the package needs,
 *                    for building in Visual Studio.
 *   --no-pdb         Drop the .pdb debug symbols (~13 files, several MB).
 *   --verify-only    Check <out> instead of assembling. Exits non-zero when the
 *                    payload is incomplete or a plugin folder is missing from
 *                    [InstallDelete], so it works as a CI gate.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SETUP_ISS = join(REPO_ROOT, "inno-setup", "setup.iss");
const ADDONS = join(REPO_ROOT, "addons");

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {
    out: join(REPO_ROOT, "inno-setup", "payload"),
    build: false,
    noPdb: false,
    verifyOnly: false,
    stageReferences: false,
    fixReferences: false,
    deploy: false,
    dryRun: false,
  };
  const takesValue = {
    "--base": "base",
    "--out": "out",
    "--panel": "panel",
    "--write-solution": "writeSolution",
    "--game": "game",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg in takesValue) {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      out[takesValue[arg]] = value;
    } else if (arg === "--build") out.build = true;
    else if (arg === "--no-pdb") out.noPdb = true;
    else if (arg === "--verify-only") out.verifyOnly = true;
    else if (arg === "--stage-references") out.stageReferences = true;
    else if (arg === "--fix-references") out.fixReferences = true;
    else if (arg === "--deploy") out.deploy = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else fail(`unknown option: ${arg}`);
  }
  return out;
}

function fail(message) {
  console.error(`\n  error: ${message}\n`);
  process.exit(2);
}

// ------------------------------------------------- the required-file list

/**
 * Reads the required-file list straight out of setup.iss rather than keeping a
 * second copy here — the two would drift, and a drifted list is exactly how a
 * broken package ships.
 */
function readRequiredFiles() {
  const iss = readFileSync(SETUP_ISS, "utf8");
  const found = [...iss.matchAll(/^#expr\s+NeedPayload\("([^"]+)"\)/gm)].map((m) =>
    m[1].replace(/\\/g, "/")
  );
  if (found.length === 0)
    fail(`no NeedPayload() checks found in ${SETUP_ISS} — was the guard removed?`);
  return found;
}

// -------------------------------------------------------- project discovery

function walk(dir, predicate, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // bin/ and obj/ hold build output, never sources. disabled/ is Linux-only
      // material plus a project pointing at the original author's machine.
      if (entry.name === "bin" || entry.name === "obj" || entry.name === "disabled") continue;
      walk(full, predicate, acc);
    } else if (predicate(full)) {
      acc.push(full);
    }
  }
  return acc;
}

function xmlValue(xml, tag) {
  const m = new RegExp(`<${tag}>\\s*([^<\\s]+)\\s*</${tag}>`, "i").exec(xml);
  return m ? m[1] : null;
}

/** First file with this name anywhere under root, or null. */
function findInTree(root, filename) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === filename.toLowerCase()) return full;
    }
  }
  return null;
}

/**
 * Some projects reference a prebuilt assembly through <HintPath>libs/…</HintPath>,
 * and that libs folder has never been committed. BotAimImprover is one project
 * that genuinely uses such an API (`using RayTraceAPI;`), so without this it cannot
 * be compiled at all — the compiler does stop rather than emit a broken assembly.
 *
 * The assemblies themselves ship in the distribution (shared\…), so stage a copy
 * where the HintPath expects it. That keeps the binary out of the repository — it
 * is a build-time input, not source.
 *
 * <ProjectReference> entries are only *reported*, never rewritten: where a shared
 * API's source belongs is an architectural decision, not a build fix. A stale
 * reference otherwise surfaces as a wall of CS0246 lines from the compiler.
 */
function checkReferences(projects, baseDir, opts = {}) {
  const staged = [];
  const unresolved = [];
  const brokenProjectRefs = [];

  for (const p of projects) {
    const xml = readFileSync(p.csproj, "utf8");

    for (const m of xml.matchAll(/<HintPath>\s*([^<]+?)\s*<\/HintPath>/g)) {
      const hint = m[1];
      // Absolute and UNC paths are the author's machine, not ours — leave them be.
      if (!hint || /^[A-Za-z]:/.test(hint) || hint.startsWith("\\\\")) continue;

      const target = resolve(p.dir, hint.replace(/\\/g, "/"));
      if (existsSync(target)) continue;
      // Without a base tree there is nothing to stage from.
      if (!baseDir) continue;

      const want = basename(target);
      const found = findInTree(baseDir, want);
      if (!found) {
        unresolved.push({ project: p.destRel, hint, want });
        continue;
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(found, target);
      }
      staged.push({ project: p.destRel, hint, from: found });
    }

    for (const m of xml.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
      const include = m[1];
      const target = resolve(p.dir, include.replace(/\\/g, "/"));
      if (existsSync(target)) continue;

      // Look for the project elsewhere in the repository, so the report can say
      // where it actually lives instead of just "not found".
      const want = basename(target);
      const actual = walk(ADDONS, (f) => basename(f) === want)[0] ?? null;
      brokenProjectRefs.push({
        csproj: p.csproj,
        project: p.destRel,
        include,
        want,
        actual: actual ? actual.slice(REPO_ROOT.length + 1) : null,
        suggestion: actual ? relative(p.dir, actual).replace(/\\/g, "/") : null,
      });
    }
  }

  return { staged, unresolved, brokenProjectRefs };
}

/**
 * Rewrites each broken <ProjectReference Include="…"> to where the project really
 * lives. Only ever called behind --fix-references: the reference is edited in the
 * user's source tree, so it stays their decision. The replacement is derived from
 * the actual location rather than a hardcoded path, which is the only definition
 * that can work in this checkout.
 */
function applyProjectRefFixes(brokenProjectRefs) {
  const applied = [];
  for (const b of brokenProjectRefs) {
    if (!b.suggestion) continue;
    const xml = readFileSync(b.csproj, "utf8");
    const from = `Include="${b.include}"`;
    if (!xml.includes(from)) continue;
    writeFileSync(b.csproj, xml.replace(from, `Include="${b.suggestion}"`), "utf8");
    applied.push({
      csprojRel: b.csproj.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"),
      project: b.project,
      from: b.include,
      to: b.suggestion,
    });
  }
  return applied;
}

/**
 * Every project that CounterStrikeSharp could load, paired with where its build
 * output belongs.
 *
 * Only projects living in a real plugin location are considered — the two folders
 * CSS scans. A scratch project elsewhere under addons\ (someone's build workspace,
 * for instance) is not part of the distribution and must never be overlaid into it.
 *
 * Within those folders a project is packaged only when its assembly name matches
 * its folder name. That is not an arbitrary rule: CSS resolves a plugin at
 * plugins/<Name>/<Name>.dll, so a helper assembly living in the same folder
 * (BotAI/Common.csproj) must not be copied alongside it.
 */
const PLUGIN_CONTAINERS = [
  "addons/counterstrikesharp/plugins/",
  "addons/counterstrikesharp/shared/",
];

function readProjects() {
  const projects = [];
  for (const csproj of walk(ADDONS, (f) => f.endsWith(".csproj"))) {
    const xml = readFileSync(csproj, "utf8");
    const dir = dirname(csproj);
    const folder = basename(dir);
    const name = xmlValue(xml, "AssemblyName") ?? basename(csproj, ".csproj");
    const tfm = xmlValue(xml, "TargetFramework");
    const destRel = dir.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
    const inPluginContainer = PLUGIN_CONTAINERS.some((c) => `${destRel}/`.startsWith(c));

    let packaged = true;
    let reason = "";
    if (!inPluginContainer) {
      packaged = false;
      reason = "not under counterstrikesharp/plugins or /shared — not a loadable plugin";
    } else if (name !== folder) {
      packaged = false;
      reason = `assembly name "${name}" does not match folder "${folder}"`;
    }

    projects.push({
      csproj,
      dir,
      destRel,
      name,
      tfm,
      // A few projects set this to false, which drops the framework from the
      // output path entirely (bin/Release/ instead of bin/Release/net10.0/).
      appendTfm: !/AppendTargetFrameworkToOutputPath>\s*false\s*</i.test(xml),
      packaged,
      reason,
    });
  }
  return projects.sort((a, b) => a.csproj.localeCompare(b.csproj));
}

/**
 * Where a project's build output actually landed. Prefers the framework-specific
 * folder but falls back to the plain one, so a project that sets
 * AppendTargetFrameworkToOutputPath=false is not silently reported as unbuilt.
 */
function findOutputDir(project) {
  const candidates = [];
  if (project.appendTfm && project.tfm) candidates.push(join(project.dir, "bin", "Release", project.tfm));
  candidates.push(join(project.dir, "bin", "Release"));
  for (const dir of candidates) {
    if (existsSync(join(dir, `${project.name}.dll`))) return dir;
  }
  return candidates[0];
}

/**
 * Where every rebuilt assembly has to land, as paths *relative to the tree root*.
 *
 * One function serves both the payload and a live game install, because both are
 * laid out as addons\counterstrikesharp\plugins\<Name>\<Name>.dll. Keeping the two
 * paths from being computed separately is the point: the deploy loop and the
 * release loop must not be able to disagree about where a plugin goes.
 *
 * A project can also emit a mirrored layout *below* its output root. BotHiderImpl
 * does exactly that: a custom MSBuild target copies 0Harmony.dll into
 * shared\0Harmony\, so the built tree carries the Harmony assembly next to the
 * plugin. Such sub-paths are relative to CounterStrikeSharp's install root
 * (addons\counterstrikesharp\), NOT to the project folder or its plugins\ /
 * shared\ container — getting that one level wrong creates a bogus plugins\shared\.
 * Missing them at all would ship a stale Harmony after a Lib.Harmony bump, since
 * nothing else ever refreshes that file.
 */
function builtFileMappings(projects, opts = {}) {
  const mappings = [];
  const notBuilt = [];
  const skipped = [];

  for (const p of projects) {
    if (!p.packaged) {
      skipped.push(p);
      continue;
    }
    if (!p.tfm) {
      notBuilt.push({ p, why: "no <TargetFramework>" });
      continue;
    }

    const binDir = findOutputDir(p);
    if (!existsSync(join(binDir, `${p.name}.dll`))) {
      notBuilt.push({ p, why: `no ${p.name}.dll under bin/Release/` });
      continue;
    }

    const wanted = [`${p.name}.dll`];
    if (existsSync(join(binDir, `${p.name}.deps.json`))) wanted.push(`${p.name}.deps.json`);
    if (!opts.noPdb && existsSync(join(binDir, `${p.name}.pdb`))) wanted.push(`${p.name}.pdb`);
    for (const f of wanted) {
      mappings.push({ from: join(binDir, f), rel: `${p.destRel}/${f}` });
    }

    const matched = PLUGIN_CONTAINERS.find((c) => `${p.destRel}/`.startsWith(c));
    if (matched) {
      const containerDir = matched.replace(/\/[^/]+\/$/, "");
      for (const rel of listRelativePaths(binDir)) {
        if (!rel.includes("/")) continue; // root files are handled above
        mappings.push({ from: join(binDir, rel), rel: `${containerDir}/${rel}` });
      }
    }
  }

  return { mappings, notBuilt, skipped };
}

// ------------------------------------------------------------------ helpers

function listFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** Paths of every file under root, relative to it, using forward slashes. */
function listRelativePaths(root, acc = [], prefix = "") {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listRelativePaths(join(root, entry.name), acc, rel);
    else acc.push(rel);
  }
  return acc;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The paths setup.iss clears at the start of an install. Inno does not remove files
 * a previous version left behind (verified), and CounterStrikeSharp loads every
 * folder under plugins\, so a plugin the list forgets would still be loaded next to
 * the new build after an upgrade.
 */
function readInstallDeleteTargets() {
  const iss = readFileSync(SETUP_ISS, "utf8");
  const section = /\[InstallDelete\]([\s\S]*?)(?=\n\[|$)/.exec(iss);
  if (!section) return [];
  return [...section[1].matchAll(/Name:\s*"\{app\}\\([^"]+)"/g)].map((m) =>
    m[1].replace(/\\+$/, "").replace(/\\/g, "/")
  );
}

/** Payload plugin/API folders that no [InstallDelete] entry covers. */
function findUncoveredPluginDirs(payloadDir) {
  const declared = new Set(readInstallDeleteTargets());
  const containers = [
    "addons/counterstrikesharp/plugins",
    "addons/counterstrikesharp/shared",
  ];
  const uncovered = [];
  for (const container of containers) {
    let entries;
    try {
      entries = readdirSync(join(payloadDir, container), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = `${container}/${entry.name}`;
      if (!declared.has(rel)) uncovered.push(rel);
    }
  }
  return uncovered;
}

/**
 * Writes a Visual Studio solution listing exactly the projects that belong in the
 * build. Handy because the set is easy to get wrong by hand: a missed project keeps
 * the base tree's old assembly in the package, and adding Common.csproj or anything
 * under disabled/ makes the build fail for unrelated reasons.
 */
function writeSolution(outFile, projects) {
  const abs = resolve(outFile);
  mkdirSync(dirname(abs), { recursive: true });
  const lines = ["<Solution>"];
  for (const p of projects) {
    const relPath = relative(dirname(abs), p.csproj).replace(/\\/g, "/");
    lines.push(`  <Project Path="${relPath}" />`);
  }
  lines.push("</Solution>");
  writeFileSync(abs, `${lines.join("\n")}\n`, "utf8");
  return abs;
}

// ------------------------------------------------ remembering what we deployed

/**
 * A dev deploy has to be able to take back what a *previous* dev deploy put there.
 *
 * CounterStrikeSharp loads every folder under plugins\, so a plugin a teammate
 * deleted or renamed keeps loading from the game otherwise — the same problem
 * [InstallDelete] solves for an upgrade, on the path that has no installer.
 *
 * There is no way to infer this from the disk: a plugin folder in the game cannot
 * be told apart from a vendored one (RayTraceImpl ships in the package and has no
 * source in this repository). So the record has to be one we write ourselves. It
 * is keyed by game folder, stores a hash per file, and is used for nothing but
 * removing files this tool wrote.
 */
const DEPLOY_STATE = join(REPO_ROOT, "inno-setup", ".deploy-state.json");

function readDeployState() {
  try {
    const parsed = JSON.parse(readFileSync(DEPLOY_STATE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // absent or unreadable — simply nothing was deployed yet
  }
}

function writeDeployState(state) {
  writeFileSync(DEPLOY_STATE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function hashOf(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const DEPLOY_ROOTS = [
  "addons",
  "addons/counterstrikesharp",
  "addons/counterstrikesharp/plugins",
  "addons/counterstrikesharp/shared",
];

/** Deletes a file and then any directories it leaves empty, up to a root. */
function removeAndPrune(gameDir, rel) {
  rmSync(join(gameDir, rel), { force: true });
  let dir = dirname(rel).replace(/\\/g, "/");
  while (dir !== "." && !DEPLOY_ROOTS.includes(dir)) {
    const full = join(gameDir, dir);
    let empty = false;
    try {
      empty = readdirSync(full).length === 0;
    } catch {
      break;
    }
    if (!empty) break;
    rmSync(full, { recursive: true, force: true });
    dir = dirname(dir).replace(/\\/g, "/");
  }
}

// ------------------------------------------------- locating a game install

function regValue(key, name) {
  try {
    const out = execFileSync("reg", ["query", key, "/v", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /REG_(?:SZ|EXPAND_SZ)\s+(.+)/i.exec(out);
    return m ? m[1].trim() : null;
  } catch {
    return null; // key absent — normal on machines where Steam was moved
  }
}

/** Every Steam library folder we can find, without walking disconnected drives. */
function steamLibraries() {
  const roots = new Set();
  for (const [key, name] of [
    ["HKCU\\Software\\Valve\\Steam", "SteamPath"],
    ["HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"],
    ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"],
  ]) {
    const value = regValue(key, name);
    if (value) roots.add(value.replace(/\//g, "\\"));
  }

  // Conventional install locations. A missing drive answers instantly, and this
  // is what still works when the registry has no Steam key at all.
  for (const drive of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    for (const sub of ["Steam", "Program Files (x86)\\Steam", "Program Files\\Steam"]) {
      const root = `${drive}:\\${sub}`;
      if (existsSync(join(root, "steamapps"))) roots.add(root);
    }
  }

  const libraries = new Set();
  for (const root of roots) {
    libraries.add(root);
    let text;
    try {
      text = readFileSync(join(root, "steamapps", "libraryfolders.vdf"), "utf8");
    } catch {
      continue;
    }
    // libraryfolders.vdf is the authoritative list — one readable copy covers
    // games installed on every other drive, which is why we never have to scan
    // for them ourselves.
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*"path"\s*"([^"]+)"/i.exec(line);
      if (m) libraries.add(m[1].replace(/\\\\/g, "\\"));
    }
  }

  for (const drive of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (existsSync(join(`${drive}:\\SteamLibrary`, "steamapps"))) libraries.add(`${drive}:\\SteamLibrary`);
  }
  return [...libraries];
}

const CS2_REL = join("steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo");

/**
 * The game\csgo folder to deploy into. Accepts that folder, the CS2 install root,
 * or the Steam library holding it; otherwise tries every library we know about.
 * Returns null rather than guessing, so the caller can ask for --game.
 */
function resolveGameCsgoDir(explicit) {
  const isCsgo = (dir) => existsSync(join(dir, "gameinfo.gi")) || existsSync(join(dir, "steam.inf"));
  if (explicit) {
    const p = resolve(explicit);
    for (const candidate of [p, join(p, CS2_REL), join(p, "game", "csgo")]) {
      if (isCsgo(candidate)) return candidate;
    }
    return null;
  }
  for (const library of steamLibraries()) {
    const candidate = join(library, CS2_REL);
    if (isCsgo(candidate)) return candidate;
  }
  return null;
}

function isCs2Running() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq cs2.exe"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /cs2\.exe/i.test(out);
  } catch {
    return false;
  }
}

/**
 * Adds and updates, and withdraws only what an earlier run of this wrote.
 *
 * With opts.dryRun it classifies every file but writes nothing — which is the only
 * way to ask "where would this land, and what would change?" without touching an
 * install. Auto-detection makes that easy to get wrong: `--deploy` on a machine
 * with a real CS2 install writes to it, so a command run to inspect detection is
 * itself a mutation unless it says otherwise.
 */
function deployMappings(mappings, gameDir, opts = {}) {
  const changed = [];
  let identical = 0;
  let created = 0;

  for (const m of mappings) {
    const dest = join(gameDir, m.rel);
    const src = readFileSync(m.from);
    if (existsSync(dest) && readFileSync(dest).equals(src)) {
      identical++;
      continue;
    }
    if (!existsSync(dest)) created++;
    if (!opts.dryRun) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, src);
    }
    changed.push(m.rel.replace(/\//g, "\\"));
  }
  return { changed, identical, created };
}

// --------------------------------------------- CounterStrikeSharp.API drift

/**
 * The API version a plugin is compiled against must not be *newer* than the one
 * the runtime provides.
 *
 * CounterStrikeSharp loads plugins into a context where CounterStrikeSharp.API is
 * supplied by the installed runtime, and .NET Core resolves a reference up to
 * whichever version is present rather than demanding an exact match. So:
 *
 *   pin older than runtime  → resolves up, normally fine. It breaks only if a
 *                            member the plugin actually calls was removed.
 *   pin newer than runtime  → the plugin calls members that do not exist in the
 *                            runtime's assembly. Hard failure at load:
 *                            MissingMethodException / MissingFieldException.
 *   pin "*"                 → a fresh restore picks the newest published version,
 *                            which is exactly how the fatal direction happens
 *                            without anyone editing a file.
 *
 * The ground truth is readable as plain text: the runtime's own
 * api\CounterStrikeSharp.API.deps.json declares "CounterStrikeSharp.API/1.0.373".
 */
function apiVersionFromTree(treeRoot) {
  const deps = join(treeRoot, "addons", "counterstrikesharp", "api", "CounterStrikeSharp.API.deps.json");
  let text;
  try {
    text = readFileSync(deps, "utf8");
  } catch {
    return null;
  }
  return /"CounterStrikeSharp\.API\/([0-9][^"]*)"/.exec(text)?.[1] ?? null;
}

function readApiPins(projects) {
  const pins = [];
  for (const p of projects) {
    const xml = readFileSync(p.csproj, "utf8");
    for (const tag of xml.matchAll(/<PackageReference\b[^>]*>/gi)) {
      if (!/CounterStrikeSharp\.API/.test(tag[0])) continue;
      pins.push({ project: p.destRel, version: /Version="([^"]*)"/i.exec(tag[0])?.[1] ?? null });
    }
  }
  return pins;
}

function versionParts(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function reportApiDrift(projects, treeRoot, where) {
  const runtime = apiVersionFromTree(treeRoot);
  const pins = readApiPins(projects);
  if (pins.length === 0) return;

  const runtimeParts = versionParts(runtime);
  const floating = pins.filter((p) => !versionParts(p.version));
  const newer = [];
  const older = [];
  if (runtimeParts) {
    for (const p of pins) {
      const parts = versionParts(p.version);
      if (!parts) continue;
      for (let i = 0; i < 3; i++) {
        if (parts[i] !== runtimeParts[i]) {
          (parts[i] < runtimeParts[i] ? older : newer).push(p);
          break;
        }
      }
    }
  }

  console.log(
    `  css api      ${runtime ? `${runtime} (${where})` : "not found"} — ${pins.length} PackageReference pins`
  );

  if (newer.length > 0) {
    console.log(`\n  WARNING — ${newer.length} pin(s) are NEWER than the runtime's ${runtime}. That is`);
    console.log("  the fatal direction: the plugin will call members the runtime's assembly");
    console.log("  does not have, and fail at load with MissingMethodException.");
    for (const p of newer) console.log(`    ${p.project}  (${p.version})`);
  }
  if (floating.length > 0) {
    console.log(`\n  WARNING — ${floating.length} pin(s) are floating, so a fresh \`dotnet restore\` can`);
    console.log(`  resolve a version newer than the runtime's ${runtime}. Nothing has to change in the`);
    console.log("  tree for that to happen; it is how the failure above appears by itself.");
    for (const p of floating) console.log(`    ${p.project}  (Version="${p.version}")`);
    console.log(`  Pin them to ${runtime} to make the build reproducible.`);
  }
  if (newer.length === 0 && floating.length === 0 && older.length > 0) {
    console.log(`  ${" ".repeat(13)}${older.length} pin(s) are older than the runtime; .NET Core resolves`);
    console.log(`  ${" ".repeat(13)}those up to ${runtime}, which is normally fine.`);
  }
  console.log("");
}

// -------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
if (args.dryRun && !args.deploy) fail("--dry-run only applies to --deploy");
const required = readRequiredFiles();
const outDir = resolve(args.out);

console.log(args.deploy ? "\n  CS2-Bot-Improver — deploy rebuilt plugins\n" : "\n  CS2-Bot-Improver — payload assembly\n");
console.log(`  repository   ${REPO_ROOT}`);
if (args.deploy) {
  console.log(`  destination  ${args.game ?? "(auto-detect a CS2 install)"}`);
  if (args.dryRun) console.log("  mode         DRY RUN — nothing will be written");
} else {
  console.log(`  payload out  ${outDir}`);
}
console.log(`  required     ${required.length} files (read from setup.iss)`);

// ---- verify-only -----------------------------------------------------------

if (args.verifyOnly) {
  const missing = required.filter((rel) => !existsSync(join(outDir, rel)));
  console.log(`\n  verifying ${outDir}\n`);
  if (missing.length > 0) {
    console.error(`  INCOMPLETE — ${missing.length} of ${required.length} required files missing:`);
    for (const rel of missing) console.error(`    ${rel}`);
    console.error("");
    process.exit(1);
  }
  console.log(`  OK — all ${required.length} required files present`);

  // A package whose plugins were compiled against a CounterStrikeSharp.API newer
  // than the one it ships would fail at plugin load, in game, with no build-time
  // symptom at all. Checking it here is the only chance to catch that.
  console.log("");
  reportApiDrift(readProjects(), outDir, "payload");

  const uncoveredInVerify = findUncoveredPluginDirs(outDir);
  if (uncoveredInVerify.length > 0) {
    console.error(`\n  ${uncoveredInVerify.length} plugin folder(s) missing from [InstallDelete]:`);
    for (const rel of uncoveredInVerify) console.error(`    ${rel}`);
    console.error("");
    process.exit(1);
  }
  console.log("  OK — every plugin folder is cleared before an upgrade\n");
  process.exit(0);
}

// ---- base tree -------------------------------------------------------------
// Repairing project references only needs the repository, so --fix-references
// works without a base tree — that is the whole point of running it before you
// have anything to assemble from.

let baseDir = null;
if (args.base) {
  baseDir = resolve(args.base);
  if (!existsSync(join(baseDir, "gameinfo.gi"))) {
    fail(
      `--base does not look like a distribution tree: ${baseDir}\n` +
        `         gameinfo.gi is missing. Pass the *extracted* package folder, not a checkout.`
    );
  }
} else if (!args.fixReferences && !args.writeSolution && !args.deploy && !args.build) {
  fail("--base is required (the extracted contents of the official CS2BotImprover.zip)");
}

// ---- guard against destroying the base tree --------------------------------
// The payload is wiped before it is written, and the base tree is read from. If
// the two overlap in either direction, one of those two facts deletes the other's
// input: --out equal to --base removes the tree it is about to copy from, and a
// --base inside --out is removed together with it. Both are silent data loss on a
// tree the user may not have a second copy of.

if (baseDir) {
  const overlaps = (a, b) => {
    const rel = relative(a.toLowerCase(), b.toLowerCase());
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const out = resolve(outDir);
  const base = resolve(baseDir);
  if (overlaps(out, base) || overlaps(base, out)) {
    fail(
      `--out and --base overlap, which would delete the tree being read from.\n` +
        `         out   ${out}\n` +
        `         base  ${base}\n` +
        `         Point --out somewhere else, for example the default inno-setup\\payload.`
    );
  }
}

// ---- buildable projects ----------------------------------------------------

const projects = readProjects();
const buildable = projects.filter((p) => p.packaged);

// ---- optional: write a solution for Visual Studio --------------------------

if (args.writeSolution) {
  const written = writeSolution(args.writeSolution, buildable);
  console.log(`\n  solution     ${written}`);
  console.log(`               lists ${buildable.length} projects (the ones the package needs)`);
  if (!args.build && !args.stageReferences && !args.fixReferences) {
    console.log("");
    process.exit(0);
  }
}

// ---- stage missing libs/ references, report broken project references ------

if (args.stageReferences || args.build || args.fixReferences) {
  const { staged, unresolved, brokenProjectRefs } = checkReferences(buildable, baseDir);
  console.log("");
  if (staged.length > 0) {
    console.log(`  staged ${staged.length} missing reference(s) so the projects can compile:`);
    for (const s of staged) console.log(`    ${s.hint}  (${s.project})\n      from ${s.from}`);
  } else {
    console.log("  references   nothing missing — every libs/ reference already resolves");
  }
  if (unresolved.length > 0) {
    console.log(`\n  UNRESOLVABLE (${unresolved.length}) — these projects cannot compile:`);
    for (const u of unresolved) console.log(`    ${u.hint}  (${u.project}) — ${u.want} is not in the base tree`);
  }
  if (brokenProjectRefs.length > 0) {
    console.log(`\n  BROKEN <ProjectReference> (${brokenProjectRefs.length}) — the compiler will`);
    console.log("  report this as a pile of CS0246 errors. The referenced project exists, just");
    console.log("  not where the reference points:");
    for (const b of brokenProjectRefs) {
      console.log(`\n    ${b.project}\n      points at   ${b.include}   (does not exist)`);
      if (b.actual) {
        console.log(`      actually in ${b.actual}`);
        console.log(`      fix with    <ProjectReference Include="${b.suggestion}">`);
      } else {
        console.log(`      ${b.want} was not found anywhere in the repository`);
      }
    }
    if (!args.fixReferences) {
      console.log("\n  Not rewritten automatically: the files are yours. Re-run with");
      console.log("  --fix-references to apply exactly the replacement above.");
    }
  }

  let stillBroken = brokenProjectRefs.length;
  if (args.fixReferences && brokenProjectRefs.length > 0) {
    const applied = applyProjectRefFixes(brokenProjectRefs);
    console.log(`\n  rewrote ${applied.length} <ProjectReference> entr${applied.length === 1 ? "y" : "ies"}:`);
    for (const a of applied) {
      console.log(`    ${a.csprojRel}\n      ${a.from}\n      -> ${a.to}`);
    }
    console.log("\n  This edited your source tree. To undo:");
    for (const a of applied) console.log(`    git checkout -- "${a.csprojRel}"`);
    stillBroken = brokenProjectRefs.length - applied.length;
  }

  if ((args.stageReferences || args.fixReferences) && !args.build) {
    console.log("");
    process.exit(unresolved.length > 0 || stillBroken > 0 ? 1 : 0);
  }
}

// ---- optional build --------------------------------------------------------

if (args.build) {
  console.log(`\n  building ${buildable.length} projects (dotnet build -c Release)\n`);
  const failed = [];
  for (const p of buildable) {
    const rel = p.csproj.slice(REPO_ROOT.length + 1);
    process.stdout.write(`    ${rel} ... `);
    try {
      execFileSync("dotnet", ["build", p.csproj, "-c", "Release", "--nologo", "-v", "q"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      console.log("ok");
    } catch (e) {
      console.log("FAILED");
      failed.push({ rel, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() });
    }
  }
  if (failed.length > 0) {
    console.log(`\n  ${failed.length} of ${buildable.length} projects failed:\n`);
    for (const f of failed) {
      const lines = f.output.split("\n").filter(Boolean);
      const codes = [...new Set(lines.map((l) => /error ([A-Z]+\d+)/.exec(l)?.[1]).filter(Boolean))];
      const first = lines.find((l) => l.includes("error ")) ?? lines[0] ?? "(no output)";
      console.log(`    ${f.rel}`);
      console.log(`      ${codes.length > 0 ? codes.join(", ") : "unknown error"}`);
      console.log(`      ${first.trim().slice(0, 150)}`);
    }
    console.log("\n  The payload is not assembled: a half-built tree would silently mix new");
    console.log("  and base-tree assemblies. Fix the above and re-run.\n");
    process.exit(1);
  }
}

// ---- deploy into a live game install ---------------------------------------
// Stops here: no payload is assembled and outDir is left untouched. This is the
// edit → build → see-it-in-game loop, kept separate from the release path so a
// dev push can never leave a half-built payload behind.

if (args.deploy) {
  const gameDir = resolveGameCsgoDir(args.game);
  if (!gameDir) {
    fail(
      "could not locate a Counter-Strike 2 install.\n" +
        "         Pass it explicitly, either game\\csgo or the CS2 root:\n" +
        '           --game "E:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo"'
    );
  }
  console.log(`\n  game         ${gameDir}`);

  // Without CounterStrikeSharp there is nothing to load these DLLs, and copying
  // them in would look successful while changing nothing.
  if (!existsSync(join(gameDir, "addons", "counterstrikesharp", "plugins"))) {
    fail(
      `CounterStrikeSharp is not installed in that folder.\n` +
        `         ${join(gameDir, "addons", "counterstrikesharp", "plugins")} does not exist.\n` +
        "         Deploying would create the folder and change nothing in game — the\n" +
        "         game has no plugin loader. Install the package first (run\n" +
        "         CS2-Bot-Improver-Setup.exe, or extract the official zip over this tree)."
    );
  }

  // A running game holds its plugin DLLs open; the copy would fail part-way and
  // leave a mix of old and new assemblies.
  if (isCs2Running()) {
    fail(
      "Counter-Strike 2 is running.\n" +
        "         Its plugin DLLs are locked, so a deploy would fail half-way and leave\n" +
        "         old and new assemblies side by side. Close the game first."
    );
  }

  // Which of the two modes the install is in decides whether a deploy can be seen
  // at all — and the difference is easy to mistake for a broken install. Online
  // Mode ships the *stock* gameinfo.gi on purpose: CS2 then never reads
  // addons\metamod, so Metamod, CounterStrikeSharp and every plugin stay unloaded
  // while playing on official servers. A deploy still succeeds in that state; it
  // just cannot show up in game until the mode is switched back.
  const gameInfo = join(gameDir, "gameinfo.gi");
  const loadsMod = (file) => existsSync(file) && /addons[\\/]metamod/i.test(readFileSync(file, "utf8"));
  const withBots = join(gameDir, "backup", "WithBots", "gameinfo.gi");

  if (loadsMod(gameInfo)) {
    console.log("  mode         Bot Mode — gameinfo.gi loads addons\\metamod, so rebuilt");
    console.log("               plugins are picked up on the next launch.");
  } else if (loadsMod(withBots)) {
    console.log("  mode         Online Mode — gameinfo.gi is the stock file, so CS2 does NOT");
    console.log("               load Metamod or CounterStrikeSharp. The deploy below still");
    console.log("               works, but nothing changes in game until you switch the Panel");
    console.log("               back to Bot Mode (机器人模式), which restores:");
    console.log(`                 ${withBots}`);
  } else {
    console.log("  WARNING      gameinfo.gi has no addons/metamod search path, and there is no");
    console.log("               backup\\WithBots variant to restore from. Re-run the installer");
    console.log("               (or extract the official package) to repair the install.");
  }

  reportApiDrift(projects, gameDir, "game");

  const { mappings, notBuilt } = builtFileMappings(projects, { noPdb: args.noPdb });
  if (mappings.length === 0) {
    fail(
      "nothing has been built yet — no bin/Release output to deploy.\n" +
        "         Build first:  dotnet build addons\\plugins.slnx -c Release\n" +
        "         or run this with --build."
    );
  }
  if (notBuilt.length > 0) {
    console.log(`\n  ${notBuilt.length} project(s) have no build output and will NOT be deployed:`);
    for (const { p, why } of notBuilt) console.log(`    ${p.destRel}  (${why})`);
    console.log("  Deploying now would leave those plugins at their previous version, next to");
    console.log("  freshly built ones. Build them first, or remove them from the solution.\n");
    process.exit(1);
  }

  const { changed, identical, created } = deployMappings(mappings, gameDir, { dryRun: args.dryRun });

  // Take back what a previous run of this tool put here and this build no longer
  // contains — a plugin a teammate deleted or renamed, whose DLL would otherwise
  // keep loading. Only files recorded in our own manifest are candidates, and only
  // while their content still matches what we wrote: anything edited since is
  // reported and left alone rather than thrown away.
  const state = readDeployState();
  const key = gameDir.toLowerCase();
  const previousFiles = state[key]?.files ?? {};
  const currentSet = new Set(mappings.map((m) => m.rel));
  const dropped = [];
  const edited = [];

  for (const rel of Object.keys(previousFiles)) {
    if (currentSet.has(rel)) continue;
    const dest = join(gameDir, rel);
    if (!existsSync(dest)) continue;
    if (hashOf(dest) !== previousFiles[rel]) {
      edited.push(rel);
      continue;
    }
    if (!args.dryRun) removeAndPrune(gameDir, rel);
    dropped.push(rel);
  }

  if (!args.dryRun) {
    state[key] = {
      game: gameDir,
      at: new Date().toISOString(),
      // Files edited since we wrote them stay tracked, with the hash we recorded at
      // deploy time. Dropping them would forget that this tool created them, and the
      // next run could no longer say anything about a plugin this repository has
      // removed. Keeping the stale hash is also what makes them withdrawable again if
      // the edit is ever reverted.
      files: {
        ...Object.fromEntries(mappings.map((m) => [m.rel, hashOf(m.from)])),
        ...Object.fromEntries(edited.map((rel) => [rel, previousFiles[rel]])),
      },
    };
    writeDeployState(state);
  }

  console.log(`\n  --- result ---${args.dryRun ? "   (dry run: nothing was written)" : ""}\n`);
  console.log(`  deployed     ${mappings.length} files from ${projects.filter((p) => p.packaged).length} projects`);
  console.log(`  updated      ${changed.length - created}`);
  console.log(`  added        ${created}`);
  console.log(`  unchanged    ${identical}`);
  if (changed.length > 0) {
    console.log("");
    for (const rel of changed) console.log(`    ${rel}`);
  }
  if (dropped.length > 0) {
    console.log(`\n  withdrawn    ${dropped.length} file(s) this tool deployed earlier and this`);
    console.log("               build no longer contains — otherwise CounterStrikeSharp would");
    console.log("               keep loading them:");
    for (const rel of dropped) console.log(`    ${rel.replace(/\//g, "\\")}`);
  }
  if (edited.length > 0) {
    console.log(`\n  left alone   ${edited.length} file(s) were deployed by this tool but have been`);
    console.log("               edited since, so they were NOT removed:");
    for (const rel of edited) console.log(`    ${rel.replace(/\//g, "\\")}`);
  }
  console.log(
    args.dryRun
      ? "\n  Dry run — no file was written and the deploy record was left unchanged.\n"
      : "\n  No hand-written file was touched. Start the game to pick the new build up.\n"
  );
  process.exit(0);
}

// ---- build only ------------------------------------------------------------
// --build stands on its own: it knows the project set and stages the missing
// libs/ references first, so it doubles as a smarter `dotnet build`. But there is
// nothing to assemble without a base tree, and the mirror step below needs one.

if (!baseDir) {
  console.log(`\n  ${buildable.length} projects built. No payload assembled (no --base given).\n`);
  process.exit(0);
}

// ---- mirror the base tree --------------------------------------------------

console.log(`\n  base tree    ${baseDir}`);
console.log(`  collecting   ${buildable.length} buildable projects\n`);

reportApiDrift(projects, baseDir, "base tree");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(baseDir, outDir, { recursive: true });

// ---- overlay rebuilt assemblies -------------------------------------------

const collected = builtFileMappings(projects, { noPdb: args.noPdb });
const { mappings, notBuilt, skipped } = collected;
let overlayCount = 0;

for (const m of mappings) {
  const dest = join(outDir, m.rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(m.from, dest);
  overlayCount++;
}

// ---- panel -----------------------------------------------------------------

if (args.panel) {
  const panel = resolve(args.panel);
  if (!existsSync(panel)) fail(`--panel not found: ${panel}`);
  // Published under a fixed name so an upgrade overwrites the previous build
  // instead of leaving version-stamped copies behind in the game folder.
  copyFileSync(panel, join(outDir, "Panel.exe"));
  console.log(`  panel        ${panel} -> Panel.exe`);
} else {
  console.log("  panel        not supplied (--panel); setup.iss will warn and build without it");
}

// The base tree ships the panel under its release name (Panel v1.4.4.exe). Leaving
// it next to Panel.exe would put two different Panels in one payload, with nothing
// in the package saying which one the installer prefers — so drop the others.
const strayPanels = readdirSync(outDir).filter(
  (f) => f !== "Panel.exe" && /^Panel.*\.exe$/i.test(f) && statSync(join(outDir, f)).isFile()
);
for (const f of strayPanels) {
  rmSync(join(outDir, f));
  console.log(`  removed      ${f} — dropped from the payload copy only, not from --base`);
}

// ---- verify ----------------------------------------------------------------

const missing = required.filter((rel) => !existsSync(join(outDir, rel)));
const files = listFiles(outDir);
const bytes = files.reduce((sum, f) => sum + statSync(f).size, 0);

console.log("\n  --- result ---\n");
console.log(`  files        ${files.length} (${mb(bytes)})`);
console.log(`  overlaid     ${overlayCount} files from ${buildable.length - notBuilt.length} projects`);
if (skipped.length > 0) {
  console.log(`\n  not packaged (${skipped.length}) — helper assemblies, not CSS plugins:`);
  for (const p of skipped) console.log(`    ${p.destRel}${sep}${p.name}  (${p.reason})`);
}
if (notBuilt.length > 0) {
  console.log(`\n  no output collected (${notBuilt.length}) — still at the base tree's version:`);
  for (const { p, why } of notBuilt) console.log(`    ${p.destRel}  (${why})`);
  console.log("    Build these in VS (Release), or re-run with --build.");
}

if (missing.length > 0) {
  console.error(`\n  INCOMPLETE — ${missing.length} of ${required.length} required files missing:`);
  for (const rel of missing) console.error(`    ${rel}`);
  console.error("\n  A source checkout is not a payload: the repository deliberately");
  console.error("  excludes every compiled binary. See inno-setup/README.md.\n");
  process.exit(1);
}

// A plugin folder nobody clears would survive the next upgrade and still be loaded
// by CounterStrikeSharp alongside the new build.
const uncovered = findUncoveredPluginDirs(outDir);
if (uncovered.length > 0) {
  console.log(`\n  WARNING — ${uncovered.length} plugin folder(s) missing from [InstallDelete]:`);
  for (const rel of uncovered) console.log(`    ${rel}`);
  console.log("  Add a filesandordirs entry for each in setup.iss, or an upgrade will");
  console.log("  leave that plugin behind where CounterStrikeSharp will still load it.");
}

console.log(`\n  OK — all ${required.length} required files present.`);
console.log(`  Next:  ISCC.exe ${join(REPO_ROOT, "inno-setup", "setup.iss")}\n`);
