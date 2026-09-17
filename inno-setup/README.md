# CS2-Bot-Improver — Inno Setup installer

**English** · [简体中文](README.zh-CN.md)

`setup.iss` builds `CS2-Bot-Improver-Setup.exe`: a Windows installer that puts the
Panel application and every plugin file into Counter-Strike 2's `game\csgo`
folder.

---

## Requirements

- **Inno Setup 6.3 or newer.** The script declares
  `ArchitecturesAllowed=x64compatible`, which older 6.x releases reject.
  Verified with 6.7.3.
- Windows x64 (Counter-Strike 2 itself is 64-bit only).

## Quick start

1. Put the packaged Panel executable at **`Panel.exe` in the repository root**.
   There is no built Panel in the repository — its Tauri backend
   (`Panel/src-tauri`) is not published — so the installer would otherwise ship
   without it.
2. Compile:

   ```bat
   ISCC.exe setup.iss
   ```

   …or open `setup.iss` in the Inno Setup IDE and press **Compile**.
3. The result is `inno-setup\output\CS2-Bot-Improver-Setup.exe` (git-ignored).

To point at a build elsewhere, define it on the command line — command-line
defines win over the built-in lookup:

```bat
ISCC.exe /DPanelExe="C:\build\Panel.exe" setup.iss
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

---

## What gets installed

Always installed:

| Source | Destination |
| --- | --- |
| `addons\` | `{app}\addons\` |
| `cfg\` (minus `*_rules_unchanged.cfg`) | `{app}\cfg\` |
| `overrides\High\`, `overrides\Low\`, `overrides\Medium\` | `{app}\overrides\...` |
| `Commands.txt`, `README.md`, `LICENSE` | `{app}\` |
| `Panel\LICENSE` | `{app}\LICENSE-Panel.txt` |
| `docs\` | `{app}\docs\` |
| the packaged Panel | `{app}\CS2-Bot-Improver-Panel.exe` |

Offered as optional tasks, **all unchecked by default**:

- **`rulesunchanged`** — the two `*_rules_unchanged.cfg` configs, for dedicated
  servers that must keep the standard game rules.
- **`archived`** — `overrides\archived\`, roughly **32 MB** of extra bot-profile
  variants.
- **`desktopicon`** — a desktop shortcut.

Together the optional file groups are about as large as the entire rest of the
package, which is why none of them is preselected.

### Notes

- The Panel is installed under a **fixed** name,
  `CS2-Bot-Improver-Panel.exe`, rather than `Panel v1.4.5.exe`. Upgrades then
  overwrite the previous build instead of leaving a pile of stale
  version-stamped executables behind in the game folder.
- `Panel\LICENSE` travels with the Panel binary, because the Panel is under
  PolyForm Strict 1.0.0 while the rest of the project is AGPL-3.0.
- Uninstalling removes the files the installer added (Inno tracks them).
  Anything the user edited in place is removed along with them.

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
2. Build the installer against that Panel:
   `ISCC /DPanelExe="…\Panel.exe" setup.iss`
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

> [!IMPORTANT]
> In **silent mode Inno selects every task**, including the ones flagged
> `unchecked`. An unattended install without an explicit `/TASKS=""` therefore
> also copies the ≈32 MB of archived overrides. Always pass `/TASKS` explicitly
> in automation:
>
> - nothing optional — `/TASKS=""`
> - everything — `/TASKS="archived,rulesunchanged,desktopicon"`

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
Inno does not translate itself — the detection-failure hint, the running-game
warning and the optional-file task labels — are provided for all six languages in
`[CustomMessages]`.

---

## Files in this folder

| File | Purpose |
| --- | --- |
| `setup.iss` | The whole installer — metadata, payload, tasks, languages and Pascal Script. |
| `output/` | Build output. Git-ignored. |
| `README.md` | This document. |
| `README.zh-CN.md` | 简体中文版本。 |

---

## Troubleshooting

**`Warning: Panel executable not found …` at compile time**
The installer still builds, but ships *without* the Panel. Put the packaged
Panel at `Panel.exe` in the repository root, or pass `/DPanelExe="<path>"`.

**`Error: Panel\package.json is missing …`**
The `inno-setup` and `Panel` folders must stay side by side in the same
repository. The script derives every path from its own location, so it works
from any checkout directory — but not if those two folders are separated.

**`Invalid value for ArchitecturesAllowed`**
The installed Inno Setup is older than 6.3. Upgrade it, or change the directive's
value to `x64`.

**The install fails partway, or files are reported as locked**
Counter-Strike 2 (or Steam, while updating the game) was running. Close it and
run the installer again — it overwrites in place, so a retry is safe.
