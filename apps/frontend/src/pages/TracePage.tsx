import { useParams } from "react-router-dom";

export function TracePage() {
  const { runId } = useParams<{ runId: string }>();
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold">Trace</h1>
      <p className="text-sm text-muted-foreground mt-1">
        {runId ? `Run ${runId}` : "Select a run"} — trace timeline coming soon.
      </p>
    </div>
  );
}
