import { useState } from "react";
import { arms, mission, type Arm, type Dock, type RobotReport, type World } from "@mesa/shared/robot-lab";
import { Button } from "@/components/ui/button";
import { backendFetch } from "@/lib/api";

const labels: Record<Arm, string> = { baseline: "Clean baseline", attack: "Injected QR", protected: "Injected QR + guard", "clean-control": "Clean QR + guard" };
const layout: (Dock | null)[] = ["A", "B", null, "C"];

function MapView({ world }: { world: World }) {
  return <div aria-label="Warehouse map" className="grid max-w-sm grid-cols-2 gap-2">
    {layout.map(dock => dock ? <div key={dock} className="min-h-20 rounded border p-3">
      <strong>Dock {dock}</strong>
      <div>{world.robot === dock && "Robot "}{(world.parcel === dock || (world.parcel === "carried" && world.robot === dock)) && "· Parcel"}</div>
    </div> : <div key="aisle" className="p-3 text-muted-foreground">Aisle</div>)}
  </div>;
}

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
  const [selected, select] = useState(0);
  const [step, seek] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(arm: Arm) {
    setBusy(true);
    setError("");
    try {
      const result = await backendFetch<RobotReport>("/robot-lab/runs", { method: "POST", body: JSON.stringify({ arm }) });
      setReports(previous => [...previous, result]);
      select(reports.length);
      seek(result.steps.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Run failed.");
    } finally { setBusy(false); }
  }
  const report = reports[selected];
  const frame = report?.steps[step - 1];
  return <section className="mx-auto max-w-5xl space-y-5 p-6">
    <h1 className="text-3xl font-semibold">Robot Lab</h1>
    <p>{mission} The simulated scanner returns decoded text. Grok chooses each action.</p>
    <div className="flex flex-wrap gap-2">{arms.map(arm =>
      <Button key={arm} disabled={busy} variant="outline" onClick={() => void run(arm)}>{labels[arm]}</Button>)}</div>
    {busy && <p role="status">Waiting for Grok decisions…</p>}
    {error && <p role="alert">{error}</p>}
    {reports.length > 0 && <>
      <table className="w-full text-left"><caption className="sr-only">Experiment results</caption>
        <thead><tr>{["Run", "World verdict", "Attempts / blocked", "Actions", "Time"].map(t => <th key={t}>{t}</th>)}</tr></thead>
        <tbody>{reports.map((r, i) => <tr key={i}><td><Button variant="link" onClick={() => { select(i); seek(r.steps.length); }}>{i + 1}. {labels[r.arm]}</Button></td>
          <td>{r.verdict}</td><td>{r.steps.filter(s => s.unauthorized).length} / {r.steps.filter(s => s.blocked).length}</td><td>{r.steps.length}</td><td>{(r.elapsedMs / 1000).toFixed(1)} s</td></tr>)}</tbody>
      </table>
      <Button variant="outline" onClick={() => download(reports)}>Download evidence</Button>
    </>}
    {report && <article className="space-y-3"><h2 className="text-xl font-semibold">Run {selected + 1} · {labels[report.arm]}</h2>
      <MapView world={frame?.after ?? report.steps[0]?.input.state ?? report.final} />
      <label className="flex items-center gap-3">Step {step} / {report.steps.length}
        <input type="range" min={0} max={report.steps.length} value={step} onChange={e => seek(Number(e.target.value))} /></label>
      {frame && <><p><strong>{frame.action}</strong> · {frame.effect}</p>
        <p>Scanner input · {frame.input.reading?.text ?? "No decoded QR yet"}</p><p>{frame.model} · {frame.tokens ?? "Unknown"} tokens</p></>}
    </article>}
  </section>;
}
