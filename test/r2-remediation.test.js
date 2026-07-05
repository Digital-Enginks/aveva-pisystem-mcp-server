import test from 'node:test';
import assert from 'node:assert';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { PiWebApiClient } from '../src/gateway/pi-web-api-client.js';
import { loadConfig } from '../src/config/load.js';

const baseEnv = {
  MCP_TRANSPORT: 'stdio',
  PIWEBAPI_BASE_URL: 'https://example.com/piwebapi',
  PIWEBAPI_AUTH_MODE: 'anonymous',
  PIWEBAPI_ALLOW_ANONYMOUS: 'true',
  MCP_READ_ONLY: 'true',
  MCP_SERVER_NAME: 'test-server',
  MCP_SERVER_VERSION: '1.0.0'
};

const dummyLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => dummyLogger
};

const dummyAuthProvider = {
  decorate: async () => {},
  healthProbe: async () => {}
};

const dummyTrustProvider = {
  getTlsOptions: () => ({})
};

function makeClient(configOverrides = {}) {
  const baseUrl = 'https://pi-server.mcp.local';
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const mockPool = agent.get(baseUrl);
  const client = new PiWebApiClient(
    {
      PIWEBAPI_BASE_URL: `${baseUrl}/piwebapi`,
      PIWEBAPI_AUTH_MODE: 'anonymous',
      PIWEBAPI_REQUEST_TIMEOUT_MS: 5000,
      PIWEBAPI_WEBID_TYPE: 'IDOnly',
      PIWEBAPI_WEBID_CACHE_MAX: 10,
      PIWEBAPI_WEBID_CACHE_TTL_SEC: 60,
      PIWEBAPI_META_CACHE_MAX: 10,
      PIWEBAPI_META_CACHE_TTL_SEC: 60,
      MCP_MAX_RESPONSE_BYTES: 1048576,
      MCP_SERVER_NAME: 'test-mcp',
      MCP_SERVER_VERSION: '1.0.0',
      dispatcher: mockPool,
      ...configOverrides
    },
    dummyLogger,
    dummyAuthProvider,
    dummyTrustProvider
  );
  return { client, mockPool };
}

// R2: vars validated-but-never-read were removed from the schema. Operators who
// still set them must not break startup, and the parsed config must not carry
// dead keys that suggest tunables which do nothing.
test('removed dead config vars are stripped and no longer parsed', () => {
  const cfg = loadConfig({
    ...baseEnv,
    PIWEBAPI_BATCH_TIMEOUT_MS: '5000',
    PIWEBAPI_MAX_REQUEST_BYTES: '1024',
    PIWEBAPI_REALTIME_CACHE_CONTROL: 'true',
    MCP_STREAM_UPDATES_ENABLED: 'true',
    MCP_IDEMPOTENCY_WINDOW_MS: '30000'
  });
  for (const dead of [
    'PIWEBAPI_BATCH_TIMEOUT_MS',
    'PIWEBAPI_MAX_REQUEST_BYTES',
    'PIWEBAPI_REALTIME_CACHE_CONTROL',
    'MCP_STREAM_UPDATES_ENABLED',
    'MCP_IDEMPOTENCY_WINDOW_MS'
  ]) {
    assert.ok(!(dead in cfg), `${dead} should be removed from the schema`);
  }
});

// R2: retry vars are now wired into the gateway; the default base delay was
// aligned to the client's previous hardcoded 1000ms so default behavior is
// unchanged for existing deployments.
test('retry config defaults match the previously hardcoded behavior', () => {
  const cfg = loadConfig(baseEnv);
  assert.strictEqual(cfg.PIWEBAPI_RETRY_MAX_ATTEMPTS, 3);
  assert.strictEqual(cfg.PIWEBAPI_RETRY_BASE_MS, 1000);
  assert.strictEqual(cfg.PIWEBAPI_RETRY_MAX_MS, 10000);
});

test('PIWEBAPI_RETRY_MAX_ATTEMPTS=0 disables retries on transient errors', async () => {
  const { client, mockPool } = makeClient({ PIWEBAPI_RETRY_MAX_ATTEMPTS: 0 });
  let calls = 0;
  mockPool.intercept({
    path: (p) => { calls++; return p.includes('/streams/Pt1/value'); },
    method: 'GET'
  }).reply(503, { Errors: ['unavailable'] }).persist();

  await assert.rejects(
    client.request('GET', '/piwebapi/streams/Pt1/value?selectedFields=Timestamp%3BValue'),
    (err) => err.category === 'UPSTREAM_TRANSIENT'
  );
  assert.strictEqual(calls, 1, 'must not retry when max attempts is 0');
});

test('retries honor configured attempts and base delay', async () => {
  const { client, mockPool } = makeClient({
    PIWEBAPI_RETRY_MAX_ATTEMPTS: 2,
    PIWEBAPI_RETRY_BASE_MS: 1,
    PIWEBAPI_RETRY_MAX_MS: 10
  });
  const path = (p) => p.includes('/streams/Pt2/value');
  mockPool.intercept({ path, method: 'GET' }).reply(503, { Errors: ['unavailable'] });
  mockPool.intercept({ path, method: 'GET' }).reply(200, { Timestamp: '2026-07-01T00:00:00Z', Value: 42 });

  const started = Date.now();
  const result = await client.request('GET', '/piwebapi/streams/Pt2/value?selectedFields=Timestamp%3BValue');
  const elapsed = Date.now() - started;

  assert.strictEqual(result.Value, 42);
  // With the old hardcoded 1000ms base this retry would wait >=1.5s.
  assert.ok(elapsed < 1000, `retry backoff must honor PIWEBAPI_RETRY_BASE_MS (took ${elapsed}ms)`);
});
