import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  toAppError,
  type AppConfig,
  type AppError,
  type AimValue,
  type BotItemKey,
  type BotItemsState,
  type DifficultyInfo,
  type DifficultyLevel,
  type DirectoryInfo,
  type DropKnivesState,
  type FilesReport,
  type GameMode,
  type ModeInfo,
  type NadesValue,
  type PresetsState,
} from "../lib/api";
import { checkForUpdate, type UpdateCheckResult } from "../lib/updater";

type Store = {
  ready: boolean;
  config: AppConfig | null;
  directory: DirectoryInfo | null;
  files: FilesReport | null;
  difficulty: DifficultyInfo | null;
  mode: ModeInfo | null;
  botItems: BotItemsState | null;
  presets: PresetsState | null;
  /** Per-section "changed while CS2 running, pending restart" flags. Persisted,
   *  so each yellow light survives a full close/reopen of the panel. */
  aimPending: boolean;
  nadesPending: boolean;
  modePending: boolean;
  difficultyPending: boolean;
  dropKnivesPending: boolean;
  /** Per Bot Item "changed while CS2 running, pending restart" flags — each
   *  toggle has its own yellow light; the panel's header light is yellow if any
   *  one of them is. */
  botItemsPending: Record<BotItemKey, boolean>;
  dropKnives: DropKnivesState | null;
  csgoPath: string | null;
  /** Update checker. Lives here rather than inside the Update page so the
   *  automatic check can run once at startup, whichever view is open. */
  autoUpdateCheck: boolean;
  setAutoUpdateCheck: (on: boolean) => void;
  updateResult: UpdateCheckResult | null;
  updateChecking: boolean;
  updateCheckedAt: number | null;
  checkForUpdateNow: () => Promise<void>;
  /** Last global error (for the error modal). */
  error: AppError | null;
  clearError: () => void;
  reportError: (e: unknown) => void;
  refreshDirectory: () => Promise<DirectoryInfo | null>;
  refreshFiles: () => Promise<void>;
  refreshDifficulty: () => Promise<void>;
  refreshAll: (silent?: boolean) => Promise<void>;
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>;
  chooseDirectory: (path: string) => Promise<void>;
  applyDifficulty: (level: DifficultyLevel) => Promise<DifficultyInfo | null>;
  applyMode: (mode: GameMode) => Promise<ModeInfo | null>;
  applyBotItem: (item: BotItemKey, on: boolean) => Promise<BotItemsState | null>;
  applyAim: (value: AimValue) => Promise<PresetsState | null>;
  applyNades: (value: NadesValue) => Promise<PresetsState | null>;
  applyDropKnives: (
    bindKey: string,
    selected: number[]
  ) => Promise<DropKnivesState | null>;
};

/** A boolean flag persisted in localStorage so it survives a full close/reopen
 *  of the panel (used for the per-section "changed while CS2 running" lights).
 *  `fallback` applies only while the key has never been written. */
function usePersistedFlag(key: string, fallback = false): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  });
  const set = useCallback(
    (v: boolean) => {
      setValue(v);
      try {
        localStorage.setItem(key, v ? "1" : "0");
      } catch {
        /* localStorage unavailable — fall back to in-memory only */
      }
    },
    [key]
  );
  return [value, set];
}

const BOT_ITEM_KEYS: BotItemKey[] = ["skins", "profiles", "agents", "music"];

function emptyBotItemFlags(): Record<BotItemKey, boolean> {
  return { skins: false, profiles: false, agents: false, music: false };
}

/** Like usePersistedFlag, but a per-key map (one yellow light per Bot Item)
 *  stored as a single JSON entry so all four survive a close/reopen together. */
function usePersistedFlagMap(
  key: string
): [
  Record<BotItemKey, boolean>,
  (item: BotItemKey, v: boolean) => void,
  () => void
] {
  const [map, setMap] = useState<Record<BotItemKey, boolean>>(() => {
    const base = emptyBotItemFlags();
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "{}");
      for (const k of BOT_ITEM_KEYS) if (raw[k] === true) base[k] = true;
    } catch {
      /* missing or legacy value — start all-false */
    }
    return base;
  });
  const persist = useCallback(
    (next: Record<BotItemKey, boolean>) => {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* localStorage unavailable — in-memory only */
      }
    },
    [key]
  );
  const setOne = useCallback(
    (item: BotItemKey, v: boolean) =>
      setMap((prev) => {
        const next = { ...prev, [item]: v };
        persist(next);
        return next;
      }),
    [persist]
  );
  const clearAll = useCallback(() => {
    const next = emptyBotItemFlags();
    persist(next);
    setMap(next);
  }, [persist]);
  return [map, setOne, clearAll];
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore must be used within AppStateProvider");
  return s;
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [directory, setDirectory] = useState<DirectoryInfo | null>(null);
  const [files, setFiles] = useState<FilesReport | null>(null);
  const [difficulty, setDifficulty] = useState<DifficultyInfo | null>(null);
  const [mode, setMode] = useState<ModeInfo | null>(null);
  const [botItems, setBotItems] = useState<BotItemsState | null>(null);
  const [presets, setPresets] = useState<PresetsState | null>(null);
  // Per-section "changed while CS2 running, pending restart" flags. Persisted in
  // localStorage so each light survives a full close/reopen of the panel while
  // CS2 keeps running (the boot refreshAll clears them once CS2 is not running).
  const [aimPending, setAimPending] = usePersistedFlag("cs2bi.aimPending");
  const [nadesPending, setNadesPending] = usePersistedFlag("cs2bi.nadesPending");
  const [modePending, setModePending] = usePersistedFlag("cs2bi.modePending");
  const [difficultyPending, setDifficultyPending] = usePersistedFlag("cs2bi.difficultyPending");
  const [dropKnivesPending, setDropKnivesPending] =
    usePersistedFlag("cs2bi.dropKnivesPending");
  const [botItemsPending, setBotItemPending, clearBotItemsPending] =
    usePersistedFlagMap("cs2bi.botItemsPending");
  const [dropKnives, setDropKnives] = useState<DropKnivesState | null>(null);
  // Update checking. The preference defaults to on (this is a public GitHub API
  // call, nothing about the machine is sent) but the user can switch it off, and
  // the choice is remembered like every other persisted flag in this panel.
  const [autoUpdateCheck, setAutoUpdateCheck] = usePersistedFlag("cs2bi.autoUpdateCheck", true);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateCheckedAt, setUpdateCheckedAt] = useState<number | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const configRef = useRef<AppConfig | null>(null);
  configRef.current = config;
  // Non-overlapping guard for the update probe (manual button + startup check).
  const updateCheckingRef = useRef(false);

  const reportError = useCallback((e: unknown) => setError(toAppError(e)), []);
  const clearError = useCallback(() => setError(null), []);

  const refreshFiles = useCallback(async () => {
    const csgo = directory?.valid ? directory.selected : null;
    if (!csgo) {
      setFiles(null);
      return;
    }
    try {
      setFiles(await api.validateFiles(csgo));
    } catch (e) {
      setFiles(null);
      reportError(e);
    }
  }, [directory, reportError]);

  const refreshDifficulty = useCallback(async () => {
    const csgo = directory?.valid ? directory.selected : null;
    if (!csgo) {
      setDifficulty(null);
      return;
    }
    try {
      setDifficulty(await api.getDifficulty(csgo));
    } catch (e) {
      setDifficulty(null);
      reportError(e);
    }
  }, [directory, reportError]);

  const applyDifficulty = useCallback(
    async (level: DifficultyLevel) => {
      const csgo = directory?.valid ? directory.selected : null;
      if (!csgo) return null;
      try {
        const info = await api.setDifficulty(csgo, level);
        setDifficulty(info);
        setDifficultyPending(info.cs2_running);
        return info;
      } catch (e) {
        reportError(e);
        return null;
      }
    },
    [directory, reportError]
  );

  const applyDropKnives = useCallback(
    async (bindKey: string, selected: number[]) => {
      const csgo = directory?.valid ? directory.selected : null;
      if (!csgo) return null;
      try {
        const info = await api.setDropKnives(csgo, bindKey, selected);
        setDropKnives(info);
        setDropKnivesPending(info.cs2_running);
        return info;
      } catch (e) {
        reportError(e);
        return null;
      }
    },
    [directory, reportError]
  );

  const applyAim = useCallback(
    async (value: AimValue) => {
      const csgo = directory?.valid ? directory.selected : null;
      if (!csgo) return null;
      try {
        const info = await api.setAim(csgo, value);
        setPresets(info);
        // Yellow (pending restart) only if the change was made while running.
        setAimPending(info.cs2_running);
        return info;
      } catch (e) {
        reportError(e);
        return null;
      }
    },
    [directory, reportError]
  );

  const applyNades = useCallback(
    async (value: NadesValue) => {
      const csgo = directory?.valid ? directory.selected : null;
      if (!csgo) return null;
      try {
        const info = await api.setNades(csgo, value);
        setPresets(info);
        setNadesPending(info.cs2_running);
        return info;
      } catch (e) {
        reportError(e);
        return null;
      }
    },
    [directory, reportError]
  );

  const applyBotItem = useCallback(
    async (item: BotItemKey, on: boolean) => {
      const csgo = directory?.valid ? directory.selected : null;
      if (!csgo) return null;
      try {
        const info = await api.setBotItem(csgo, item, on);
        setBotItems(info);
        // Only this item's light goes yellow, and only if changed while running.
        setBotItemPending(item, info.cs2_running);
        return info;
      } catch (e) {
        reportError(e);
        return null;
      }
    },
    [directory, reportError]
  );

  const applyMode = useCallback(
    async (m: GameMode) => {
      const csgo = directory?.valid ? directory.selected : null;
      if (!csgo) return null;
      try {
        const info = await api.setMode(csgo, m);
        setMode(info);
        setModePending(info.cs2_running);
        return info;
      } catch (e) {
        reportError(e);
        return null;
      }
    },
    [directory, reportError]
  );

  const refreshDirectory = useCallback(async () => {
    try {
      const info = await api.detectDirectories();
      setDirectory(info);
      return info;
    } catch (e) {
      reportError(e);
      return null;
    }
  }, [reportError]);

  const refreshAll = useCallback(async (silent = false) => {
    const info = await refreshDirectory();
    const csgo = info?.valid ? info.selected : null;
    if (csgo) {
      try {
        const [f, d, m, b, p, k] = await Promise.all([
          api.validateFiles(csgo),
          api.getDifficulty(csgo),
          api.getMode(csgo),
          api.getBotItems(csgo),
          api.getPresets(csgo),
          api.getDropKnives(csgo),
        ]);
        setFiles(f);
        setDifficulty(d);
        setMode(m);
        setBotItems(b);
        setPresets(p);
        setDropKnives(k);
        // Once CS2 is no longer running, any pending change has taken effect —
        // clear that section's flag (each command reports its own cs2_running).
        if (!p.cs2_running) {
          setAimPending(false);
          setNadesPending(false);
        }
        if (!d.cs2_running) setDifficultyPending(false);
        if (!m.cs2_running) setModePending(false);
        if (!b.cs2_running) clearBotItemsPending();
        if (!k.cs2_running) setDropKnivesPending(false);
      } catch (e) {
        // Background poll: a transient read error shouldn't blank the UI or pop a
        // modal — keep the last good state and wait for the next tick.
        if (silent) return;
        setFiles(null);
        setDifficulty(null);
        setMode(null);
        setBotItems(null);
        setPresets(null);
        setDropKnives(null);
        setAimPending(false);
        setNadesPending(false);
        setModePending(false);
        setDifficultyPending(false);
        clearBotItemsPending();
        setDropKnivesPending(false);
        reportError(e);
      }
    } else {
      setFiles(null);
      setDifficulty(null);
      setMode(null);
      setBotItems(null);
      setPresets(null);
      setDropKnives(null);
      setAimPending(false);
      setNadesPending(false);
      setModePending(false);
      setDifficultyPending(false);
      clearBotItemsPending();
      setDropKnivesPending(false);
    }
  }, [refreshDirectory, reportError]);

  const updateConfig = useCallback(
    async (patch: Partial<AppConfig>) => {
      const base = configRef.current;
      if (!base) return;
      const next = { ...base, ...patch };
      setConfig(next);
      try {
        await api.saveConfig(next);
      } catch (e) {
        reportError(e);
      }
    },
    [reportError]
  );

  const chooseDirectory = useCallback(
    async (path: string) => {
      try {
        const info = await api.selectDirectory(path);
        setDirectory(info);
        const csgo = info.valid ? info.selected : null;
        setFiles(csgo ? await api.validateFiles(csgo) : null);
      } catch (e) {
        reportError(e);
      }
    },
    [reportError]
  );

  // One shared code path for the Update page button and the startup probe. A
  // failed check comes back as data (UpdateCheckResult), never thrown, so a flaky
  // network shows an inline note instead of the global error modal.
  const checkForUpdateNow = useCallback(async () => {
    if (updateCheckingRef.current) return;
    updateCheckingRef.current = true;
    setUpdateChecking(true);
    try {
      setUpdateResult(await checkForUpdate());
      setUpdateCheckedAt(Date.now());
    } finally {
      updateCheckingRef.current = false;
      setUpdateChecking(false);
    }
  }, []);

  // Global safety net: surface any unexpected error/rejection as a modal so the
  // UI never fails silently.
  useEffect(() => {
    const onErr = (e: ErrorEvent) => {
      if (e.error) reportError(e.error);
    };
    const onRej = (e: PromiseRejectionEvent) => reportError(e.reason);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, [reportError]);

  // Boot: load config then detect dir + validate files.
  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.getConfig();
        setConfig(cfg);
      } catch (e) {
        reportError(e);
      }
      // Enforce the launch-option rule: disk follows the remembered -insecure.
      try {
        await api.reconcileLaunchOptions();
      } catch (e) {
        reportError(e);
      }
      const info = await refreshDirectory();
      const csgo = info?.valid ? info.selected : null;
      if (csgo) {
        try {
          await api.cleanupBackups(csgo);
        } catch {
          /* best-effort cleanup of legacy .bak files */
        }
        try {
          // Bring CounterStrikeSharp's core.json FollowCS2ServerGuidelines in
          // line with the current Skins state on every launch.
          await api.reconcileCoreJson(csgo);
        } catch {
          /* best-effort: core.json / core.example.json may be absent */
        }
      }
      await refreshAll();
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live updates: while the panel is open and visible, re-scan every 0.5s so all
  // indicator lights and buttons reflect the current on-disk / CS2-running state
  // without the user reopening the panel. Silent (never pops an error modal),
  // non-overlapping (skips a tick if the previous scan is still in flight), and
  // paused while the window is hidden/minimized to avoid needless work.
  const pollingRef = useRef(false);
  useEffect(() => {
    if (!ready) return;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        await refreshAll(true);
      } finally {
        pollingRef.current = false;
      }
    };
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [ready, refreshAll]);

  // Startup update probe: at most once per app launch, and only while the
  // preference is on (turning it on mid-session runs it too). Kept out of the
  // 500 ms status poll on purpose — the GitHub API is rate-limited per IP.
  const autoCheckedRef = useRef(false);
  useEffect(() => {
    if (!ready || !autoUpdateCheck || autoCheckedRef.current) return;
    autoCheckedRef.current = true;
    void checkForUpdateNow();
  }, [ready, autoUpdateCheck, checkForUpdateNow]);

  const value: Store = {
    ready,
    config,
    directory,
    files,
    difficulty,
    mode,
    botItems,
    presets,
    aimPending,
    nadesPending,
    modePending,
    difficultyPending,
    dropKnivesPending,
    botItemsPending,
    dropKnives,
    csgoPath: directory?.valid ? directory.selected : null,
    autoUpdateCheck,
    setAutoUpdateCheck,
    updateResult,
    updateChecking,
    updateCheckedAt,
    checkForUpdateNow,
    error,
    clearError,
    reportError,
    refreshDirectory,
    refreshFiles,
    refreshDifficulty,
    refreshAll,
    updateConfig,
    chooseDirectory,
    applyDifficulty,
    applyMode,
    applyBotItem,
    applyAim,
    applyNades,
    applyDropKnives,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
