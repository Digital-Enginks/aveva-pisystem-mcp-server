import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { sanitizeError } from './sanitizer.js';

export function handleMcpError(err) {
  const sanitized = sanitizeError(err);

  // If it's an edge auth or input validation error, throw as McpError (protocol channel)
  if (
    sanitized.code === 'EDGE_UNAUTHENTICATED' ||
    sanitized.code === 'EDGE_FORBIDDEN' ||
    sanitized.code === 'INVALID_INPUT'
  ) {
    let jsonRpcCode = ErrorCode.InvalidRequest;
    if (sanitized.code === 'INVALID_INPUT') {
      jsonRpcCode = ErrorCode.InvalidParams;
    }
    
    throw new McpError(jsonRpcCode, sanitized.message);
  }

  // Otherwise, return as isError result (domain channel)
  return formatToolError(sanitized);
}

export function formatToolError(sanitized) {
  const content = [
    {
      type: 'text',
      text: sanitized.message
    }
  ];

  if (sanitized.correlationId) {
    content.push({
      type: 'text',
      text: `Correlation ID: ${sanitized.correlationId}`
    });
  }

  const result = {
    isError: true,
    content
  };

  if (sanitized.details) {
    // structuredContent must be a JSON object per the MCP spec; string or array
    // details are surfaced as an extra text block instead of being placed there,
    // which would produce a result the client rejects. Details are already
    // scrubbed by the sanitizer, so they are safe to echo as text.
    if (typeof sanitized.details === 'object' && !Array.isArray(sanitized.details)) {
      result.structuredContent = sanitized.details;
    } else {
      content.push({
        type: 'text',
        text: typeof sanitized.details === 'string'
          ? sanitized.details
          : JSON.stringify(sanitized.details)
      });
    }
  }

  return result;
}
