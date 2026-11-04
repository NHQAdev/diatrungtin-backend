export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'OUT_OF_STOCK'
  | 'PRICE_CHANGED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_STATUS_TRANSITION'
  | 'STORE_NOT_CONFIGURED'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/** An expected, client-facing error. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);

export const unauthenticated = (message = 'Bạn cần đăng nhập để tiếp tục.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'Bạn không có quyền thực hiện thao tác này.') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Không tìm thấy dữ liệu.') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);

/** Postgres error codes we turn into friendly messages. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === '23505' && (constraint === undefined || pgError.constraint === constraint);
}

export function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23503';
}
