# CS2-Bot-Improver — Inno Setup installer

**English** · [简体中文](README.zh-CN.md)

`setup.iss` builds `CS2-Bot-Improver-Setup.exe`: a Windows installer that puts the
Panel application and the whole plugin into Counter-Strike 2's `game\csgo`
folder.

---

## Requirements

- **Inno Setup 6.3 or newer.** The script declares
  `ArchitecturesAllowed=x64compatible`, which older 6.x releases reject.
  Verified with 6.7.3.
- Windows x64 (Counter-Strike 2 itself is 64-bit only).
- A **distribution tree** to package — see [Payload](#payload) below. This is the
  part that is easy to get wrong, so read that section before anything else.

---

## Payload

> [!IMPORTANT]
> **This repository is source-only and cannot be packaged directly.**

`.gitignore` excludes `**/bin/` and `**/obj/`, and the loader files CS2 needs were
never committed at all. So a checkout contains 97 `.cs` files and **zero DLLs**,
while what actually runs is **510 DLLs** plus the Metamod stubs and a packed
`botprofile.vpk` — 152 MB of binaries against 4.6 MB of sources.

An installer built straight from the checkout therefore copies source files into
`game\csgo` and no loadable code. CS2 starts with the plugin entirely absent, and
nothing in the UI says why. `setup.iss` now refuses to build in that case: it
checks 21 files that the plugin cannot start without and aborts with the missing
paths listed.

The payload must come from a **distribution tree** instead — the contents of the
official `CS2BotImprover.zip`:

```
addons/
backup/
cfg/
overrides/
gameinfo.gi
Panel.exe                        (the packaged Panel application)
```

Put that tree in **`inno-setup\payload\`** (git-ignored), or point ISCC at it:

```bat
ISCC /DPayloadRoot="D:\build\CS2BotImprover" setup.iss
```

### Why those 21 files are fatal when missing

| Missing | Consequence |
| --- | --- |
| `gameinfo.gi` | CS2 never looks inside `addons\` — nothing loads at all |
| `addons\metamod.vdf`, `addons\metamod_x64.vdf` | Metamod is never injected; the whole chain dies here |
| `addons\metamod\bin\win64\server.dll`, `metamod.2.cs2.dll` | Metamod has no implementation to load |
| `addons\metamod\counterstrikesharp.vdf` | Metamod never loads CounterStrikeSharp |
| `counterstrikesharp\bin\win64\counterstrikesharp.dll` | No scripting host, so no plugin runs |
| `counterstrikesharp\dotnet\dotnet.exe` | CounterStrikeSharp has no runtime to boot |
| `counterstrikesharp\configs\core.json` | The Panel's Skins toggle has nothing to edit |
| `counterstrikesharp\gamedata\gamedata.json` | Signatures/offsets for this game build are unknown |
| `counterstrikesharp\plugins\BotAI\BotAI.dll` | A plugin the rest of the chain expects is gone |
| `addons\{BotController,BotHider,BotVision}\bin\win64\*.dll` | The three native plugins are absent |
| `addons\RayTrace\bin\win64\RayTrace.dll` | Ray tracing is absent |
| `backup\Online\gameinfo.gi`, `backup\WithBots\gameinfo.gi` | The Panel's Online / Bot Mode switch has nothing to copy |
| `overrides\botprofile.vpk`, `overrides\Medium\botprofile.vpk` | The Panel's difficulty switch has no profiles to activate |
| `cfg\my_bot_normal_config.cfg` | The game loads no bot configuration |

### Not offered as options, on purpose

The repository also carries `overrides/archived/` and two
`cfg/*_rules_unchanged.cfg`. Neither is part of the distribution:

- `overrides/archived/*/botprofile.db` are **uncompiled** profiles; the game reads
  `botprofile.vpk`. Installing the `.db` files would do nothing.
- The rules-unchanged variant ships as its **own release zip under the same
  filenames**, so `my_bot_normal_config.cfg` is the rules-unchanged config in that
  package. Installing both side by side could not work.

---

### Assembling it — `tools/assemble-payload.mjs`

There is no need to hand-copy files around. The helper script takes an existing
distribution tree as the base, overlays whatever you rebuilt, and then refuses to
hand back a tree that is missing anything CS2 needs to start:

```bat
node inno-setup\tools\assemble-payload.mjs ^
  --base "D:\build\CS2BotImprover" ^
  --panel "D:\build\Panel.exe"
```

| Option | Meaning |
| --- | --- |
| `--base <dir>` | Distribution tree to start from. Must contain `gameinfo.gi`. |
| `--out <dir>` | Where to write the payload. Default `inno-setup\payload`. Wiped first, so no stale files survive. |
| `--panel <exe>` | Packaged Panel application; published as `Panel.exe`. |
| `--build` | Run `dotnet build -c Release` over every buildable project first. Omit it when you built in Visual Studio. |
| `--stage-references` | Only stage the missing `libs/` references, then stop. Run once before opening Visual Studio. |
| `--fix-references` | Repair `<ProjectReference>` entries pointing at a folder that does not exist. Opt-in, because it edits source files; prints the `git checkout` that undoes it. |
| `--write-solution <path>` | Write a `.slnx` listing exactly the projects the package needs, for building in Visual Studio. |
| `--deploy` | Copy the rebuilt assemblies straight into a CS2 install instead of assembling a payload. Adds and updates, and withdraws only files an earlier deploy of its own wrote. See [the development loop](#the-loop-while-you-are-editing-code). |
| `--game <dir>` | Which install to deploy into: `…\game\csgo`, the CS2 root, or the Steam library holding it. Auto-detected when omitted — which means a bare `--deploy` writes to the install it finds. |
| `--dry-run` | Report what `--deploy` would add, update and withdraw, then stop without writing anything. Use it to check the detected target. |
| `--no-pdb` | Drop the `.pdb` debug symbols. |
| `--verify-only` | Check an existing payload instead of assembling one. Exits non-zero when the payload is incomplete **or** a plugin folder is missing from `[InstallDelete]`, so it works as a CI gate. |

Two safety properties worth knowing before you pass paths to it:

- **`--out` and `--base` may not overlap, in either direction.** The payload is
  wiped before it is written and the base tree is read from, so `--out` equal to
  `--base` would delete the tree it is about to copy from, and a `--base` inside
  `--out` would go with it. Both are refused, comparing paths case-insensitively
  because Windows paths are.
- **Removing a stale Panel touches the payload copy only.** The base tree keeps
  whatever it shipped with.

Two things it derives rather than being told:

- **The required-file list comes from `setup.iss`**, by reading the
  `#define NeedPayload("…")` checks out of the script. There is exactly one copy
  of that list, so the script and the installer cannot disagree about what
  "complete" means.
- **Each project's destination is its own source folder.** A plugin is packaged
  only when its assembly name matches its folder name, because that is how
  CounterStrikeSharp locates it — `plugins\<Name>\<Name>.dll`. Helper assemblies
  sharing a folder (`plugins\BotAI\Common.csproj`) are reported and skipped.
- **Only projects under `counterstrikesharp\plugins\` or `\shared\` are considered
  plugins at all.** A scratch project elsewhere under `addons\` — a build workspace,
  say — is reported and left out of the package.
- **Sub-paths below a project's output root map onto CounterStrikeSharp's install
  root**, not onto the project folder. `BotHiderImpl` relies on this: a custom
  MSBuild target copies `0Harmony.dll` into `shared\0Harmony\`, so the built tree
  looks like

  ```
  bin\Release\net10.0\BotHiderImpl.dll
  bin\Release\net10.0\shared\0Harmony\0Harmony.dll
  ```

  and the second path becomes
  `addons\counterstrikesharp\shared\0Harmony\0Harmony.dll` in the payload.
  Missing that would ship a stale Harmony after a `Lib.Harmony` bump, because
  nothing else ever refreshes that file.

### If you want to rebuild the plugins yourself

Roughly 150 of the payload's files are third-party and simply vendored; only the
managed plugins are built from this repository. Things worth knowing before you
open Visual Studio:

- **11 of the 16 projects are buildable**, all through NuGet — `dotnet restore`
  is enough, you do **not** need a local CounterStrikeSharp install.
  `CounterStrikeSharp.API` is referenced as a package.
- **Three projects reference a prebuilt assembly through a `libs\` folder that is
  not in the repository.** `BotAimImprover` and `NadeSystem` want
  `libs\RayTraceApi.dll`; `BotState` wants `libs\BotControllerApi.dll`. Without
  them those three cannot compile at all — the compiler stops rather than emitting
  a broken assembly (`BotAimImprover` is the one that genuinely uses the API, via
  `using RayTraceAPI;`).

  Run this once before opening Visual Studio, and the tool copies the assemblies
  out of the distribution tree into a git-ignored `libs\` folder:

  ```bat
  node inno-setup\tools\assemble-payload.mjs --stage-references --base "D:\build\CS2BotImprover"
  ```

  `--build` does it for you automatically.
- **Two `<ProjectReference>` entries point at a folder that does not exist**, so
  those two projects cannot compile either — and the failure arrives as ~40
  `CS0246` lines, which reads like a code problem rather than a path problem:

  | Project | Points at | Actually lives in |
  | --- | --- | --- |
  | `plugins\BotControllerImpl` | `../BotControllerApi/` | `shared\BotControllerApi\` |
  | `plugins\BotHiderImpl` | `..\BotHiderApi\` | `shared\BotHiderApi\` |

  The tool reports this rather than fixing it silently — the files are yours. To
  have it apply exactly the replacement above, and print the `git checkout` command
  that undoes it:

  ```bat
  node inno-setup\tools\assemble-payload.mjs --fix-references
  ```

  The replacement is derived from where the project actually is, so it is the only
  path that can work in this checkout. Verified: with it applied, **all 11 projects
  compile**; without it, those two fail and the rest build.
- **`CounterStrikeSharp.API` is pinned three ways in the build** — 1.0.367 (×2),
  1.0.371 (×6), 1.0.373 (×2) — across 10 references in 8 projects
  (`BotControllerApi` and `BotHiderApi` reference no CSS API at all).

  The version that matters is the one the *runtime* provides, and it is readable as
  plain text from the tree's own
  `addons\counterstrikesharp\api\CounterStrikeSharp.API.deps.json`:
  **1.0.373**. So eight of the ten pins are older than the runtime they load into.
  That direction is normally harmless — .NET Core resolves a reference *up* to
  whichever version is present rather than demanding an exact match, so it breaks
  only if a member a plugin calls was removed. The fatal direction is the opposite
  one: a pin *newer* than the runtime calls members that do not exist and fails at
  load with `MissingMethodException`.

  Both the tool and this document used to claim a `*` floating pin and a 1.0.362 pin
  were part of the build. They are not: those live in
  `plugins\disabled\`, which `walk()` skips, the solution generator excludes and the
  package never contains. **No pin in the build is floating**, so a restore cannot
  silently pull something newer than the runtime. `--deploy` and payload assembly
  both re-check this against the tree in front of them and warn if that ever stops
  being true.
- **The package ships its own .NET runtime, and that is what decides the target
  framework.** `addons\counterstrikesharp\dotnet\shared\Microsoft.NETCore.App\`
  holds **10.0.3**, and `api\CounterStrikeSharp.API.runtimeconfig.json` sets
  `"rollForward": "Major"`. The projects target two frameworks — `net10.0` for most,
  `net8.0` for `BotBuy` and `RoundDamageRecap` — and **both load**: the first matches
  the runtime directly, the second rolls forward to 10.0.3.

  Verified against the shipped tree rather than assumed: building here produces the
  same `runtimeTarget` for both (`v10.0` / `v8.0`), and `BotAI.deps.json` comes out
  **byte-identical** to the released one. That file records the whole dependency
  graph, so an exact match is about as close to proof as this gets that your
  toolchain and the one that built the release agree.
- **Pins can drift from the release without anyone noticing.** The same comparison
  caught one: the tree pins `BotBuy` to `1.0.367`, while the *released* `BotBuy` was
  built against `1.0.366`. Harmless in this direction — both resolve up to the
  runtime's 1.0.373 — but it shows the pins were edited after the release, which is
  exactly how a pin ends up newer than the runtime it loads into.
- **There is no `.sln`, no `Directory.Build.props` and no `NuGet.config`** in the
  repository, so one command writes a solution listing exactly the right projects:

  ```bat
  node inno-setup\tools\assemble-payload.mjs --write-solution addons\plugins.slnx
  ```

  Point it at an existing `.slnx` to overwrite it. Keep
  `addons\counterstrikesharp\plugins\disabled\` out of the solution: that folder
  holds the Linux variants, one of which references a path on the original author's
  machine (`..\..\..\..\Tmp\ArchiveV02\Common\bin\Debug\net8.0\Common.dll`). None of
  it is part of the release. Any scratch project of your own elsewhere under
  `addons\` is excluded automatically.
- Target frameworks are `net10.0` for most projects and `net8.0` for `BotBuy` and
  `RoundDamageRecap`. A .NET 10 SDK can target both — no second SDK needed.

The four native plugins (`BotController`, `BotHider`, `BotVision`, `RayTrace`)
have **no source in this repository**; they live in other projects, so treat their
binaries as vendored input rather than something to rebuild.

### The loop while you are editing code

Once an install exists you do not need to rebuild the installer to see a code
change in game:

```bat
:: once per checkout — a solution with exactly the projects the package needs
node inno-setup\tools\assemble-payload.mjs --write-solution addons\plugins.slnx

:: build it, in Visual Studio or on the command line
dotnet build addons\plugins.slnx -c Release

:: push the rebuilt DLLs into the game
node inno-setup\tools\assemble-payload.mjs --deploy
```

`--build --deploy` does the last two steps in one command. A `.slnx` on its own
only compiles — putting the result where the game reads it is the separate third
step, which is what `--deploy` is for.

The deploy step locates the install by itself (registry, `libraryfolders.vdf`, then
the conventional drive layouts), so with one Steam library and one CS2 it takes no
argument. It prints the folder it picked; `--game` overrides it.

**Auto-detection is not read-only.** A bare `--deploy` writes to whichever install
it finds — so a command run merely to see what would be detected is itself a
mutation. Add `--dry-run` for that:

```bat
node inno-setup\tools\assemble-payload.mjs --deploy --dry-run
```

It prints the same report — target folder, mode, API check, and every file it would
add, update or withdraw — and writes nothing, leaving the deploy record untouched.

What it will and will not do:

- **Adds and updates, and withdraws only what it wrote itself.** It cannot take a
  working install apart: the only deletions it performs are files listed in its own
  record whose content still matches what it deployed. Anything edited since is
  reported and kept. Pruning for an *upgrade* remains the installer's
  `[InstallDelete]` step.
- **Refuses to run half-way.** If any project has no `bin\Release` output it stops
  and names them: deploying the rest would leave old and new assemblies side by
  side, which is the state that is hardest to debug.
- **Refuses while CS2 is running**, because a running game holds its plugin DLLs
  open and the copy would fail part-way.
- **Refuses when CounterStrikeSharp is missing** from the target folder. There would
  be no plugin loader, so the copy would look successful while changing nothing.
- Touches **only the 11 managed plugins**. Metamod, CounterStrikeSharp, the .NET
  runtime, the four native plugins and `overrides\*.vpk` are vendored and nothing in
  this repository builds them.
- **Checks the `CounterStrikeSharp.API` pins against the runtime in the tree it is
  deploying to.** A pin newer than the runtime, or a floating `*` that a restore
  could resolve past it, produces `MissingMethodException` at plugin load — a
  failure with no obvious cause in the plugin's own code. Older pins are reported as
  a count only, because .NET Core resolves those up and they normally work.

**It remembers what it deployed, so a plugin someone deletes does not linger.** The
record is `inno-setup\.deploy-state.json` — git-ignored, keyed by game folder, one
hash per file. If a teammate deletes or renames a plugin, the next `--deploy`
removes the files it had written for it and prunes the emptied folder: otherwise
CounterStrikeSharp, which loads *every* folder under `plugins\`, would keep loading
the old build alongside the new one. This cannot be inferred from the disk instead —
a plugin folder in the game is indistinguishable from a vendored one such as
`RayTraceImpl`, which ships in the package and has no source here. Files edited since
they were deployed are reported and kept, and stay tracked so later runs still know
about them.

**Check the mode before wondering why nothing changed.** Online Mode installs the
*stock* `gameinfo.gi` on purpose, and CS2 then never reads `addons\metamod` —
Metamod, CounterStrikeSharp and every plugin stay unloaded by design, which is what
keeps official servers unaffected. A deploy still succeeds in that state; it just
cannot show up in game. `--deploy` reports which mode it found and, in Online Mode,
prints the `backup\WithBots\gameinfo.gi` that restores the mod. Switching the Panel
back to Bot Mode is the whole fix — the deployed files are already in place.

---

## Quick start

```bat
:: 1. assemble the payload (base tree + your rebuilt DLLs + the Panel)
node inno-setup\tools\assemble-payload.mjs --base "D:\build\CS2BotImprover" --panel "D:\build\Panel.exe"

:: 2. build the installer — it picks up inno-setup\payload automatically
ISCC.exe inno-setup\setup.iss
```

The result is `inno-setup\output\CS2-Bot-Improver-Setup.exe`, around 44 MB.

`setup.iss` uses `inno-setup\payload` whenever that folder contains a
`gameinfo.gi`, so step 2 needs no arguments. To read and write trees elsewhere:

```bat
ISCC.exe /DPayloadRoot="D:\build\CS2BotImprover" /DPanelExe="D:\build\Panel.exe" setup.iss
```

---

## Where the version number comes from

**Nothing is hardcoded.** `Panel/package.json`'s `version` field is the single
source of truth, and the script reads it at compile time. It feeds `AppVersion`,
`VersionInfoVersion` and `VersionInfoProductVersion`, so the installer's own file
properties match the Panel exactly:

```powershell
(Get-Item .\output\CS2-Bot-Improver-Setup.exe).VersionInfo.ProductVersion
# -> 1.4.5
```

The same value drives the Panel's title bar (via Vite's `define`) and its update
checker, so the three can never drift apart. **Bump the version in exactly one
place — `Panel/package.json`.**

ISPP has no JSON parser, but it can read a file one line at a time
(`FileOpen`/`FileRead`), which is all a single-key lookup needs; the `"version"`
value is then pulled out with `Pos`/`Copy`. If the field cannot be read the
compile **fails with an explanatory message** rather than silently shipping a
wrong version number.

The Panel executable and the payload have to come from the **same** release. When
the executable carries version info that disagrees with `package.json`, the
compile warns — a mismatched pair would produce an installer whose version label
lies about the Panel inside it.

---

## Where it installs

`DefaultDirName={code:GetDefaultCsgoDir}` — the destination is resolved at run
time by the Pascal Script in `[Code]`, using this chain:

1. Steam's root, from `HKCU\Software\Valve\Steam\SteamPath`, then
   `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`, then
   `HKLM\SOFTWARE\Valve\Steam\InstallPath`.
2. The conventional locations on the system drive:
   `Program Files (x86)\Steam`, `Program Files\Steam`, `Steam`.
3. Every library listed in each root's `steamapps\libraryfolders.vdf`.
4. Plus `<system drive>\SteamLibrary`.

It then looks for
`<library>\steamapps\common\Counter-Strike Global Offensive\game\csgo`,
preferring a library that also contains `appmanifest_730.acf` (the manifest for
CS2's Steam app id), so an unrelated folder cannot shadow the real one.

### Why there is no sweep across the other drive letters

Pascal Script exposes **no** drive-enumeration API here (`GetDriveType` and
`GetLogicalDrives` are both absent), and probing letters directly can block for
seconds on an empty optical drive or a disconnected network drive — an
unacceptable stall in a setup program. Nothing is lost by leaving it out:
reading `libraryfolders.vdf` from any *one* Steam root already reveals the
libraries living on every other drive.

This was verified on a machine with **no Steam registry keys at all** (a moved
Steam install) where CS2 lives on a non-system drive: detection still resolved

```
E:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive\game\csgo
```

### When detection fails

The destination page replaces its description with an explanation of which
folder to pick, translated for every bundled language, and the user can browse to
it manually. The default field still starts at the conventional location.

Whatever the user then chooses is checked before anything is written: if the folder
holds neither `gameinfo.gi` nor `steam.inf`, a confirmation explains that the
plugin would land somewhere the game never reads, and names the folder that was
selected. Without that, a mistyped path or a machine with no detectable CS2 would
produce a tidy, successful-looking install of 650 files that does nothing.

`LooksLikeCsgoDir` is the whole check — two `FileExists` calls. Verified against
the real install (true), the same path with a trailing backslash (true),
`C:\Windows` (false) and a non-existent path (false).

---

## What gets installed

From the **payload**:

| Source | Destination |
| --- | --- |
| `addons\` (510 DLLs, all configs and loaders) | `{app}\addons\` |
| `cfg\` | `{app}\cfg\` |
| `overrides\` | `{app}\overrides\` |
| `gameinfo.gi` | `{app}\gameinfo.gi` |
| `backup\` | `{app}\backup\` |
| the packaged Panel | `{app}\CS2-Bot-Improver-Panel.exe` |

From the **repository** (documentation, which the payload does not carry):

| Source | Destination |
| --- | --- |
| `Commands.txt`, `README.md`, `LICENSE` | `{app}\` |
| `docs\` | `{app}\docs\` |
| `Panel\LICENSE` | `{app}\LICENSE-Panel.txt` |

One optional task, **unchecked** by default: a desktop shortcut. Inno's own
translations supply its label.

### Upgrading over an existing install

Inno does **not** remove files a previous version installed that the new version no
longer ships. Verified with a two-version probe: a dropped file and a renamed file
both survived an in-place upgrade, including on the real upgrade path where Inno
picks up the previous install from the registry.

That matters here because CounterStrikeSharp loads *every* folder under
`plugins\`. A plugin left behind by the previous release would still be loaded
beside the new build, which produces duplicate-plugin errors at best.

So `[InstallDelete]` clears each directory the mod owns outright before extraction.
Only mod-owned paths are listed — `overrides` also holds
`swift_demo_menu_override.vpk`, `cfg\` holds Valve's configs and user edits,
`counterstrikesharp\configs` holds the user's `core.json`, and `metamod\` holds a
`metaplugins.ini` users may have edited, so none of those are touched.

`assemble-payload.mjs` checks the payload against that list and warns when a plugin
folder is not covered, and `--verify-only` fails on it — so adding a plugin cannot
silently leave the list behind.

`gameinfo.gi` and the Panel are handled separately and deliberately:
- the Panel is installed under a **fixed** name, so an upgrade overwrites the
  previous build rather than leaving version-stamped copies behind;
- `gameinfo.gi` is flagged `uninsneveruninstall` and restored on uninstall, as
  described below.

### Uninstalling, and why `cfg\` and `gameinfo.gi` are handled differently

The plugin overwrites files the base game also ships: `gameinfo.gi` (two extra
search paths so CS2 looks inside `addons\`) and the `cfg\gamemode_*.cfg` set.

Inno's uninstaller removes files from its own list and **does not care that the
content changed** — verified by installing a file, replacing it with entirely
different content, and uninstalling: the file was deleted anyway. That makes a
Steam game update dangerous: once it restores Valve's copy of `gameinfo.gi`,
uninstalling would delete a file CS2 needs, and the game would only start again
after **Verify integrity of game files**.

So those two entries carry `uninsneveruninstall` and survive uninstallation:

| Item | On uninstall |
| --- | --- |
| `gameinfo.gi` | Kept, and **restored to Valve's original content** — `CurUninstallStepChanged` copies the pristine `backup\Online\gameinfo.gi` over it before Inno removes `backup\`. `usUninstall` is used because it was verified to run while `backup\` still exists. |
| `cfg\*` | Kept as-is. The mod's own three configs (`bot_buy.cfg`, `my_bot_ffa_config.cfg`, `my_bot_normal_config.cfg`, ≈9 KB) stay behind, and the `gamemode_*.cfg` files keep the mod's bot-friendly rules. Nothing is deleted, so the game cannot be left without a file it needs. |
| `addons\`, `overrides\`, `backup\`, the Panel, the docs | Removed normally — all of it is the mod's own. |

Everything else the installer adds is removed as usual, including the Panel,
the documentation and the uninstaller itself.

### Notes

- The Panel is installed under a **fixed** name,
  `CS2-Bot-Improver-Panel.exe`, rather than `Panel v1.4.5.exe`. Upgrades then
  overwrite the previous build instead of leaving a pile of stale
  version-stamped executables behind in the game folder.
- `Panel\LICENSE` travels with the Panel binary, because the Panel is under
  PolyForm Strict 1.0.0 while the rest of the project is AGPL-3.0.

---

## Publishing a release

The Panel's update checker looks for one exact asset name on the latest GitHub
release:

```
CS2-Bot-Improver-Setup.exe
```

That name is `OutputBaseFilename` in `[Setup]`; if a release does not carry an
asset with *exactly* that name, the Panel still detects the new version but
cannot offer the installer and sends the user to the release page instead.

So an installer-enabled release goes:

1. Bump `version` in `Panel/package.json` and build the Panel from it.
2. Build the installer against that Panel and that release's distribution tree:
   `ISCC /DPayloadRoot="…" /DPanelExe="…\Panel.exe" setup.iss`
3. Create the GitHub release, tagged **`v<version>`** — the same version string
   `package.json` declares, because that is what the comparison runs against.
4. Attach `CS2-Bot-Improver-Setup.exe`, keeping the name the script produced,
   alongside the existing Windows and Linux zips.

Two things to watch:

- The API endpoint the Panel uses is `releases/latest`, which **skips drafts and
  prereleases**. A `v1.5.0-rc1` tag will never be offered to anyone.
- The Panel itself is not built by anything in this repository, because its Tauri
  backend (`Panel/src-tauri`) is not published. Step 2 is therefore always a
  manual hand-off of the built executable.

---

## Unattended / silent installs

```bat
CS2-Bot-Improver-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART ^
  /TASKS="" /LANG=chinesesimplified ^
  /DIR="D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive\game\csgo"
```

> [!NOTE]
> In **silent mode Inno selects every task**, including the ones flagged
> `unchecked`. That only affects the desktop shortcut here — pass `/TASKS=""` for
> no shortcut, or `/TASKS="desktopicon"` for one.

Other useful flags: `/DIR=…`, `/LANG=…`, `/LOG="install.log"`, `/NORESTART`,
`/SUPPRESSMSGBOXES`.

---

## Checking for a running game

Before installing, the script runs `tasklist` and looks for `cs2.exe`. If the
game is running, the user is asked to close it first — its plugin DLLs are locked
while it runs, which makes the install fail halfway through — and can choose to
continue anyway.

Silent installs skip the prompt, so **close CS2 yourself before automating a
deployment.**

---

## Languages

The wizard ships English, 简体中文, Русский, Deutsch, 日本語 and 한국어. The texts
Inno does not translate itself — the detection-failure hint and the running-game
warning — are provided for all six languages in `[CustomMessages]`.

---

## Files in this folder

| File | Purpose |
| --- | --- |
| `setup.iss` | The whole installer — metadata, payload, tasks, languages and Pascal Script. |
| `tools/assemble-payload.mjs` | Assembles and verifies the payload tree. See above. |
| `payload/` | The distribution tree to package. Git-ignored, produced by the tool. |
| `output/` | Build output. Git-ignored. |
| `README.md` | This document. |
| `README.zh-CN.md` | 简体中文版本。 |

---

## Troubleshooting

**`Error: The payload is incomplete.`**
The expected fix, when the payload is the repository instead of a distribution
tree. The warnings directly above the error list every missing path; see
[Payload](#payload).

**`Warning: Panel executable is version X but this installer is built as Y`**
The Panel executable and the payload came from different releases. Rebuild the
installer with the matching pair — the version follows
`Panel/package.json`.

**`Error: Panel\package.json is missing`**
The `inno-setup` and `Panel` folders must stay side by side in the same
repository. The script derives every path from its own location, so it works
from any checkout directory — but not if those two folders are separated.

**`Invalid value for ArchitecturesAllowed`**
The installed Inno Setup is older than 6.3. Upgrade it, or change the directive's
value to `x64`.

**The install fails partway, or files are reported as locked**
Counter-Strike 2 (or Steam, while updating the game) was running. Close it and
run the installer again — it overwrites in place, so a retry is safe.
