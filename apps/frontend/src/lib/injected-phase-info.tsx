import { useState } from "react";
import { Info } from "lucide-react";
import { cn } from "cn";
import { INJECTED_LAUNCH_COPY } from "./run-launch";

const TOOLTIP_ID = "injected-phase-info-tooltip";

/**
 * Accessible info control for Launch run → Inject fault.
 * Explains automatic malicious-prompt injection on previous baselines.
 */
export function InjectedPhaseInfo() {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex shrink-0">
      <button
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
      <span
        id={TOOLTIP_ID}
        role="tooltip"
        className={cn(
          open
            ? "absolute left-0 top-full z-20 mt-1 w-64 max-w-[min(16rem,calc(100vw-3rem))] rounded-xl border border-border bg-popover px-3 py-2 text-left text-xs leading-relaxed text-popover-foreground shadow-md"
            : "sr-only",
        )}
      >
        {INJECTED_LAUNCH_COPY.tooltip}
      </span>
    </span>
  );
}
