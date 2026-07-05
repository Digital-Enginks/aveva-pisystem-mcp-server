import test from 'node:test';
import assert from 'node:assert';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { PiWebApiClient } from '../src/gateway/pi-web-api-client.js';
import { Semaphore } from '../src/gateway/semaphore.js';
import { readErrorBody } from '../src/gateway/http-body.js';
import { AppError, ErrorCategory } from '../src/errors/error-model.js';

const testConfig = {
  PIWEBAPI_BASE_URL: 'https://pi-server-real.com/piwebapi', // Use non-local domain to verify production enforcers
  PIWEBAPI_AUTH_MODE: 'anonymous',
  PIWEBAPI_ALLOW_ANONYMOUS: true,
  PIWEBAPI_REQUEST_TIMEOUT_MS: 100,
  PIWEBAPI_WEBID_TYPE: 'IDOnly',
  PIWEBAPI_WEBID_CACHE_MAX: 10,
  PIWEBAPI_WEBID_CACHE_TTL_SEC: 60,
  PIWEBAPI_META_CACHE_MAX: 10,
  PIWEBAPI_META_CACHE_TTL_SEC: 60,
  PIWEBAPI_MAX_CONCURRENT: 4,
  MCP_SERVER_NAME: 'test-mcp',
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

test('Semaphore - basic capacity and dynamically adjust capacity', async () => {
  const sem = new Semaphore(2);
  assert.strictEqual(sem.capacity, 2);

  let active = 0;
  const run = async () => {
    await sem.acquire();
    active++;
    assert.ok(active <= sem.capacity);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    sem.release();
  };

  await Promise.all([run(), run(), run(), run()]);

  // Adjust capacity dynamically
  sem.setCapacity(4);
  assert.strictEqual(sem.capacity, 4);

  // Shrink capacity
  sem.setCapacity(1);
  assert.strictEqual(sem.capacity, 1);
});

test('Semaphore - aborting a queued acquire rejects and frees the slot for a live waiter', async () => {
  const sem = new Semaphore(1);

  // Occupy the only slot.
  await sem.acquire();

  // A waiter that is aborted while queued must reject and must not consume the
  // slot when it later frees up, otherwise abandoned requests clog the queue.
  const ac = new AbortController();
  const abortedAcquire = sem.acquire(ac.signal);

  // A second, live waiter queued behind it.
  let liveAcquired = false;
  const liveAcquire = sem.acquire().then(() => { liveAcquired = true; });

  ac.abort();
  await assert.rejects(abortedAcquire, (err) => err.name === 'AbortError');

  // Releasing the held slot must hand it to the live waiter, not the dead one.
  sem.release();
  await liveAcquire;
  assert.strictEqual(liveAcquired, true);
});

test('Semaphore - acquiring with an already-aborted signal rejects immediately', async () => {
  const sem = new Semaphore(2);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(sem.acquire(ac.signal), (err) => err.name === 'AbortError');
});

test('readErrorBody - caps an oversized upstream error body instead of buffering it all', async () => {
  // Simulate a hostile upstream streaming far more than the cap in 64KB chunks.
  const oversized = (async function* () {
    for (let i = 0; i < 100; i++) {
      yield Buffer.alloc(64 * 1024, 0x41); // 'A'
    }
  })();

  const text = await readErrorBody(oversized, 4096);
  assert.ok(text.length < 5000, `expected capped body, got ${text.length} chars`);
  assert.ok(text.endsWith('... (truncated)'));
});

test('readErrorBody - returns the full body when under the cap', async () => {
  const small = (async function* () {
    yield Buffer.from('upstream said no');
  })();
  const text = await readErrorBody(small, 4096);
  assert.strictEqual(text, 'upstream said no');
});

test('PiWebApiClient - Strict Projection Enforcer', async () => {
  const client = new PiWebApiClient(testConfig, dummyLogger, dummyAuthProvider, dummyTrustProvider);

  // GET request without selectedFields should throw AppError
  await assert.rejects(
    client.request('GET', '/piwebapi/streams/some-id/value'),
    (err) => {
      return err instanceof AppError &&
             err.category === ErrorCategory.INVALID_INPUT &&
             err.message.includes('selectedFields projection is required');
    }
  );

  // Batch GET sub-request without selectedFields should throw AppError
  await assert.rejects(
    client.request('POST', '/piwebapi/batch', {
      resolve: { Method: 'GET', Resource: 'http://foo/streams' }
    }),
    (err) => {
      return err instanceof AppError &&
             err.category === ErrorCategory.INVALID_INPUT &&
             err.message.includes('selectedFields projection is required');
    }
  );
});

test('PiWebApiClient - Retry Policies & Non-idempotent Writes', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  
  const mockPool = agent.get('https://pi-server-real.com');
  const config = { ...testConfig, dispatcher: agent };
  const client = new PiWebApiClient(config, dummyLogger, dummyAuthProvider, dummyTrustProvider);

  // Intercept 1: GET idempotent request transiently failing once, then succeeding
  mockPool.intercept({
    path: '/piwebapi/streams/test/value?selectedFields=Timestamp%3BValue&webIdType=IDOnly',
    method: 'GET'
  }).reply(503, 'Service Unavailable');

  mockPool.intercept({
    path: '/piwebapi/streams/test/value?selectedFields=Timestamp%3BValue&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, { Timestamp: 'now', Value: 10 });

  const res = await client.request('GET', '/piwebapi/streams/test/value?selectedFields=Timestamp%3BValue&webIdType=IDOnly');
  assert.strictEqual(res.Value, 10);

  // Intercept 2: POST non-idempotent write request failing. It must NOT retry.
  mockPool.intercept({
    path: '/piwebapi/streams/test/value',
    method: 'POST'
  }).reply(503, 'Service Unavailable');

  await assert.rejects(
    client.request('POST', '/piwebapi/streams/test/value', { Value: 5 }),
    (err) => {
      return err instanceof AppError && err.category === ErrorCategory.UPSTREAM_TRANSIENT;
    }
  );
});

test('PiWebApiClient - Adaptive Cooldown & Retry-After', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  
  const mockPool = agent.get('https://pi-server-real.com');
  const config = { ...testConfig, dispatcher: agent };
  const client = new PiWebApiClient(config, dummyLogger, dummyAuthProvider, dummyTrustProvider);

  // Mock 429 response carrying Retry-After header
  mockPool.intercept({
    path: '/piwebapi/streams/test/value?selectedFields=Timestamp%3BValue&webIdType=IDOnly',
    method: 'GET'
  }).reply(429, 'Rate limit exceeded', {
    headers: { 'Retry-After': '1' } // Wait 1 second
  });

  mockPool.intercept({
    path: '/piwebapi/streams/test/value?selectedFields=Timestamp%3BValue&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, { Timestamp: 'now', Value: 20 });

  assert.strictEqual(client.currentConcurrencyLimit, 4);

  const startTime = Date.now();
  const res = await client.request('GET', '/piwebapi/streams/test/value?selectedFields=Timestamp%3BValue&webIdType=IDOnly');
  const elapsed = Date.now() - startTime;

  assert.strictEqual(res.Value, 20);
  assert.ok(elapsed >= 1000); // Verify it waited for Retry-After duration of 1s
  assert.strictEqual(client.currentConcurrencyLimit, 3); // 4 -> decrease to 2 -> success recovery to 3
  assert.strictEqual(client.inCooldown, true);
});

test('PiWebApiClient - Batch Splitting pre-flight check', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  
  const mockPool = agent.get('https://pi-server-real.com');
  const config = { ...testConfig, dispatcher: agent };
  const client = new PiWebApiClient(config, dummyLogger, dummyAuthProvider, dummyTrustProvider);

  // Construct a batch request large enough to force _splitBatch to partition it.
  const hugeBatch = {};
  for (let i = 0; i < 100; i++) {
    hugeBatch[`key_${i}`] = {
      Method: 'POST',
      Resource: 'https://pi-server-real.com/piwebapi/streams/test/value',
      Content: 'A'.repeat(50000) // Large content
    };
  }

  const partitions = client._splitBatch(hugeBatch, 100000);
  assert.ok(partitions.length > 1);

  // Verify that the split keeps parent keys in all partitions if there is a dependency
  const dependentBatch = {
    parent: { Method: 'GET', Resource: 'https://pi-server-real.com/piwebapi/elements?path=foo' },
    child1: { Method: 'GET', Resource: 'https://pi-server-real.com/piwebapi/streams/{0}/value', ParentIds: ['parent'] },
    child2: { Method: 'GET', Resource: 'https://pi-server-real.com/piwebapi/streams/{0}/value', ParentIds: ['parent'] }
  };

  const splitDeps = client._splitBatch(dependentBatch, 50); // force split
  assert.strictEqual(splitDeps.length, 2);
  assert.ok(splitDeps[0].parent && splitDeps[1].parent); // Parent key must exist in all partitions
});

test('PiWebApiClient - WebID Self-Healing Cache Invalidation', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  
  const mockPool = agent.get('https://pi-server-real.com');
  const config = { ...testConfig, dispatcher: agent };
  const client = new PiWebApiClient(config, dummyLogger, dummyAuthProvider, dummyTrustProvider);

  // Populate cache with stale entry
  const path = '\\\\server\\tag-stale';
  const staleWebId = 'StaleWebID123';
  const realWebId = 'RealWebID456';
  
  client.webIdCache.set(
    `https://pi-server-real.com/piwebapi:${path}:IDOnly`,
    staleWebId
  );

  // Mock read for stale WebID failing with 404 (NOT_FOUND)
  mockPool.intercept({
    path: `/piwebapi/streams/${staleWebId}/value?selectedFields=Timestamp%3BValue%3BGood%3BQuestionable%3BSubstituted%3BAnnotated%3BUnitsAbbreviation&webIdType=IDOnly`,
    method: 'GET'
  }).reply(404, 'Not Found');

  // Mock the batch request that will resolve the path and perform read for new WebID
  mockPool.intercept({
    path: '/piwebapi/batch',
    method: 'POST'
  }).reply(200, {
    resolve: {
      Status: 200,
      Content: { WebId: realWebId, Name: 'tag-stale' }
    },
    read: {
      Status: 200,
      Content: { Timestamp: 'now', Value: 100 }
    }
  });

  const res = await client.resolveAndRead(path, 'value', {});
  assert.strictEqual(res.Value, 100);

  // Verify that the cache was self-healed and updated with the real WebID
  const cachedVal = client.webIdCache.get(`https://pi-server-real.com/piwebapi:${path}:IDOnly`);
  assert.strictEqual(cachedVal, realWebId);
});
