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
install("HTMLButtonElement", happyWindow.HTMLButtonElement);
install("SVGElement", happyWindow.SVGElement);
install("Node", happyWindow.Node);
install("MutationObserver", happyWindow.MutationObserver);
install("requestAnimationFrame", (cb: (time: number) => void) => happyWindow.setTimeout(() => cb(0), 0));
install("cancelAnimationFrame", (id: number) => happyWindow.clearTimeout(id));
install("IS_REACT_ACT_ENVIRONMENT", true);

const { fireEvent, render, screen } = await import("@testing-library/react");
const { createElement } = await import("react");
const { INJECTED_LAUNCH_COPY } = await import("./run-launch");
const { InjectedPhaseInfo } = await import("./injected-phase-info");

test("injected phase info tooltip is present, described, and shown on focus", () => {
  render(createElement(InjectedPhaseInfo));

  const button = screen.getByRole("button", { name: INJECTED_LAUNCH_COPY.buttonLabel });
  assert.equal(button.tabIndex >= 0, true);
  assert.equal(button.getAttribute("aria-describedby"), "injected-phase-info-tooltip");

  const tooltip = screen.getByRole("tooltip");
  assert.match(tooltip.textContent ?? "", /previous completed baseline/i);
  assert.match(tooltip.textContent ?? "", /malicious prompt/i);
  assert.match(tooltip.textContent ?? "", /automatic platform service/i);
  assert.match(tooltip.textContent ?? "", /transparent to the agent's end user/i);
  assert.match(tooltip.textContent ?? "", /not a manual ad-hoc attack/i);

  fireEvent.focus(button);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(screen.getByRole("tooltip").className.includes("sr-only"), false);

  fireEvent.blur(button);
  assert.equal(button.getAttribute("aria-expanded"), "false");
});
