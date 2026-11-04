import { useParams } from "react-router-dom";

export function RunsPage() {
  const { runId } = useParams<{ runId?: string }>();
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold">Runs</h1>
      <p className="text-sm text-muted-foreground mt-1">
        {runId ? `Run ${runId}` : "Testa agente"} — run launcher and history coming soon.
      </p>
    </div>
  );
}
