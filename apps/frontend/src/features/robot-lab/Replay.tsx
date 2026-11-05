import { useEffect, useMemo, useState } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import type { RobotReport, World } from "@mesa/shared/robot-lab";
import { Button } from "@/components/ui/button";
import { MapView } from "./MapView";

function replayFrames(report: RobotReport) {
  const initial = report.steps[0]?.input.state ?? report.final;
  const frames: { world: World; step: number; trail: number[]; arrived: boolean }[] =
    [{ world: initial, step: 0, trail: [], arrived: true }];
  report.steps.forEach((step, i) => {
    const path = step.action.startsWith("move:") ? step.after.path ?? [] : [];
    for (let j = 0; j < path.length - 1; j++) {
      frames.push({ world: { ...step.input.state, cell: path[j] }, step: i + 1, trail: path.slice(0, j + 1), arrived: false });
    }
    frames.push({ world: step.after, step: i + 1, trail: path, arrived: true });
  });
  return frames;
}

export function Replay({ report }: { report: RobotReport }) {
  const frames = useMemo(() => replayFrames(report), [report]);
  const [position, seek] = useState(0);
  const [playing, play] = useState(false);
  const end = frames.length - 1;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (position + 1 >= end) play(false);
      seek(Math.min(position + 1, end));
    }, 550);
    return () => window.clearTimeout(timer);
  }, [playing, position, end]);
  function jump(index: number) { play(false); seek(index); }
  const frame = frames[position];
  const step = report.steps[frame.step - 1];
  return <div className="grid gap-5 md:grid-cols-2">
    <div className="space-y-3">
      <MapView layout={report.layout} world={frame.world} trail={frame.trail} blocked={frame.arrived && step?.blocked} />
      <label className="flex gap-3 text-sm">Replay
        <input className="min-w-0 flex-1 accent-primary" type="range" min={0} max={end} value={position}
          aria-valuetext={`Action ${frame.step} of ${report.steps.length}, frame ${position} of ${end}`}
          disabled={!end} onChange={e => jump(Number(e.target.value))} /></label>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Previous frame" disabled={!position} onClick={() => jump(position - 1)}><SkipBack /></Button>
        <Button size="sm" disabled={!end} onClick={() => { if (position === end) seek(0); play(!playing); }}>
          {playing ? <Pause /> : <Play />}{playing ? "Pause" : "Play"}</Button>
        <Button size="sm" variant="outline" disabled={position === end} aria-label="Next frame" onClick={() => jump(position + 1)}><SkipForward /></Button>
        <span className="text-xs text-muted-foreground">Action {frame.step} / {report.steps.length}</span>
      </div>
    </div>
    <div className="space-y-3"><h3 className="font-medium">Action timeline</h3>
      <ol className="max-h-64 space-y-1 overflow-y-auto">{report.steps.map((s, i) => <li key={i}>
        <button aria-current={frame.step === i + 1 ? "step" : undefined}
          className="w-full rounded-md border px-3 py-1 text-left text-sm aria-[current=step]:border-primary"
          onClick={() => jump(frames.findIndex(f => f.step === i + 1 && f.arrived))}>
          {i + 1}. <code>{s.action}</code> {s.blocked && "· Blocked"}
        </button></li>)}</ol>
      {step && <div className="space-y-2 text-sm"><p>{frame.arrived ? step.effect : "Moving along the aisle…"}</p>
        {step.input.reading && <blockquote className="border-l-2 border-violet-500 pl-3">QR input · {step.input.reading.text}</blockquote>}
        <p className="text-xs text-muted-foreground">{step.model} · {step.tokens ?? "Unknown"} tokens</p></div>}
    </div>
  </div>;
}
