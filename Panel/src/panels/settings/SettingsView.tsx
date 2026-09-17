import { useState } from "react";
import { BackIcon, ChevronRight } from "../../components/icons";
import StatusDot from "../../components/StatusDot";
import DevsPage from "./DevsPage";
import LanguagesPage from "./LanguagesPage";
import DirectoryPage from "./DirectoryPage";
import UpdatePage from "./UpdatePage";
import { useStore } from "../../state/store";
import { useT, type I18nKey } from "../../i18n";
import "./settings.css";

type Page = "root" | "devs" | "languages" | "directory" | "updates";

const TITLE_KEYS: Record<Page, I18nKey> = {
  root: "set.title",
  devs: "set.devs",
  languages: "set.languages",
  directory: "set.directory",
  updates: "set.updates",
};

/** Order of the rows on the Settings root screen. */
const ROOT_PAGES: Page[] = ["devs", "languages", "directory", "updates"];

export default function SettingsView({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState<Page>("root");
  const t = useT();
  const { updateResult } = useStore();
  const back = () => (page === "root" ? onClose() : setPage("root"));
  // Mirrors the dot on the Updates page so a pending update is visible without
  // having to open it first.
  const updateAvailable = updateResult?.ok === true && updateResult.info.hasUpdate;

  return (
    <div className="settings">
      <div className="settings__head">
        <button className="settings__back" onClick={back} aria-label="Back">
          <BackIcon size={20} />
        </button>
        <span className="settings__title">{t(TITLE_KEYS[page])}</span>
      </div>

      <div className="settings__body">
        {page === "root" && (
          <div className="settings-list">
            {ROOT_PAGES.map((p) => (
              <button key={p} className="settings-row settings-row--nav" onClick={() => setPage(p)}>
                <span className="settings-row__title">{t(TITLE_KEYS[p])}</span>
                {p === "updates" && updateAvailable ? (
                  <StatusDot status="yellow" title={t("upd.newVersion")} />
                ) : (
                  <ChevronRight size={18} />
                )}
              </button>
            ))}
          </div>
        )}
        {page === "devs" && <DevsPage />}
        {page === "languages" && <LanguagesPage />}
        {page === "directory" && <DirectoryPage />}
        {page === "updates" && <UpdatePage />}
      </div>
    </div>
  );
}
