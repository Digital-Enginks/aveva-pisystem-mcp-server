import { scrub } from '../security/redactor.js';
import { AppError } from './error-model.js';

// Safe messages maps categories to generic actionable hints
const SAFE_MESSAGES = {
  INVALID_INPUT: 'The request parameters were invalid.',
  EDGE_UNAUTHENTICATED: 'Authentication is required to access this resource.',
  EDGE_FORBIDDEN: 'You are not permitted to perform this operation.',
  NOT_FOUND: 'The requested PI System item was not found.',
  UNAUTHORIZED: 'Authentication with the upstream PI System failed.',
  FORBIDDEN: 'Access to the PI System resource was denied.',
  RATE_LIMITED: 'Rate limit reached. Retrying shortly.',
  PAYLOAD_TOO_LARGE: 'The request payload exceeds the allowed size limit.',
  LIMIT_EXCEEDED: 'The request item count exceeds the allowed limit.',
  WRITES_DISABLED: 'Writes are currently disabled on this server.',
  FEATURE_DISABLED: 'This server feature is disabled by its configuration.',
  UPSTREAM_TRANSIENT: 'The upstream PI System is temporarily unavailable.',
  UPSTREAM_PERMANENT: 'The upstream PI System returned an unrecoverable error.',
  PARTIAL_BATCH: 'Some sub-operations in the batch failed.',
  PARTIAL_WRITE: 'Some values could not be written to the PI System.',
  INTERNAL: 'An unexpected internal server error occurred.'
};

export function sanitizeError(err) {
  const isAppError = err instanceof AppError;
  const category = isAppError ? err.category : 'INTERNAL';
  const retryable = isAppError ? err.retryable : false;
  const correlationId = isAppError ? err.correlationId : null;

  let safeMessage = SAFE_MESSAGES[category] || SAFE_MESSAGES.INTERNAL;

  // Preserve any details, but scrub and redact them first
  let safeDetails = null;
  if (isAppError && err.details) {
    safeDetails = scrub(err.details);
    
    // Additional defense: if details contains raw error text, strip it down or redact FQDNs/paths
    if (typeof safeDetails === 'string') {
      safeDetails = cleanText(safeDetails);
    } else if (typeof safeDetails === 'object') {
      safeDetails = cleanObject(safeDetails);
    }
  }

  return {
    code: category,
    message: safeMessage,
    retryable,
    correlationId,
    details: safeDetails
  };
}

export function cleanText(text) {
  let cleaned = scrub(text);
  // Redact URLs
  cleaned = cleaned.replace(/https?:\/\/[^\s"'()]+/gi, '[URL_REDACTED]');
  // Redact UNC paths (\\HOST\share\...), the native PI/AF path format. The
  // leading server name is the sensitive token; we stop at whitespace so the
  // surrounding message text stays readable. Must run before the drive-letter
  // path rule, which would not match a UNC's leading backslashes.
  cleaned = cleaned.replace(/\\\\[^\s"'<>|]+/g, '[PATH_REDACTED]');
  // Redact potential Windows paths
  cleaned = cleaned.replace(/[a-zA-Z]:\\[a-zA-Z0-9._\-\\]+/g, '[PATH_REDACTED]');
  // Redact potential Unix paths
  cleaned = cleaned.replace(/\/[\w.\-]+(\/[\w.\-]+)+/g, '[PATH_REDACTED]');
  // Redact potential FQDNs / domains (at least 3 segments or custom local TLDs)
  cleaned = cleaned.replace(/\b[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+\b/g, '[HOST_REDACTED]');
  cleaned = cleaned.replace(/\b[a-zA-Z0-9-]+\.(?:local|internal|ot|plant|lan|com|net|org|edu|gov)\b/gi, '[HOST_REDACTED]');
  // Redact IP addresses
  cleaned = cleaned.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP_REDACTED]');
  return cleaned;
}

function cleanObject(obj, visited = new WeakSet()) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return cleanText(obj);
  if (typeof obj === 'object') {
    if (visited.has(obj)) return '[CIRCULAR_REFERENCE]';
    visited.add(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => cleanObject(item, visited));
  }
  if (typeof obj === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        cleaned[key] = cleanText(value);
      } else if (typeof value === 'object') {
        cleaned[key] = cleanObject(value, visited);
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }
  return obj;
}
