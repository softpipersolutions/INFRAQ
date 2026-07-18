/**
 * A single error type the worker's task handlers throw for *expected* failure
 * modes (bad input, missing estimate, wrong version state). Carrying an HTTP
 * `status` on the error lets the Hono layer translate a domain failure into the
 * right 4xx/5xx without every route re-classifying `Error` instances by string.
 *
 * Anything that is NOT a `WorkerError` is treated as an unexpected 500 — we do
 * not want to leak "estimate not found" as a 500 nor mask a genuine bug as a
 * 400, so the distinction is explicit at the throw site.
 */
export class WorkerError extends Error {
  /** HTTP status the API layer should respond with. */
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "WorkerError";
    this.status = status;
  }
}
