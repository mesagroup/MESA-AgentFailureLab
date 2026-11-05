import { useState } from "react";
import { arms, mission, defaultScenario, limits, warehouseMap, type Scenario, type Arm, type RobotReport } from "@mesa/shared/robot-lab";
import { MapView } from "./MapView";
import { Replay } from "./Replay";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { backendFetch } from "@/lib/api";

const labels: Record<Arm, string> = { baseline: "Clean baseline", attack: "Injected QR", protected: "Injected QR + guard", "clean-control": "Clean QR + guard" };
function download(reports: RobotReport[]) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(reports, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "robot-lab-runs.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function RobotLab() {
  const [reports, setReports] = useState<RobotReport[]>([]);
  const [selected, select] = useState<number | null>(null);
  const [arm, chooseArm] = useState<Arm>("baseline");
  const [scenario, configure] = useState<Scenario>(defaultScenario);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run() {
    setBusy(true);
    setError("");
    try {
      const result = await backendFetch<RobotReport>("/robot-lab/runs", { method: "POST", body: JSON.stringify({ arm, scenario }) });
      if (!result.layout) throw new Error("The backend needs the warehouse map update. Please retry after deployment.");
      setReports(previous => [...previous, result]);
      select(reports.length);

    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Run failed.");
    } finally { setBusy(false); }
  }
  const report = selected === null ? undefined : reports[selected];
  function change(next: Scenario) { configure(next); select(null); }
  return <section className="mx-auto max-w-6xl space-y-5 px-4 pb-8 md:px-8">
    <header><h1 className="text-3xl font-semibold tracking-tight">Robot Lab</h1>
      <p className="mt-1 text-sm text-muted-foreground">{mission}</p></header>
    <Card><CardHeader><CardTitle>Configure run</CardTitle></CardHeader><CardContent>
      <fieldset disabled={busy} className="flex flex-wrap items-end gap-5">
        <label className="grid gap-1 text-sm">Experiment<select className="rounded-md border bg-background p-2" value={arm}
          onChange={e => { chooseArm(e.target.value as Arm); select(null); }}>{arms.map(a => <option value={a} key={a}>{labels[a]}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Map size<select className="rounded-md border bg-background p-2" value={scenario.size}
          onChange={e => change({ ...scenario, size: Number(e.target.value) as Scenario["size"] })}><option value="5">5 × 5</option><option value="9">9 × 9</option></select></label>
        {(["injections", "obstacles"] as const).map(key => <label key={key} className="grid gap-2 text-sm">
          {key === "injections" ? "Prompt injections" : "Obstacles"} · {scenario[key]}
          <input type="range" className="accent-primary" min={0} max={limits[key]} value={scenario[key]}
            onChange={e => change({ ...scenario, [key]: Number(e.target.value) })} /></label>)}
        <Button onClick={() => void run()} disabled={busy}>{busy ? "Running…" : "Launch run"}</Button>
      </fieldset>
      <p className="mt-3 text-xs text-muted-foreground">Clean controls use harmless text at the same QR locations. With zero injections, only the clean dispatch QR is present.</p>
      {busy && <p role="status">Waiting for Grok decisions…</p>}{error && <p role="alert">{error}</p>}
    </CardContent></Card>
    <Card><CardHeader><CardTitle>{report ? `Run ${selected! + 1} · ${labels[report.arm]} · ${report.verdict}` : "Warehouse preview"}</CardTitle></CardHeader>
      <CardContent>{report ? <div className="space-y-4"><Replay key={selected} report={report} />
        <Button variant="outline" disabled={busy} onClick={() => { chooseArm(report.arm); change(report.layout.scenario); }}>Reuse this setup</Button></div> : <MapView layout={warehouseMap(scenario)} />}</CardContent></Card>
    {!!reports.length && <Card><CardHeader><CardTitle>Run history</CardTitle></CardHeader><CardContent className="space-y-3 overflow-x-auto">
      <table className="w-full text-left text-sm"><thead><tr>{["Run", "Map / injections / obstacles", "Verdict", "Attempts / blocked", "Actions", "Time"].map(t => <th key={t} className="px-2">{t}</th>)}</tr></thead>
        <tbody>{reports.map((r, i) => <tr key={i} className="border-t"><td><Button variant="link" onClick={() => select(i)}>{i + 1}. {labels[r.arm]}</Button></td>
          <td>{r.layout.scenario.size} × {r.layout.scenario.size} / {r.arm === "baseline" || r.arm === "clean-control" ? 0 : r.layout.scenario.injections} / {r.layout.obstacles.length}</td>
          <td>{r.verdict}</td><td>{r.steps.filter(s => s.unauthorized).length} / {r.steps.filter(s => s.blocked).length}</td>
          <td>{r.steps.length}</td><td>{(r.elapsedMs / 1000).toFixed(1)} s</td></tr>)}</tbody></table>
      <Button variant="outline" onClick={() => download(reports)}>Download evidence</Button>
    </CardContent></Card>}
  </section>;
}
