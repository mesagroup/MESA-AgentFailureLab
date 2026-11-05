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
install("HTMLInputElement", happyWindow.HTMLInputElement);
install("HTMLButtonElement", happyWindow.HTMLButtonElement);
install("Node", happyWindow.Node);
install("MutationObserver", happyWindow.MutationObserver);
install("requestAnimationFrame", (cb: (time: number) => void) => happyWindow.setTimeout(() => cb(0), 0));
install("cancelAnimationFrame", (id: number) => happyWindow.clearTimeout(id));
install("IS_REACT_ACT_ENVIRONMENT", true);

const { fireEvent, render, screen } = await import("@testing-library/react");
const { createElement } = await import("react");
const { Replay } = await import("./Replay");
const { defaultScenario, emptyMap, mission } = await import("@mesa/shared/robot-lab");

test("slider, play/pause and timeline use the recorded route and final state", () => {
  const layout = emptyMap(defaultScenario);
  layout.signs = [14];
  layout.obstacles = [7];
  const initial = { cell: 10, robot: "A" as const, parcel: "carried" as const, delivered: false, scanned: true };
  const final = { ...initial, cell: 14, robot: "B" as const, path: [11, 12, 13, 14], seen: [14] };
  render(createElement(Replay, { report: {
    arm: "baseline", layout, mission, elapsedMs: 1, verdict: "budget-exhausted", final,
    steps: [{ action: "move:B", model: "fixture", tokens: null, effect: "Moved to dock.", unauthorized: false,
      blocked: false, input: { state: initial, feedback: "", guarded: false, reading: null }, after: final }],
  } }));
  const map = () => screen.getByRole("img").getAttribute("aria-label");
  assert.match(map()!, /robot at cell 11, parcel at cell 11/);
  assert.equal(screen.queryByLabelText("QR sign"), null);
  assert.equal(screen.queryByLabelText("Obstacle"), null);
  fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
  assert.match(map()!, /robot at cell 13, parcel at cell 13/);
  assert.ok(screen.getByLabelText("Obstacle"));
  assert.equal(screen.queryByLabelText("QR sign"), null);
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  fireEvent.click(screen.getByRole("button", { name: /1\. move:B/ }));
  assert.ok(screen.getByLabelText("QR sign"));
  assert.match(map()!, /robot at cell 15, parcel at cell 15/);
});
