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
 * Options
 *   --base <dir>     Distribution tree to start from: the extracted contents of
 *                    the official CS2BotImprover.zip. Must contain gameinfo.gi.
 *   --out <dir>      Where to write the payload. Default: inno-setup/payload.
 *                    Wiped first, so the result never carries stale files.
 *   --panel <exe>    Packaged Panel application, published as Panel.exe.
 *   --build          Run `dotnet build -c Release` over every buildable project
 *                    before collecting. Without it, existing bin/Release output
 *                    is collected, which is what you want after building in VS.
 *                    Also stages the missing libs/ references first.
 *   --stage-references
 *                    Only stage the libs/ references described below, then stop.
 *                    Run this once before building in Visual Studio.
 *   --no-pdb         Drop the .pdb debug symbols (~13 files, several MB).
 *   --verify-only    Check <out> instead of assembling. Useful in CI.
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
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
  };
  const takesValue = { "--base": "base", "--out": "out", "--panel": "panel" };
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
 * Every project that CounterStrikeSharp could load, paired with where its build
 * output belongs.
 *
 * A project is only packaged when its assembly name matches its folder name.
 * That is not an arbitrary rule: CSS resolves a plugin at plugins/<Name>/<Name>.dll,
 * so a helper assembly living in the same folder (BotAI/Common.csproj) must not be
 * copied alongside it.
 */
function readProjects() {
  const projects = [];
  for (const csproj of walk(ADDONS, (f) => f.endsWith(".csproj"))) {
    const xml = readFileSync(csproj, "utf8");
    const dir = dirname(csproj);
    const folder = basename(dir);
    const name = xmlValue(xml, "AssemblyName") ?? basename(csproj, ".csproj");
    const tfm = xmlValue(xml, "TargetFramework");
    projects.push({
      csproj,
      dir,
      destRel: dir.slice(REPO_ROOT.length + 1),
      name,
      tfm,
      // A few projects set this to false, which drops the framework from the
      // output path entirely (bin/Release/ instead of bin/Release/net10.0/).
      appendTfm: !/AppendTargetFrameworkToOutputPath>\s*false\s*</i.test(xml),
      packaged: name === folder,
      reason: name === folder ? "" : `assembly name "${name}" does not match folder "${folder}"`,
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

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// -------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const required = readRequiredFiles();
const outDir = resolve(args.out);

console.log("\n  CS2-Bot-Improver — payload assembly\n");
console.log(`  repository   ${REPO_ROOT}`);
console.log(`  payload out  ${outDir}`);
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
  console.log(`  OK — all ${required.length} required files present\n`);
  process.exit(0);
}

// ---- base tree -------------------------------------------------------------

if (!args.base) {
  fail("--base is required (the extracted contents of the official CS2BotImprover.zip)");
}
const baseDir = resolve(args.base);
if (!existsSync(join(baseDir, "gameinfo.gi"))) {
  fail(
    `--base does not look like a distribution tree: ${baseDir}\n` +
      `         gameinfo.gi is missing. Pass the *extracted* package folder, not a checkout.`
  );
}

// ---- buildable projects ----------------------------------------------------

const projects = readProjects();
const buildable = projects.filter((p) => p.packaged);

// ---- stage missing libs/ references, report broken project references ------

if (args.stageReferences || args.build) {
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
    console.log("\n  Not rewritten automatically: where a shared API's source belongs is a");
    console.log("  project decision, not a build fix.");
  }
  if (args.stageReferences && !args.build) {
    console.log("");
    process.exit(unresolved.length > 0 || brokenProjectRefs.length > 0 ? 1 : 0);
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

// ---- mirror the base tree --------------------------------------------------

console.log(`\n  base tree    ${baseDir}`);
console.log(`  collecting   ${buildable.length} buildable projects\n`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(baseDir, outDir, { recursive: true });

// ---- overlay rebuilt assemblies -------------------------------------------

let overlayCount = 0;
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
  const wanted = [`${p.name}.dll`];
  if (existsSync(join(binDir, `${p.name}.deps.json`))) wanted.push(`${p.name}.deps.json`);
  if (!args.noPdb && existsSync(join(binDir, `${p.name}.pdb`))) wanted.push(`${p.name}.pdb`);

  const missingFromBin = wanted.filter((f) => !existsSync(join(binDir, f)));
  if (missingFromBin.includes(`${p.name}.dll`)) {
    notBuilt.push({ p, why: `no ${p.name}.dll under bin/Release/` });
    continue;
  }

  const destDir = join(outDir, p.destRel);
  mkdirSync(destDir, { recursive: true });
  for (const f of wanted) {
    if (existsSync(join(binDir, f))) {
      copyFileSync(join(binDir, f), join(destDir, f));
      overlayCount++;
    }
  }
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
  console.log(`  removed      stale ${f} from the base tree`);
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

console.log(`\n  OK — all ${required.length} required files present.`);
console.log(`  Next:  ISCC.exe ${join(REPO_ROOT, "inno-setup", "setup.iss")}\n`);
