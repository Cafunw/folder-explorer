import { useState, type ReactNode } from "react";
import { t } from "../i18n";

export const pct = (v: number) => `%${Math.round(v * 100)}`;
export const px = (v: number) => `${Math.round(v * 10) / 10} px`;
export const times = (v: number) => `${v.toFixed(2)}×`;

export function Row({ title, desc, stack, children }: { title: string; desc?: string; stack?: boolean; children?: ReactNode }) {
  return (
    <div className="row" data-stack={stack || undefined}>
      <div className="row-text">
        <div className="row-title">{title}</div>
        {desc && <div className="row-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

export function Toggle({ on: value, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className="toggle" data-on={value} onClick={() => onChange(!value)} role="switch" aria-checked={value} />;
}

export type SegOption<T> = { v: T; label: string; icon?: ReactNode };

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: SegOption<T>[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.v)} data-active={o.v === value} onClick={() => onChange(o.v)}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  format,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="slider" data-disabled={disabled || undefined}>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="val">{format ? format(value) : value}</span>
    </div>
  );
}

export function Colors({ value, options, onChange, allowNone }: { value: string | null; options: string[]; onChange: (c: string | null) => void; allowNone?: boolean }) {
  return (
    <div className="colors">
      {allowNone && <button className="swatch none" data-active={value === null} onClick={() => onChange(null)} title={t.noColor} />}
      {options.map((c) => (
        <button key={c} className="swatch" style={{ background: c }} data-active={value === c} onClick={() => onChange(c)} />
      ))}
      <input type="color" className="color-input" value={value ?? "#888888"} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

const CUSTOM_SWATCHES = ["#ffffff", "#111827", "#3b82f6", "#8b5cf6", "#ec4899", "#22c55e"];

/** null = automatic (or the accent colour); otherwise a picked colour. */
export function AutoColor({
  value,
  fallback,
  autoLabel = t.optAuto,
  onChange,
}: {
  value: string | null;
  fallback: string;
  autoLabel?: string;
  onChange: (c: string | null) => void;
}) {
  return (
    <div className="auto-color">
      {value !== null && <Colors value={value} options={CUSTOM_SWATCHES} onChange={(c) => onChange(c ?? fallback)} />}
      <Seg
        value={value === null ? "auto" : "custom"}
        options={[
          { v: "auto", label: autoLabel },
          { v: "custom", label: t.optCustom },
        ]}
        onChange={(v) => onChange(v === "auto" ? null : (value ?? fallback))}
      />
    </div>
  );
}

export function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [listening, setListening] = useState(false);
  return (
    <button
      className="hotkey"
      data-listening={listening}
      onClick={() => setListening(true)}
      onBlur={() => setListening(false)}
      onKeyDown={(e) => {
        if (!listening) return;
        e.preventDefault();
        if (e.key === "Escape") return setListening(false);
        const mods: string[] = [];
        if (e.ctrlKey) mods.push("Ctrl");
        if (e.altKey) mods.push("Alt");
        if (e.shiftKey) mods.push("Shift");
        if (e.metaKey) mods.push("Super");
        let key = e.code;
        if (key.startsWith("Key")) key = key.slice(3);
        else if (key.startsWith("Digit")) key = key.slice(5);
        else if (key === "Space") key = "Space";
        else if (!/^F\d{1,2}$/.test(key)) {
          if (["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"].includes(key)) return;
        }
        if (mods.length === 0) return;
        onChange([...mods, key].join("+"));
        setListening(false);
      }}
    >
      {listening ? t.pressKeys : value}
    </button>
  );
}
