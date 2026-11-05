# Production Trace import

`POST /traces` stores a pasted or uploaded lab Trace as a production document. This is the backend for [#51](https://github.com/mesagroup/MESA-AgentFailureLab/issues/51) (FE-owned). It is not OpenTelemetry remap ([otel.md](otel.md)) and it is not a harness run.

`POST /traces` does not conflict with `GET /traces`, `GET /traces/:traceId`, or `POST /traces/:traceId/diagnose`. There is no `/traces/import` alias.

## Contract (`CONTRACT_VERSION` `0.5.0`)

Optional `Trace.source` still validates when omitted. The enum is `harness`, `demo_seed`, `otel_prod`, `otel_test`, and `production`. Writers set the field: harness/attacker → `harness`, boot demo pairs → `demo_seed`, OTel pull → `otel_prod` / `otel_test`, this route → `production` (server-side, ignoring the client value).

### Request

```http
POST /traces
Content-Type: application/json
```

Body: one Trace object (`packages/shared/schemas/trace.schema.json`). No envelope. No auth. Size limit **1 048 576 bytes** (`TRACE_IMPORT_BODY_LIMIT`).

Example using a shared fixture:

```bash
curl -sS -D - -o /tmp/imported-trace.json -X POST http://127.0.0.1:3001/traces \
  -H 'content-type: application/json' \
  --data-binary @packages/shared/examples/production/t1-search-product.json
```

The server:

1. Validates with `validateTrace`.
2. Rejects injector/attacker `fault.*` (`fault.injected`, non-empty `fault.labels`, or `fault.attacker.used`).
3. Stamps `source: "production"`.
4. Inserts with `insertTrace` (no overwrite).

It does not create a Run row. `run_id` on the document is caller-supplied. `GET /runs/:runId` may 404. Diagnosis still works: `POST /traces/:traceId/diagnose` loads the Trace, not the Run.

### Success

HTTP **201**. Body is the stored Trace (same shape as `GET /traces/:traceId`), with `source` `"production"`.

The document is visible in `GET /traces`, `GET /traces?source=production`, and `GET /traces/:traceId`. Diagnosis is `POST /traces/:traceId/diagnose` (empty body).

### Errors

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_trace` | Body failed `validateTrace`. `message` is the joined Ajv errors; `errors` is the array. |
| 400 | `fault_forbidden` | Schema-valid Trace with injector or attacker `fault.*` (ADR-002: only the injector/attacker writes those fields). |
| 400 | `invalid_request` | Parser/media-type errors (malformed JSON, wrong content type). |
| 409 | `conflict` | A trace with that `trace_id` already exists (seed, harness, OTel pull, or a previous import). The stored row is unchanged. |
| 413 | `payload_too_large` | Body larger than 1 MiB. |

```json
{ "error": "conflict", "message": "Trace trace-t1-prod-search-001 already exists." }
```

```json
{
  "error": "fault_forbidden",
  "message": "Production import cannot include injector or attacker fault.* (ADR-002). Send fault.injected false, fault.labels [], and fault.attacker { used: false, payload_id: null }."
}
```

The route does not take the mock-world gate. A 409 here is always `conflict` on the trace id, not `world_busy`.

## Outcome criterion (production, #51)

A production import has **no lab verifier ground truth and no `fault.labels` ground truth**.

| Field | What it means on an imported production Trace |
| --- | --- |
| `fault.*` | Must be the empty production mark: `injected` false, `labels` `[]`, `attacker.used` false. The lab injector did not run. There is no catalog code to score. |
| `outcome.verifier` | Required by the Trace schema, so the JSON must include it. It is **caller-supplied snapshot and checks**, not a re-run of the mock verifier against `GET /internal/state`. The harness does not call the shop on import. |
| `outcome.success` | Still must equal `outcome.verifier.passed` (schema). That equality is a document constraint, not proof that the mock world agreed. |
| `diagnosis` | Null until `POST /traces/:traceId/diagnose`. Grok still must not write `outcome.verifier` or `fault.*`. |
| `fix_verified` / before-after | The shop experiment formula (`baseline_pass && injected_before_fail && injected_after_pass && …`) does **not** apply. There is no injected-before arm and no mock world bound to this document. |

How to read a production diagnosis: treat `diagnosis` (category, cause, culprit `step_id`, evidence, proposed fixes) as assisted judgement on the imported steps. Do not treat `outcome.verifier.passed` as a lab pass/fail authority for that attempt, and do not treat empty `fault.labels` as “no fault occurred in production.” Replay `POST /runs` `phase: after_fix` against a missing parent Run is out of scope for this import.

Shared paste fixtures: [`packages/shared/examples/production/`](../packages/shared/examples/production/README.md).

## What #51 FE needs

1. Client-side `validateTrace` (already used for the fixtures).
2. `POST /traces` with the raw Trace JSON (not `{ trace: … }`).
3. On 201, open `/traces/:traceId` using `trace_id` from the response (which already has `source: "production"`).
4. Offer diagnosis through the existing `POST /traces/:traceId/diagnose` control. No new diagnose contract.
5. Surface `409 conflict` when the id collides with a seed/OTel/harness row; do not retry as upsert.
6. Surface `400 fault_forbidden` when the paste includes `fault.labels` / injected / attacker.
7. Cap uploads at 1 MiB or handle `413 payload_too_large`.
8. List filter `source=production` works on `GET /traces` once this backend is deployed. Upload/paste UI remains #51.
