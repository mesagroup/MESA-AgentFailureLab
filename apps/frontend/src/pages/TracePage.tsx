import { useParams } from "react-router-dom";

export function TracePage() {
  const { traceId } = useParams<{ traceId: string }>();
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold">Trace</h1>
      <p className="text-sm text-muted-foreground mt-1">
        {traceId ? `Trace ${traceId}` : "Ispeziona traccia"} — trace timeline coming soon.
      </p>
    </div>
  );
}
