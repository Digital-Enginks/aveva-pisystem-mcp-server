import { AppError, ErrorCategory } from '../../errors/error-model.js';

export class DomainError extends AppError {
  constructor({ category, message, details = null, cause = null }) {
    // Determine default retryable status based on category
    const retryable = [
      ErrorCategory.RATE_LIMITED,
      ErrorCategory.UPSTREAM_TRANSIENT
    ].includes(category);

    super({
      category,
      retryable,
      message,
      details,
      cause
    });
    this.name = 'DomainError';
  }
}
