import StatusDot, { type Status } from "../../components/StatusDot";
import Toggle from "../../components/Toggle";
import Collapsible from "../../components/Collapsible";
import { useStore } from "../../state/store";
import { useT, type I18nKey } from "../../i18n";
import {
  CURRENT_VERSION,
  downloadUrl,
  openExternal,
  type UpdateFailure,
} from "../../lib/updater";

/** One inline explanation per failure mode — nothing here goes through the
 *  global error modal, so a flaky network never interrupts the user. */
const FAILURE_KEYS: Record<UpdateFailure, I18nKey> = {
  offline: "upd.offline",
  rateLimited: "upd.rateLimited",
  noReleases: "upd.noReleases",
  server: "upd.server",
  unexpected: "upd.unexpected",
};

export default function UpdatePage() {
  const {
    autoUpdateCheck,
    setAutoUpdateCheck,
    updateResult,
    updateChecking,
    updateCheckedAt,
    checkForUpdateNow,
    reportError,
  } = useStore();
  const t = useT();

  const open = async (url: string) => {
    try {
      await openExternal(url);
    } catch (e) {
      reportError(e);
    }
  };

  const info = updateResult?.ok ? updateResult.info : null;
  const failureKey = updateResult && !updateResult.ok ? FAILURE_KEYS[updateResult.reason] : null;
  const dot: Status = info ? (info.hasUpdate ? "yellow" : "green") : "unknown";

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };

  return (
    <div className="settings-list">
      <div className="settings-row">
        <div className="settings-row__text">
          <span className="settings-row__title">{t("upd.auto")}</span>
          <span className="settings-row__sub">{t("upd.autoHint")}</span>
        </div>
        <Toggle
          checked={autoUpdateCheck}
          onChange={setAutoUpdateCheck}
          ariaLabel={t("upd.auto")}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row__text">
          <span className="settings-row__title">{t("upd.current")}</span>
          <span className="settings-row__sub upd__version">v{CURRENT_VERSION}</span>
        </div>
        <StatusDot status={dot} title={info?.hasUpdate ? t("upd.newVersion") : undefined} />
      </div>

      {info?.hasUpdate && (
        <>
          <div className="dir-note dir-note--info">
            <div className="upd__headline">{t("upd.available", { v: info.latest ?? "" })}</div>
            {info.publishedAt && (
              <div className="upd__meta">
                {t("upd.published", { t: fmtDate(info.publishedAt) })}
              </div>
            )}
          </div>

          {info.setup ? (
            <button
              className="settings-row settings-row--action"
              onClick={() => void open(downloadUrl(info))}
            >
              {t("upd.download")}
            </button>
          ) : (
            // A release without the installer attached is still worth surfacing —
            // the user just has to pick the asset themselves on the release page.
            <div className="dir-note">{t("upd.noInstaller")}</div>
          )}

          <button
            className="settings-row settings-row--action"
            onClick={() => void open(info.pageUrl)}
          >
            {t("upd.releasePage")}
          </button>

          {info.notes && (
            <Collapsible title={t("upd.notes")}>
              <pre className="upd__notes">{info.notes}</pre>
            </Collapsible>
          )}
        </>
      )}

      {info && !info.hasUpdate && (
        <div className="dir-note dir-note--ok">{t("upd.upToDate")}</div>
      )}

      {failureKey && <div className="dir-note">{t(failureKey)}</div>}

      <button
        className="settings-row settings-row--action"
        disabled={updateChecking}
        onClick={() => void checkForUpdateNow()}
      >
        {updateChecking ? t("upd.checking") : t("upd.check")}
      </button>

      <div className="dir-note dir-note--muted">
        {updateCheckedAt
          ? t("upd.lastChecked", { t: new Date(updateCheckedAt).toLocaleTimeString() })
          : t("upd.neverChecked")}
      </div>
    </div>
  );
}
