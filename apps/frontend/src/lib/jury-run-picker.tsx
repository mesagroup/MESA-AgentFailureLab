import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronDown, Search } from "lucide-react";
import { cn } from "cn";
import type { Agent, Run } from "@mesa/shared";
import {
  JURY_LAUNCH_COPY,
  runPhaseLabel,
  taskForRun,
  taskTitleForRun,
} from "./run-launch";

function runStatusClass(status: string): string {
  if (status === "passed") return "text-green-600";
  if (status === "failed" || status === "error") return "text-red-500";
  return "text-muted-foreground";
}

function stopSheetPointer(event: PointerEvent<HTMLElement>) {
  event.stopPropagation();
}

function stopSheetKeys(event: KeyboardEvent<HTMLElement>) {
  event.stopPropagation();
}

function JuryRunSummary({
  agent,
  run,
  promptPreview,
}: {
  agent: Agent | null;
  run: Run;
  promptPreview?: boolean;
}) {
  const title = taskTitleForRun(agent, run);
  const task = taskForRun(agent, run);
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium truncate">{title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{run.task_id}</span>
        <span className="text-[11px] text-muted-foreground">{runPhaseLabel(run.phase)}</span>
        <span className={cn("text-[11px] font-mono", runStatusClass(run.status))}>{run.status}</span>
      </div>
      {promptPreview ? (
        <p className="text-xs text-muted-foreground line-clamp-2">
          {task?.prompt ?? "No prompt on agent for this task id."}
        </p>
      ) : null}
    </div>
  );
}

export function JuryRunPicker({
  agent,
  launching,
  filter,
  onFilter,
  references,
  selectedRun,
  onSelectRun,
}: {
  agent: Agent | null;
  launching: boolean;
  filter: string;
  onFilter: (value: string) => void;
  references: readonly Run[];
  selectedRun: Run | null;
  onSelectRun: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const activeRun = references[activeIndex];
  const activeOptionId = activeRun ? `${listId}-opt-${activeRun.run_id}` : undefined;

  useEffect(() => {
    if (!open) return;
    const selectedIdx = selectedRun
      ? references.findIndex((run) => run.run_id === selectedRun.run_id)
      : -1;
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0);
  }, [open, references, selectedRun]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: globalThis.PointerEvent) {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function closeList(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function pick(runId: string) {
    onSelectRun(runId);
    onFilter("");
    closeList(true);
  }

  function moveActive(delta: number) {
    if (references.length === 0) return;
    setActiveIndex((index) => {
      const next = index + delta;
      if (next < 0) return 0;
      if (next > references.length - 1) return references.length - 1;
      return next;
    });
  }

  function pickActive() {
    const run = references[activeIndex];
    if (run) pick(run.run_id);
  }

  function onRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    stopSheetKeys(event);
    if (event.key === "Escape") {
      event.preventDefault();
      closeList(true);
    }
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    stopSheetKeys(event);
    if (event.key === "Escape") {
      event.preventDefault();
      closeList(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pickActive();
    }
  }

  return (
    <div ref={rootRef} className="space-y-2" onKeyDown={onRootKeyDown} onPointerDown={stopSheetPointer}>
      <button
        ref={triggerRef}
        type="button"
        disabled={launching}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={cn(
          "w-full flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-50",
          selectedRun ? "border-foreground bg-muted/20" : "border-border/40 hover:bg-muted/20",
        )}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (open) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {selectedRun ? (
          <JuryRunSummary agent={agent} run={selectedRun} promptPreview={!open} />
        ) : (
          <span className="text-sm text-muted-foreground flex-1">{JURY_LAUNCH_COPY.pickerPlaceholder}</span>
        )}
        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 shrink-0 mt-0.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div className="rounded-xl border border-border/40 bg-background p-3 space-y-3">
          <div className="relative">
            <Search aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
            <input
              value={filter}
              autoFocus
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeOptionId}
              onChange={(event) => onFilter(event.target.value)}
              placeholder={JURY_LAUNCH_COPY.pickerFilterPlaceholder}
              className="h-9 w-full pl-9 text-sm rounded-none border-0 border-b border-border/60 bg-transparent outline-none placeholder:text-muted-foreground/50 disabled:opacity-50"
              aria-label={JURY_LAUNCH_COPY.pickerFilterLabel}
              disabled={launching}
              onPointerDown={stopSheetPointer}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          {references.length === 0 ? (
            <p className="text-xs text-muted-foreground">No runs match this filter.</p>
          ) : (
            <div
              id={listId}
              role="listbox"
              aria-label="Reference runs"
              className="space-y-1 max-h-56 overflow-y-auto"
            >
              {references.map((run, index) => {
                const selected = selectedRun?.run_id === run.run_id;
                const active = index === activeIndex;
                return (
                  <button
                    key={run.run_id}
                    id={`${listId}-opt-${run.run_id}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    disabled={launching}
                    className={cn(
                      "w-full flex items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors disabled:opacity-50",
                      selected ? "border border-foreground bg-muted/20" : "border border-transparent hover:bg-muted/20",
                      active && "bg-muted/30",
                    )}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => pick(run.run_id)}
                  >
                    <JuryRunSummary agent={agent} run={run} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
