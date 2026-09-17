import { openUrl } from "@tauri-apps/plugin-opener";
import { PROJECT_URL } from "../data/devs";

/**
 * Update checking against GitHub Releases.
 *
 * Panel/src-tauri is not part of this repository, so there is no Rust side to
 * host `tauri-plugin-updater` here. This module therefore stays entirely on the
 * webview side of the Tauri boundary: it uses `fetch` against the public GitHub
 * API and the opener plugin to hand the URL to the system browser. It can tell
 * the user that a newer build exists and take them to it — it deliberately never
 * downloads or executes anything on its own.
 */

/** `owner/name`, derived from the project URL so the two can never drift apart. */
const REPO = (() => {
  const m = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(PROJECT_URL.trim());
  if (!m) throw new Error(`PROJECT_URL is not a GitHub repository URL: ${PROJECT_URL}`);
  return m[1];
})();

/** The version this build was compiled with — single source: Panel/package.json. */
export const CURRENT_VERSION: string = __APP_VERSION__;

/** Human-facing fallback: always valid, even when no installer asset is attached. */
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

/** The installer produced by inno-setup/setup.iss. */
export const SETUP_ASSET_NAME = "CS2-Bot-Improver-Setup.exe";

const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const REQUEST_TIMEOUT_MS = 10_000;

export type ReleaseAsset = { name: string; url: string; size: number };

export type UpdateInfo = {
  /** Version currently running (from package.json). */
  current: string;
  /** Latest published release tag, or null when nothing is published yet. */
  latest: string | null;
  /** True when `latest` is strictly newer than `current`. */
  hasUpdate: boolean;
  /** The installer asset for that release, when the maintainer attached one. */
  setup: ReleaseAsset | null;
  /** Always-usable link — the release page itself. */
  pageUrl: string;
  publishedAt: string | null;
  /** Raw release notes (Markdown), truncated for display. */
  notes: string;
};

/** Why a check failed. Kept as data (not a thrown error) so the Update page can
 *  show an inline explanation instead of popping the global error modal. */
export type UpdateFailure = "offline" | "rateLimited" | "noReleases" | "server" | "unexpected";

export type UpdateCheckResult =
  | { ok: true; info: UpdateInfo }
  | { ok: false; reason: UpdateFailure };

// ---- Version comparison ----

type ParsedVersion = { parts: number[]; prerelease: string | null };

function parseVersion(raw: string): ParsedVersion {
  const s = raw.trim().replace(/^v/i, "");
  const [core, ...rest] = s.split("-");
  return {
    parts: core.split(".").map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    }),
    prerelease: rest.length > 0 ? rest.join("-") : null,
  };
}

/**
 * Semver-ish ordering: numeric segments compared left to right with missing
 * segments treated as 0, and a prerelease ("1.5.0-rc1") sorting below its own
 * release ("1.5.0"). Returns -1, 0 or 1.
 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.parts.length, vb.parts.length);
  for (let i = 0; i < len; i++) {
    const diff = (va.parts[i] ?? 0) - (vb.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (va.prerelease === vb.prerelease) return 0;
  if (va.prerelease === null) return 1;
  if (vb.prerelease === null) return -1;
  return va.prerelease < vb.prerelease ? -1 : 1;
}

// ---- GitHub response parsing ----

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseAssets(raw: unknown): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseAsset[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const name = asString(rec.name);
    const url = asString(rec.browser_download_url);
    if (!name || !url) continue;
    const size = typeof rec.size === "number" ? rec.size : 0;
    out.push({ name, url, size });
  }
  return out;
}

function truncateNotes(body: string | null): string {
  if (!body) return "";
  const limit = 1200;
  return body.length > limit ? `${body.slice(0, limit).trimEnd()}…` : body;
}

/**
 * Fetch the latest release and compare it with the running build.
 * Never throws — network and API problems come back as `{ ok: false, reason }`.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  // Manual timeout rather than AbortSignal.timeout() so the call works on the
  // older webviews Tauri may host, where that static helper can be missing.
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
  } catch {
    // DNS failure, no route, TLS error, or the timeout above firing.
    return { ok: false, reason: "offline" };
  } finally {
    window.clearTimeout(timer);
  }

  // 404 = the repository exists but has no published release yet.
  if (res.status === 404) return { ok: false, reason: "noReleases" };
  // The unauthenticated API allows 60 requests per hour per IP.
  if (res.status === 403 || res.status === 429) return { ok: false, reason: "rateLimited" };
  if (!res.ok) return { ok: false, reason: "server" };

  let raw: Record<string, unknown>;
  try {
    raw = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "unexpected" };
  }

  const tag = asString(raw.tag_name) ?? asString(raw.name);
  if (!tag) return { ok: false, reason: "unexpected" };

  const assets = parseAssets(raw.assets);
  const setup = assets.find((a) => a.name.toLowerCase() === SETUP_ASSET_NAME.toLowerCase()) ?? null;
  const pageUrl = asString(raw.html_url) ?? RELEASES_PAGE;

  return {
    ok: true,
    info: {
      current: CURRENT_VERSION,
      latest: tag,
      hasUpdate: compareVersions(tag, CURRENT_VERSION) > 0,
      setup,
      pageUrl,
      publishedAt: asString(raw.published_at),
      notes: truncateNotes(asString(raw.body)),
    },
  };
}

/** Hand a URL to the system browser / default downloader. */
export async function openExternal(url: string): Promise<void> {
  await openUrl(url);
}

/**
 * Where the user should be sent to get the new build: the installer asset when
 * the release ships one, otherwise the release page itself.
 */
export function downloadUrl(info: UpdateInfo): string {
  return info.setup?.url ?? info.pageUrl;
}
