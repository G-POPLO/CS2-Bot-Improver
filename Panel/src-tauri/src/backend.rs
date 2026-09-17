//! The Panel's Tauri command surface, mirroring the contract the frontend
//! declares in `Panel/src/lib/api.ts`.
//!
//! # What this backend does
//!
//! It is a complete implementation of the command set the frontend calls:
//!
//! * **Reads** inspect the game folder and report what is actually there —
//!   directory discovery, the 21-file completeness check, difficulty / mode
//!   detection, bot-item state, and the drop-knife binding.
//! * **Writes** modify the game folder, the bot config, CounterStrikeSharp's
//!   `core.json`, the user's own config file, and the Steam account's launch
//!   options. Every write is a narrow, targeted edit: a file is copied from a
//!   source the package already ships, or a single line / single JSON value is
//!   replaced. Nothing is ever deleted wholesale.
//!
//! ## Deferral (the yellow lights)
//!
//! CS2 holds its plugin DLLs and `gameinfo.gi` open while it runs. Changing
//! either then is pointless anyway — the game reads them at startup. So when CS2
//! is running the mode swap and the plugin-folder renames are **skipped**, the
//! choice is remembered, and the DTOs report `cs2_running: true`, which is what
//! turns the panel's indicator yellow ("restart CS2 to apply"). The difficulty
//! swap is attempted and its failure tolerated for the same reason.
//!
//! ## Safety properties worth knowing
//!
//! * The launch-option reconcile **adopts** the launch options already on disk
//!   when it creates a config for the first time. A fresh Panel therefore cannot
//!   strip `-insecure` from a working installation; it only ever changes the
//!   flag after the user picks a mode.
//! * `localconfig.vdf` is backed up once, to `localconfig.vdf.bak`, before the
//!   first modification.
//! * Writes go to a temporary file and are then renamed over the target, so an
//!   interrupted write cannot leave a half-written config behind.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------------------
// DTOs — field names are the JSON keys the frontend already reads.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct BotItems {
    pub skins: bool,
    pub profiles: bool,
    pub agents: bool,
    pub music: bool,
}

impl Default for BotItems {
    fn default() -> Self {
        Self { skins: true, profiles: true, agents: true, music: true }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct AppConfig {
    pub language: Option<String>,
    pub difficulty: Option<String>,
    pub mode: Option<String>,
    pub insecure: bool,
    pub bot_items: BotItems,
    pub aim: Option<String>,
    pub nades: Option<String>,
    pub drop_knife_bind: String,
    pub drop_knife_subclasses: Vec<u32>,
    pub csgo_path: Option<String>,
    pub first_run_done: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            language: None,
            difficulty: None,
            mode: None,
            insecure: false,
            bot_items: BotItems::default(),
            aim: None,
            nades: None,
            // Matches the README: point at the ground and press `\`.
            drop_knife_bind: "\\".to_string(),
            drop_knife_subclasses: Vec::new(),
            csgo_path: None,
            // Left false so a genuinely fresh installation shows the language
            // picker, which is what that overlay is for.
            first_run_done: false,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct DirectoryInfo {
    pub candidates: Vec<String>,
    pub selected: Option<String>,
    pub valid: bool,
    pub needs_choice: bool,
    pub steam_found: bool,
}

#[derive(Serialize, Clone)]
pub struct FilesReport {
    pub ok: bool,
    pub total: usize,
    pub present: usize,
    pub missing: Vec<String>,
    pub misplaced: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct DifficultyInfo {
    pub current: Option<String>,
    pub available: Vec<String>,
    pub active_present: bool,
    pub cs2_running: bool,
}

#[derive(Serialize, Clone)]
pub struct BotItemsState {
    pub skins: bool,
    pub profiles: bool,
    pub agents: bool,
    pub music: bool,
    pub cfg_present: bool,
    pub cs2_running: bool,
}

#[derive(Serialize, Clone)]
pub struct PresetsState {
    pub aim: Option<String>,
    pub nades: Option<String>,
    pub cfg_present: bool,
    pub cs2_running: bool,
}

#[derive(Serialize, Clone)]
pub struct DropKnivesState {
    pub bind_key: String,
    pub selected: Vec<u32>,
    pub cfg_present: bool,
    pub cs2_running: bool,
}

#[derive(Serialize, Clone)]
pub struct ModeInfo {
    pub current: Option<String>,
    pub online_present: bool,
    pub bots_present: bool,
    pub insecure: bool,
    pub user_count: usize,
    pub cs2_running: bool,
    pub pending: bool,
}

#[derive(Serialize, Clone)]
pub struct LaunchResult {
    pub options: String,
    pub insecure: bool,
}

/// Mirrors the frontend's `AppError` (see `lib/api.ts`). The `code` is stable and
/// never localized; the UI looks it up in its own dictionary.
#[derive(Debug, Serialize, Clone)]
pub struct AppError {
    pub code: String,
    pub category: String,
    pub detail: String,
}

impl AppError {
    pub fn missing(detail: impl std::fmt::Display) -> Self {
        Self { code: "E1001".into(), category: "missing".into(), detail: detail.to_string() }
    }
    pub fn io(detail: impl std::fmt::Display) -> Self {
        Self { code: "E1002".into(), category: "io".into(), detail: detail.to_string() }
    }
    pub fn invalid(detail: impl std::fmt::Display) -> Self {
        Self { code: "E1003".into(), category: "invalid".into(), detail: detail.to_string() }
    }
    pub fn steam(detail: impl std::fmt::Display) -> Self {
        Self { code: "E1004".into(), category: "steam".into(), detail: detail.to_string() }
    }
    pub fn launch(detail: impl std::fmt::Display) -> Self {
        Self { code: "E1005".into(), category: "launch".into(), detail: detail.to_string() }
    }
}

// ---------------------------------------------------------------------------
// Constants mirrored from the packaging scripts
// ---------------------------------------------------------------------------

/// One entry per file CS2 cannot start the plugin without. The same list is
/// enforced by `inno-setup/setup.iss` at install time and by
/// `inno-setup/tools/assemble-payload.mjs` when a payload is assembled.
const REQUIRED: &[&str] = &[
    "addons/metamod.vdf",
    "addons/metamod_x64.vdf",
    "addons/metamod/counterstrikesharp.vdf",
    "addons/metamod/metaplugins.ini",
    "addons/metamod/bin/win64/server.dll",
    "addons/metamod/bin/win64/metamod.2.cs2.dll",
    "addons/counterstrikesharp/bin/win64/counterstrikesharp.dll",
    "addons/counterstrikesharp/dotnet/dotnet.exe",
    "addons/counterstrikesharp/configs/core.json",
    "addons/counterstrikesharp/gamedata/gamedata.json",
    "addons/counterstrikesharp/plugins/BotAI/BotAI.dll",
    "addons/BotController/bin/win64/BotController.dll",
    "addons/BotHider/bin/win64/BotHider.dll",
    "addons/BotVision/bin/win64/BotVision.dll",
    "addons/RayTrace/bin/win64/RayTrace.dll",
    "gameinfo.gi",
    "backup/Online/gameinfo.gi",
    "backup/WithBots/gameinfo.gi",
    "overrides/botprofile.vpk",
    "overrides/Medium/botprofile.vpk",
    "cfg/my_bot_normal_config.cfg",
];

/// Where CS2 lives inside a Steam library.
const CS2_REL: &[&str] =
    &["steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo"];

const DIFFICULTY_LEVELS: &[&str] = &["Low", "Medium", "High"];
const CFG_REL: &[&str] = &["cfg", "my_bot_normal_config.cfg"];
const CORE_JSON_REL: &[&str] = &[
    "addons",
    "counterstrikesharp",
    "configs",
    "core.json",
];

/// Legacy backup files earlier builds of the Panel left behind. Deleted nowhere
/// else — `cleanup_backups` only ever removes these exact paths.
const LEGACY_BACKUPS: &[&[&str]] = &[
    &["gameinfo.gi.bak"],
    &["overrides", "botprofile.vpk.bak"],
    &["cfg", "my_bot_normal_config.cfg.bak"],
    &["addons", "counterstrikesharp", "configs", "core.json.bak"],
    &["backup", "Online", "gameinfo.gi.bak"],
    &["backup", "WithBots", "gameinfo.gi.bak"],
];

/// The CS2 app id, whose launch options carry `-insecure`.
const CS2_APP_ID: &str = "730";
const INSECURE_FLAG: &str = "-insecure";

// ---------------------------------------------------------------------------
// Process state
// ---------------------------------------------------------------------------

pub struct PanelState {
    config: Mutex<AppConfig>,
    /// Where `config` is persisted. Resolved from the app handle at startup.
    config_file: PathBuf,
    /// Directory chosen in this session (a "Browse…" pick), overriding the
    /// remembered one until the next launch.
    session_dir: Mutex<Option<String>>,
    /// Whether `bot_items` has been seeded from the filesystem yet.
    items_seeded: Mutex<bool>,
    /// `(sampled_at, running)` — CS2 liveness costs a process spawn, and the
    /// frontend polls every 500 ms, so the answer is cached.
    running: Mutex<Option<(Instant, bool)>>,
    /// `(sampled_at, info)` — directory discovery walks every drive letter.
    dir_cache: Mutex<Option<(Instant, DirectoryInfo)>>,
}

impl PanelState {
    pub fn new(app: &AppHandle) -> Self {
        let config_file = app
            .path()
            .app_config_dir()
            .map(|dir| dir.join("config.json"))
            .unwrap_or_else(|_| PathBuf::from("panel-config.json"));

        let config = load_config(&config_file).unwrap_or_else(|| {
            // First run. Adopt what the installation already has so that the
            // boot-time reconcile cannot silently change anything: reading the
            // Steam launch options now is what makes the very first launch a
            // no-op instead of a rewrite.
            let insecure = localconfig_paths()
                .iter()
                .find_map(|path| read_launch_options(path))
                .map(|options| has_token(&options, INSECURE_FLAG))
                .unwrap_or(false);
            AppConfig { insecure, ..AppConfig::default() }
        });

        Self {
            config: Mutex::new(config),
            config_file,
            session_dir: Mutex::new(None),
            items_seeded: Mutex::new(false),
            running: Mutex::new(None),
            dir_cache: Mutex::new(None),
        }
    }
}

impl Default for PanelState {
    fn default() -> Self {
        // Only reachable from tests; there is no app handle to resolve a config
        // directory from, so the config stays in memory.
        Self {
            config: Mutex::new(AppConfig::default()),
            config_file: PathBuf::from("panel-config.json"),
            session_dir: Mutex::new(None),
            items_seeded: Mutex::new(false),
            running: Mutex::new(None),
            dir_cache: Mutex::new(None),
        }
    }
}

/// Take a lock, recovering from poisoning instead of panicking. A command that
/// blew up mid-write must not take the whole panel down with it.
fn m<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn load_config(path: &Path) -> Option<AppConfig> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Write the config back to disk. Best effort: a failure here must not surface
/// as a modal, because the in-memory value the UI is showing is still correct —
/// it just will not survive a restart.
fn persist(state: &PanelState) {
    let config = m(&state.config).clone();
    let Ok(json) = serde_json::to_string_pretty(&config) else { return };
    if let Some(dir) = state.config_file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = atomic_write(&state.config_file, json.as_bytes());
}

// ---------------------------------------------------------------------------
// Low-level file helpers
// ---------------------------------------------------------------------------

/// Write via a temporary file in the same directory, then rename over the
/// target. A crash mid-write leaves the original intact.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".panel-tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes)?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

fn join_all(base: &Path, parts: &[&str]) -> PathBuf {
    let mut p = base.to_path_buf();
    for part in parts {
        p.push(part);
    }
    p
}

/// A folder CS2 would load: it has the metadata file the game reads.
fn is_csgo_dir(dir: &Path) -> bool {
    dir.join("gameinfo.gi").is_file() || dir.join("steam.inf").is_file()
}

/// Accept the `game\csgo` folder itself, the CS2 install root, or the Steam
/// library holding it — the same forgiveness `assemble-payload.mjs` applies.
fn resolve_csgo_dir(explicit: &str) -> Option<String> {
    let p = PathBuf::from(explicit);
    let candidates = [p.clone(), p.join("game").join("csgo"), join_all(&p, CS2_REL)];
    candidates
        .into_iter()
        .find(|c| is_csgo_dir(c))
        .map(|c| c.to_string_lossy().to_string())
}

/// Steam roots, the library folders they declare, and the conventional
/// `<drive>:\SteamLibrary` names. Ported from `steamLibraries()` in
/// `inno-setup/tools/assemble-payload.mjs`. Drives below C: are skipped — an
/// empty floppy drive makes `is_dir()` block for seconds.
fn steam_libraries() -> Vec<String> {
    let mut roots: BTreeSet<String> = BTreeSet::new();
    for drive in 'C'..='Z' {
        for sub in ["Steam", "Program Files (x86)\\Steam", "Program Files\\Steam"] {
            let root = format!("{drive}:\\{sub}");
            if Path::new(&root).join("steamapps").is_dir() {
                roots.insert(root);
            }
        }
    }

    let mut libraries: BTreeSet<String> = roots.iter().cloned().collect();
    for root in &roots {
        let vdf = Path::new(root).join("steamapps").join("libraryfolders.vdf");
        let Ok(text) = fs::read_to_string(&vdf) else { continue };
        for line in text.lines() {
            // `"path"		"D:\\SteamLibrary"` — the only line shape that matters.
            let trimmed = line.trim_start();
            let Some(rest) = trimmed.strip_prefix("\"path\"") else { continue };
            let Some(open) = rest.find('"') else { continue };
            let after = &rest[open + 1..];
            let Some(close) = after.find('"') else { continue };
            let value = after[..close].replace("\\\\", "\\");
            if !value.is_empty() {
                libraries.insert(value);
            }
        }
    }
    for drive in 'C'..='Z' {
        let lib = format!("{drive}:\\SteamLibrary");
        if Path::new(&lib).join("steamapps").is_dir() {
            libraries.insert(lib);
        }
    }
    libraries.into_iter().collect()
}

/// Byte-for-byte comparison, size first, streamed so a multi-megabyte
/// `botprofile.vpk` never lands in memory.
fn files_equal(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (fs::metadata(a), fs::metadata(b)) else {
        return false;
    };
    if ma.len() != mb.len() {
        return false;
    }
    if ma.len() == 0 {
        return true;
    }
    let (Ok(mut fa), Ok(mut fb)) = (File::open(a), File::open(b)) else {
        return false;
    };
    let mut buf_a = vec![0u8; 64 * 1024];
    let mut buf_b = vec![0u8; 64 * 1024];
    loop {
        let na = match fa.read(&mut buf_a) {
            Ok(0) => return true,
            Ok(n) => n,
            Err(_) => return false,
        };
        let nb = match fb.read(&mut buf_b) {
            Ok(n) => n,
            Err(_) => return false,
        };
        if na != nb || buf_a[..na] != buf_b[..nb] {
            return false;
        }
    }
}

/// The mistake the red "wrong location" light exists for: the package was
/// extracted one level too deep, so `addons\` sits inside a subfolder instead of
/// beside `gameinfo.gi`. Reported as the folder the user should move the
/// contents out of.
fn find_misplaced(csgo: &Path) -> Option<String> {
    let entries = fs::read_dir(csgo).ok()?;
    for entry in entries.flatten().take(400) {
        let path = entry.path();
        if path.is_dir() && path.join("addons").join("metamod.vdf").is_file() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

/// Copy `source` over `target`, doing nothing when they already match so the
/// panel never rewrites a file with identical bytes (which would invalidate
/// nothing but does churn timestamps and mappings).
fn copy_if_different(source: &Path, target: &Path) -> Result<(), AppError> {
    if !source.is_file() {
        return Err(AppError::missing(source.display().to_string()));
    }
    if files_equal(source, target) {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(AppError::io)?;
    }
    fs::copy(source, target).map_err(AppError::io)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Process probes
// ---------------------------------------------------------------------------

/// Is a process with this image name running? `tasklist` rather than a Win32
/// snapshot so this stays a short function, with `CREATE_NO_WINDOW` so no
/// console flashes up.
#[cfg(windows)]
fn probe_process(image: &str) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let filter = format!("IMAGENAME eq {image}");
    std::process::Command::new("tasklist")
        .args(["/FI", &filter, "/NH", "/FO", "CSV"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .to_ascii_lowercase()
                .contains(&image.to_ascii_lowercase())
        })
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn probe_process(_image: &str) -> bool {
    false
}

fn cs2_running(state: &PanelState) -> bool {
    if let Some((at, running)) = *m(&state.running) {
        if at.elapsed() < Duration::from_millis(1500) {
            return running;
        }
    }
    let running = probe_process("cs2.exe");
    *m(&state.running) = Some((Instant::now(), running));
    running
}

// ---------------------------------------------------------------------------
// The bot config
// ---------------------------------------------------------------------------

/// Read `bind <key> "subclass_create N;subclass_create N;…"` out of the bot
/// config. Returns the key and the knife subclass ids in file order.
fn parse_knife_bind(text: &str) -> Option<(String, Vec<u32>)> {
    for line in text.lines() {
        let Some((key, tail)) = split_bind_line(line) else { continue };
        let selected = tail
            .split(';')
            .filter_map(|seg| seg.trim().strip_prefix("subclass_create "))
            .filter_map(|n| n.trim().parse::<u32>().ok())
            .collect();
        return Some((key, selected));
    }
    None
}

/// `bind <key> "<command>;<command>"` → `(key, command)`.
fn split_bind_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("bind ")?;
    let rest = rest.trim_start();
    let (key, tail) = if let Some(quoted) = rest.strip_prefix('"') {
        let end = quoted.find('"')?;
        (quoted[..end].to_string(), quoted[end + 1..].trim().to_string())
    } else {
        let end = rest.find(char::is_whitespace)?;
        (rest[..end].to_string(), rest[end..].trim().to_string())
    };
    Some((key, tail.trim_matches('"').to_string()))
}

/// A console key is written bare, the way the shipped config writes `\`, unless
/// it contains something that would break the line's tokenisation.
fn format_bind_key(key: &str) -> String {
    let risky = key.is_empty()
        || key.contains(char::is_whitespace)
        || key.contains('"')
        || key.contains(';');
    if risky {
        format!("\"{}\"", key.replace('"', "\\\""))
    } else {
        key.to_string()
    }
}

/// Replace the `bind … subclass_create …` line, or append one when the config
/// has none yet. Only that line moves; the other 60-odd lines are untouched.
fn rewrite_knife_bind(path: &Path, key: &str, ids: &[u32]) -> Result<(), AppError> {
    if !path.is_file() {
        return Err(AppError::missing(path.display().to_string()));
    }
    let text = fs::read_to_string(path).map_err(AppError::io)?;
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let commands: Vec<String> =
        ids.iter().map(|id| format!("subclass_create {id}")).collect();
    let replacement = format!("bind {} \"{}\"", format_bind_key(key), commands.join(";"));

    let mut replaced = false;
    let mut out: Vec<String> = Vec::new();
    for line in text.split(eol) {
        let is_bind = !replaced
            && split_bind_line(line)
                .map(|(_, tail)| tail.contains("subclass_create"))
                .unwrap_or(false);
        if is_bind {
            out.push(replacement.clone());
            replaced = true;
        } else {
            out.push(line.to_string());
        }
    }
    if !replaced {
        out.push(String::new());
        out.push(replacement);
    }
    let joined = out.join(eol);
    if joined == text {
        return Ok(());
    }
    atomic_write(path, joined.as_bytes()).map_err(AppError::io)
}

/// Legacy `.bak` sweep. Only the exact paths earlier builds created are removed —
/// six files, checked individually, never a wildcard over the game folder.
fn cleanup_legacy_backups(csgo: &Path) -> usize {
    let mut removed = 0;
    for rel in LEGACY_BACKUPS {
        let path = join_all(csgo, rel);
        if path.is_file() && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ---------------------------------------------------------------------------
// Steam launch options
// ---------------------------------------------------------------------------

/// Every Steam account's `localconfig.vdf` we can see.
fn localconfig_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for library in steam_libraries() {
        // `userdata` only exists in the Steam *root*; a library folder has none,
        // so this naturally skips them without needing a separate root list.
        let Ok(entries) = fs::read_dir(Path::new(&library).join("userdata")) else {
            continue;
        };
        for entry in entries.flatten() {
            let config = entry.path().join("config").join("localconfig.vdf");
            if config.is_file() {
                out.push(config);
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn has_token(options: &str, token: &str) -> bool {
    options
        .split_whitespace()
        .any(|t| t.eq_ignore_ascii_case(token))
}

/// Add or remove `-insecure` while leaving every other launch option alone.
fn set_token(options: &str, token: &str, present: bool) -> String {
    let mut tokens: Vec<&str> = options
        .split_whitespace()
        .filter(|t| !t.eq_ignore_ascii_case(token))
        .collect();
    if present {
        tokens.push(token);
    }
    tokens.join(" ")
}

/// The key on a VDF line, if it has one: `"key"		"value"` or `"key"\n{`.
fn vdf_key(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// The value on a `"key"	"value"` line.
fn vdf_value(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix('"')?;
    let key_end = rest.find('"')?;
    let after = &rest[key_end + 1..];
    let open = after.find('"')?;
    let after = &after[open + 1..];
    let close = after.find('"')?;
    Some(after[..close].replace("\\\\", "\\").replace("\\\"", "\""))
}

fn vdf_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn brace_delta(line: &str) -> i32 {
    line.matches('{').count() as i32 - line.matches('}').count() as i32
}

/// Brace depth entering line `index`.
fn depth_at(lines: &[&str], index: usize) -> i32 {
    lines[..index.min(lines.len())].iter().map(|l| brace_delta(l)).sum()
}

/// Index of the line whose key is `key`, scanned between `from` and `to`, at
/// exactly `want_depth` — an absolute depth counted from the top of the file, so
/// an app block earlier in the same parent cannot be mistaken for this one.
fn find_key_line(
    lines: &[&str],
    key: &str,
    from: usize,
    to: usize,
    want_depth: i32,
) -> Option<usize> {
    let mut depth = depth_at(lines, from);
    for i in from..to {
        if depth == want_depth
            && vdf_key(lines[i]).map(|k| k.eq_ignore_ascii_case(key)) == Some(true)
        {
            return Some(i);
        }
        depth += brace_delta(lines[i]);
        if depth < 0 {
            return None;
        }
    }
    None
}

/// Index of the line carrying the opening brace of `key`'s block. The brace is
/// either on the key's own line or on the next non-empty one.
fn find_block(lines: &[&str], key: &str, from: usize, to: usize, want_depth: i32) -> Option<usize> {
    let at = find_key_line(lines, key, from, to, want_depth)?;
    if lines[at].contains('{') {
        return Some(at);
    }
    let mut j = at + 1;
    while j < to && lines[j].trim().is_empty() {
        j += 1;
    }
    if j < to && lines[j].contains('{') {
        return Some(j);
    }
    None
}

/// Index of the line closing the block opened on `open`.
fn matching_close(lines: &[&str], open: usize, to: usize) -> Option<usize> {
    let mut depth = 0i32;
    for i in open..to {
        depth += lines[i].matches('{').count() as i32;
        depth -= lines[i].matches('}').count() as i32;
        if depth == 0 {
            return Some(i);
        }
    }
    None
}

/// The CS2 app block: `(line index of its opening brace, line index of its
/// closing brace)`. Depths are absolute — `apps` is a child of
/// `UserLocalConfigStore`, so it sits at depth 1.
fn cs2_app_block(lines: &[&str]) -> Option<(usize, usize)> {
    let apps = find_block(lines, "apps", 0, lines.len(), 1)?;
    let apps_end = matching_close(lines, apps, lines.len())?;
    let app = find_block(lines, CS2_APP_ID, apps + 1, apps_end, 2)?;
    let app_end = matching_close(lines, app, apps_end)?;
    Some((app, app_end))
}

fn read_launch_options(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    // Search only inside the CS2 block's body: every app carries its own
    // LaunchOptions key, and the games listed before CS2 are not ours to read.
    let (app, app_end) = cs2_app_block(&lines)?;
    let key_line = find_key_line(&lines, "LaunchOptions", app + 1, app_end, 3)?;
    vdf_value(lines[key_line])
}

/// Rewrite the CS2 `LaunchOptions` value, preserving the file's line endings,
/// indentation and every other setting. Returns true when the file changed.
fn write_launch_options(path: &Path, options: &str) -> Result<bool, AppError> {
    let text = fs::read_to_string(path).map_err(AppError::io)?;
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = text.split(eol).collect();
    let (app, app_end) = cs2_app_block(&lines).ok_or_else(|| {
        AppError::steam(format!("no \"{}\" app block in {}", CS2_APP_ID, path.display()))
    })?;

    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    match find_key_line(&lines, "LaunchOptions", app + 1, app_end, 3) {
        Some(index) => {
            if vdf_value(lines[index]).as_deref() == Some(options) {
                return Ok(false);
            }
            let indent = &lines[index][..lines[index].len() - lines[index].trim_start().len()];
            out[index] = format!("{indent}\"LaunchOptions\"\t\t\"{}\"", vdf_escape(options));
        }
        None => {
            // No LaunchOptions key yet: insert one as the app block's first
            // child, matching whatever indentation its siblings already use.
            let indent = lines
                .iter()
                .skip(app + 1)
                .find(|l| !l.trim().is_empty() && !l.trim_start().starts_with('}'))
                .map(|l| l[..l.len() - l.trim_start().len()].to_string())
                .unwrap_or_else(|| {
                    let parent = &lines[app][..lines[app].len() - lines[app].trim_start().len()];
                    format!("{parent}\t")
                });
            out.insert(
                app + 1,
                format!("{indent}\"LaunchOptions\"\t\t\"{}\"", vdf_escape(options)),
            );
        }
    }

    // One backup, taken from the pristine file, kept alongside it.
    let mut backup = path.as_os_str().to_os_string();
    backup.push(".bak");
    let backup = PathBuf::from(backup);
    if !backup.exists() {
        let _ = fs::copy(path, &backup);
    }

    atomic_write(path, out.join(eol).as_bytes()).map_err(AppError::io)?;
    Ok(true)
}

/// Does this account's config list CS2 at all? Accounts that have never launched
/// CS2 get nothing written to them — they are not the user's CS2 account, and
/// inventing an app block for them would be presumptuous.
fn has_cs2_app_block(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else { return false };
    let lines: Vec<&str> = text.lines().collect();
    cs2_app_block(&lines).is_some()
}

/// Reconcile one account's config. Split out from the loop so the policy can be
/// tested without a real Steam installation.
fn reconcile_localconfig(path: &Path, insecure: bool) -> bool {
    if !has_cs2_app_block(path) {
        return false;
    }
    // An account with the app block but no LaunchOptions key yet has empty
    // options — which is exactly the state a Bot Mode switch needs to fix.
    let current = read_launch_options(path).unwrap_or_default();
    let wanted = set_token(&current, INSECURE_FLAG, insecure);
    if wanted == current {
        return false;
    }
    write_launch_options(path, &wanted).unwrap_or(false)
}

/// Bring every Steam account's CS2 launch options in line with `insecure`.
/// Returns how many accounts were changed. Never fatal: on a machine with no
/// Steam, or with Steam holding the file open, this quietly does nothing.
fn reconcile_launch_options_for(insecure: bool) -> usize {
    localconfig_paths()
        .iter()
        .filter(|path| reconcile_localconfig(path, insecure))
        .count()
}

/// How many Steam accounts this machine has CS2 launch options for.
fn steam_user_count() -> usize {
    localconfig_paths().len()
}

// ---------------------------------------------------------------------------
// Commands — config
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_config(state: State<'_, PanelState>) -> AppConfig {
    m(&state.config).clone()
}

#[tauri::command]
pub fn save_config(config: AppConfig, state: State<'_, PanelState>) {
    *m(&state.config) = config;
    persist(&state);
}

// ---------------------------------------------------------------------------
// Commands — directory + file validation
// ---------------------------------------------------------------------------

fn detect(state: &PanelState, force: bool) -> DirectoryInfo {
    if !force {
        if let Some((at, info)) = m(&state.dir_cache).as_ref() {
            if at.elapsed() < Duration::from_millis(1000) {
                return info.clone();
            }
        }
    }

    let remembered = m(&state.session_dir)
        .clone()
        .or_else(|| m(&state.config).csgo_path.clone());

    let mut candidates: Vec<String> = Vec::new();
    {
        let mut push = |path: String| {
            if !candidates.iter().any(|c| c.eq_ignore_ascii_case(&path)) {
                candidates.push(path);
            }
        };
        if let Some(raw) = remembered.as_deref() {
            if let Some(resolved) = resolve_csgo_dir(raw) {
                push(resolved);
            }
        }
        for library in steam_libraries() {
            let candidate = join_all(Path::new(&library), CS2_REL);
            if is_csgo_dir(&candidate) {
                push(candidate.to_string_lossy().to_string());
            }
        }
    }

    let info = DirectoryInfo {
        selected: candidates.first().cloned(),
        valid: !candidates.is_empty(),
        // Only worth asking about when nothing has been chosen yet.
        needs_choice: candidates.len() > 1 && remembered.is_none(),
        steam_found: !steam_libraries().is_empty(),
        candidates,
    };
    *m(&state.dir_cache) = Some((Instant::now(), info.clone()));
    info
}

#[tauri::command]
pub fn detect_directories(state: State<'_, PanelState>) -> DirectoryInfo {
    detect(&state, false)
}

#[tauri::command]
pub fn select_directory(path: String, state: State<'_, PanelState>) -> DirectoryInfo {
    let resolved = resolve_csgo_dir(&path).unwrap_or(path);
    *m(&state.session_dir) = Some(resolved.clone());
    m(&state.config).csgo_path = Some(resolved);
    persist(&state);
    detect(&state, true)
}

/// Remove the legacy `.bak` files earlier builds left in the game folder.
#[tauri::command]
pub fn cleanup_backups(csgo: String) -> usize {
    cleanup_legacy_backups(Path::new(&csgo))
}

#[tauri::command]
pub fn validate_files(csgo: String) -> FilesReport {
    let base = Path::new(&csgo);
    let mut missing: Vec<String> = Vec::new();
    for rel in REQUIRED {
        if !base.join(rel).exists() {
            missing.push(rel.replace('/', "\\"));
        }
    }
    let total = REQUIRED.len();
    let present = total - missing.len();
    let misplaced = if missing.is_empty() { None } else { find_misplaced(base) };
    FilesReport { ok: missing.is_empty(), total, present, missing, misplaced }
}

// ---------------------------------------------------------------------------
// Commands — difficulty
// ---------------------------------------------------------------------------

/// Swap `overrides\botprofile.vpk` for the chosen level's copy.
fn apply_difficulty(csgo: &Path, level: &str) -> Result<(), AppError> {
    if !DIFFICULTY_LEVELS.contains(&level) {
        return Err(AppError::invalid(format!("unknown difficulty {level}")));
    }
    let overrides = csgo.join("overrides");
    copy_if_different(&overrides.join(level).join("botprofile.vpk"), &overrides.join("botprofile.vpk"))
}

/// The active profile is whichever level's `botprofile.vpk` is byte-identical to
/// `overrides\botprofile.vpk`; the other two stay parked in their subfolders.
fn difficulty_state(csgo: &str, running: bool) -> DifficultyInfo {
    let overrides = Path::new(csgo).join("overrides");
    let active = overrides.join("botprofile.vpk");
    let available: Vec<String> = DIFFICULTY_LEVELS
        .iter()
        .filter(|level| overrides.join(**level).join("botprofile.vpk").is_file())
        .map(|level| (*level).to_string())
        .collect();
    let active_present = active.is_file();
    let current = if active_present {
        available
            .iter()
            .find(|level| {
                let parked = overrides.join(level.as_str()).join("botprofile.vpk");
                files_equal(&active, &parked)
            })
            .cloned()
    } else {
        None
    };
    DifficultyInfo { current, available, active_present, cs2_running: running }
}

#[tauri::command]
pub fn get_difficulty(csgo: String, state: State<'_, PanelState>) -> DifficultyInfo {
    difficulty_state(&csgo, cs2_running(&state))
}

#[tauri::command]
pub fn set_difficulty(
    csgo: String,
    level: String,
    state: State<'_, PanelState>,
) -> Result<DifficultyInfo, AppError> {
    let running = cs2_running(&state);
    let result = apply_difficulty(Path::new(&csgo), &level);
    match result {
        Ok(()) => {
            let mut config = m(&state.config);
            config.difficulty = Some(level);
            drop(config);
            persist(&state);
            Ok(difficulty_state(&csgo, running))
        }
        // While CS2 runs the active profile may be locked. The user is about to
        // restart anyway, and the UI already shows yellow for that, so remember
        // the choice and let the restart pick it up rather than erroring.
        Err(err) if running => {
            let mut config = m(&state.config);
            config.difficulty = Some(level);
            drop(config);
            persist(&state);
            let _ = err;
            Ok(difficulty_state(&csgo, running))
        }
        Err(err) => Err(err),
    }
}

// ---------------------------------------------------------------------------
// Commands — game mode
// ---------------------------------------------------------------------------

/// Swap `gameinfo.gi` for the chosen mode's copy. Bot Mode ships one with an
/// `addons\metamod` search path; Online ships Valve's stock file, so the two
/// never collide.
fn apply_mode(csgo: &Path, mode: &str) -> Result<(), AppError> {
    let folder = match mode {
        "online" => "Online",
        "bots" => "WithBots",
        other => return Err(AppError::invalid(format!("unknown mode {other}"))),
    };
    let source = csgo.join("backup").join(folder).join("gameinfo.gi");
    copy_if_different(&source, &csgo.join("gameinfo.gi"))
}

fn mode_state(state: &PanelState, csgo: &str, running: bool, user_count: usize) -> ModeInfo {
    let base = Path::new(csgo);
    let gameinfo = base.join("gameinfo.gi");
    let online = base.join("backup").join("Online").join("gameinfo.gi");
    let bots = base.join("backup").join("WithBots").join("gameinfo.gi");
    let online_present = online.is_file();
    let bots_present = bots.is_file();

    let current = if files_equal(&gameinfo, &online) {
        Some("online".to_string())
    } else if files_equal(&gameinfo, &bots) {
        Some("bots".to_string())
    } else {
        None
    };

    let (remembered, insecure) = {
        let config = m(&state.config);
        (config.mode.clone(), config.insecure)
    };

    ModeInfo {
        pending: running && current.is_some() && remembered != current,
        current,
        online_present,
        bots_present,
        insecure,
        user_count,
        cs2_running: running,
    }
}

#[tauri::command]
pub fn get_mode(csgo: String, state: State<'_, PanelState>) -> ModeInfo {
    let running = cs2_running(&state);
    let info = mode_state(&state, &csgo, running, steam_user_count());
    // Learn the mode the installation is in, so the first run has something to
    // compare against instead of reporting a spurious pending change.
    if m(&state.config).mode.is_none() {
        if let Some(current) = &info.current {
            m(&state.config).mode = Some(current.clone());
            persist(&state);
        }
    }
    info
}

#[tauri::command]
pub fn set_mode(
    csgo: String,
    mode: String,
    state: State<'_, PanelState>,
) -> Result<ModeInfo, AppError> {
    if mode != "online" && mode != "bots" {
        return Err(AppError::invalid(format!("unknown mode {mode}")));
    }
    let running = cs2_running(&state);
    let insecure = mode == "bots";

    // CS2 holds gameinfo.gi open while it runs, and reads it only at startup —
    // so defer rather than fight the lock. The frontend turns the control yellow
    // because cs2_running is true.
    if !running {
        apply_mode(Path::new(&csgo), &mode)?;
    }

    {
        let mut config = m(&state.config);
        config.mode = Some(mode);
        config.insecure = insecure;
    }
    persist(&state);

    let users = reconcile_launch_options_for(insecure);
    Ok(mode_state(&state, &csgo, running, users.max(steam_user_count())))
}

#[tauri::command]
pub fn reconcile_launch_options(state: State<'_, PanelState>) -> usize {
    let insecure = m(&state.config).insecure;
    reconcile_launch_options_for(insecure)
}

#[tauri::command]
pub fn launch_cs2(state: State<'_, PanelState>) -> Result<LaunchResult, AppError> {
    let insecure = m(&state.config).insecure;
    // Make sure the flag matches the remembered mode before handing off to Steam.
    reconcile_launch_options_for(insecure);

    let options = if insecure { INSECURE_FLAG.to_string() } else { String::new() };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "steam://rungameid/730"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(AppError::launch)?;
    }
    #[cfg(not(windows))]
    return Err(AppError::launch("launching CS2 is Windows-only"));

    Ok(LaunchResult { options, insecure })
}

/// Keep CounterStrikeSharp's `FollowCS2ServerGuidelines` in step with the Skins
/// toggle: cosmetics on → the flag is off, cosmetics off → the flag is on.
fn reconcile_core_json_file(csgo: &Path, skins_on: bool) -> Result<(), AppError> {
    let path = join_all(csgo, CORE_JSON_REL);
    if !path.is_file() {
        return Ok(());
    }
    let text = fs::read_to_string(&path).map_err(AppError::io)?;
    let want = !skins_on;
    let Some(updated) = set_json_bool(&text, "FollowCS2ServerGuidelines", want) else {
        return Ok(());
    };
    if updated == text {
        return Ok(());
    }
    atomic_write(&path, updated.as_bytes()).map_err(AppError::io)
}

/// Replace one JSON boolean in place, leaving the file's own formatting (which
/// CounterStrikeSharp rewrites anyway) intact.
fn set_json_bool(text: &str, key: &str, value: bool) -> Option<String> {
    let needle = format!("\"{key}\"");
    let key_at = text.find(&needle)?;
    let after_key = key_at + needle.len();
    let colon = after_key + text[after_key..].find(':')?;
    let value_start = colon + 1 + text[colon + 1..].len().saturating_sub(text[colon + 1..].trim_start().len());
    let tail = &text[value_start..];
    let literal = if tail.starts_with("true") {
        "true"
    } else if tail.starts_with("false") {
        "false"
    } else {
        return None;
    };
    let mut out = String::with_capacity(text.len() + 1);
    out.push_str(&text[..value_start]);
    out.push_str(if value { "true" } else { "false" });
    out.push_str(&text[value_start + literal.len()..]);
    Some(out)
}

#[tauri::command]
pub fn reconcile_core_json(csgo: String, state: State<'_, PanelState>) {
    let skins = m(&state.config).bot_items.skins;
    let _ = reconcile_core_json_file(Path::new(&csgo), skins);
}

// ---------------------------------------------------------------------------
// Commands — bot items
// ---------------------------------------------------------------------------

/// The two toggles that have a real on-disk switch, as `(enabled, disabled)`
/// folder pairs. Agents and music kits ride along with the skin randomiser: the
/// package ships no separate switch for them.
fn plugin_folders(csgo: &Path, item: &str) -> Option<(PathBuf, PathBuf)> {
    let addons = csgo.join("addons");
    match item {
        "skins" => {
            let plugins = addons.join("counterstrikesharp").join("plugins");
            Some((plugins.join("BotRandomizer"), plugins.join("BotRandomizer_disabled")))
        }
        "profiles" => Some((addons.join("BotHider"), addons.join("BotHider_disabled"))),
        _ => None,
    }
}

fn set_plugin_enabled(csgo: &Path, item: &str, on: bool) -> Result<(), AppError> {
    let Some((enabled, disabled)) = plugin_folders(csgo, item) else {
        return Ok(()); // no on-disk switch — remembered in the config only
    };
    let (from, to) = if on { (&disabled, &enabled) } else { (&enabled, &disabled) };
    if !from.is_dir() {
        // Already in the requested state, or the plugin is not installed at all.
        return Ok(());
    }
    if to.exists() {
        return Err(AppError::io(format!(
            "{} already exists — refusing to overwrite it",
            to.display()
        )));
    }
    fs::rename(from, to).map_err(AppError::io)
}

fn folder_enabled(dir: &Path, name: &str) -> bool {
    dir.join(name).is_dir() && !dir.join(format!("{name}_disabled")).is_dir()
}

fn seed_bot_items(state: &PanelState, csgo: &str) {
    let mut seeded = m(&state.items_seeded);
    if *seeded {
        return;
    }
    let base = Path::new(csgo);
    let plugins = base.join("addons").join("counterstrikesharp").join("plugins");
    let addons = base.join("addons");
    let mut config = m(&state.config);
    config.bot_items.skins = folder_enabled(&plugins, "BotRandomizer");
    config.bot_items.profiles = folder_enabled(&addons, "BotHider");
    *seeded = true;
}

fn bot_items_state(state: &PanelState, csgo: &str, running: bool) -> BotItemsState {
    seed_bot_items(state, csgo);
    let items = m(&state.config).bot_items.clone();
    BotItemsState {
        skins: items.skins,
        profiles: items.profiles,
        agents: items.agents,
        music: items.music,
        cfg_present: cfg_file(csgo).is_file(),
        cs2_running: running,
    }
}

#[tauri::command]
pub fn get_bot_items(csgo: String, state: State<'_, PanelState>) -> BotItemsState {
    let running = cs2_running(&state);
    bot_items_state(&state, &csgo, running)
}

#[tauri::command]
pub fn set_bot_item(
    csgo: String,
    item: String,
    on: bool,
    state: State<'_, PanelState>,
) -> Result<BotItemsState, AppError> {
    let running = cs2_running(&state);

    // CS2 maps the plugin DLLs, so renaming the folder while it runs fails. The
    // panel reports that as "restart to apply" instead of an error.
    if !running {
        set_plugin_enabled(Path::new(&csgo), &item, on)?;
    }

    {
        let mut config = m(&state.config);
        let items = &mut config.bot_items;
        match item.as_str() {
            "skins" => items.skins = on,
            "profiles" => items.profiles = on,
            "agents" => items.agents = on,
            "music" => items.music = on,
            _ => {}
        }
    }
    persist(&state);

    // The Skins toggle and CounterStrikeSharp's guidelines flag move together.
    if item == "skins" {
        let _ = reconcile_core_json_file(Path::new(&csgo), on);
    }
    Ok(bot_items_state(&state, &csgo, running))
}

// ---------------------------------------------------------------------------
// Commands — aim / nades presets
// ---------------------------------------------------------------------------

/// The managed preset block the Panel keeps at the end of the bot config.
///
/// The bot config is exec'd by the game, so `bot_aim` / `bot_nades` written here
/// are delivered as console commands at load — which is the only way these
/// presets reach the plugin. The markers are ASCII-only on purpose: the game
/// parses this file, not just we do.
const PRESETS_BEGIN: &str =
    "// >>> CS2 Bot Improver Panel - managed presets, edits in this block are overwritten";
const PRESETS_END: &str = "// <<< CS2 Bot Improver Panel - managed presets";

const AIM_VALUES: &[&str] = &["head", "mixed", "body"];
const NADES_VALUES: &[&str] = &["max", "more", "normal", "off"];

/// Read the managed block out of a bot config. Returns `(aim, nades)`.
fn parse_presets(text: &str) -> (Option<String>, Option<String>) {
    let mut aim = None;
    let mut nades = None;
    let mut inside = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed == PRESETS_BEGIN {
            inside = true;
            continue;
        }
        if trimmed == PRESETS_END {
            inside = false;
            continue;
        }
        if !inside {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("bot_aim ") {
            aim = Some(value.trim().to_string());
        } else if let Some(value) = trimmed.strip_prefix("bot_nades ") {
            nades = Some(value.trim().to_string());
        }
    }
    (aim, nades)
}

/// Write (or drop) the managed block. Only those few lines move; the rest of the
/// file — including the aliases and the knife bind — is copied through verbatim.
/// Returns true when the file changed.
fn rewrite_presets(
    path: &Path,
    aim: Option<&str>,
    nades: Option<&str>,
) -> Result<bool, AppError> {
    if !path.is_file() {
        return Err(AppError::missing(path.display().to_string()));
    }
    let text = fs::read_to_string(path).map_err(AppError::io)?;
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = text.split(eol).collect();

    let begin = lines.iter().position(|l| l.trim() == PRESETS_BEGIN);
    let end = lines.iter().position(|l| l.trim() == PRESETS_END);

    let mut wanted: Vec<String> = Vec::new();
    if let Some(value) = aim {
        wanted.push(format!("bot_aim {value}"));
    }
    if let Some(value) = nades {
        wanted.push(format!("bot_nades {value}"));
    }

    let mut out: Vec<String> = Vec::new();
    match (begin, end) {
        // Replacing an existing block.
        (Some(b), Some(e)) if e > b => {
            // Dropping the block takes the blank line that introduced it with it.
            let head = if wanted.is_empty() && b > 0 && lines[b - 1].trim().is_empty() {
                b - 1
            } else {
                b
            };
            out.extend(lines[..head].iter().map(|l| l.to_string()));
            if !wanted.is_empty() {
                out.push(PRESETS_BEGIN.to_string());
                out.extend(wanted.iter().cloned());
                out.push(PRESETS_END.to_string());
            }
            out.extend(lines[e + 1..].iter().map(|l| l.to_string()));
        }
        // No block yet: append one, separated by a blank line.
        _ => {
            out.extend(lines.iter().map(|l| l.to_string()));
            if !wanted.is_empty() {
                // A file that ends with a newline leaves a trailing empty
                // element in `lines`. Insert the block in front of it so the
                // result gains exactly one blank line and keeps its final
                // newline, rather than gaining two.
                let trailing_newline = out.last().map(|l| l.is_empty()).unwrap_or(false);
                if trailing_newline {
                    out.pop();
                }
                out.push(String::new());
                out.push(PRESETS_BEGIN.to_string());
                out.extend(wanted.iter().cloned());
                out.push(PRESETS_END.to_string());
                if trailing_newline {
                    out.push(String::new());
                }
            }
        }
    }

    let joined = out.join(eol);
    if joined == text {
        return Ok(false);
    }
    atomic_write(path, joined.as_bytes()).map_err(AppError::io)?;
    Ok(true)
}

fn presets_state(state: &PanelState, csgo: &str, running: bool) -> PresetsState {
    let cfg = cfg_file(csgo);
    let cfg_present = cfg.is_file();
    // The config file is what the game will actually read, so it wins when it
    // says something; the remembered values cover one that has none yet.
    let (aim, nades) = match fs::read_to_string(&cfg) {
        Ok(text) => parse_presets(&text),
        Err(_) => (None, None),
    };
    let config = m(&state.config);
    PresetsState {
        aim: aim.or_else(|| config.aim.clone()),
        nades: nades.or_else(|| config.nades.clone()),
        cfg_present,
        cs2_running: running,
    }
}

#[tauri::command]
pub fn get_presets(csgo: String, state: State<'_, PanelState>) -> PresetsState {
    let running = cs2_running(&state);
    presets_state(&state, &csgo, running)
}

/// Reject anything the plugin does not understand before it reaches the config
/// file — a bad value there would be exec'd by the game as a console command.
fn validate_presets(aim: Option<&str>, nades: Option<&str>) -> Result<(), AppError> {
    if let Some(value) = aim {
        if !AIM_VALUES.contains(&value) {
            return Err(AppError::invalid(format!("unknown aim mode {value}")));
        }
    }
    if let Some(value) = nades {
        if !NADES_VALUES.contains(&value) {
            return Err(AppError::invalid(format!("unknown nade mode {value}")));
        }
    }
    Ok(())
}

/// Shared write path for both presets: one value changes, the other is carried
/// over from the current state so the pair never loses a half.
fn apply_presets(
    csgo: &str,
    aim: Option<String>,
    nades: Option<String>,
    state: &PanelState,
) -> Result<PresetsState, AppError> {
    validate_presets(aim.as_deref(), nades.as_deref())?;

    rewrite_presets(&cfg_file(csgo), aim.as_deref(), nades.as_deref())?;

    {
        let mut config = m(&state.config);
        if let Some(value) = aim {
            config.aim = Some(value);
        }
        if let Some(value) = nades {
            config.nades = Some(value);
        }
    }
    persist(state);

    let running = cs2_running(state);
    Ok(presets_state(state, csgo, running))
}

#[tauri::command]
pub fn set_aim(
    csgo: String,
    value: String,
    state: State<'_, PanelState>,
) -> Result<PresetsState, AppError> {
    let carried = presets_state(&state, &csgo, false).nades;
    apply_presets(&csgo, Some(value), carried, &state)
}

#[tauri::command]
pub fn set_nades(
    csgo: String,
    value: String,
    state: State<'_, PanelState>,
) -> Result<PresetsState, AppError> {
    let carried = presets_state(&state, &csgo, false).aim;
    apply_presets(&csgo, carried, Some(value), &state)
}

// ---------------------------------------------------------------------------
// Commands — drop knives
// ---------------------------------------------------------------------------

fn cfg_file(csgo: &str) -> PathBuf {
    join_all(Path::new(csgo), CFG_REL)
}

fn drop_knives_state(state: &PanelState, csgo: &str, running: bool) -> DropKnivesState {
    let cfg = cfg_file(csgo);
    let cfg_present = cfg.is_file();
    let config = m(&state.config).clone();
    let mut bind_key = config.drop_knife_bind.clone();
    let mut selected = config.drop_knife_subclasses.clone();
    // Let the config file on disk win when it has a binding — that is the value
    // the game will actually honour.
    if cfg_present {
        if let Ok(text) = fs::read_to_string(&cfg) {
            if let Some((key, ids)) = parse_knife_bind(&text) {
                bind_key = key;
                selected = ids;
            }
        }
    }
    DropKnivesState { bind_key, selected, cfg_present, cs2_running: running }
}

#[tauri::command]
pub fn get_drop_knives(csgo: String, state: State<'_, PanelState>) -> DropKnivesState {
    let running = cs2_running(&state);
    drop_knives_state(&state, &csgo, running)
}

#[tauri::command]
pub fn set_drop_knives(
    csgo: String,
    bind_key: String,
    selected: Vec<u32>,
    state: State<'_, PanelState>,
) -> Result<DropKnivesState, AppError> {
    // A cfg is read once at launch, so writing it while CS2 runs is safe: the
    // change simply takes effect on the next session, which the UI indicates.
    rewrite_knife_bind(&cfg_file(&csgo), &bind_key, &selected)?;
    {
        let mut config = m(&state.config);
        config.drop_knife_bind = bind_key;
        config.drop_knife_subclasses = selected;
    }
    persist(&state);
    let running = cs2_running(&state);
    Ok(drop_knives_state(&state, &csgo, running))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_tree(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("panel-test-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp tree");
        path
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, contents).expect("write file");
    }

    #[test]
    fn launch_option_token_is_added_and_removed_without_touching_others() {
        let base = "-novid -disable_workshop_command_filtering";
        let with = set_token(base, INSECURE_FLAG, true);
        assert_eq!(with, "-novid -disable_workshop_command_filtering -insecure");
        assert!(has_token(&with, "-insecure"));
        let without = set_token(&with, INSECURE_FLAG, false);
        assert_eq!(without, base);
        assert!(!has_token(&without, "-insecure"));
        // Idempotent: re-adding an existing flag must not duplicate it.
        assert_eq!(set_token(&with, INSECURE_FLAG, true), with);
    }

    #[test]
    fn vdf_reads_and_replaces_launch_options_in_place() {
        let dir = temp_tree("vdf-replace");
        let path = dir.join("localconfig.vdf");
        write(
            &path,
            "\"UserLocalConfigStore\"\n{\n\t\"apps\"\n\t{\n\t\t\"730\"\n\t\t{\n\t\t\t\"LaunchOptions\"\t\t\"-novid\"\n\t\t\t\"LastPlayed\"\t\t\"1700000000\"\n\t\t}\n\t}\n}\n",
        );
        assert_eq!(read_launch_options(&path).as_deref(), Some("-novid"));

        assert!(write_launch_options(&path, "-novid -insecure").unwrap());
        let updated = fs::read_to_string(&path).unwrap();
        assert!(updated.contains("\"LaunchOptions\"\t\t\"-novid -insecure\""));
        // Neighbouring settings and every brace survive.
        assert!(updated.contains("\"LastPlayed\"\t\t\"1700000000\""));
        assert_eq!(updated.matches('{').count(), updated.matches('}').count());
        // A second identical write is a no-op, so the boot reconcile is free.
        assert!(!write_launch_options(&path, "-novid -insecure").unwrap());
        assert!(dir.join("localconfig.vdf.bak").is_file());
    }

    #[test]
    fn vdf_inserts_launch_options_when_the_app_block_has_none() {
        let dir = temp_tree("vdf-insert");
        let path = dir.join("localconfig.vdf");
        write(
            &path,
            "\"UserLocalConfigStore\"\n{\n\t\"apps\"\n\t{\n\t\t\"730\"\n\t\t{\n\t\t\t\"LastPlayed\"\t\t\"1700000000\"\n\t\t}\n\t}\n}\n",
        );
        assert_eq!(read_launch_options(&path), None);
        assert!(write_launch_options(&path, "-insecure").unwrap());
        assert_eq!(read_launch_options(&path).as_deref(), Some("-insecure"));
        let updated = fs::read_to_string(&path).unwrap();
        assert_eq!(updated.matches('{').count(), updated.matches('}').count());
        assert!(updated.contains("\"LastPlayed\""));
    }

    #[test]
    fn vdf_next_app_block_is_not_confused_with_730() {
        let dir = temp_tree("vdf-siblings");
        let path = dir.join("localconfig.vdf");
        write(
            &path,
            "\"UserLocalConfigStore\"\n{\n\t\"apps\"\n\t{\n\t\t\"440\"\n\t\t{\n\t\t\t\"LaunchOptions\"\t\t\"-dxlevel 90\"\n\t\t}\n\t\t\"730\"\n\t\t{\n\t\t\t\"LaunchOptions\"\t\t\"-novid\"\n\t\t}\n\t\t\"620\"\n\t\t{\n\t\t\t\"LaunchOptions\"\t\t\"-console\"\n\t\t}\n\t}\n}\n",
        );
        assert_eq!(read_launch_options(&path).as_deref(), Some("-novid"));
        assert!(write_launch_options(&path, "").unwrap());
        let updated = fs::read_to_string(&path).unwrap();
        assert!(updated.contains("730"));
        assert_eq!(read_launch_options(&path).as_deref(), Some(""));
        assert_eq!(updated.matches("LaunchOptions").count(), 3);
    }

    #[test]
    fn difficulty_swap_copies_the_selected_profile_and_detects_it() {
        let dir = temp_tree("difficulty");
        let overrides = dir.join("overrides");
        write(&overrides.join("Medium").join("botprofile.vpk"), "medium-profile");
        write(&overrides.join("High").join("botprofile.vpk"), "high-profile");
        write(&dir.join("gameinfo.gi"), "gi");
        let csgo = dir.to_string_lossy().to_string();

        // Nothing active yet.
        let before = difficulty_state(&csgo, false);
        assert!(!before.active_present);
        assert_eq!(before.current, None);
        assert_eq!(before.available, vec!["Medium".to_string(), "High".to_string()]);

        apply_difficulty(&dir, "High").unwrap();
        let after = difficulty_state(&csgo, false);
        assert!(after.active_present);
        assert_eq!(after.current.as_deref(), Some("High"));

        apply_difficulty(&dir, "Medium").unwrap();
        assert_eq!(difficulty_state(&csgo, false).current.as_deref(), Some("Medium"));

        // An unknown level is refused rather than guessed at.
        assert!(apply_difficulty(&dir, "Insane").is_err());
        // A missing level's file is a clean error, not a partial write.
        assert!(matches!(apply_difficulty(&dir, "Low"), Err(AppError { .. })));
    }

    #[test]
    fn mode_swap_uses_the_right_gameinfo_and_only_when_needed() {
        let dir = temp_tree("mode");
        write(&dir.join("backup").join("Online").join("gameinfo.gi"), "stock-gi");
        write(&dir.join("backup").join("WithBots").join("gameinfo.gi"), "modded-gi");
        let csgo = dir.to_string_lossy().to_string();

        apply_mode(&dir, "bots").unwrap();
        assert_eq!(fs::read_to_string(dir.join("gameinfo.gi")).unwrap(), "modded-gi");
        assert_eq!(mode_state(&PanelState::default(), &csgo, false, 0).current.as_deref(), Some("bots"));

        apply_mode(&dir, "online").unwrap();
        assert_eq!(fs::read_to_string(dir.join("gameinfo.gi")).unwrap(), "stock-gi");
        assert_eq!(mode_state(&PanelState::default(), &csgo, false, 0).current.as_deref(), Some("online"));

        assert!(apply_mode(&dir, "nonsense").is_err());
    }

    #[test]
    fn core_json_flag_keeps_formatting_and_tracks_the_skins_toggle() {
        let dir = temp_tree("corejson");
        let path = join_all(&dir, CORE_JSON_REL);
        let original = "{\n    \"PublicChatTrigger\": [ \"!\" ],\n    \"FollowCS2ServerGuidelines\": false,\n    \"UnlockConCommands\": true\n}\n";
        write(&path, original);

        // Skins off → guidelines on.
        reconcile_core_json_file(&dir, false).unwrap();
        let updated = fs::read_to_string(&path).unwrap();
        assert!(updated.contains("\"FollowCS2ServerGuidelines\": true"));
        assert!(updated.contains("    \"UnlockConCommands\": true")); // 4-space indent kept
        assert!(updated.contains("[ \"!\" ]"));

        // Already correct → no rewrite at all, so no timestamp churn.
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        reconcile_core_json_file(&dir, false).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);

        reconcile_core_json_file(&dir, true).unwrap();
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("\"FollowCS2ServerGuidelines\": false"));
    }

    #[test]
    fn json_bool_replacement_is_surgical() {
        let text = "{\"a\":true,\"FollowCS2ServerGuidelines\":false,\"b\":\"false\"}";
        assert_eq!(
            set_json_bool(text, "FollowCS2ServerGuidelines", true).unwrap(),
            "{\"a\":true,\"FollowCS2ServerGuidelines\":true,\"b\":\"false\"}"
        );
        // A missing key, or one that is not a boolean literal, is left alone.
        assert_eq!(set_json_bool(text, "nope", true), None);
        assert_eq!(set_json_bool("{\"k\": \"x\"}", "k", true), None);
    }

    #[test]
    fn plugin_folders_rename_in_both_directions() {
        let dir = temp_tree("plugins");
        let plugins = dir.join("addons").join("counterstrikesharp").join("plugins");
        write(&plugins.join("BotRandomizer").join("BotRandomizer.dll"), "dll");
        write(&dir.join("addons").join("BotHider").join("bot.dll"), "dll");

        assert!(folder_enabled(&plugins, "BotRandomizer"));

        set_plugin_enabled(&dir, "skins", false).unwrap();
        assert!(plugins.join("BotRandomizer_disabled").is_dir());
        assert!(!folder_enabled(&plugins, "BotRandomizer"));

        set_plugin_enabled(&dir, "skins", true).unwrap();
        assert!(folder_enabled(&plugins, "BotRandomizer"));

        // Repeating the current state is a no-op, not an error.
        set_plugin_enabled(&dir, "skins", true).unwrap();
        // Agents/music have no on-disk switch and must not error.
        set_plugin_enabled(&dir, "agents", false).unwrap();

        // Renaming onto an existing folder is refused instead of clobbering it.
        write(&plugins.join("BotRandomizer_disabled").join("x"), "x");
        assert!(set_plugin_enabled(&dir, "skins", false).is_err());
    }

    #[test]
    fn knife_bind_line_is_rewritten_in_place() {
        let dir = temp_tree("bind");
        let cfg = cfg_file(&dir.to_string_lossy());
        write(
            &cfg,
            "sv_cheats 1\nmp_c4timer 50\n\nbind \\ \"subclass_create 500;subclass_create 503\"\nalias bot_buy \"exec bot_buy.cfg\"\n",
        );

        let (key, ids) = parse_knife_bind(&fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(key, "\\");
        assert_eq!(ids, vec![500, 503]);

        rewrite_knife_bind(&cfg, "v", &[507, 509]).unwrap();
        let text = fs::read_to_string(&cfg).unwrap();
        assert!(text.contains("bind v \"subclass_create 507;subclass_create 509\""));
        assert!(text.contains("sv_cheats 1"));
        assert!(text.contains("mp_c4timer 50"));
        assert!(text.contains("alias bot_buy \"exec bot_buy.cfg\""));
        assert_eq!(text.lines().count(), 5);
        assert_eq!(parse_knife_bind(&text).unwrap().1, vec![507, 509]);

        // Rewriting the same values again must not touch the file.
        let before = fs::metadata(&cfg).unwrap().modified().unwrap();
        rewrite_knife_bind(&cfg, "v", &[507, 509]).unwrap();
        assert_eq!(fs::metadata(&cfg).unwrap().modified().unwrap(), before);

        // A cfg with no binding gets one appended.
        let plain = dir.join("cfg").join("other.cfg");
        write(&plain, "sv_cheats 1\n");
        rewrite_knife_bind(&plain, "\\", &[500]).unwrap();
        assert!(fs::read_to_string(&plain).unwrap().contains("bind \\ \"subclass_create 500\""));
    }

    #[test]
    fn knife_bind_handles_multi_char_keys_and_crlf() {
        let dir = temp_tree("bind-crlf");
        let cfg = cfg_file(&dir.to_string_lossy());
        write(&cfg, "bind f1 \"subclass_create 500\"\r\nsv_cheats 1\r\n");
        rewrite_knife_bind(&cfg, "f2", &[500, 512]).unwrap();
        let text = fs::read_to_string(&cfg).unwrap();
        assert!(text.contains("bind f2 \"subclass_create 500;subclass_create 512\"\r\n"));
        // CRLF must survive, otherwise every line of the file changes.
        assert!(text.contains("sv_cheats 1\r\n"));
    }

    #[test]
    fn validate_files_reports_exactly_the_missing_entries() {
        let dir = temp_tree("validate");
        write(&dir.join("gameinfo.gi"), "gi");
        write(&dir.join("addons").join("metamod.vdf"), "vdf");
        let report = validate_files(dir.to_string_lossy().to_string());
        assert_eq!(report.total, REQUIRED.len());
        assert_eq!(report.present, 2);
        assert!(!report.ok);
        assert!(!report.missing.contains(&"gameinfo.gi".to_string()));
        assert!(report.missing.contains(&"addons\\metamod_x64.vdf".to_string()));
        assert_eq!(report.missing.len(), REQUIRED.len() - 2);
    }

    #[test]
    fn misplaced_detection_finds_a_nested_extraction() {
        let dir = temp_tree("misplaced");
        write(&dir.join("gameinfo.gi"), "gi");
        // The package was extracted one level too deep.
        write(&dir.join("CS2BotImprover").join("addons").join("metamod.vdf"), "vdf");
        let report = validate_files(dir.to_string_lossy().to_string());
        assert_eq!(
            report.misplaced.as_deref(),
            Some(dir.join("CS2BotImprover").to_string_lossy().as_ref())
        );
    }

    #[test]
    fn cleanup_only_removes_the_legacy_backups_it_owns() {
        let dir = temp_tree("cleanup");
        write(&dir.join("gameinfo.gi.bak"), "legacy");
        write(&dir.join("overrides").join("botprofile.vpk.bak"), "legacy");
        write(&dir.join("cfg").join("my_bot_normal_config.cfg.bak"), "legacy");
        // Untouched: a user's own backup, and the live files.
        write(&dir.join("gameinfo.gi"), "live");
        write(&dir.join("cfg").join("gamemode_competitive.cfg.bak"), "user's own");
        write(&dir.join("addons").join("notes.bak"), "user's own");

        assert_eq!(cleanup_legacy_backups(&dir), 3);
        assert!(dir.join("gameinfo.gi").is_file());
        assert!(dir.join("cfg").join("gamemode_competitive.cfg.bak").is_file());
        assert!(dir.join("addons").join("notes.bak").is_file());
        assert!(!dir.join("gameinfo.gi.bak").exists());
    }

    #[test]
    fn directory_resolution_accepts_all_three_shapes() {
        let dir = temp_tree("resolve");
        let csgo = dir.join("game").join("csgo");
        write(&csgo.join("gameinfo.gi"), "gi");
        let csgo_str = csgo.to_string_lossy().to_string();
        let root_str = dir.to_string_lossy().to_string();

        assert_eq!(resolve_csgo_dir(&csgo_str).as_deref(), Some(csgo_str.as_str()));
        assert_eq!(resolve_csgo_dir(&root_str).as_deref(), Some(csgo_str.as_str()));
        assert_eq!(resolve_csgo_dir("Z:\\nope"), None);
    }

    #[test]
    fn config_round_trips_through_disk() {
        let dir = temp_tree("config");
        let path = dir.join("config.json");
        let mut config = AppConfig::default();
        config.language = Some("zh-CN".into());
        config.first_run_done = true;
        config.aim = Some("head".into());
        config.drop_knife_subclasses = vec![500, 503];
        fs::write(&path, serde_json::to_string_pretty(&config).unwrap()).unwrap();

        let loaded = load_config(&path).expect("config loads");
        assert_eq!(loaded.language.as_deref(), Some("zh-CN"));
        assert_eq!(loaded.aim.as_deref(), Some("head"));
        assert_eq!(loaded.drop_knife_subclasses, vec![500, 503]);
        assert!(loaded.first_run_done);
    }

    #[test]
    fn config_tolerates_missing_and_partial_files() {
        let dir = temp_tree("config-partial");
        let path = dir.join("config.json");
        // Absent file → the caller falls back to defaults.
        assert!(load_config(&path).is_none());
        // A config written by an older build, missing newer keys, still loads.
        fs::write(&path, "{\"language\":\"ru\",\"first_run_done\":true}").unwrap();
        let loaded = load_config(&path).expect("partial config loads");
        assert_eq!(loaded.language.as_deref(), Some("ru"));
        assert!(loaded.insecure == false);
        assert_eq!(loaded.drop_knife_bind, "\\");
        // Garbage is not a config.
        fs::write(&path, "not json").unwrap();
        assert!(load_config(&path).is_none());
    }

    #[test]
    fn reconcile_touches_only_accounts_that_have_cs2() {
        let dir = temp_tree("reconcile");
        // Owns CS2, no launch options yet.
        let owner = dir.join("owner.vdf");
        write(
            &owner,
            "\"UserLocalConfigStore\"\n{\n\t\"apps\"\n\t{\n\t\t\"730\"\n\t\t{\n\t\t\t\"LastPlayed\"\t\t\"1700000000\"\n\t\t}\n\t}\n}\n",
        );
        // Never launched CS2.
        let other = dir.join("other.vdf");
        write(
            &other,
            "\"UserLocalConfigStore\"\n{\n\t\"apps\"\n\t{\n\t\t\"440\"\n\t\t{\n\t\t\t\"LastPlayed\"\t\t\"1\"\n\t\t}\n\t}\n}\n",
        );

        // Going online with nothing to remove is a no-op, not an insertion.
        assert!(!reconcile_localconfig(&owner, false));
        assert_eq!(read_launch_options(&owner), None);
        // Nothing was written, so no backup was taken either.
        assert!(!owner.with_extension("vdf.bak").exists());

        // Bot Mode inserts the flag.
        assert!(reconcile_localconfig(&owner, true));
        assert_eq!(read_launch_options(&owner).as_deref(), Some("-insecure"));
        // ...and the same again is a no-op, so a restart does not rewrite it.
        assert!(!reconcile_localconfig(&owner, true));
        // Back to online removes it.
        assert!(reconcile_localconfig(&owner, false));
        assert_eq!(read_launch_options(&owner).as_deref(), Some(""));

        // A Steam account that has never seen CS2 is left completely alone.
        let before = fs::read_to_string(&other).unwrap();
        assert!(!reconcile_localconfig(&other, true));
        assert_eq!(fs::read_to_string(&other).unwrap(), before);
        assert!(!other.with_extension("vdf.bak").exists());
    }

    #[test]
    fn launch_options_preserve_the_user_s_other_flags() {
        let dir = temp_tree("reconcile-flags");
        let path = dir.join("user.vdf");
        write(
            &path,
            "\"UserLocalConfigStore\"\n{\n\t\"apps\"\n\t{\n\t\t\"730\"\n\t\t{\n\t\t\t\"LaunchOptions\"\t\t\"-novid -disable_workshop_command_filtering\"\n\t\t}\n\t}\n}\n",
        );
        assert!(reconcile_localconfig(&path, true));
        let options = read_launch_options(&path).unwrap();
        assert!(options.contains("-novid"));
        assert!(options.contains("-disable_workshop_command_filtering"));
        assert!(options.contains("-insecure"));
        // Exactly one -insecure, never two.
        assert_eq!(options.matches("-insecure").count(), 1);

        assert!(reconcile_localconfig(&path, false));
        let options = read_launch_options(&path).unwrap();
        assert!(!options.contains("-insecure"));
        assert!(options.contains("-novid"));
    }

    #[test]
    fn presets_block_is_appended_read_updated_and_dropped() {
        let dir = temp_tree("presets");
        let cfg = cfg_file(&dir.to_string_lossy());
        write(&cfg, "sv_cheats 1\nmp_c4timer 50\n\nalias bot_buy \"exec bot_buy.cfg\"\n");

        // Nothing managed yet.
        let text = fs::read_to_string(&cfg).unwrap();
        assert_eq!(parse_presets(&text), (None, None));

        // Appending puts the block at the end, after the file's own content,
        // with exactly one blank line between them.
        assert!(rewrite_presets(&cfg, Some("mixed"), None).unwrap());
        let text = fs::read_to_string(&cfg).unwrap();
        assert_eq!(parse_presets(&text), (Some("mixed".into()), None));
        assert_eq!(
            text,
            "sv_cheats 1\nmp_c4timer 50\n\nalias bot_buy \"exec bot_buy.cfg\"\n\n// >>> CS2 Bot Improver Panel - managed presets, edits in this block are overwritten\nbot_aim mixed\n// <<< CS2 Bot Improver Panel - managed presets\n"
        );

        // Adding nades keeps aim, and repeating it changes nothing.
        assert!(rewrite_presets(&cfg, Some("mixed"), Some("normal")).unwrap());
        let text = fs::read_to_string(&cfg).unwrap();
        assert_eq!(parse_presets(&text), (Some("mixed".into()), Some("normal".into())));
        assert_eq!(text.matches("bot_aim ").count(), 1);
        let before = fs::metadata(&cfg).unwrap().modified().unwrap();
        assert!(!rewrite_presets(&cfg, Some("mixed"), Some("normal")).unwrap());
        assert_eq!(fs::metadata(&cfg).unwrap().modified().unwrap(), before);
        // The block is replaced, never duplicated.
        assert_eq!(text.matches(PRESETS_BEGIN).count(), 1);

        // Dropping both values restores the file exactly: no block, no blank
        // line left behind, final newline intact.
        assert!(rewrite_presets(&cfg, None, None).unwrap());
        let text = fs::read_to_string(&cfg).unwrap();
        assert_eq!(text, "sv_cheats 1\nmp_c4timer 50\n\nalias bot_buy \"exec bot_buy.cfg\"\n");
        assert_eq!(parse_presets(&text), (None, None));
        // Dropping an absent block is a no-op.
        assert!(!rewrite_presets(&cfg, None, None).unwrap());
    }

    #[test]
    fn presets_block_keeps_crlf_and_ignores_the_aliases_around_it() {
        let dir = temp_tree("presets-crlf");
        let cfg = cfg_file(&dir.to_string_lossy());
        write(
            &cfg,
            "sv_cheats 1\r\nalias bot_aim_head \"bot_aim head\"\r\nalias bot_aim_body \"bot_aim body\"\r\n",
        );
        rewrite_presets(&cfg, Some("head"), Some("off")).unwrap();
        let text = fs::read_to_string(&cfg).unwrap();
        assert!(text.contains("\r\nbot_nades off\r\n"));
        // The pre-existing aliases are not mistaken for the managed block.
        assert_eq!(text.matches("alias bot_aim").count(), 2);
        assert_eq!(parse_presets(&text), (Some("head".into()), Some("off".into())));
        assert!(text.contains("bot_aim head\r\nbot_nades off\r\n"));
    }

    #[test]
    fn preset_values_are_validated_before_they_reach_the_config() {
        assert!(validate_presets(Some("mixed"), Some("normal")).is_ok());
        assert!(validate_presets(Some("head"), None).is_ok());
        assert!(validate_presets(None, None).is_ok());
        assert!(validate_presets(Some("face"), None).is_err());
        assert!(validate_presets(None, Some("lots")).is_err());
        // A value that would inject another command is refused outright.
        assert!(validate_presets(Some("head; sv_cheats 1"), None).is_err());
    }

    #[test]
    fn atomic_write_replaces_the_target_and_leaves_no_temp_file() {
        let dir = temp_tree("atomic");
        let path = dir.join("thing.txt");
        write(&path, "old");
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("panel-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
