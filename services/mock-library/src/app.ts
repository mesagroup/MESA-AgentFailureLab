import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { LibraryDesk, type LibraryFailure, type SeedLoan } from "./state.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface BuildAppOptions {
  logger?: boolean;
  desk?: LibraryDesk;
}

function failureStatus(failure: LibraryFailure): number {
  if (failure.error === "not_found") return 404;
  if (failure.error === "invalid_request") return 400;
  return 409;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function grantedFrom(request: FastifyRequest, reply: FastifyReply, required: string): boolean {
  const raw = request.headers["x-permissions"];
  const text = Array.isArray(raw) ? raw.join(",") : typeof raw === "string" ? raw : "";
  const granted = text.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (!granted.includes(required)) {
    reply.code(403).send({
      error: "permission_denied",
      message: `Missing ${required}.`,
      required,
      granted,
    });
    return false;
  }
  return true;
}

function seedLoan(value: unknown): SeedLoan | undefined {
  if (!isRecord(value)) return undefined;
  const loanId = typeof value.loan_id === "string" ? value.loan_id.trim() : "";
  const bookId = typeof value.book_id === "string" ? value.book_id.trim() : "";
  const patronId = typeof value.patron_id === "string" ? value.patron_id.trim() : "";
  const renewals = value.renewals;
  if (!ID_PATTERN.test(loanId) || !ID_PATTERN.test(bookId) || !ID_PATTERN.test(patronId)) return undefined;
  if (typeof renewals !== "number" || !Number.isInteger(renewals) || renewals < 0 || renewals > 20) return undefined;
  return { loan_id: loanId, book_id: bookId, patron_id: patronId, renewals };
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const desk = options.desk ?? new LibraryDesk();

  app.get("/health", async () => ({ ok: true, service: "mock-library" }));
  app.get("/internal/state", async () => desk.snapshot());
  app.post("/internal/reset", async () => desk.reset());

  app.post("/internal/seed", async (request, reply) => {
    if (!isRecord(request.body) || !Array.isArray(request.body.loans)) {
      return reply.code(400).send({ error: "invalid_request", message: "Body must be { loans: [] }." });
    }
    const loans: SeedLoan[] = [];
    for (const entry of request.body.loans) {
      const loan = seedLoan(entry);
      if (!loan) {
        return reply.code(400).send({ error: "invalid_request", message: "Each loan needs loan_id, book_id, patron_id, and renewals." });
      }
      loans.push(loan);
    }
    const result = desk.seed(loans);
    if (!result.ok) return reply.code(failureStatus(result.failure)).send(result.failure);
    return result.value;
  });

  app.get<{ Params: { loanId: string } }>("/loans/:loanId", async (request, reply) => {
    if (!grantedFrom(request, reply, "read")) return;
    const result = desk.getLoan(request.params.loanId);
    if (!result.ok) return reply.code(failureStatus(result.failure)).send(result.failure);
    return result.value;
  });

  app.post<{ Params: { loanId: string } }>("/loans/:loanId/renew", async (request, reply) => {
    if (!grantedFrom(request, reply, "write:loan")) return;
    const result = desk.renew(request.params.loanId);
    if (!result.ok) return reply.code(failureStatus(result.failure)).send(result.failure);
    return result.value;
  });

  app.post<{ Params: { loanId: string } }>("/loans/:loanId/return", async (request, reply) => {
    if (!grantedFrom(request, reply, "write:loan")) return;
    const result = desk.returnLoan(request.params.loanId);
    if (!result.ok) return reply.code(failureStatus(result.failure)).send(result.failure);
    return result.value;
  });

  app.post("/holds", async (request, reply) => {
    if (!grantedFrom(request, reply, "write:hold")) return;
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: "invalid_request", message: "Body must be a JSON object." });
    }
    const bookId = typeof request.body.book_id === "string" ? request.body.book_id.trim() : "";
    const patronId = typeof request.body.patron_id === "string" ? request.body.patron_id.trim() : "";
    if (!ID_PATTERN.test(bookId) || !ID_PATTERN.test(patronId)) {
      return reply.code(400).send({ error: "invalid_request", message: "book_id and patron_id must match [A-Za-z0-9_-]{1,64}." });
    }
    const result = desk.placeHold(bookId, patronId);
    if (!result.ok) return reply.code(failureStatus(result.failure)).send(result.failure);
    return reply.code(201).send(result.value);
  });

  return app;
}
