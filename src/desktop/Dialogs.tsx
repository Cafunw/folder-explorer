import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { api, iconUrl, mediaUrl } from "../api";
import { t } from "../i18n";
import { primaryGrid } from "../layout/grid";
import { isFolderId, renameFolder, setCustom, setFolderColor, setFolderLook, updateFolder } from "../layout/model";
import { FOLDER_COLORS, spring } from "../settings";
import type { FolderLook, OpenStyle, StartApp } from "../types";
import { DIALOG_BODY, DIALOG_TITLE, useDialogFocus } from "../ui/dialog";
import { askDeleteFolderDeep, deleteFolderDeep, deleteIds } from "./actions";
import { GroupOptions, UnlockDialog } from "./GroupDialogs";
import { draftOf, patchOf, type GroupDraft } from "./kinds";
import { commit, expectItemAt, refreshItems, toast, useDesk } from "./store";
import { FolderGlyph, ItemImage } from "./Tile";
import { closeStep, isDirty, type CloseEvent } from "./unsaved";

export function Dialogs() {
  const dialog = useDesk((s) => s.dialog);
  const settings = useDesk((s) => s.settings);
  const grids = useDesk((s) => s.grids);
  const g = primaryGrid(grids);
  const close = () => useDesk.setState({ dialog: null });
  // a dialog with a draft puts its own close attempt here, so the backdrop and Esc ask before discarding
  const guard = useRef<(() => void) | null>(null);
  const tryClose = () => (guard.current ?? close)();
  const box = useRef<HTMLDivElement>(null);
  // Esc reaches the dialog wherever the focus is (a click on a blank spot leaves it on <body>)
  const open = !!dialog && dialog.kind !== "quicklook";
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation(); // not also the desktop's Esc (panel back, clear selection)
      if (!e.repeat) tryClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!g) return null;
  const folderEdit = dialog?.kind === "customize" && isFolderId(dialog.id);
  const confirm = dialog?.kind === "confirmDeleteFolder" || dialog?.kind === "confirmRecycle";

  return (
    <AnimatePresence>
      {dialog && dialog.kind !== "quicklook" && (
        <motion.div key="dlg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <div
            className="dialog-backdrop"
            onPointerDown={(e) => {
              e.stopPropagation();
              tryClose();
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
          {/* centred in the primary work area, so a tall dialog scrolls instead of running under the taskbar */}
          <div className="dialog-place" style={{ left: g.left + g.workLeft, top: g.top + g.workTop, width: g.workWidth, height: g.workHeight }}>
            <motion.div
              ref={box}
              role={confirm ? "alertdialog" : "dialog"}
              aria-modal="true"
              aria-labelledby={DIALOG_TITLE}
              aria-describedby={confirm ? DIALOG_BODY : undefined}
              className={folderEdit ? "dialog folder-edit" : "dialog"}
              style={dialog.kind === "unlock" ? { width: 320 } : undefined}
              initial={{ opacity: 0, scale: 0.94, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={spring(settings, 0.35, 0.18)}
              onPointerDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
              onKeyDown={(e) => e.stopPropagation()} // Esc is handled on the window, above
            >
              {dialog.kind === "addApp" && <AddApp placement={dialog.placement} onClose={close} />}
              {dialog.kind === "customize" && <Customize id={dialog.id} focus={dialog.focus} guard={guard} onClose={close} />}
              {dialog.kind === "unlock" && <UnlockDialog key={dialog.id} id={dialog.id} onClose={close} />}
              {dialog.kind === "confirmDeleteFolder" && (
                <Confirm
                  title={t.confirmDeleteFolderTitle}
                  body={t.confirmDeleteFolderBody(dialog.files.length)}
                  onCancel={close}
                  onOk={() => {
                    close();
                    deleteFolderDeep(dialog.folderIds, dialog.files);
                  }}
                />
              )}
              {dialog.kind === "confirmRecycle" && (
                <Confirm
                  title={t.jiggle.confirmRecycle}
                  body={t.confirmDeleteFolderBody(dialog.ids.length)}
                  onCancel={close}
                  onOk={() => {
                    close();
                    void deleteIds(dialog.ids);
                  }}
                />
              )}
              <DialogFocus box={box} />
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Mounts and leaves with the open dialog (last, so the content's own focus effects run first). */
function DialogFocus({ box }: { box: RefObject<HTMLElement | null> }) {
  useDialogFocus(box, useIsPresent());
  return null;
}

type Guard = { current: (() => void) | null };

/** Backdrop / Esc on a dialog with a draft: close when the draft is as opened, otherwise ask with `UnsavedBar`. */
function useUnsaved(guard: Guard, draft: object | null, save: () => void, onClose: () => void) {
  const [start] = useState(draft); // what the dialog was opened with
  const [asking, setAsking] = useState(false);
  const step = (ev: CloseEvent) => {
    // a draft whose folder is gone has nothing left to save
    const s = closeStep(!!draft && isDirty(start, draft), asking, ev);
    if (s === "save") save();
    else if (s === "close") onClose();
    else setAsking(s === "ask");
  };
  useEffect(() => {
    guard.current = () => step("request");
    return () => {
      guard.current = null;
    };
  });
  return { asking, step };
}

/** "Kaydedilmemiş değişiklikler var"; it stands in for the dialog's own buttons while shown (styles.css). */
function UnsavedBar({ onStep }: { onStep: (ev: CloseEvent) => void }) {
  return (
    <div className="actions unsaved">
      <span role="alert">{t.unsavedChanges}</span>
      <button className="btn" onClick={() => onStep("stay")}>
        {t.cancel}
      </button>
      <button className="btn danger" onClick={() => onStep("discard")}>
        {t.dontSave}
      </button>
      <button className="btn primary" onClick={() => onStep("save")} autoFocus>
        {t.save}
      </button>
    </div>
  );
}

function Confirm({ title, body, onOk, onCancel }: { title: string; body: ReactNode; onOk: () => void; onCancel: () => void }) {
  return (
    <>
      <h2 id={DIALOG_TITLE}>{title}</h2>
      <div className="body" id={DIALOG_BODY} style={{ color: "var(--fg-dim)", lineHeight: 1.5 }}>
        {body}
      </div>
      <div className="actions">
        <button className="btn" onClick={onCancel} autoFocus>
          {t.cancel}
        </button>
        <button className="btn danger" onClick={onOk}>
          {t.delete}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- add app

let appsCache: StartApp[] | null = null;

function AddApp({ placement, onClose }: { placement: import("../types").Placement | null; onClose: () => void }) {
  const [tab, setTab] = useState<"apps" | "web">("apps");
  const [apps, setApps] = useState<StartApp[] | null>(appsCache);
  const [q, setQ] = useState("");
  const [url, setUrl] = useState("https://");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (appsCache) return;
    api
      .listStartApps()
      .then((a) => {
        const coll = new Intl.Collator("tr", { sensitivity: "base", numeric: true });
        appsCache = a.sort((x, y) => coll.compare(x.name, y.name));
        setApps(appsCache);
      })
      .catch(() => setApps([]));
  }, []);

  const filtered = useMemo(() => {
    if (!apps) return [];
    const n = q.trim().toLocaleLowerCase("tr");
    return n ? apps.filter((a) => a.name.toLocaleLowerCase("tr").includes(n)) : apps;
  }, [apps, q]);

  const created = async (path: string) => {
    if (placement) expectItemAt(path.toLowerCase(), placement);
    await refreshItems();
    onClose();
  };

  const addApp = async (a: StartApp) => {
    if (busy) return;
    setBusy(true);
    try {
      await created(await api.createShortcut(a.parsingName, a.name));
    } catch (e) {
      console.error(e);
      toast(t.operationFailed);
      setBusy(false);
    }
  };

  const addUrl = async () => {
    const u = url.trim();
    if (!/^https?:\/\/.+/i.test(u)) return;
    let n = name.trim();
    if (!n) {
      try {
        n = new URL(u).hostname.replace(/^www\./, "");
      } catch {
        n = u;
      }
    }
    setBusy(true);
    try {
      await created(await api.createUrlShortcut(u, n));
    } catch (e) {
      console.error(e);
      toast(t.operationFailed);
      setBusy(false);
    }
  };

  return (
    <>
      <h2 id={DIALOG_TITLE}>{t.addAppTitle}</h2>
      <div className="tabs">
        <button className="tab" data-active={tab === "apps"} aria-pressed={tab === "apps"} onClick={() => setTab("apps")}>
          {t.appsTab}
        </button>
        <button className="tab" data-active={tab === "web"} aria-pressed={tab === "web"} onClick={() => setTab("web")}>
          {t.webTab}
        </button>
      </div>
      <div className="body" style={{ minHeight: 320 }}>
        {tab === "apps" ? (
          <>
            <input className="input" placeholder={t.searchApps} aria-label={t.searchApps} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            <div className="app-list">
              {!apps && <div style={{ padding: 12, color: "var(--fg-dim)" }}>{t.loading}</div>}
              {filtered.map((a) => (
                <button key={a.parsingName} className="app-row" onClick={() => addApp(a)} disabled={busy}>
                  <img src={iconUrl(a.parsingName, 64, "app")} alt="" loading="lazy" draggable={false} />
                  <span>{a.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>{t.urlLabel}</label>
              <input className="input" aria-label={t.urlLabel} value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label>{t.nameLabel}</label>
              <input className="input" aria-label={t.nameLabel} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </>
        )}
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>
          {t.cancel}
        </button>
        {tab === "web" && (
          <button className="btn primary" onClick={addUrl} disabled={busy}>
            {t.addShortcut}
          </button>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- folder: per-folder look

const OPEN_STYLES: [OpenStyle, string][] = [
  ["zoom", t.openZoom],
  ["spring", t.openSpring],
  ["flip", t.openFlip],
  ["blur", t.openBlur],
  ["fade", t.openFade],
];

function LookRow({
  label,
  hint,
  overridden,
  onReset,
  children,
}: {
  label: string;
  hint?: string;
  overridden: boolean;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <div className="look-row" role="group" aria-label={label}>
      <div className="look-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="look-control">{children}</div>
      <button className="look-reset" style={{ visibility: overridden ? "visible" : "hidden" }} onClick={onReset} title={t.useDefault}>
        {t.useDefault}
      </button>
    </div>
  );
}

function FolderCustomize({ id, focus, guard, onClose }: { id: string; focus?: "rule" | "source"; guard: Guard; onClose: () => void }) {
  const folder = useDesk((s) => s.layout.folders[id]);
  const settings = useDesk((s) => s.settings);
  const [name, setName] = useState(folder?.name ?? "");
  const [color, setColor] = useState<string | null>(folder?.color ?? null);
  const [look, setLook] = useState<FolderLook>(folder?.look ?? {});
  const [kinds, setKinds] = useState<GroupDraft | null>(() => (folder ? draftOf(folder) : null));

  const eff = {
    opacity: look.opacity ?? settings.transparency.folderTile,
    blur: look.blur ?? settings.transparency.folderTileBlur,
    radius: look.radius ?? settings.folders.radius,
    panelOpacity: look.panelOpacity ?? settings.transparency.panel,
  };
  const patch = (p: Partial<FolderLook>) => setLook((cur) => ({ ...cur, ...p }));
  const reset = (k: keyof FolderLook) =>
    setLook((cur) => {
      const n = { ...cur };
      delete n[k];
      return n;
    });

  const pickIcon = async () => {
    const file = await openDialog({
      multiple: false,
      filters: [{ name: "Resim", extensions: ["png", "jpg", "jpeg", "webp", "gif", "ico", "svg", "bmp"] }],
    });
    if (typeof file !== "string") return;
    try {
      patch({ icon: await api.importMedia(file, "icon") });
    } catch (e) {
      console.error(e);
      toast(t.operationFailed);
    }
  };

  const save = () => {
    if (!folder || !kinds) return;
    let l = useDesk.getState().layout;
    const n = name.trim();
    if (n && n !== folder.name) l = renameFolder(l, id, n);
    if (color !== folder.color) l = setFolderColor(l, id, color);
    l = setFolderLook(l, id, look);
    l = updateFolder(l, useDesk.getState().grids, id, patchOf(kinds));
    commit(l);
    onClose();
  };
  const { asking, step } = useUnsaved(guard, folder ? { name: name.trim(), color, look, kinds } : null, save, onClose);
  if (!folder || !kinds) return null;

  const pct = (v: number) => `%${Math.round(v * 100)}`;
  const fence = folder.display === "fence";
  return (
    <>
      <h2 id={DIALOG_TITLE}>{fence ? t.fence.edit : t.editFolder}</h2>
      <div className="body">
        <div className="look-preview">
          <div style={{ width: 56, height: 56 }}>
            <FolderGlyph folderId={id} size={56} lookOverride={look} colorOverride={color} />
          </div>
          <span>{name || folder.name}</span>
        </div>
        <div className="field">
          <label>{t.folderName}</label>
          <input
            className="input"
            aria-label={t.folderName}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            autoFocus
          />
        </div>
        <div className="field">
          <label>{t.color}</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="swatch none"
              style={{ width: 24, height: 24 }}
              data-active={color === null}
              aria-pressed={color === null}
              onClick={() => setColor(null)}
              title={t.noColor}
              aria-label={t.noColor}
            />
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                className="swatch"
                style={{ background: c, width: 24, height: 24 }}
                data-active={color === c}
                aria-pressed={color === c}
                aria-label={`${t.color} ${c}`}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <GroupOptions
          id={id}
          draft={kinds}
          onChange={setKinds}
          focus={focus}
          onSourceChosen={(n) => {
            if (!name.trim() || name === t.newFolderName || name === t.grp.newLive) setName(n);
          }}
        />

        <div className="look-section">{t.lookSection}</div>
        <LookRow label={t.tileOpacity} hint={t.tileOpacityHint} overridden={look.opacity !== undefined} onReset={() => reset("opacity")}>
          <input type="range" min={0} max={1} step={0.01} value={eff.opacity} onChange={(e) => patch({ opacity: Number(e.target.value) })} />
          <span className="look-val">{pct(eff.opacity)}</span>
        </LookRow>
        <LookRow label={t.tileBlur} overridden={look.blur !== undefined} onReset={() => reset("blur")}>
          <input type="range" min={0} max={40} step={1} value={eff.blur} onChange={(e) => patch({ blur: Number(e.target.value) })} />
          <span className="look-val">{Math.round(eff.blur)} px</span>
        </LookRow>
        <LookRow label={t.cornerRadius} overridden={look.radius !== undefined} onReset={() => reset("radius")}>
          <input type="range" min={0} max={0.5} step={0.01} value={eff.radius} onChange={(e) => patch({ radius: Number(e.target.value) })} />
          <span className="look-val">{pct(eff.radius * 2)}</span>
        </LookRow>
        <LookRow label={t.previewGrid} overridden={look.preview !== undefined} onReset={() => reset("preview")}>
          <div className="mini-seg">
            {([2, 3] as const).map((n) => (
              <button
                key={n}
                data-active={(look.preview ?? settings.folders.preview) === n}
                aria-pressed={(look.preview ?? settings.folders.preview) === n}
                onClick={() => patch({ preview: n })}
              >
                {n} × {n}
              </button>
            ))}
          </div>
        </LookRow>
        <LookRow label={t.customIcon} overridden={!!look.icon} onReset={() => reset("icon")}>
          <button className="btn" onClick={pickIcon}>
            {t.chooseImage}
          </button>
        </LookRow>

        <div className="look-section">{t.openSection}</div>
        <LookRow label={t.panelStyleLabel} overridden={look.panelStyle !== undefined} onReset={() => reset("panelStyle")}>
          <div className="mini-seg">
            {(["ios", "android"] as const).map((st) => (
              <button
                key={st}
                data-active={(look.panelStyle ?? settings.folders.style) === st}
                aria-pressed={(look.panelStyle ?? settings.folders.style) === st}
                onClick={() => patch({ panelStyle: st })}
              >
                {st === "ios" ? t.styleIos : t.styleAndroid}
              </button>
            ))}
          </div>
        </LookRow>
        <LookRow label={t.openAnimLabel} overridden={look.openStyle !== undefined} onReset={() => reset("openStyle")}>
          <select
            className="input"
            style={{ width: "auto" }}
            value={look.openStyle ?? settings.animation.openStyle}
            onChange={(e) => patch({ openStyle: e.target.value as OpenStyle })}
          >
            {OPEN_STYLES.map(([st, label]) => (
              <option key={st} value={st}>
                {label}
              </option>
            ))}
          </select>
        </LookRow>
        <LookRow label={t.panelOpacityLabel} overridden={look.panelOpacity !== undefined} onReset={() => reset("panelOpacity")}>
          <input type="range" min={0} max={1} step={0.01} value={eff.panelOpacity} onChange={(e) => patch({ panelOpacity: Number(e.target.value) })} />
          <span className="look-val">{pct(eff.panelOpacity)}</span>
        </LookRow>
      </div>
      {asking && <UnsavedBar onStep={step} />}
      <div className="actions">
        <div style={{ display: "flex", gap: 8, marginRight: "auto" }}>
          <button className="btn" onClick={() => setLook({})}>
            {t.resetAll}
          </button>
          <button
            className="btn"
            onClick={() => {
              onClose();
              deleteIds([id]);
            }}
          >
            {fence ? t.fence.dissolve : t.ungroup}
          </button>
          <button
            className="btn danger"
            onClick={() => {
              onClose();
              askDeleteFolderDeep([id]);
            }}
          >
            {t.deleteFolderWithContents}
          </button>
        </div>
        <button className="btn" onClick={onClose}>
          {t.cancel}
        </button>
        <button className="btn primary" onClick={save}>
          {t.save}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- customize

function Customize({ id, focus, guard, onClose }: { id: string; focus?: "rule" | "source"; guard: Guard; onClose: () => void }) {
  if (isFolderId(id)) return <FolderCustomize id={id} focus={focus} guard={guard} onClose={onClose} />;
  return <ItemCustomize id={id} guard={guard} onClose={onClose} />;
}

function ItemCustomize({ id, guard, onClose }: { id: string; guard: Guard; onClose: () => void }) {
  const layout = useDesk((s) => s.layout);
  const item = useDesk((s) => s.itemMap.get(id));
  const isFolder = isFolderId(id);
  const folder = isFolder ? layout.folders[id] : null;
  const custom = layout.custom[id] ?? {};
  const [name, setName] = useState(isFolder ? folder?.name ?? "" : custom.name ?? "");
  const [icon, setIcon] = useState<string | null>(custom.icon ?? null);
  const [color, setColor] = useState<string | null>(folder?.color ?? null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pickIcon = async () => {
    const file = await openDialog({
      multiple: false,
      filters: [{ name: "Resim", extensions: ["png", "jpg", "jpeg", "webp", "gif", "ico", "svg", "bmp"] }],
    });
    if (typeof file !== "string") return;
    try {
      setIcon(await api.importMedia(file, "icon"));
    } catch (e) {
      console.error(e);
      toast(t.operationFailed);
    }
  };

  const save = () => {
    let l = useDesk.getState().layout;
    if (isFolder) {
      if (name.trim() && name.trim() !== folder?.name) l = renameFolder(l, id, name.trim());
      if (color !== (folder?.color ?? null)) l = setFolderColor(l, id, color);
    } else {
      l = setCustom(l, id, { name: name.trim() || null, icon });
    }
    commit(l);
    onClose();
  };
  const { asking, step } = useUnsaved(guard, { name: name.trim(), icon, color }, save, onClose);

  return (
    <>
      <h2 id={DIALOG_TITLE}>{t.customizeTitle}</h2>
      <div className="body">
        <div className="field">
          <label>{isFolder ? t.folderName : t.displayName}</label>
          <input
            ref={inputRef}
            className="input"
            aria-label={isFolder ? t.folderName : t.displayName}
            value={name}
            placeholder={item?.name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            autoFocus
          />
          {!isFolder && <span style={{ fontSize: 11, color: "var(--fg-faint)" }}>{t.displayNameHint}</span>}
        </div>
        {isFolder ? (
          <div className="field">
            <label>{t.color}</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="swatch none"
                style={{ width: 26, height: 26 }}
                data-active={color === null}
                aria-pressed={color === null}
                aria-label={t.noColor}
                onClick={() => setColor(null)}
              />
              {FOLDER_COLORS.map((c) => (
                <button
                  key={c}
                  className="swatch"
                  style={{ background: c, width: 26, height: 26 }}
                  data-active={color === c}
                  aria-pressed={color === c}
                  aria-label={`${t.color} ${c}`}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="field">
            <label>{t.customIcon}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="tile-icon" style={{ width: 52, height: 52, borderRadius: 12, background: "var(--input-bg)", padding: 6 }}>
                {icon ? <img src={mediaUrl(icon)} alt="" /> : <ItemImage id={id} size={40} />}
              </div>
              <button className="btn" onClick={pickIcon}>
                {t.chooseImage}
              </button>
              {icon && (
                <button className="btn" onClick={() => setIcon(null)}>
                  {t.reset}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {asking && <UnsavedBar onStep={step} />}
      <div className="actions">
        <button className="btn" onClick={onClose}>
          {t.cancel}
        </button>
        <button className="btn primary" onClick={save}>
          {t.save}
        </button>
      </div>
    </>
  );
}
