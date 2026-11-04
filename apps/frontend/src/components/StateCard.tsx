import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiErrorDetails, friendlyApiMessage } from "@/lib/errors";

export function StateCard({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-card px-5 py-12 text-center shadow-island">
      <Icon className="mx-auto size-5 text-muted-foreground" aria-hidden />
      <p className="mt-3 text-sm font-medium">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const [open, setOpen] = useState(false);
  const details = apiErrorDetails(error);
  return (
    <StateCard
      icon={AlertCircle}
      title={friendlyApiMessage(error)}
      action={
        <div className="flex flex-col items-center gap-3">
          {onRetry && (
            <Button size="sm" variant="outline" className="rounded-full" onClick={onRetry}>
              Retry
            </Button>
          )}
          {details && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
            >
              {open ? "Hide details" : "Show details"}
            </button>
          )}
          {open && details && <p className="font-mono text-xs text-muted-foreground">{details}</p>}
        </div>
      }
    />
  );
}
