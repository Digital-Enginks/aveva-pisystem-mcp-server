import test from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { Paging } from '../src/domain/values/Paging.js';
import { TimeRange } from '../src/domain/values/TimeRange.js';
import { PiWebApiClient } from '../src/gateway/pi-web-api-client.js';
import { readRecordedTool } from '../src/controllers/tools/data/read_recorded.js';
import { readSummaryTool } from '../src/controllers/tools/data/read_summary.js';
import { readInterpolatedTool } from '../src/controllers/tools/data/read_interpolated.js';
import { searchEventFramesTool } from '../src/controllers/tools/discovery/search_event_frames.js';
import { TrustProvider } from '../src/gateway/trust.js';
import { LifecycleManager } from '../src/bootstrap/lifecycle.js';
import { writeValueTool } from '../src/controllers/tools/write/write_value.js';
import { writeValuesTool } from '../src/controllers/tools/write/write_values.js';
import { writeValuesMultiTool } from '../src/controllers/tools/write/write_values_multi.js';
import { loadConfig } from '../src/config/load.js';

const testConfig = {
  PIWEBAPI_BASE_URL: 'https://pi-server.mcp.local/piwebapi',
  PIWEBAPI_AUTH_MODE: 'anonymous',
  PIWEBAPI_ALLOW_ANONYMOUS: true,
  PIWEBAPI_REQUEST_TIMEOUT_MS: 5000,
  PIWEBAPI_WEBID_TYPE: 'IDOnly',
  PIWEBAPI_WEBID_CACHE_MAX: 10,
  PIWEBAPI_WEBID_CACHE_TTL_SEC: 60,
  PIWEBAPI_META_CACHE_MAX: 10,
  PIWEBAPI_META_CACHE_TTL_SEC: 60,
  MCP_MAX_RESPONSE_BYTES: 1048576,
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

function makeClient(baseUrl = 'https://pi-server.mcp.local') {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const mockPool = agent.get(baseUrl);
  const client = new PiWebApiClient(
    { ...testConfig, PIWEBAPI_BASE_URL: `${baseUrl}/piwebapi`, dispatcher: mockPool },
    dummyLogger,
    dummyAuthProvider,
    dummyTrustProvider
  );
  return { client, mockPool };
}

function decodeToken(token) {
  return JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
}

// R1-1: GetRecorded has no startIndex; pagination must advance startTime via a
// timestamp cursor, otherwise PI returns the same page forever.
test('read_recorded paginates by time cursor, never by startIndex', async (t) => {
  const { client, mockPool } = makeClient();
  const context = { gateway: client, config: testConfig, logger: dummyLogger, signal: null };

  const baseArgs = {
    stream: 'Pt1WebId',
    startTime: '2026-06-27T00:00:00.000Z',
    endTime: '2026-06-28T00:00:00.000Z',
    pageSize: 2
  };

  // Page 1: full page -> hasMore, token carries the last raw timestamp as cursor.
  mockPool.intercept({
    path: (p) => p.includes('/streams/Pt1WebId/recorded')
      && p.includes('startTime=2026-06-27T00%3A00%3A00.000Z')
      && p.includes('maxCount=2')
      && !p.includes('startIndex'),
    method: 'GET'
  }).reply(200, {
    Items: [
      { Timestamp: '2026-06-27T01:00:00Z', Value: 1.0, Good: true },
      { Timestamp: '2026-06-27T02:00:00Z', Value: 2.0, Good: true }
    ]
  });

  const page1 = JSON.parse((await readRecordedTool.handler(baseArgs, context)).content[0].text);
  assert.strictEqual(page1.items.length, 2);
  assert.strictEqual(page1.hasMore, true);
  const token1 = decodeToken(page1.nextPageToken);
  assert.strictEqual(token1.cursor, '2026-06-27T02:00:00Z');

  // Page 2: request must start at the cursor timestamp; the value at the cursor
  // (already returned on page 1) must be filtered out of the result.
  mockPool.intercept({
    path: (p) => p.includes('/streams/Pt1WebId/recorded')
      && p.includes('startTime=2026-06-27T02%3A00%3A00Z')
      && !p.includes('startIndex'),
    method: 'GET'
  }).reply(200, {
    Items: [
      { Timestamp: '2026-06-27T02:00:00Z', Value: 2.0, Good: true },
      { Timestamp: '2026-06-27T03:00:00Z', Value: 3.0, Good: true }
    ]
  });

  const page2 = JSON.parse((await readRecordedTool.handler(
    { ...baseArgs, pageToken: page1.nextPageToken }, context
  )).content[0].text);
  assert.strictEqual(page2.items.length, 1);
  assert.strictEqual(page2.items[0].value, 3.0);
  assert.strictEqual(decodeToken(page2.nextPageToken).cursor, '2026-06-27T03:00:00Z');
});

// R1-5: pageToken is forgeable (hash, not HMAC) -> pageSize must be clamped
// server-side so a forged token cannot request unbounded pages.
test('Paging clamps forged pageSize and rejects non-numeric sizes safely', () => {
  const forge = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64');

  const huge = Paging.parseToken(forge({ startIndex: 0, pageSize: 999999, queryHash: 'h' }), 'h');
  assert.strictEqual(huge.pageSize, 1000);

  const bogus = Paging.parseToken(forge({ startIndex: 0, pageSize: 'abc', queryHash: 'h' }), 'h');
  assert.strictEqual(bogus.pageSize, 100);

  const negative = Paging.parseToken(forge({ startIndex: -5, pageSize: -3, queryHash: 'h' }), 'h');
  assert.strictEqual(negative.startIndex, 0);
  assert.strictEqual(negative.pageSize, 1);
});

// R1-2: without Items.Errors in the default projections, per-stream failures in
// streamset responses are invisible and the PARTIAL envelope can never fire.
test('readMulti default projections include Items.Errors (and quality for summary)', async (t) => {
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { process.env.NODE_ENV = prevNodeEnv; });

  const { client, mockPool } = makeClient('https://pi-prod.example.test');
  const captured = [];
  mockPool.intercept({
    path: (p) => { captured.push(decodeURIComponent(p)); return true; },
    method: 'GET'
  }).reply(200, { Items: [] }).persist();

  await client.readCurrentValueMulti(['W1'], undefined, undefined, undefined, undefined, null, null);
  const range = new TimeRange('2026-06-27T00:00:00.000Z', '2026-06-28T00:00:00.000Z');
  await client.readRecordedMulti(['W1'], range, 'Inside', undefined, 100, null, null);
  await client.readSummaryMulti(['W1'], range, ['Average'], 'TimeWeighted', undefined, null, null);

  const [valueUrl, recordedUrl, summaryUrl] = captured;
  assert.ok(valueUrl.includes('Items.Errors'), `value projection missing Items.Errors: ${valueUrl}`);
  assert.ok(recordedUrl.includes('Items.Errors'), `recorded projection missing Items.Errors: ${recordedUrl}`);
  assert.ok(summaryUrl.includes('Items.Errors'), `summary projection missing Items.Errors: ${summaryUrl}`);
  assert.ok(summaryUrl.includes('Items.UnitsAbbreviation'), 'summary projection missing Items.UnitsAbbreviation');
  assert.ok(summaryUrl.includes('Items.Items.Value.Good'), 'summary projection missing quality flags');
});

// R1-3: enums must match the official PI Web API sets; invented values cause 400s.
test('tool schemas only accept official PI Web API enum values', () => {
  const summarySchema = z.object(readSummaryTool.inputSchema);
  assert.strictEqual(summarySchema.safeParse({ stream: 'W', summaryType: ['TotalPerHour'] }).success, false);
  assert.strictEqual(summarySchema.safeParse({ stream: 'W', summaryType: ['TotalWithUOM', 'All'] }).success, true);
  assert.strictEqual(summarySchema.safeParse(
    { stream: 'W', summaryType: ['Average'], calculationBasis: 'TimeWeightedAdHocStart' }
  ).success, false);
  assert.strictEqual(summarySchema.safeParse(
    { stream: 'W', summaryType: ['Average'], calculationBasis: 'EventWeightedIncludeBothEnds' }
  ).success, true);

  const interpSchema = z.object(readInterpolatedTool.inputSchema);
  assert.strictEqual(interpSchema.safeParse(
    { stream: 'W', interval: '1h', syncTimeBoundaryType: 'ExactMirror' }
  ).success, false);
  assert.strictEqual(interpSchema.safeParse(
    { stream: 'W', interval: '1h', syncTimeBoundaryType: 'Outside' }
  ).success, true);

  const efSchema = z.object(searchEventFramesTool.inputSchema);
  assert.strictEqual(efSchema.safeParse({ database: 'D', searchMode: 'EntireRange' }).success, false);
  assert.strictEqual(efSchema.safeParse({ database: 'D', searchMode: 'BackwardFromStartTime' }).success, true);
});

// R1-4: a stream/target that is not a path must be a well-formed WebID before
// it is interpolated into a URL path; otherwise ?/&// inject query params or
// path segments and bypass the selectedFields enforcer.
test('gateway rejects non-WebID stream identifiers before building URLs', async () => {
  const { client } = makeClient();
  const injected = 'W1?selectedFields=Links&x=';

  await assert.rejects(
    client.readDirect(injected, 'recorded'),
    (err) => err.category === 'INVALID_INPUT'
  );
  await assert.rejects(
    client.readMulti('W1/../attributes', 'value'),
    (err) => err.category === 'INVALID_INPUT'
  );
  await assert.rejects(
    client.writeValues(
      [{ webIdOrPath: injected, timestamp: '2026-06-27T00:00:00Z', value: 1 }],
      'Replace', 'DoNotBuffer', null, null
    ),
    (err) => err.category === 'INVALID_INPUT'
  );
});

// R1-9: with PIWEBAPI_TLS_VERIFY=false Node never calls checkServerIdentity,
// so a configured pin would be silently ignored -> refuse at startup.
test('TrustProvider rejects TLS pin combined with disabled TLS verification', () => {
  assert.throws(
    () => new TrustProvider(
      { PIWEBAPI_TLS_PIN_SHA256: 'ab'.repeat(32), PIWEBAPI_TLS_VERIFY: false },
      dummyLogger
    ),
    (err) => err.category === 'INTERNAL'
  );

  // Pin with verification enabled is the supported configuration.
  const ok = new TrustProvider({ PIWEBAPI_TLS_PIN_SHA256: 'ab'.repeat(32) }, dummyLogger);
  assert.strictEqual(typeof ok.getTlsOptions().checkServerIdentity, 'function');
});

// R1-6: unhandled rejections / uncaught exceptions must be handled explicitly
// (redacted log + clean shutdown) instead of crashing with a raw dump.
test('LifecycleManager registers process-level fatal error handlers', () => {
  const before = {
    rejection: process.listenerCount('unhandledRejection'),
    exception: process.listenerCount('uncaughtException')
  };

  const lifecycle = new LifecycleManager(dummyLogger);
  lifecycle.setupProcessErrorHandlers();

  try {
    assert.strictEqual(process.listenerCount('unhandledRejection'), before.rejection + 1);
    assert.strictEqual(process.listenerCount('uncaughtException'), before.exception + 1);
  } finally {
    process.removeListener('unhandledRejection', process.listeners('unhandledRejection').at(-1));
    process.removeListener('uncaughtException', process.listeners('uncaughtException').at(-1));
  }
});

// R1-10: idempotencyKey was advertised on write tools but never implemented;
// advertising a no-op durability knob is worse than not having it.
test('write tools no longer advertise the unimplemented idempotencyKey', () => {
  for (const tool of [writeValueTool, writeValuesTool, writeValuesMultiTool]) {
    assert.strictEqual('idempotencyKey' in tool.inputSchema, false, tool.name);
  }
});

// R1-12: GET /streamsets/{action}?webId=... (the ad-hoc form) ignores the AF
// filter params; sending them implies a filtering that never happens.
test('readCurrentValueMulti omits AF filter params in ad-hoc webIds mode', async () => {
  const { client, mockPool } = makeClient();
  const captured = [];
  mockPool.intercept({
    path: (p) => { captured.push(decodeURIComponent(p)); return true; },
    method: 'GET'
  }).reply(200, { Items: [] }).persist();

  await client.readCurrentValueMulti(['W1', 'W2'], '*', 'CatA', 'TmplB', true, null, null);
  await client.readCurrentValueMulti('ParentWebId', '*', 'CatA', 'TmplB', true, null, null);

  const [adHocUrl, parentUrl] = captured;
  assert.ok(!adHocUrl.includes('categoryName'), `ad-hoc URL must not carry categoryName: ${adHocUrl}`);
  assert.ok(!adHocUrl.includes('templateName'), 'ad-hoc URL must not carry templateName');
  assert.ok(!adHocUrl.includes('showHidden'), 'ad-hoc URL must not carry showHidden');
  assert.ok(parentUrl.includes('categoryName=CatA'), `parent form must keep AF filters: ${parentUrl}`);
});

// R1-13: without nameFilter the walker only sees the first server page
// (default cap 1000 children) -> false NOT_FOUND past the cap.
test('path walker filters children by name instead of listing unfiltered pages', async () => {
  const { client, mockPool } = makeClient();

  mockPool.intercept({ path: (p) => p.includes('/assetservers?name=afsrv'), method: 'GET' })
    .reply(200, { WebId: 'AsrvWebId', Name: 'afsrv' });
  mockPool.intercept({ path: (p) => p.includes('/assetservers/AsrvWebId/assetdatabases'), method: 'GET' })
    .reply(200, { Items: [{ WebId: 'DbWebId', Name: 'db' }] });
  // These interceptors only match when nameFilter is on the URL; without it
  // the walker's requests go unmatched and the resolve rejects.
  mockPool.intercept({
    path: (p) => p.includes('/assetdatabases/DbWebId/elements') && p.includes('nameFilter=el-1001'),
    method: 'GET'
  }).reply(200, { Items: [{ WebId: 'El1WebId', Name: 'el-1001' }] });
  mockPool.intercept({
    path: (p) => p.includes('/elements/El1WebId/attributes') && p.includes('nameFilter=temp'),
    method: 'GET'
  }).reply(200, { Items: [{ WebId: 'AttrWebId', Name: 'temp' }] });

  const webId = await client.pathResolver.resolveByWalking('\\\\afsrv\\db\\el-1001|temp', 'attribute', null);
  assert.strictEqual(webId, 'AttrWebId');
});

// R1-14: concurrent cache misses for the same key must join one in-flight
// upstream request instead of stampeding on cold start.
test('resolvePathToWebId and resolveMetadata single-flight concurrent misses', async () => {
  const { client, mockPool } = makeClient();

  // One-shot interceptors: a second upstream request would go unmatched and reject.
  mockPool.intercept({ path: (p) => p.includes('/points?path='), method: 'GET' })
    .reply(200, { WebId: 'PtWebId', Name: 'tag1' });
  const [a, b] = await Promise.all([
    client.resolvePathToWebId('\\\\srv\\tag1'),
    client.resolvePathToWebId('\\\\srv\\tag1')
  ]);
  assert.strictEqual(a, 'PtWebId');
  assert.strictEqual(b, 'PtWebId');

  mockPool.intercept({ path: (p) => p.includes('/points/MetaWebId'), method: 'GET' })
    .reply(200, { WebId: 'MetaWebId', Name: 'tag1', PointType: 'Float32' });
  const [m1, m2] = await Promise.all([
    client.resolveMetadata('MetaWebId', null, null),
    client.resolveMetadata('MetaWebId', null, null)
  ]);
  assert.strictEqual(m1.webId, 'MetaWebId');
  assert.strictEqual(m2.webId, 'MetaWebId');
});

// R1-16: bearer edge auth without a pinned audience accepts tokens minted for
// any other relying party at the same issuer -> MCP_EDGE_AUDIENCE is required.
test('config requires MCP_EDGE_AUDIENCE for bearer edge auth', () => {
  const env = {
    PIWEBAPI_BASE_URL: 'https://example.com/piwebapi',
    MCP_TRANSPORT: 'http',
    MCP_HTTP_BIND: '0.0.0.0',
    MCP_HTTP_PORT: '8080',
    PIWEBAPI_AUTH_MODE: 'anonymous',
    PIWEBAPI_ALLOW_ANONYMOUS: 'true',
    MCP_READ_ONLY: 'true',
    PIWEBAPI_REQUEST_TIMEOUT_MS: '5000',
    MCP_SERVER_NAME: 'test-server',
    MCP_SERVER_VERSION: '1.0.0',
    MCP_EDGE_AUTH_MODE: 'bearer'
  };
  assert.throws(() => loadConfig(env), /MCP_EDGE_AUDIENCE/);
  const ok = loadConfig({ ...env, MCP_EDGE_AUDIENCE: 'pi-mcp' });
  assert.strictEqual(ok.MCP_EDGE_AUDIENCE, 'pi-mcp');
});

// R1-3: PI rejects endTime with Backward*/Forward* search modes -> fail loud
// client-side instead of surfacing an upstream 400.
test('search_event_frames rejects endTime with directional search modes', async () => {
  await assert.rejects(
    searchEventFramesTool.handler(
      { database: 'DbWebId', searchMode: 'BackwardFromStartTime', startTime: '*-1d', endTime: '*' },
      { gateway: null, signal: null }
    ),
    (err) => err.category === 'INVALID_INPUT'
  );
});
