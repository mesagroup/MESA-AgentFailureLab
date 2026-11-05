import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { INJECTED_LAUNCH_COPY } from "./run-launch";

const TOOLTIP_ID = "injected-phase-info-tooltip";

/**
 * Accessible info control for Launch run → Inject fault.
 * Explains automatic malicious-prompt injection on previous baselines.
 */
export function InjectedPhaseInfo() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState({ top: 0, left: 0, width: 256 });

  useLayoutEffect(() => {
    if (!open) return;
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.min(256, Math.max(160, window.innerWidth - 24));
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
    setBox({ top: rect.bottom + 6, left, width });
  }, [open]);

  const tooltip = (
    <span
      id={TOOLTIP_ID}
      role="tooltip"
      className={
        open
          ? "rounded-xl border border-border bg-popover px-3 py-2 text-left text-xs leading-relaxed text-popover-foreground shadow-md"
          : "sr-only"
      }
      style={open ? { position: "fixed", top: box.top, left: box.left, width: box.width, zIndex: 80 } : undefined}
    >
      {INJECTED_LAUNCH_COPY.tooltip}
    </span>
  );

  return (
    <span className="inline-flex shrink-0">
      <button
        ref={buttonRef}
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={INJECTED_LAUNCH_COPY.buttonLabel}
        aria-describedby={TOOLTIP_ID}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      {open && typeof document !== "undefined" ? createPortal(tooltip, document.body) : tooltip}
    </span>
  );
}
