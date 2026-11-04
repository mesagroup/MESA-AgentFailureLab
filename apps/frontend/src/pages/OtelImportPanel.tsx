import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { importOtelBatch } from "@/lib/api";
import { otelImportErrorText, parseOtelBatch } from "@/lib/otel";

/**
 * Paste or upload a version-1 span batch and open the Trace the importer stored.
 * The panel never asks for a bearer token. Mapping does not invent fault labels
 * or a verifier; the batch must already include `outcome.verifier`.
 */
export function OtelImportPanel({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  function showFailure(message: string, httpDetails: string | null) {
    setError(message);
    setDetails(httpDetails);
  }

  async function handleImport() {
    const parsed = parseOtelBatch(text);
    if (!parsed.ok) {
      showFailure(parsed.error, null);
      return;
    }
    setImporting(true);
    setError(null);
    setDetails(null);
    try {
      const result = await importOtelBatch(agentId, parsed.value);
      const traceId = result.traces[0]?.trace_id;
      if (!traceId) {
        showFailure("Import stored no trace.", null);
        return;
      }
      navigate(`/traces/${encodeURIComponent(traceId)}`);
    } catch (cause) {
      const shown = otelImportErrorText(cause);
      showFailure(shown.message, shown.details);
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="space-y-3 rounded-2xl bg-card px-5 py-5 shadow-island">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Import OTel spans</h2>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="Upload a span batch"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result === "string") setText(reader.result);
              };
              reader.readAsText(file);
            }}
          />
          <Button type="button" size="sm" variant="outline" className="rounded-full" onClick={() => fileRef.current?.click()}>
            Upload JSON
          </Button>
          <Button type="button" size="sm" className="rounded-full" disabled={importing} onClick={() => void handleImport()}>
            {importing ? "Importing…" : "Import"}
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Paste a version 1 span batch. Import maps spans to a Trace and a baseline Run, then opens that Trace. It does not call the OTel endpoint, and it does not invent fault labels or a verifier. The batch must already include outcome.verifier.
      </p>
      <textarea
        value={text}
        rows={8}
        className="w-full rounded-none border-0 border-b border-border/60 bg-transparent px-0 py-1 font-mono text-xs placeholder:text-muted-foreground/50 focus-visible:border-foreground focus-visible:outline-none resize-y"
        aria-label="Span batch JSON"
        placeholder='{"version":1,"items":[...]}'
        onChange={(event) => setText(event.target.value)}
      />
      {error && (
        <p className="text-sm break-words text-destructive">
          {error}
          {details ? <span className="mt-1 block font-mono text-xs">{details}</span> : null}
        </p>
      )}
    </section>
  );
}
