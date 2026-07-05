export const ErrorCategory = {
  INVALID_INPUT: 'INVALID_INPUT',
  EDGE_UNAUTHENTICATED: 'EDGE_UNAUTHENTICATED',
  EDGE_FORBIDDEN: 'EDGE_FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  WRITES_DISABLED: 'WRITES_DISABLED',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  UPSTREAM_TRANSIENT: 'UPSTREAM_TRANSIENT',
  UPSTREAM_PERMANENT: 'UPSTREAM_PERMANENT',
  PARTIAL_BATCH: 'PARTIAL_BATCH',
  PARTIAL_WRITE: 'PARTIAL_WRITE',
  INTERNAL: 'INTERNAL'
};

export class AppError extends Error {
  constructor({ category, retryable, message, details = null, cause = null, correlationId = null }) {
    super(message);
    this.name = 'AppError';
    this.category = category;
    this.retryable = retryable;
    this.details = details;
    this.cause = cause;
    this.correlationId = correlationId;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  toJSON() {
    return {
      name: this.name,
      category: this.category,
      retryable: this.retryable,
      message: this.message,
      details: this.details,
      correlationId: this.correlationId
    };
  }
}
