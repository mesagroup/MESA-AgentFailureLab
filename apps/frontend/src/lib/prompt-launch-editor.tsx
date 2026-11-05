import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "cn";
import {
  PROMPT_LAUNCH_COPY,
  type PromptHistoryEntry,
} from "./run-launch";

/**
 * Launch-sheet prompt editor used by injected, after_fix, and jury.
 * Owns the draft so parent re-renders (reference run object identity, jury
 * GET, run list refresh) cannot overwrite keystrokes.
 */
export function PromptLaunchEditor({
  prefillKey,
  taskPrompt,
  helperText,
  history,
  disabled,
  onDraftChange,
}: {
  prefillKey: string;
  taskPrompt: string;
  helperText: string;
  history: readonly PromptHistoryEntry[];
  disabled?: boolean;
  onDraftChange: (draft: string, touched: boolean) => void;
}) {
  const [draft, setDraft] = useState(taskPrompt);
  const [touched, setTouched] = useState(false);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;

  useEffect(() => {
    setDraft(taskPrompt);
    setTouched(false);
    onDraftChangeRef.current(taskPrompt, false);
    // Prefill only when the selected run/phase changes — not when the parent
    // re-renders with a new task object of the same prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillKey]);

  function commit(next: string, nextTouched: boolean) {
    setDraft(next);
    setTouched(nextTouched);
    onDraftChange(next, nextTouched);
  }

  function stopSheetPointer(event: PointerEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function stopSheetKeys(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation();
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium mb-2">{PROMPT_LAUNCH_COPY.label}</p>
        <p className="text-xs text-muted-foreground mb-2">{helperText}</p>
        <textarea
          value={draft}
          disabled={disabled}
          readOnly={false}
          rows={6}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-xl border border-border/40 bg-background px-3 py-2 text-sm leading-relaxed resize-y min-h-[8rem] disabled:opacity-50"
          aria-label={PROMPT_LAUNCH_COPY.label}
          onPointerDown={stopSheetPointer}
          onKeyDown={stopSheetKeys}
          onChange={(event) => commit(event.target.value, true)}
        />
        {touched && draft !== taskPrompt && (
          <button
            type="button"
            disabled={disabled}
            className="mt-2 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-50"
            onClick={() => commit(taskPrompt, false)}
          >
            {PROMPT_LAUNCH_COPY.reset}
          </button>
        )}
      </div>

      <div>
        <p className="text-sm font-medium mb-1">{PROMPT_LAUNCH_COPY.historyLabel}</p>
        <p className="text-xs text-muted-foreground mb-2">{PROMPT_LAUNCH_COPY.historyHint}</p>
        <ol className="space-y-1.5" aria-label={PROMPT_LAUNCH_COPY.historyLabel}>
          <li>
            <button
              type="button"
              disabled={disabled}
              className={cn(
                "w-full text-left rounded-lg border px-3 py-2 transition-colors disabled:opacity-50",
                !touched || draft === taskPrompt
                  ? "border-foreground bg-muted/20"
                  : "border-border/40 hover:bg-muted/20",
              )}
              onClick={() => commit(taskPrompt, false)}
            >
              <span className="block text-[11px] text-muted-foreground">{PROMPT_LAUNCH_COPY.taskLine}</span>
              <span className="block text-xs whitespace-pre-wrap line-clamp-2 mt-0.5">{taskPrompt || "—"}</span>
            </button>
          </li>
          {history.map((entry) => (
            <li key={entry.run_id}>
              <button
                type="button"
                disabled={disabled}
                className={cn(
                  "w-full text-left rounded-lg border px-3 py-2 transition-colors disabled:opacity-50",
                  touched && draft === entry.prompt
                    ? "border-foreground bg-muted/20"
                    : "border-border/40 hover:bg-muted/20",
                )}
                onClick={() => commit(entry.prompt, entry.prompt !== taskPrompt)}
              >
                <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] font-mono text-muted-foreground">
                  <span>{entry.run_id}</span>
                  <span>{entry.phase}</span>
                  <span>{entry.started_at ?? "—"}</span>
                </span>
                <span className="block text-xs whitespace-pre-wrap line-clamp-2 mt-0.5">{entry.prompt}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function launchPromptOverride(draft: string, taskPrompt: string | undefined, touched: boolean): string | null {
  if (!touched) return null;
  const next = draft.trim();
  if (next.length === 0) return null;
  if (taskPrompt !== undefined && next === taskPrompt.trim()) return null;
  return draft;
}
