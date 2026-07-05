import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStdioTransport } from '../src/protocol/stdio-transport.js';
import { createHttpRequestListener } from '../src/bootstrap/composition-root.js';
import { AppError, ErrorCategory } from '../src/errors/error-model.js';

// --- test doubles ---------------------------------------------------------

const silentLogger = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return silentLogger; }
};

const idProvider = { generate: () => 'test-correlation-id' };

const okEdgeAuth = {
  authenticate: async () => ({ user: 'tester', roles: ['reader'] }),
  authorizeWrite: () => true
};

const LEAKY_UPSTREAM = 'connect ECONNREFUSED pi-archive.corp.internal:443';

function gatewayReturning(items) {
  return {
    config: { PIWEBAPI_BASE_URL: 'https://pi.example/piwebapi' },
    request: async () => ({ Items: items })
  };
}

function gatewayThrowing() {
  return {
    config: { PIWEBAPI_BASE_URL: 'https://pi.example/piwebapi' },
    request: async () => {
      throw new AppError({
        category: ErrorCategory.UPSTREAM_TRANSIENT,
        retryable: true,
        message: LEAKY_UPSTREAM
      });
    }
  };
}

function makeDeps(overrides = {}) {
  return {
    config: {
      MCP_SERVER_NAME: 'test-mcp',
      MCP_WRITE_TOOLS_ENABLED: false,
      MCP_MAX_RESPONSE_BYTES: 1048576,
      ...overrides.config
    },
    logger: silentLogger,
    idProvider,
    gateway: overrides.gateway ?? gatewayReturning([]),
    edgeAuth: overrides.edgeAuth ?? okEdgeAuth,
    edgeRateLimiter: overrides.edgeRateLimiter ?? null
  };
}

async function withServer(deps, fn) {
  const server = http.createServer(createHttpRequestListener(deps));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    // fetch keeps connections alive, which would stall server.close(); tear them down.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function mcpPost(base, body, opts = {}) {
  const {
    accept = 'application/json, text/event-stream',
    method = 'POST',
    path = '/mcp',
    raw
  } = opts;
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: accept },
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, headers: res.headers, text, json };
}

const callBody = (id, name, args = {}) => ({
  jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args }
});
const listBody = (id) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });

// --- MCP correctness (real SDK StreamableHTTPServerTransport) -------------

test('tools/list advertises read tools with read annotations and hides writes when disabled', async () => {
  await withServer(makeDeps(), async (base) => {
    const { status, json } = await mcpPost(base, listBody(1));
    assert.equal(status, 200);

    const tools = json.result.tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('pi.discovery.list_data_servers'), 'read tool should be listed');
    assert.ok(!names.some((n) => n.startsWith('pi.write.')), 'write tools must not be advertised when disabled');

    const readTool = tools.find((t) => t.name === 'pi.discovery.list_data_servers');
    assert.equal(readTool.annotations.readOnlyHint, true);
    assert.equal(readTool.annotations.idempotentHint, true);
  });
});

test('tools/list advertises write tools as destructive when enabled', async () => {
  await withServer(makeDeps({ config: { MCP_WRITE_TOOLS_ENABLED: true } }), async (base) => {
    const { json } = await mcpPost(base, listBody(1));
    const writeTool = json.result.tools.find((t) => t.name === 'pi.write.value');
    assert.ok(writeTool, 'write tool should be advertised when enabled');
    assert.equal(writeTool.annotations.readOnlyHint, false);
    assert.equal(writeTool.annotations.destructiveHint, true);
    assert.equal(writeTool.annotations.idempotentHint, false);
  });
});

test('tools/call returns the tool result on the success path', async () => {
  const gateway = gatewayReturning([
    { WebId: 'W1', Name: 'DA1', Path: '\\\\DA1', IsConnected: true, ServerVersion: '3.4' }
  ]);
  await withServer(makeDeps({ gateway }), async (base) => {
    const { status, json } = await mcpPost(base, callBody(2, 'pi.discovery.list_data_servers'));
    assert.equal(status, 200);
    assert.notEqual(json.result.isError, true);
    assert.match(json.result.content[0].text, /DA1/);
  });
});

test('tools/call upstream failure returns a sanitized isError result with no host leak', async () => {
  await withServer(makeDeps({ gateway: gatewayThrowing() }), async (base) => {
    const { status, json } = await mcpPost(base, callBody(3, 'pi.discovery.list_data_servers'));
    assert.equal(status, 200);
    assert.equal(json.result.isError, true);
    const text = json.result.content.map((c) => c.text).join('\n');
    assert.match(text, /temporarily unavailable/i);
    assert.ok(!text.includes('pi-archive.corp.internal'), 'must not leak upstream host');
    assert.ok(!text.includes('ECONNREFUSED'), 'must not leak raw upstream error');
  });
});

test('transport requires the streamable Accept header (real SDK negotiation)', async () => {
  await withServer(makeDeps(), async (base) => {
    const { status } = await mcpPost(base, listBody(1), { accept: 'application/json' });
    assert.equal(status, 406);
  });
});

// --- HTTP edge behaviour --------------------------------------------------

test('unknown path returns 404', async () => {
  await withServer(makeDeps(), async (base) => {
    const { status } = await mcpPost(base, listBody(1), { path: '/nope' });
    assert.equal(status, 404);
  });
});

test('non-POST method returns 405 with Allow header', async () => {
  await withServer(makeDeps(), async (base) => {
    const { status, headers } = await mcpPost(base, undefined, { method: 'GET' });
    assert.equal(status, 405);
    assert.equal(headers.get('allow'), 'POST');
  });
});

test('edge authentication failure returns 401 with sanitized body and no leak', async () => {
  const edgeAuth = {
    authenticate: async () => {
      throw new AppError({
        category: ErrorCategory.EDGE_UNAUTHENTICATED,
        retryable: false,
        message: `bad token for https://idp.corp.internal/.well-known/jwks`
      });
    },
    authorizeWrite: () => true
  };
  await withServer(makeDeps({ edgeAuth }), async (base) => {
    const { status, headers, json } = await mcpPost(base, listBody(1));
    assert.equal(status, 401);
    assert.equal(headers.get('www-authenticate'), 'Bearer');
    assert.equal(json.error.code, 'EDGE_UNAUTHENTICATED');
    assert.ok(!json.error.message.includes('idp.corp.internal'), 'must not leak issuer host');
  });
});

test('oversized request body is rejected with 413 before reaching the transport', async () => {
  await withServer(makeDeps(), async (base) => {
    const raw = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"' +
      'x'.repeat(5 * 1024 * 1024) + '"}}';
    const { status } = await mcpPost(base, undefined, { raw });
    assert.equal(status, 413);
  });
});

test('write tool call by an unauthorized caller is rejected as a protocol error', async () => {
  const edgeAuth = {
    authenticate: async () => ({ user: 'tester', roles: ['reader'] }),
    authorizeWrite: () => {
      throw new AppError({
        category: ErrorCategory.EDGE_FORBIDDEN,
        retryable: false,
        message: 'caller tester lacks role pi-writers'
      });
    }
  };
  const deps = makeDeps({ config: { MCP_WRITE_TOOLS_ENABLED: true }, edgeAuth });
  await withServer(deps, async (base) => {
    const { status, json } = await mcpPost(
      base,
      callBody(4, 'pi.write.value', { target: 'sinusoid', timestamp: '*', value: 1 })
    );
    assert.equal(status, 200);
    assert.ok(json.error, 'forbidden write must surface as a JSON-RPC error');
    assert.match(json.error.message, /not permitted/i);
    assert.ok(!json.error.message.includes('pi-writers'), 'must not leak role/authz detail');
  });
});

// R1-18: the edge write gate must also match write calls inside a JSON-RPC
// batch body, not only a single top-level message.
test('write tool call inside a JSON-RPC batch hits the edge write gate', async () => {
  let writeGateChecked = false;
  const edgeAuth = {
    authenticate: async () => ({ user: 'tester', roles: ['reader'] }),
    authorizeWrite: () => {
      writeGateChecked = true;
      throw new AppError({
        category: ErrorCategory.EDGE_FORBIDDEN,
        retryable: false,
        message: 'caller tester lacks role pi-writers'
      });
    }
  };
  const deps = makeDeps({ config: { MCP_WRITE_TOOLS_ENABLED: true }, edgeAuth });
  await withServer(deps, async (base) => {
    const batch = [
      listBody(1),
      callBody(2, 'pi.write.value', { target: 'sinusoid', timestamp: '*', value: 1 })
    ];
    const { status, json } = await mcpPost(base, batch);
    assert.equal(status, 200);
    assert.equal(writeGateChecked, true, 'batch write call must be checked at the edge');
    assert.ok(json.error, 'forbidden batch write must surface as a JSON-RPC error');
    assert.equal(json.id, null);
  });
});

// --- stdio stdout guard ----------------------------------------------------

test('stdio transport guards console.log from polluting stdout', () => {
  const originalLog = console.log;
  const originalError = console.error;
  let errorLogged = null;
  console.error = (msg, ...args) => { errorLogged = [msg, ...args].join(' '); };

  try {
    const transport = createStdioTransport();
    console.log('Testing console.log intercept');
    assert.ok(errorLogged.includes('[STDOUT POLLUTION GUARDED]'));
    assert.ok(errorLogged.includes('Testing console.log intercept'));
    transport.restoreConsole();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});
