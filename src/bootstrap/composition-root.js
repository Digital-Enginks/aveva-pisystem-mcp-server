import http from 'node:http';
import crypto from 'node:crypto';
import { loadConfig } from '../config/load.js';
import { createLogger } from '../logging/logger.js';
import { LifecycleManager } from './lifecycle.js';
import { EdgeAuthenticator } from '../protocol/edge-auth.js';
import { EdgeRateLimiter } from '../protocol/rate-limit.js';
import { buildServer } from './build-server.js';
import { createStdioTransport } from '../protocol/stdio-transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PiWebApiClient } from '../gateway/pi-web-api-client.js';
import { validateAuthPolicy } from '../security/auth-policy.js';
import { createAuthProvider } from '../security/auth-provider.js';
import { TrustProvider } from '../gateway/trust.js';
import { sanitizeError } from '../errors/sanitizer.js';
import { AppError, ErrorCategory } from '../errors/error-model.js';


// Largest inbound JSON-RPC request body accepted at the HTTP edge. This bounds
// memory before the MCP transport ever sees the payload; tune at the fronting
// proxy for stricter limits.
const MAX_INBOUND_BODY_BYTES = 4 * 1024 * 1024;

// Sanitized edge-error category -> HTTP status. Edge failures are transport-level
// concerns, so they map to HTTP status codes rather than becoming JSON-RPC tool
// errors. The response body always carries the generic SAFE message from the
// sanitizer, so no host, token, or upstream detail leaks here.
const EDGE_ERROR_STATUS = {
  EDGE_UNAUTHENTICATED: 401,
  EDGE_FORBIDDEN: 403,
  WRITES_DISABLED: 403,
  RATE_LIMITED: 429,
  INVALID_INPUT: 400,
  PAYLOAD_TOO_LARGE: 413
};

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function rejectEdge(res, err, logger) {
  const sanitized = sanitizeError(err);
  const status = EDGE_ERROR_STATUS[sanitized.code] || 500;

  if (status >= 500) {
    logger.error('Edge request rejected', { code: sanitized.code, error: err.message });
  } else {
    logger.warn('Edge request rejected', { code: sanitized.code });
  }

  const headers = status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {};
  sendJson(res, status, { error: { code: sanitized.code, message: sanitized.message } }, headers);
}

// Read and JSON-parse the request body with a hard byte cap, so the MCP transport
// receives an already-parsed body and an oversized payload is rejected before it
// is fully buffered. Throws an AppError-shaped object the edge mapper understands.
async function readJsonBody(req) {
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new AppError({
      category: ErrorCategory.INVALID_INPUT,
      retryable: false,
      message: 'Unsupported content type'
    });
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_INBOUND_BODY_BYTES) {
      throw new AppError({
        category: ErrorCategory.PAYLOAD_TOO_LARGE,
        retryable: false,
        message: 'Request body too large'
      });
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError({
      category: ErrorCategory.INVALID_INPUT,
      retryable: false,
      message: 'Malformed JSON body'
    });
  }
}

// Build the Node HTTP request listener for the stateless MCP endpoint. Exported
// so the edge behaviour (routing, auth, body limits) can be exercised in tests
// without standing up the full bootstrap.
export function createHttpRequestListener(deps) {
  return (req, res) => {
    handleHttpRequest(req, res, deps).catch((err) => {
      deps.logger.error('Unhandled error handling HTTP request', { error: err.message });
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Internal Server Error' } });
      }
    });
  };
}

async function handleHttpRequest(req, res, deps) {
  const { config, logger, idProvider, gateway, edgeAuth, edgeRateLimiter } = deps;

  if (req.url !== '/mcp') {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not Found' } });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } }, { Allow: 'POST' });
    return;
  }

  // Edge controls run before the MCP transport touches the request: rate limit,
  // then authenticate, then read the (bounded) body. Any failure maps to a
  // transport-level HTTP status instead of a JSON-RPC error.
  let authInfo;
  let parsedBody;
  try {
    if (edgeRateLimiter) {
      // Keyed on the immediate peer address. Behind a reverse proxy every caller
      // collapses to the proxy address; enforce per-tenant limits at the proxy.
      // (Trusting X-Forwarded-* here would let any caller spoof their own bucket.)
      edgeRateLimiter.checkLimit(req.socket?.remoteAddress || 'unknown');
    }
    authInfo = await edgeAuth.authenticate(req);
    parsedBody = await readJsonBody(req);

    // Edge check: authorization for write tools. The body may be a single
    // JSON-RPC message or a batch (array); a write call anywhere in a batch
    // must pass the same gate.
    const messages = Array.isArray(parsedBody) ? parsedBody : (parsedBody ? [parsedBody] : []);
    const hasWriteCall = messages.some((msg) =>
      msg && msg.method === 'tools/call' &&
      typeof msg.params?.name === 'string' && msg.params.name.startsWith('pi.write.')
    );
    if (hasWriteCall && config.MCP_WRITE_TOOLS_ENABLED) {
      edgeAuth.authorizeWrite(authInfo);
    }
  } catch (err) {
    if (err instanceof AppError && (err.category === ErrorCategory.EDGE_FORBIDDEN || err.category === ErrorCategory.WRITES_DISABLED)) {
      // Return JSON-RPC error response with status 200 for authenticated/authorized write failures
      const sanitized = sanitizeError(err);
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: parsedBody && !Array.isArray(parsedBody) ? parsedBody.id ?? null : null,
        error: {
          code: -32600, // InvalidRequest
          message: sanitized.message
        }
      });
      return;
    }
    rejectEdge(res, err, logger);
    return;
  }

  // Stateless pattern: a fresh McpServer and transport per request so concurrent
  // callers can never collide on JSON-RPC request ids or share session state.
  const authContext = { authorizeWrite: () => edgeAuth.authorizeWrite(authInfo) };
  const server = buildServer(config, logger, idProvider, gateway, authContext);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

export async function bootstrap(env = process.env) {
  // 1. Configuration
  const config = loadConfig(env);

  // 2. Logger
  const logger = createLogger(config);
  logger.info('Initializing AVEVA PI System MCP Server');

  // 3. Lifecycle manager
  const lifecycle = new LifecycleManager(logger);
  lifecycle.setupSignalHandlers();
  lifecycle.setupProcessErrorHandlers();

  // 4. Injected spine
  const idProvider = { generate: () => crypto.randomUUID() };

  // 5. Security & policy
  validateAuthPolicy(config);
  const trustProvider = new TrustProvider(config, logger);
  const authProvider = createAuthProvider(config, logger, trustProvider);

  // 6. Gateway adapter
  const gateway = new PiWebApiClient(config, logger, authProvider, trustProvider);
  lifecycle.registerShutdown('pi-web-api-client-close', async () => {
    await gateway.close();
  });

  // 7. Transport binding
  if (config.MCP_TRANSPORT === 'stdio') {
    logger.info('Binding STDIO transport');
    const server = buildServer(config, logger, idProvider, gateway, null);
    const transport = createStdioTransport();
    await server.connect(transport);

    lifecycle.registerShutdown('stdio-transport', async () => {
      transport.restoreConsole?.();
      await server.close();
    });
  } else {
    logger.info('Binding HTTP transport', { bind: config.MCP_HTTP_BIND, port: config.MCP_HTTP_PORT });

    const edgeAuth = new EdgeAuthenticator(config, logger);

    let edgeRateLimiter = null;
    if (config.MCP_EDGE_RATE_LIMIT) {
      edgeRateLimiter = new EdgeRateLimiter(config.MCP_EDGE_RATE_LIMIT);
      const interval = setInterval(() => edgeRateLimiter.cleanup(), 60000);
      interval.unref?.();
      lifecycle.registerShutdown('edge-rate-limiter-cleanup', () => clearInterval(interval));
    }

    const deps = { config, logger, idProvider, gateway, edgeAuth, edgeRateLimiter };
    const httpServer = http.createServer(createHttpRequestListener(deps));

    httpServer.listen(config.MCP_HTTP_PORT, config.MCP_HTTP_BIND, () => {
      logger.info('HTTP transport listening');
    });

    lifecycle.registerShutdown('http-server', () => new Promise((resolve) => {
      httpServer.close(() => {
        logger.info('HTTP server closed');
        resolve();
      });
    }));
  }

  // 8. Startup health probes
  await lifecycle.runProbes([
    {
      name: 'Authentication Provider Probe',
      fn: async () => {
        logger.info('Running authentication setup verification');
        await authProvider.healthProbe();
      }
    }
  ]);

  logger.info('AVEVA PI System MCP Server initialized successfully');
  return { lifecycle };
}
