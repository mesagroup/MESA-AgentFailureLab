import { CONTRACT_VERSION } from "@mesa/shared";

const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:3001";
const agentServiceUrl = import.meta.env.VITE_AGENTSERVICE_URL || "http://127.0.0.1:3002";

export function App() {
  return (
    <main>
      <p className="eyebrow">Track 03 · CHAOS.AI</p>
      <h1>MESA Agent Failure Lab</h1>
      <p className="lede">
        Scaffold for the web UI. Registration, the run list, and the trace timeline will live here.
        This app does not own the mock world, the verifier, or Grok.
      </p>

      <p className="meta">
        Shared contract <code>@mesa/shared</code> version <strong>{CONTRACT_VERSION}</strong>.
        Task success is <code>outcome.verifier</code> from the backend. This UI will render traces
        and before/after runs. It will not decide whether a task passed.
      </p>

      <section className="grid" aria-label="App ownership">
        <article>
          <h2>Frontend</h2>
          <p>This app, port 3000. Agent registration, runs, and the timeline.</p>
        </article>
        <article>
          <h2>Backend</h2>
          <p>
            Mock e-commerce, verifier, and harness. <a href={backendUrl}>{backendUrl}</a>
          </p>
        </article>
        <article>
          <h2>Agent service</h2>
          <p>
            Grok reference agent and diagnosis.{" "}
            <a href={agentServiceUrl}>{agentServiceUrl}</a>
          </p>
        </article>
      </section>
    </main>
  );
}
