import 'server-only';
import { ERROR_CATALOGUE, type ErrorCode } from '@/server/errors/codes';

export type ErrorDetails = Record<string, unknown>;

/**
 * The only error type services throw (C-06). The HTTP status comes from the catalogue, never from
 * the call site. `details` reach the client on 4xx only; `options.cause` keeps the original error
 * for the logs.
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message?: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message ?? ERROR_CATALOGUE[code].message, options);
    this.code = code;
    this.status = ERROR_CATALOGUE[code].status;
    this.details = details;
  }
}

export const isAppError = (err: unknown): err is AppError => err instanceof AppError;
