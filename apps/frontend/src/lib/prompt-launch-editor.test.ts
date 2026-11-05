import assert from "node:assert/strict";
import test from "node:test";
import { Browser } from "happy-dom";

const browser = new Browser();
const page = browser.newPage();
const happyWindow = page.mainFrame.window;

function install(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

install("window", happyWindow);
install("document", happyWindow.document);
install("HTMLElement", happyWindow.HTMLElement);
install("HTMLTextAreaElement", happyWindow.HTMLTextAreaElement);
install("HTMLButtonElement", happyWindow.HTMLButtonElement);
install("Node", happyWindow.Node);
install("MutationObserver", happyWindow.MutationObserver);
install("requestAnimationFrame", (cb: (time: number) => void) => happyWindow.setTimeout(() => cb(0), 0));
install("cancelAnimationFrame", (id: number) => happyWindow.clearTimeout(id));
install("IS_REACT_ACT_ENVIRONMENT", true);

const { fireEvent, render, screen } = await import("@testing-library/react");
const { createElement } = await import("react");
const { PromptLaunchEditor, launchPromptOverride } = await import("./prompt-launch-editor");

test("launchPromptOverride is omitted until the draft differs from the task", () => {
  assert.equal(launchPromptOverride("same", "same", false), null);
  assert.equal(launchPromptOverride("same", "same", true), null);
  assert.equal(launchPromptOverride("  edited  ", "same", true), "  edited  ");
});

test("typing in the jury prompt editor changes the value and reports an override", async () => {
  const events: Array<{ draft: string; touched: boolean }> = [];
  const taskPrompt = "Cancel the last order for this session.";
  render(
    createElement(PromptLaunchEditor, {
      prefillKey: "jury:run-base",
      taskPrompt,
      helperText: "Starts from the reference task. Edit before launch.",
      history: [
        {
          run_id: "run-prev",
          phase: "injected",
          prompt: "Previous jury prompt.",
          started_at: "2026-11-05T10:00:00.000Z",
        },
      ],
      onDraftChange: (draft: string, touched: boolean) => {
        events.push({ draft, touched });
      },
    }),
  );

  const textarea = screen.getByLabelText("Prompt for this launch") as HTMLTextAreaElement;
  assert.equal(textarea.value, taskPrompt);
  assert.equal(textarea.readOnly, false);
  assert.equal(textarea.disabled, false);

  fireEvent.change(textarea, { target: { value: `${taskPrompt}\nOVERRIDE-JURY-TYPING` } });
  assert.equal(textarea.value.includes("OVERRIDE-JURY-TYPING"), true);
  const last = events.at(-1);
  assert.equal(last?.touched, true);
  assert.equal(last?.draft.includes("OVERRIDE-JURY-TYPING"), true);
  assert.equal(launchPromptOverride(last!.draft, taskPrompt, last!.touched), last!.draft);

  fireEvent.click(screen.getByText("Previous jury prompt."));
  const loaded = events.at(-1);
  assert.equal(loaded?.draft, "Previous jury prompt.");
  assert.equal(launchPromptOverride(loaded!.draft, taskPrompt, loaded!.touched), "Previous jury prompt.");
});
