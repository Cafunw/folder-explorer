import { useEffect, useLayoutEffect, useRef } from "react";
import { t } from "../i18n";
import type { GridInfo } from "../layout/grid";
import { setHeadingText, spanOf } from "../layout/model";
import type { Placement } from "../types";
import { showItemMenu, startRename } from "./actions";
import { beginBlockPointer } from "./dnd";
import { JiggleBadge } from "./Jiggle";
import { iconEls } from "./registry";
import { commit, useDesk } from "./store";
import "./fence.css";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * A text heading (optionally underlined) or a divider line (with optional small text) over its
 * cells: click selects, drag moves, the right-edge handle changes the width, double-click / F2
 * edits the text, right-click opens its menu.
 */
export function Heading({ id, g, pl, moving }: { id: string; g: GridInfo; pl: Placement; moving: boolean }) {
  const h = useDesk((s) => s.layout.headings[id]);
  const selected = useDesk((s) => s.selection.has(id));
  const editing = useDesk((s) => s.rename?.id === id);
  const editable = useDesk((s) => !s.settings.behavior.lockLayout);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    iconEls.set(id, el);
    return () => {
      if (iconEls.get(id) === el) iconEls.delete(id);
    };
  }, [id]);

  if (!h) return null;
  const span = spanOf(pl);
  const size = Math.round(Math.min(28, Math.max(15, g.iconSize * 0.42)));
  const text = editing ? <HeadingEditor id={id} text={h.text} /> : null;
  const small = text ?? (h.text ? <span className="heading-small">{h.text}</span> : null);

  return (
    <div
      ref={ref}
      className="heading"
      data-hit=""
      data-style={h.style}
      data-align={h.align}
      data-selected={selected}
      data-moving={moving}
      style={{ width: span.w * g.cellW, height: span.h * g.cellH, ["--heading-size" as string]: `${size}px` }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!editing) beginBlockPointer(e, id, "move");
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!editing) startRename(id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void showItemMenu(id);
      }}
    >
      {h.style === "title" ? (
        <div className="heading-title" data-underline={!!h.underline}>
          {text ?? (
            <span className="heading-text" data-empty={!h.text}>
              {h.text || t.fence.headingPlaceholder}
            </span>
          )}
        </div>
      ) : (
        <div className="heading-divider">
          {small && h.align === "center" && <span className="heading-line" />}
          {small}
          <span className="heading-line" />
        </div>
      )}
      {editable && (
        <div
          className="heading-resize"
          onPointerDown={(e) => {
            e.stopPropagation();
            beginBlockPointer(e, id, "resize-x");
          }}
        />
      )}
      <JiggleBadge id={id} style={{ left: -4, top: "calc(50% - 10px)" }} />
    </div>
  );
}

function HeadingEditor({ id, text }: { id: string; text: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    useDesk.setState({ rename: null });
    const value = ref.current?.value.trim() ?? text;
    if (save && value !== text) commit(setHeadingText(useDesk.getState().layout, id, value));
  };
  return (
    <input
      ref={ref}
      className="heading-input"
      defaultValue={text}
      placeholder={t.fence.headingPlaceholder}
      spellCheck={false}
      onPointerDown={stop}
      onDoubleClick={stop}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}
