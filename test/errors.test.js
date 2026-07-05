import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, ErrorCategory } from '../src/errors/error-model.js';
import { sanitizeError } from '../src/errors/sanitizer.js';
import { handleMcpError } from '../src/errors/to-mcp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { scrub } from '../src/security/redactor.js';

test('AppError - Instantiates with correct properties', () => {
  const err = new AppError({
    category: ErrorCategory.NOT_FOUND,
    retryable: false,
    message: 'Item not found',
    correlationId: 'id-123'
  });

  assert.equal(err.category, ErrorCategory.NOT_FOUND);
  assert.equal(err.retryable, false);
  assert.equal(err.message, 'Item not found');
  assert.equal(err.correlationId, 'id-123');
});

test('Error Sanitizer - Removes internal hostnames, paths, and stack traces', () => {
  const innerError = new Error('Database C:\\private\\path failed on internal-srv.domain.local');
  const err = new AppError({
    category: ErrorCategory.UPSTREAM_PERMANENT,
    retryable: false,
    message: 'Connection failed',
    cause: innerError,
    details: 'Details containing internal-srv.domain.local and C:\\private\\path'
  });

  const sanitized = sanitizeError(err);
  
  assert.equal(sanitized.code, ErrorCategory.UPSTREAM_PERMANENT);
  assert.equal(sanitized.message, 'The upstream PI System returned an unrecoverable error.');
  assert.ok(!sanitized.details.includes('C:\\private\\path'));
  assert.ok(!sanitized.details.includes('internal-srv.domain.local'));
  assert.ok(sanitized.details.includes('[PATH_REDACTED]'));
});

test('Error Sanitizer - redacts UNC paths so PI/AF server names never leak', () => {
  // Intent: PI/AF resources are addressed by UNC path (\\SERVER\db\element).
  // A drive-letter rule does not match a UNC's leading backslashes, so the
  // server name would otherwise survive sanitization and disclose topology.
  const err = new AppError({
    category: ErrorCategory.NOT_FOUND,
    retryable: false,
    message: 'Not found',
    details: { Errors: ["Element '\\\\AF-SRV-01\\PlantDB\\Reactor1' was not found."] }
  });

  const sanitized = sanitizeError(err);
  const reason = sanitized.details.Errors[0];
  assert.ok(!reason.includes('AF-SRV-01'), 'UNC server name must be redacted');
  assert.ok(reason.includes('[PATH_REDACTED]'));
});

test('Error Channel Routing - Maps caller errors to McpError throw', () => {
  const err = new AppError({
    category: ErrorCategory.EDGE_UNAUTHENTICATED,
    retryable: false,
    message: 'Invalid credentials'
  });

  assert.throws(() => {
    handleMcpError(err);
  }, (thrown) => {
    return thrown instanceof McpError && thrown.message.includes('Authentication is required');
  });
});

test('Error Channel Routing - Maps PI domain errors to isError result', () => {
  const err = new AppError({
    category: ErrorCategory.NOT_FOUND,
    retryable: false,
    message: 'Point not found',
    correlationId: 'corr-id-123'
  });

  const result = handleMcpError(err);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'The requested PI System item was not found.');
  assert.equal(result.content[1].text, 'Correlation ID: corr-id-123');
});

test('Error Sanitizer - handles object details and arrays', () => {
  const err = new AppError({
    category: ErrorCategory.UPSTREAM_PERMANENT,
    message: 'Fail',
    details: {
      host: 'my.internal.local',
      paths: ['C:\\some\\path', '/usr/bin/local'],
      empty: null,
      unmodified: 123
    }
  });

  const sanitized = sanitizeError(err);
  assert.equal(sanitized.details.host, '[HOST_REDACTED]');
  assert.equal(sanitized.details.paths[0], '[PATH_REDACTED]');
  assert.equal(sanitized.details.paths[1], '[PATH_REDACTED]');
  assert.equal(sanitized.details.empty, null);
  assert.equal(sanitized.details.unmodified, 123);
});

test('Redactor - handles circular references, error objects, and sensitive keys', () => {
  // Test Circular reference
  const obj = { name: 'test' };
  obj.self = obj;
  
  const scrubbedCircular = scrub(obj);
  assert.equal(scrubbedCircular.self, '[CIRCULAR_REFERENCE]');

  // Test Error object
  const err = new Error('Secret password=1234');
  err.stack = 'Stack containing HTTP/spn.local';
  const scrubbedErr = scrub(err);
  assert.ok(scrubbedErr instanceof Error);
  assert.equal(scrubbedErr.message, 'Secret password=[REDACTED]');
  assert.equal(scrubbedErr.stack, 'Stack containing [REDACTED]');

  // Test sensitive keys redacting
  const sensitiveObj = {
    password: 'my-secret-pass',
    apiToken: 'jwt-token-123',
    other: 'normal'
  };
  const scrubbedSensitive = scrub(sensitiveObj);
  assert.equal(scrubbedSensitive.password, '[REDACTED]');
  assert.equal(scrubbedSensitive.apiToken, '[REDACTED]');
  assert.equal(scrubbedSensitive.other, 'normal');
});

