import { AnimatePresence, motion } from "motion/react";
import { primaryGrid } from "../layout/grid";
import { spring } from "../settings";
import { dismissToast, useDesk } from "./store";

export function Toasts() {
  const toasts = useDesk((s) => s.toasts);
  const grids = useDesk((s) => s.grids);
  const settings = useDesk((s) => s.settings);
  const g = primaryGrid(grids);
  if (!g) return null;
  return (
    <div className="toasts" style={{ left: g.left + g.workLeft + g.workWidth / 2, bottom: window.innerHeight - (g.top + g.workTop + g.workHeight) + 48 }}>
      <AnimatePresence initial={false}>
        {toasts.map((tt) => (
          <motion.div
            key={tt.id}
            layout
            className="toast"
            data-hit=""
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={spring(settings, 0.35, 0.2)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span>{tt.text}</span>
            {tt.action && (
              <button
                onClick={() => {
                  dismissToast(tt.id);
                  tt.action!.run();
                }}
              >
                {tt.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
