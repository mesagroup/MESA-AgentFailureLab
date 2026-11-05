import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { Browser } from "happy-dom";
import type { Agent, Run } from "@mesa/shared";
import { filterRunsByQuery, JURY_LAUNCH_COPY } from "./run-launch.ts";

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
install("SVGElement", happyWindow.SVGElement);
install("Node", happyWindow.Node);
install("MutationObserver", happyWindow.MutationObserver);
install("requestAnimationFrame", (cb: (time: number) => void) => happyWindow.setTimeout(() => cb(0), 0));
install("cancelAnimationFrame", (id: number) => happyWindow.clearTimeout(id));
install("IS_REACT_ACT_ENVIRONMENT", true);

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { JuryRunPicker } = await import("./jury-run-picker");

afterEach(() => cleanup());

function run(partial: Partial<Run> & Pick<Run, "run_id" | "agent_id" | "task_id" | "phase" | "status">): Run {
  return {
    trace_ids: [],
    injection_plan: null,
    fix_kinds: [],
    ...partial,
  };
}

const agent = {
  agent_id: "external-library",
  tasks: [
    { task_id: "place-hold", title: "Hold the atlas for Ada", prompt: "Place a hold for patron-ada." },
    { task_id: "renew-loan", title: "Renew Ada's owl guide", prompt: "Renew the seeded loan for the patron." },
  ],
} as Agent;

const runs = [
  run({ run_id: "run-hold", agent_id: "external-library", task_id: "place-hold", phase: "baseline", status: "passed" }),
  run({
    run_id: "run-hold-err",
    agent_id: "external-library",
    task_id: "place-hold",
    phase: "baseline",
    status: "error",
  }),
  run({ run_id: "run-renew", agent_id: "external-library", task_id: "renew-loan", phase: "baseline", status: "passed" }),
];

function PickerHarness() {
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRun = runs.find((item) => item.run_id === selectedId) ?? null;
  return createElement(JuryRunPicker, {
    agent,
    launching: false,
    filter,
    onFilter: setFilter,
    references: filterRunsByQuery(runs, agent, filter),
    selectedRun,
    onSelectRun: setSelectedId,
  });
}

test("closed security picker shows a placeholder and hides sibling runs", () => {
  render(createElement(PickerHarness));
  assert.ok(screen.getByRole("button", { name: JURY_LAUNCH_COPY.pickerPlaceholder }));
  assert.equal(screen.queryByRole("listbox"), null);
  assert.equal(screen.queryByText("Renew Ada's owl guide"), null);
  assert.equal(screen.queryByText("Hold the atlas for Ada"), null);
});

test("opening the picker lists runs; choosing one keeps only the selected card", () => {
  render(createElement(PickerHarness));
  fireEvent.click(screen.getByRole("button", { name: JURY_LAUNCH_COPY.pickerPlaceholder }));
  assert.ok(screen.getByRole("listbox", { name: "Reference runs" }));
  assert.ok(screen.getByRole("option", { name: /Hold the atlas for Ada.*passed/i }));
  assert.ok(screen.getByRole("option", { name: /Renew Ada's owl guide/i }));

  fireEvent.click(screen.getByRole("option", { name: /Renew Ada's owl guide/i }));
  assert.equal(screen.queryByRole("listbox"), null);
  assert.ok(screen.getByRole("button", { name: /Renew Ada's owl guide/ }));
  assert.equal(screen.queryByText("Hold the atlas for Ada"), null);
  assert.match(screen.getByRole("button", { expanded: false }).textContent ?? "", /Renew the seeded loan/);
});

test("filter inside the open picker keeps matching runs only", () => {
  render(createElement(PickerHarness));
  fireEvent.click(screen.getByRole("button", { name: JURY_LAUNCH_COPY.pickerPlaceholder }));
  fireEvent.change(screen.getByLabelText(JURY_LAUNCH_COPY.pickerFilterLabel), { target: { value: "error" } });
  assert.ok(screen.getByRole("option", { name: /Hold the atlas for Ada.*error/i }));
  assert.equal(screen.queryByRole("option", { name: /Renew Ada's owl guide/i }), null);
  assert.equal(screen.queryByRole("option", { name: /passed/i }), null);
});

test("choosing a run clears the filter so reopening lists every run", () => {
  render(createElement(PickerHarness));
  fireEvent.click(screen.getByRole("button", { name: JURY_LAUNCH_COPY.pickerPlaceholder }));
  fireEvent.change(screen.getByLabelText(JURY_LAUNCH_COPY.pickerFilterLabel), { target: { value: "renew" } });
  fireEvent.click(screen.getByRole("option", { name: /Renew Ada's owl guide/i }));
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  assert.ok(screen.getByRole("option", { name: /Hold the atlas for Ada.*passed/i }));
  assert.ok(screen.getByRole("option", { name: /Renew Ada's owl guide/i }));
});

test("Escape closes the open list", () => {
  render(createElement(PickerHarness));
  fireEvent.click(screen.getByRole("button", { name: JURY_LAUNCH_COPY.pickerPlaceholder }));
  assert.ok(screen.getByRole("listbox"));
  fireEvent.keyDown(screen.getByLabelText(JURY_LAUNCH_COPY.pickerFilterLabel), { key: "Escape" });
  assert.equal(screen.queryByRole("listbox"), null);
});
