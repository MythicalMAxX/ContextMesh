export type ErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'CONFLICT' | 'UNAUTHENTICATED';

export class NetworkError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message: string, details?: unknown) => new NetworkError('NOT_FOUND', message, details);
export const forbidden = (message: string, details?: unknown) => new NetworkError('FORBIDDEN', message, details);
export const invalid = (message: string, details?: unknown) => new NetworkError('INVALID', message, details);
export const conflict = (message: string, details?: unknown) => new NetworkError('CONFLICT', message, details);
