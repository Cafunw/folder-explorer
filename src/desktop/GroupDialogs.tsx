// The group settings' kind / display / lock sections (inside the customize dialog) and the unlock
// dialog a locked group asks with before it opens.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Delete,
  Folder,
  FolderSync,
  Hourglass,
  Layers,
  LayoutGrid,
  Lock,
  PanelTop,
  Plus,
  ScanFace,
  Sparkles,
  SquareDashed,
  Star,
  X,
} from "lucide-react";
import { motion, useAnimationControls } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { holdsChildren, SMART_TYPES } from "../layout/model";
import type { GroupDisplay, GroupKind, GroupLock, SmartType } from "../types";
import { DIALOG_TITLE } from "../ui/dialog";
import { checkPin, makeLock, newRow, PIN_MAX, ruleOf, smartMatchCount, validPin, type GroupDraft, type RowDraft, type RuleDraft } from "./kinds";
import { helloAvailable, helloVerify, notePinResult, pinBlockedFor, unlockCancelled, unlockSucceeded } from "./locks";
import { useDesk } from "./store";
import "./groups.css";

const KINDS: { kind: GroupKind; icon: ReactNode }[] = [
  { kind: "group", icon: <Folder size={18} /> },
  { kind: "smart", icon: <Sparkles size={18} /> },
  { kind: "live", icon: <FolderSync size={18} /> },
  { kind: "frequent", icon: <Star size={18} /> },
  { kind: "temp", icon: <Hourglass size={18} /> },
];

const DISPLAYS: { display: GroupDisplay; icon: ReactNode }[] = [
  { display: "panel", icon: <LayoutGrid size={18} /> },
  { display: "stack", icon: <Layers size={18} /> },
  { display: "tabs", icon: <PanelTop size={18} /> },
  { display: "fence", icon: <SquareDashed size={18} /> },
];

/** The last path segment (a live group's suggested name). */
const folderName = (dir: string) => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;

// ---------------------------------------------------------------- customize sections

export function GroupOptions({
  id,
  draft,
  onChange,
  onSourceChosen,
  focus,
}: {
  id: string;
  draft: GroupDraft;
  onChange: (d: GroupDraft) => void;
  /** a live folder was picked: the dialog may take its name */
  onSourceChosen: (name: string) => void;
  focus?: "rule" | "source";
}) {
  const children = useDesk((s) => s.layout.folders[id]?.children.length ?? 0);
  const savedLock = useDesk((s) => s.layout.folders[id]?.lock ?? null);
  const groupName = useDesk((s) => s.layout.folders[id]?.name ?? "");
  const set = (p: Partial<GroupDraft>) => onChange({ ...draft, ...p });
  const empties = !holdsChildren({ kind: draft.kind === "group" ? undefined : draft.kind }) && children > 0;

  return (
    <>
      <div className="look-section">{t.grp.kindSection}</div>
      <div className="kind-chips">
        {KINDS.map(({ kind, icon }) => (
          <button key={kind} className="kind-chip" data-active={draft.kind === kind} aria-pressed={draft.kind === kind} onClick={() => set({ kind })}>
            {icon}
            {t.grp.kinds[kind]}
          </button>
        ))}
      </div>
      <div className="kind-hint">
        {t.grp.kindHints[draft.kind]}
        {empties && ` · ${t.grp.childrenOut(children)}`}
      </div>
      {draft.kind === "smart" && (
        <RuleEditor id={id} value={draft.rule} onChange={(rule) => set({ rule })} autoFocus={focus === "rule"} />
      )}
      {draft.kind === "live" && (
        <SourcePicker
          value={draft.source}
          autoPick={focus === "source" && !draft.source}
          onChange={(source) => {
            set({ source });
            onSourceChosen(folderName(source));
          }}
        />
      )}
      {draft.kind === "frequent" && (
        <NumberRow label={t.grp.limitLabel} min={4} max={30} value={draft.limit} onChange={(limit) => set({ limit })} />
      )}
      {draft.kind === "temp" && (
        <NumberRow
          label={t.grp.tempDaysLabel}
          hint={t.grp.tempDaysHint}
          min={1}
          max={90}
          value={draft.tempDays}
          unit={t.grp.days}
          onChange={(tempDays) => set({ tempDays })}
        />
      )}

      <div className="look-section">{t.grp.displaySection}</div>
      <div className="kind-chips">
        {DISPLAYS.map(({ display, icon }) => {
          const off = display === "tabs" && (draft.kind === "live" || draft.kind === "frequent");
          return (
            <button
              key={display}
              className="kind-chip"
              data-active={draft.display === display}
              aria-pressed={draft.display === display}
              disabled={off}
              style={off ? { opacity: 0.4, cursor: "default" } : undefined}
              onClick={() => set({ display })}
            >
              {icon}
              {t.grp.displays[display]}
            </button>
          );
        })}
      </div>
      <div className="kind-hint">{t.grp.displayHints[draft.display]}</div>

      <div className="look-section">{t.grp.lockSection}</div>
      <LockEditor name={groupName} saved={savedLock} value={draft.lock} onChange={(lock) => set({ lock })} />
    </>
  );
}

function NumberRow({
  label,
  hint,
  min,
  max,
  value,
  unit,
  onChange,
}: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  value: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="look-row" role="group" aria-label={label}>
      <div className="look-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="look-control">
        <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="look-val">
          {value}
          {unit ? ` ${unit}` : ""}
        </span>
      </div>
      <span />
    </div>
  );
}

// ---------------------------------------------------------------- smart rule editor

const TYPE_ORDER: SmartType[] = ["image", "document", "video", "audio", "archive", "shortcut", "game", "folder", "file"];

function RuleEditor({ id, value, onChange, autoFocus }: { id: string; value: RuleDraft; onChange: (r: RuleDraft) => void; autoFocus: boolean }) {
  const items = useDesk((s) => s.items);
  const layout = useDesk((s) => s.layout);
  const rule = useMemo(() => ruleOf(value), [value]);
  const count = useMemo(() => smartMatchCount(layout, items, id, rule), [layout, items, id, rule]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    box.current?.scrollIntoView({ block: "nearest" });
    box.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [autoFocus]);

  const update = (key: number, p: Partial<RowDraft>) =>
    onChange({ ...value, rows: value.rows.map((r) => (r.key === key ? { ...r, ...p } : r)) });

  return (
    <div className="kind-box" ref={box}>
      <div className="look-row" style={{ minHeight: 34, marginBottom: 6 }}>
        <div className="look-label">
          <span>{t.grp.matchLabel}</span>
        </div>
        <div className="look-control">
          <div className="mini-seg">
            <button data-active={value.all} aria-pressed={value.all} onClick={() => onChange({ ...value, all: true })}>
              {t.grp.matchAll}
            </button>
            <button data-active={!value.all} aria-pressed={!value.all} onClick={() => onChange({ ...value, all: false })}>
              {t.grp.matchAny}
            </button>
          </div>
        </div>
        <span />
      </div>
      {value.rows.map((r) => (
        <div className="rule-row" key={r.key}>
          <select className="input" value={r.field} onChange={(e) => update(r.key, { field: e.target.value as RowDraft["field"] })}>
            {(["ext", "name", "type", "age"] as const).map((f) => (
              <option key={f} value={f}>
                {t.grp.fields[f]}
              </option>
            ))}
          </select>
          <div className="rule-value">
            {r.field === "ext" && (
              <input
                className="input"
                placeholder={t.grp.extPlaceholder}
                value={r.text}
                spellCheck={false}
                onChange={(e) => update(r.key, { text: e.target.value })}
              />
            )}
            {r.field === "name" && (
              <>
                <select className="input" style={{ flex: "none" }} value={r.nameOp} onChange={(e) => update(r.key, { nameOp: e.target.value as RowDraft["nameOp"] })}>
                  <option value="contains">{t.grp.opContains}</option>
                  <option value="startsWith">{t.grp.opStartsWith}</option>
                </select>
                <input className="input" placeholder={t.grp.namePlaceholder} value={r.text} onChange={(e) => update(r.key, { text: e.target.value })} />
              </>
            )}
            {r.field === "type" && (
              <select className="input" style={{ flex: 1 }} value={r.type} onChange={(e) => update(r.key, { type: e.target.value as SmartType })}>
                {TYPE_ORDER.filter((x) => SMART_TYPES.includes(x)).map((x) => (
                  <option key={x} value={x}>
                    {t.grp.types[x]}
                  </option>
                ))}
              </select>
            )}
            {r.field === "age" && (
              <>
                <select className="input" style={{ flex: 1 }} value={r.ageOp} onChange={(e) => update(r.key, { ageOp: e.target.value as RowDraft["ageOp"] })}>
                  <option value="newerThan">{t.grp.opNewer}</option>
                  <option value="olderThan">{t.grp.opOlder}</option>
                </select>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={3650}
                  style={{ width: 64, flex: "none" }}
                  value={r.days}
                  onChange={(e) => update(r.key, { days: Math.max(0, Math.min(3650, Math.round(Number(e.target.value) || 0))) })}
                />
                <span style={{ alignSelf: "center", color: "var(--fg-dim)" }}>{t.grp.days}</span>
              </>
            )}
          </div>
          <button
            className="icon-btn"
            title={t.grp.removeCondition}
            aria-label={t.grp.removeCondition}
            onClick={() => onChange({ ...value, rows: value.rows.filter((x) => x.key !== r.key) })}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="rule-foot">
        <button className="link-btn" onClick={() => onChange({ ...value, rows: [...value.rows, newRow(value.rows.at(-1)?.field ?? "ext")] })}>
          <Plus size={14} />
          {t.grp.addCondition}
        </button>
        <span className={rule.conditions.length ? "count" : undefined}>
          {rule.conditions.length ? t.grp.willCollect(count) : t.grp.noConditions}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- live folder picker

type Known = Awaited<ReturnType<typeof api.knownFolders>>;
let knownCache: Known | null = null;

function SourcePicker({ value, onChange, autoPick }: { value: string | null; onChange: (dir: string) => void; autoPick: boolean }) {
  const [known, setKnown] = useState<Known | null>(knownCache);
  useEffect(() => {
    if (knownCache) return;
    api
      .knownFolders()
      .then((k) => {
        knownCache = k;
        setKnown(k);
      })
      .catch(() => {});
  }, []);
  const pick = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false, defaultPath: value ?? undefined });
      if (typeof dir === "string" && dir) onChange(dir);
    } catch (e) {
      console.warn("folder picker", e);
    }
  };
  useEffect(() => {
    if (autoPick) void pick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const quick = known
    ? ([
        [t.grp.downloads, known.downloads],
        [t.grp.documents, known.documents],
        [t.grp.pictures, known.pictures],
      ].filter(([, p]) => !!p) as [string, string][])
    : [];
  return (
    <div className="kind-box">
      <div className="source-path" data-empty={!value}>
        {value ?? t.grp.noSource}
      </div>
      <div className="chip-row">
        <button className="btn primary" onClick={pick}>
          {t.grp.chooseFolder}
        </button>
        {quick.map(([label, p]) => (
          <button key={p} className="btn" onClick={() => onChange(p)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- lock

function LockEditor({
  name,
  saved,
  value,
  onChange,
}: {
  name: string;
  saved: GroupLock | null;
  value: GroupLock | null;
  onChange: (l: GroupLock | null) => void;
}) {
  const [hello, setHello] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"idle" | "set" | "verify">("idle");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    helloAvailable().then((ok) => live && setHello(ok));
    return () => {
      live = false;
    };
  }, []);
  const reset = () => {
    setMode("idle");
    setPin("");
    setPin2("");
    setError("");
  };

  const applyLock = async () => {
    if (!validPin(pin)) return setError(t.grp.pinInvalid);
    if (pin !== pin2) return setError(t.grp.pinMismatch);
    onChange(await makeLock(pin, !!hello));
    reset();
  };

  const startRemove = async () => {
    setError("");
    if (saved?.method === "hello" && (await helloAvailable())) {
      setBusy(true);
      const ok = await helloVerify(name, t.grp.helloMessage);
      setBusy(false);
      if (ok) onChange(null);
      else if (saved.hash) setMode("verify");
      else setError(t.grp.helloFailed);
      return;
    }
    setMode("verify");
  };

  const verifyPin = async () => {
    const wait = pinBlockedFor();
    if (wait) return setError(t.grp.tooMany(wait));
    const ok = await checkPin(saved, pin);
    notePinResult(ok);
    if (!ok) {
      setPin("");
      return setError(t.grp.wrongPin);
    }
    onChange(null);
    reset();
  };

  const pinInput = (v: string, set: (s: string) => void, placeholder: string, onEnter: () => void, autoFocus = false) => (
    <input
      className="input"
      type="password"
      inputMode="numeric"
      autoComplete="off"
      maxLength={PIN_MAX}
      placeholder={placeholder}
      aria-label={placeholder}
      value={v}
      autoFocus={autoFocus}
      onChange={(e) => {
        set(e.target.value.replace(/\D/g, ""));
        setError("");
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          void onEnter();
        }
      }}
    />
  );

  const savedNow = !!saved && value === saved;
  return (
    <div className="kind-box">
      <div className="lock-status">
        <Lock size={15} />
        <span style={{ flex: 1 }}>
          {value && savedNow
            ? value.method === "hello"
              ? t.grp.lockedHello
              : t.grp.lockedPin
            : value
              ? t.grp.lockPending
              : saved
                ? t.grp.unlockPending
                : t.grp.notLocked}
        </span>
        {!value && !saved && mode === "idle" && (
          <button className="btn" onClick={() => setMode("set")}>
            {t.grp.lock}
          </button>
        )}
        {savedNow && mode === "idle" && (
          <button className="btn" disabled={busy} onClick={startRemove}>
            {t.grp.unlock}
          </button>
        )}
        {value !== saved && (
          <button className="btn" onClick={() => onChange(saved)}>
            {t.cancel}
          </button>
        )}
      </div>
      {mode === "set" && (
        <>
          <div className="pin-fields">
            {pinInput(pin, setPin, t.grp.pinLabel, applyLock, true)}
            {pinInput(pin2, setPin2, t.grp.pinConfirm, applyLock)}
          </div>
          <div className="kind-hint">{hello === null ? "" : hello ? t.grp.pinBackup : t.grp.pinOnly}</div>
          <div className="chip-row">
            <button className="btn primary" onClick={applyLock}>
              {t.grp.setLock}
            </button>
            <button className="btn" onClick={reset}>
              {t.cancel}
            </button>
          </div>
        </>
      )}
      {mode === "verify" && (
        <div className="chip-row" style={{ alignItems: "center", marginTop: 4 }}>
          <div style={{ flex: 1 }}>{pinInput(pin, setPin, t.grp.enterPin, verifyPin, true)}</div>
          <button className="btn primary" onClick={verifyPin}>
            {t.grp.verify}
          </button>
          <button className="btn" onClick={reset}>
            {t.cancel}
          </button>
        </div>
      )}
      {error && <div className="form-error" role="alert" style={{ marginTop: 6 }}>{error}</div>}
      <div className="lock-note">{t.grp.lockNote}</div>
    </div>
  );
}

// ---------------------------------------------------------------- unlock dialog

/** A locked group asks before it opens: Windows Hello when it is locked with it, else / as fallback the PIN. */
export function UnlockDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const folder = useDesk((s) => s.layout.folders[id]);
  const lock = folder?.lock;
  const [mode, setMode] = useState<"hello" | "pin" | "none">(lock?.method === "hello" ? "hello" : "pin");
  const [helloBusy, setHelloBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [pin, setPin] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const shake = useAnimationControls();
  const name = folder?.name ?? "";

  const tryHello = async () => {
    setMode("hello");
    setMsg({ text: t.grp.helloWaiting, error: false });
    if (!(await helloAvailable())) {
      if (lock?.hash) {
        setMode("pin");
        setMsg(null);
      } else {
        setMode("none");
        setMsg({ text: t.grp.helloUnavailable, error: true });
      }
      return;
    }
    setHelloBusy(true);
    const ok = await helloVerify(name, t.grp.helloMessage);
    setHelloBusy(false);
    if (ok) return unlockSucceeded(id);
    setMsg({ text: t.grp.helloFailed, error: true });
  };

  useEffect(() => {
    if (lock?.method === "hello") void tryHello();
    return () => unlockCancelled(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (mode === "pin") inputRef.current?.focus();
  }, [mode]);

  const close = onClose;

  const submit = async (value = pin) => {
    const wait = pinBlockedFor();
    if (wait) return setMsg({ text: t.grp.tooMany(wait), error: true });
    if (!value) return;
    const ok = await checkPin(lock, value);
    notePinResult(ok);
    if (ok) return unlockSucceeded(id);
    setPin("");
    setMsg({ text: t.grp.wrongPin, error: true });
    void shake.start({ x: [0, -10, 9, -6, 4, 0], transition: { duration: 0.36 } });
    inputRef.current?.focus();
  };

  const type = (d: string) => {
    if (pin.length >= PIN_MAX) return;
    setPin(pin + d);
    setMsg(null);
    inputRef.current?.focus();
  };

  if (!folder) return null;
  return (
    <div className="unlock">
      <div className="unlock-icon">{mode === "hello" ? <ScanFace size={28} /> : <Lock size={26} />}</div>
      <h2 id={DIALOG_TITLE}>{name || t.grp.unlockTitle}</h2>
      <div className="unlock-sub" data-error={!!msg?.error} aria-live="polite">
        {msg?.text ?? (mode === "pin" ? t.grp.enterPin : "")}
      </div>
      {mode === "pin" && (
        <>
          <motion.div className="pin-dots" animate={shake}>
            {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
              <i key={i} data-on={i < pin.length} />
            ))}
          </motion.div>
          <input
            ref={inputRef}
            className="pin-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={PIN_MAX}
            value={pin}
            aria-label={t.grp.enterPin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_MAX));
              setMsg(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="pin-pad" onPointerDown={(e) => e.preventDefault()}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button key={d} onClick={() => type(d)}>
                {d}
              </button>
            ))}
            <button aria-label={t.grp.backspace} title={t.grp.backspace} onClick={() => setPin(pin.slice(0, -1))}>
              <Delete size={18} />
            </button>
            <button onClick={() => type("0")}>0</button>
            <button className="ok" disabled={pin.length < 4} onClick={() => void submit()}>
              {t.grp.open}
            </button>
          </div>
        </>
      )}
      <div className="actions">
        {mode === "hello" && !helloBusy && (
          <button className="btn" onClick={tryHello}>
            {t.grp.tryAgain}
          </button>
        )}
        {mode === "hello" && !helloBusy && lock?.hash && (
          <button
            className="btn"
            onClick={() => {
              setMode("pin");
              setMsg(null);
            }}
          >
            {t.grp.usePin}
          </button>
        )}
        {mode === "pin" && lock?.method === "hello" && (
          <button className="btn" onClick={tryHello}>
            {t.grp.useHello}
          </button>
        )}
        <button className="btn" onClick={close}>
          {t.cancel}
        </button>
      </div>
    </div>
  );
}
