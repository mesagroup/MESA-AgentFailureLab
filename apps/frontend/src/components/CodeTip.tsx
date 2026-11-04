import { useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function CodeTip({ label, code, children }: { label: string; code: string; children?: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className="inline-flex max-w-full items-center rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${label}. Code ${code}`}
      >
        {children ?? label}
      </TooltipTrigger>
      <TooltipContent>{code}</TooltipContent>
    </Tooltip>
  );
}

export function CopyIdButton({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(id).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy id"}
    </button>
  );
}
