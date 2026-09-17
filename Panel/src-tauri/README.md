# Panel — Tauri backend (`src-tauri`)

The Panel frontend (`Panel/src/`) is a React app; everything it cannot do from a
webview — inspecting the game folder, swapping files, editing Steam's config — is
implemented here in Rust and reached over Tauri v2's `invoke` bridge.

> [!NOTE]
> The original `src-tauri` is not published with this repository, so this one was
> written from the frontend's own contract (`Panel/src/lib/api.ts`) plus what the
> README, the packaging scripts and the shipped payload document. Where the
> original behaviour could not be observed it is marked *reconstructed* below.

---

## Build

```bat
cd Panel
npm install
npm run tauri build         :: bundle: NSIS installer + Panel.exe
:: or, equivalent and without the CLI:
npm run build
cd src-tauri
cargo build --release --features custom-protocol
```

The binary lands at `src-tauri\target\release\Panel.exe` and is self-contained —
the frontend bundle is embedded, so it needs no files beside it. It does need the
**WebView2 Runtime** (present on Windows 11 and up to date Windows 10; the README
documents the install for older Windows 10).

Tests run against temporary trees and a synthetic Steam config, so they touch
nothing real:

```bat
cargo test --lib
```

`--features custom-protocol` switches the webview from `build.devUrl` (dev
server) to the embedded bundle. Without it a release build starts, shows an empty
window and waits for a dev server that is not running. `npm run tauri build` runs
`npm run build` for you; a bare `cargo build` does not.

---

## Commands

| Command | Reads | Writes |
| --- | --- | --- |
| `get_config` / `save_config` | `%APPDATA%\com.cs2botimprover.panel\config.json` | same file, atomically |
| `detect_directories` | Steam roots, `libraryfolders.vdf`, `<library>\steamapps\common\Counter-Strike Global Offensive\game\csgo` | — |
| `select_directory` | validates the pick | remembers it in the config |
| `validate_files` | the 21 files `inno-setup/setup.iss` treats as fatal | — |
| `get_difficulty` | which `overrides\<level>\botprofile.vpk` matches the active one | — |
| `set_difficulty` | | copies `overrides\<level>\botprofile.vpk` → `overrides\botprofile.vpk` |
| `get_mode` | active `gameinfo.gi` vs `backup\Online\` and `backup\WithBots\` | learns the mode into the config once |
| `set_mode` | | copies the matching `backup\<mode>\gameinfo.gi` → `gameinfo.gi`, then reconciles launch options |
| `reconcile_launch_options` | `Steam\userdata\<id>\config\localconfig.vdf` | sets / clears `-insecure` in the CS2 app entry |
| `launch_cs2` | | opens `steam://rungameid/730` |
| `reconcile_core_json` | `addons\counterstrikesharp\configs\core.json` | flips `FollowCS2ServerGuidelines` to match the Skins toggle |
| `get_bot_items` | plugin folders below `addons\` | — |
| `set_bot_item` | | renames `BotRandomizer` / `BotHider` ↔ `…_disabled` |
| `get_presets` / `set_aim` / `set_nades` | the config | the config |
| `get_drop_knives` | the `bind … subclass_create …` line in `cfg\my_bot_normal_config.cfg` | rewrites that one line |
| `cleanup_backups` | | removes six known legacy `*.bak` paths |

### Deferral — the yellow lights

CS2 holds `gameinfo.gi` and the plugin DLLs open while it runs, and reads them
only at startup, so changing them then is pointless *and* likely to fail. When
`cs2.exe` is running, `set_mode` and `set_bot_item` therefore **skip the disk
write**, remember the choice, and report `cs2_running: true` — which is what the
frontend turns into a yellow "restart CS2 to apply" indicator. `set_difficulty`
attempts the swap and tolerates a failure for the same reason.

### Safety properties

* **A fresh install cannot break a working setup.** When no config file exists
  yet, the launch options already on disk are *adopted* — `insecure` is read from
  the Steam account that has CS2. The boot-time reconcile is then a no-op instead
  of a rewrite, and `-insecure` is only ever changed after the user picks a mode.
* **Only accounts that own CS2 are touched.** A Steam account whose config has no
  CS2 app entry is skipped entirely; no app block is invented for it.
* **Narrow writes.** A write is a file copied from a source the package already
  ships, or a single line / single JSON value replaced in place. The bot config
  keeps its other ~60 lines, its comments and its line endings; `localconfig.vdf`
  keeps every other app and setting.
* **Atomic.** Nothing is written in place: the new content goes to a temporary
  file that is then renamed over the target, so an interrupted write cannot leave
  a half-written config behind.
* **No-op writes are skipped.** Every write compares first and returns early when
  the file already says what it should, so a repeated poll cannot churn the disk.
* **`localconfig.vdf` is backed up** once, to `localconfig.vdf.bak`, before the
  first modification.
* **Nothing is deleted** except the six legacy `*.bak` paths in `LEGACY_BACKUPS`
  (checked individually, never a wildcard), plus a command's own temp file.

### Known gaps

* **Presets are not delivered to the game.** `set_aim` / `set_nades` persist the
  choice in the Panel's config, but no console command is written into a cfg or
  injected at launch, so the plugin never receives `bot_aim …` / `bot_nades …`.
  *Reconstructed:* the original presumably applies them when launching.
* **Launch options are written immediately, even if Steam is running.** Steam
  rewrites `localconfig.vdf` when it exits and could discard the change; the
  original may well defer this. Re-run the Panel, or toggle the mode again once
  Steam is closed, if the flag does not stick.
* **`user_count`** reports how many Steam accounts have CS2 launch options, not
  how many were changed.
* **`-insecure` placement.** The flag is appended to the user's existing options.
  If the original puts it first, the resulting string differs cosmetically.
* **Config location and shape are reconstructed.** The file is
  `%APPDATA%\com.cs2botimprover.panel\config.json`, named after the Tauri
  identifier. Note that `identifier` was chosen to match the original Panel's
  (`com.cs2botimprover.panel` was confirmed from the WebView2 data folder the
  official build had already created), so a build from this backend is a drop-in
  replacement *and* shares that data folder — including the frontend's
  `localStorage` flags (the per-section "pending restart" lights and the
  auto-update preference) with an official Panel installed side by side.
* **Existing on-disk state wins where it must.** `get_drop_knives` reports the
  binding found in the cfg rather than the remembered one, because that is what
  the game will honour.

---

## Layout

```
src-tauri/
  Cargo.toml            binary target is named `Panel` on purpose — that is the
                        file name assemble-payload.mjs and setup.iss expect
  build.rs              tauri-build: config validation + Windows resources
  tauri.conf.json       window: 460x720 design at 125% zoom, undecorated, created
                        hidden so src/main.tsx can size and centre it first
  capabilities/         the permissions the frontend is granted
  src/main.rs           one line: start the app
  src/lib.rs            plugin registration + invoke_handler
  src/backend.rs        DTOs, state, the 20 commands, and the unit tests
  icons/                generated application icons (PNG set + multi-size ICO)
```

The command implementations live in the library target so `cargo test --lib` can
exercise them — a `windows_subsystem = "windows"` binary has no console for a
test harness to report through.

The window is created with `visible: false` on purpose: `Panel/src/main.tsx`
measures the monitor, picks a zoom between 0.7 and 1.25, resizes and centres the
window, and only then reveals it, so it never appears at the wrong size first.
`capabilities/default.json` grants `show` / `set-size` / `center` for exactly that
sequence; remove them and the window stays hidden.
