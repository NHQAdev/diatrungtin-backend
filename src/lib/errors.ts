export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
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

export const unauthenticated = (message = 'Bạn cần đăng nhập để tiếp tục.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'Bạn không có quyền thực hiện thao tác này.') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Không tìm thấy dữ liệu.') => new AppError(404, 'NOT_FOUND', message);
