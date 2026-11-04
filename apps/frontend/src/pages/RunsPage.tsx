import { useEffect, useRef, useState } from "react";
import { PlusCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { createRun, listRuns, type RunParams } from "@/lib/api";
import type { Run, RunPhase, RunStatus } from "@mesa/shared";

// T1–T5 from the reference agent (hardcoded fallback)
const REFERENCE_TASKS = [
  { task_id: "T1", title: "Search and open a product" },
  { task_id: "T2", title: "Add units to the cart" },
  { task_id: "T3", title: "Check out the cart" },
  { task_id: "T4", title: "Read order status" },
  { task_id: "T5", title: "Cancel an order only when allowed" },
];

function PhaseBadge({ phase }: { phase: RunPhase }) {
  const styles: Record<RunPhase, string> = {
    baseline: "bg-blue-500/15 text-blue-500 border-blue-500/20",
    injected: "bg-amber-500/15 text-amber-500 border-amber-500/20",
    after_fix: "bg-emerald-500/15 text-emerald-500 border-emerald-500/20",
  };
  const labels: Record<RunPhase, string> = {
    baseline: "baseline",
    injected: "injected",
    after_fix: "after fix",
  };
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono", styles[phase])}>
      {labels[phase]}
    </span>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  const styles: Record<RunStatus, string> = {
    queued: "border-border text-muted-foreground",
    running: "border-blue-500/30 text-blue-500 animate-pulse",
    passed: "bg-green-500/15 text-green-500 border-green-500/20",
    failed: "bg-red-500/15 text-red-500 border-red-500/20",
    error: "bg-red-500/15 text-red-500 border-red-500/20",
  };
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono", styles[status])}>
      {status}
    </span>
  );
}

export function RunsPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchRuns() {
    try {
      const data = await listRuns();
      setRuns(data.sort((a, b) => b.run_id.localeCompare(a.run_id)));
    } catch {
      // keep existing state on error
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchRuns();
  }, []);

  // Poll when any run is active
  useEffect(() => {
    const hasActive = runs.some((r) => r.status === "queued" || r.status === "running");
    if (hasActive && !pollingRef.current) {
      pollingRef.current = setInterval(fetchRuns, 3000);
    } else if (!hasActive && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [runs]);

  function handleRowClick(run: Run) {
    const target = run.trace_ids[0] ?? run.run_id;
    navigate(`/traces/${target}`);
  }

  return (
    <div className="px-5 pb-8 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between pt-2 pb-2">
        <div>
          <h1 className="text-xl font-semibold">Runs</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Test history · Track 03 CHAOS.AI</p>
        </div>
        <Button onClick={() => setSheetOpen(true)} size="sm" variant="outline" className="gap-1.5 rounded-full">
          <PlusCircle className="h-3.5 w-3.5" />
          New run
        </Button>
      </div>

      <div className="rounded-2xl bg-card shadow-island overflow-hidden">
        {loading ? (
          <div className="p-5 space-y-3">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground">No runs yet.</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Launch one to get started.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs">Run</TableHead>
                <TableHead className="text-xs">Task</TableHead>
                <TableHead className="text-xs">Phase</TableHead>
                <TableHead className="text-xs">Status</TableHead>
                <TableHead className="text-xs text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow
                  key={run.run_id}
                  className="cursor-pointer"
                  onClick={() => handleRowClick(run)}
                >
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {run.run_id.slice(0, 12)}…
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {run.task_id}
                  </TableCell>
                  <TableCell>
                    <PhaseBadge phase={run.phase} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={run.status} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(2)}s` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <NewRunSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onLaunched={() => {
          setSheetOpen(false);
          fetchRuns();
        }}
      />
    </div>
  );
}

function NewRunSheet({
  open,
  onOpenChange,
  onLaunched,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onLaunched: () => void;
}) {
  const [phase, setPhase] = useState<RunPhase>("baseline");
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set(REFERENCE_TASKS.map((t) => t.task_id)));
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleTask(id: string) {
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleLaunch() {
    if (selectedTasks.size === 0) {
      setError("Select at least one task.");
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      const params: RunParams = {
        phase,
        task_ids: [...selectedTasks],
      };
      await createRun(params);
      onLaunched();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Launch failed.");
    } finally {
      setLaunching(false);
    }
  }

  // Reset on open
  useEffect(() => {
    if (open) {
      setPhase("baseline");
      setSelectedTasks(new Set(REFERENCE_TASKS.map((t) => t.task_id)));
      setError(null);
    }
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex flex-col h-[72vh] rounded-t-2xl p-0">
        {/* Header */}
        <div className="shrink-0 px-8 pt-6 pb-5 border-b border-border/40">
          <p className="text-xs text-muted-foreground mb-0.5">New run</p>
          <SheetTitle className="font-mono text-base font-medium tracking-tight">configure</SheetTitle>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left — phase */}
          <div className="w-[38%] shrink-0 border-r border-border/40 px-8 py-6 space-y-6">
            <div>
              <p className="text-sm font-medium mb-3">Phase</p>
              <div className="flex flex-col gap-2">
                {(["baseline", "injected", "after_fix"] as RunPhase[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPhase(p)}
                    className={cn(
                      "text-left px-4 py-2.5 rounded-xl border text-sm transition-colors",
                      phase === p
                        ? "bg-foreground text-background border-foreground"
                        : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
                    )}
                  >
                    <span className="font-mono">{p === "after_fix" ? "after_fix" : p}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Fault injection — disabled placeholder */}
            {phase === "injected" && (
              <div>
                <p className="text-sm font-medium mb-2">Fault injection</p>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <div className="rounded-xl border border-border/40 px-4 py-2.5 opacity-40 cursor-not-allowed select-none">
                        <span className="text-xs text-muted-foreground font-mono">preset</span>
                        <p className="text-xs text-muted-foreground mt-0.5">Fault selector</p>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>Available when injector is ready</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}
          </div>

          {/* Right — tasks */}
          <div className="flex-1 overflow-y-auto px-8 py-6">
            <p className="text-sm font-medium mb-3">Tasks</p>
            <div className="space-y-2">
              {REFERENCE_TASKS.map((task) => {
                const checked = selectedTasks.has(task.task_id);
                return (
                  <label
                    key={task.task_id}
                    className="flex items-center gap-3 rounded-xl border border-border/40 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTask(task.task_id)}
                      className="accent-primary shrink-0"
                    />
                    <span className="font-mono text-xs text-muted-foreground w-6 shrink-0">{task.task_id}</span>
                    <span className="text-sm">{task.title}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center gap-3 px-8 py-4 border-t border-border/40">
          {error && <span className="text-xs text-destructive flex-1">{error}</span>}
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={launching}>
              Cancel
            </Button>
            <Button onClick={handleLaunch} disabled={launching || selectedTasks.size === 0}>
              {launching ? "Launching…" : "Launch run"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
