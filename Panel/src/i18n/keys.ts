// English is the source of truth and the fallback for any missing key/locale.
// Game commands/values (head/mixed/body, max/more/normal/off, CT/T, the cfg
// directives) are intentionally NOT translated.
export const EN = {
  "tb.settings": "Settings",
  "tb.minimize": "Minimize",
  "tb.close": "Close",

  "st.directory": "Directory",
  "st.files": "Files",
  "st.allPresent": "All present",
  "st.missing": "{n} missing",
  "st.checking": "Checking…",
  "st.steamNotFound": "Steam not found",
  "st.notLocated": "game/csgo not located",
  "st.multiple": "Multiple installs — choose in Settings",
  "st.viewMissing": "View missing files",
  "st.wrongLocation": "Files are in the wrong folder — move them into game\\csgo",

  "mode.title": "Mode",
  "mode.online": "Online Mode",
  "mode.bot": "Bot Mode",
  "mode.launch": "Launch CS2",
  "mode.launching": "Launching CS2…",

  "diff.title": "Difficulty",

  "pre.title": "Presets",
  "pre.aim": "Aim",
  "pre.nades": "Nades",
  "pre.teams": "Teams",
  "pre.dropKnives": "Drop Knives",
  "pre.team": "Team",
  "pre.copy": "Copy",
  "pre.bind": "Bind",
  "pre.pressKey": "Press a key…",

  "bi.title": "Bot Items",
  "bi.skins": "Skins",
  "bi.profiles": "Profiles",
  "bi.agents": "Agents",
  "bi.music": "Music Kits",

  "cmd.title": "Commands",
  "cmd.search": "Search…",
  "cmd.h.gameMode": "GAME MODE",
  "cmd.h.connection": "CONNECTION",
  "cmd.h.aimStyle": "BOT AIM STYLE",
  "cmd.h.nadeThrowing": "BOT NADE THROWING",
  "cmd.h.botManagement": "BOT MANAGEMENT",
  "cmd.h.addTeams": "ADD TEAMS",
  "cmd.h.coordinatedBuy": "COORDINATED BUY",
  // Placeholder hints shown (non-selectable) after certain bot commands.
  "cmd.hint.botName": "bot name",
  "cmd.hint.number": "number",

  "set.title": "Settings",
  "set.devs": "Devs",
  "set.languages": "Languages",
  "set.directory": "Directory",
  "set.updates": "Updates",
  "set.project": "Project",
  "set.browse": "Browse…",
  "set.steamNotDetected": "Steam was not detected. Use Browse to locate game/csgo.",
  "set.noCsgo": "No game/csgo directories detected.",

  // Updates page. {v} is the release tag and {t} a formatted date; the version
  // numbers themselves are never translated.
  "upd.auto": "Check for updates automatically",
  "upd.autoHint": "Reads the public GitHub Releases API on startup.",
  "upd.current": "Installed version",
  "upd.check": "Check now",
  "upd.checking": "Checking…",
  "upd.upToDate": "You are on the latest version.",
  "upd.available": "Version {v} is available",
  "upd.download": "Download installer",
  "upd.releasePage": "Open release page",
  "upd.lastChecked": "Last checked {t}",
  "upd.neverChecked": "Not checked yet",
  "upd.published": "Released {t}",
  "upd.notes": "What's new",
  "upd.noReleases": "No release has been published yet.",
  "upd.offline": "Could not reach GitHub. Check your connection and try again.",
  "upd.rateLimited": "GitHub is rate-limiting update checks. Try again later.",
  "upd.server": "GitHub returned an error. Try again later.",
  "upd.unexpected": "Unexpected response from GitHub.",
  "upd.noInstaller": "This release has no installer attached — open the release page instead.",
  "upd.newVersion": "Update available",

  "ctx.refresh": "Refresh",

  "common.ok": "OK",
  "common.copied": "Copied",
  "common.copyFailed": "Copy failed",
  "common.nothingToCopy": "Nothing to copy",
  "common.restart": "Applied — restart CS2",
  "err.title": "Something went wrong",
  "err.missingFiles": "Missing files",
  "err.copyCode": "Copy error code",

  // Per-category user-facing messages (chosen by AppError.category).
  "errcat.path": "A required file or folder was not found.",
  "errcat.permission": "Permission denied. Try running as administrator.",
  "errcat.steam": "Steam could not be located.",
  "errcat.parse": "A configuration file could not be read.",
  "errcat.io": "A file operation failed. Make sure CS2 is closed and try again.",
  "errcat.config": "Settings could not be saved.",
  "errcat.internal": "An unexpected error occurred.",
} as const;

export type I18nKey = keyof typeof EN;
