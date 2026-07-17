import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

/** Domain error carrying its HTTP status; the API layer maps it 1:1 to a response. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Maps AppError/ZodError to a consistent `{ error: { code, message, details? } }` envelope. */
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    if (typeof error.details?.retryAfterSeconds === "number") {
      res.set("Retry-After", String(error.details.retryAfterSeconds));
    }
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details && { details: error.details }),
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "invalid request",
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
    });
    return;
  }

  console.error(error);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "unexpected server error" } });
};
