import test from 'node:test';
import assert from 'node:assert';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { loadFixture } from './helper.js';
import { WebIdCache } from '../src/gateway/webid-cache.js';
import { MetadataCache } from '../src/gateway/metadata-cache.js';
import { PathResolver } from '../src/gateway/path-resolver.js';
import { WriteValidator } from '../src/gateway/write-validator.js';
import { enforceSizeGuard } from '../src/gateway/response-size-guard.js';
import { normalizeTvq } from '../src/gateway/value-normalizer.js';
import { PiWebApiClient } from '../src/gateway/pi-web-api-client.js';
import { listDataServersTool } from '../src/controllers/tools/discovery/list_data_servers.js';
import { listAssetServersTool } from '../src/controllers/tools/discovery/list_asset_servers.js';
import { listAssetDatabasesTool } from '../src/controllers/tools/discovery/list_asset_databases.js';
import { searchPointsTool } from '../src/controllers/tools/discovery/search_points.js';
import { searchElementsTool } from '../src/controllers/tools/discovery/search_elements.js';
import { listChildElementsTool } from '../src/controllers/tools/discovery/list_child_elements.js';
import { searchAttributesTool } from '../src/controllers/tools/discovery/search_attributes.js';
import { searchEventFramesTool } from '../src/controllers/tools/discovery/search_event_frames.js';
import { listTemplatesTool } from '../src/controllers/tools/discovery/list_templates.js';
import { listCategoriesTool } from '../src/controllers/tools/discovery/list_categories.js';
import { resolvePointTool } from '../src/controllers/tools/discovery/resolve_point.js';

import { getValueTool } from '../src/controllers/tools/data/get_value.js';
import { getValueMultiTool } from '../src/controllers/tools/data/get_value_multi.js';
import { getEndTool } from '../src/controllers/tools/data/get_end.js';
import { readRecordedTool } from '../src/controllers/tools/data/read_recorded.js';
import { readRecordedMultiTool } from '../src/controllers/tools/data/read_recorded_multi.js';
import { readInterpolatedTool } from '../src/controllers/tools/data/read_interpolated.js';
import { readInterpolatedMultiTool } from '../src/controllers/tools/data/read_interpolated_multi.js';
import { readInterpolatedAtTimesTool } from '../src/controllers/tools/data/read_interpolated_attimes.js';
import { readPlotTool } from '../src/controllers/tools/data/read_plot.js';
import { readSummaryTool } from '../src/controllers/tools/data/read_summary.js';
import { readSummaryMultiTool } from '../src/controllers/tools/data/read_summary_multi.js';

import { writeValueTool } from '../src/controllers/tools/write/write_value.js';
import { writeValuesTool } from '../src/controllers/tools/write/write_values.js';
import { writeValuesMultiTool } from '../src/controllers/tools/write/write_values_multi.js';

import { serverStatusTool } from '../src/controllers/tools/meta/server_status.js';
import { AppError } from '../src/errors/error-model.js';

// Setup Mock Client Config
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
  MCP_WRITE_TOOLS_ENABLED: true,
  MCP_ADMIN_IDENTITY_CONFIGURED: true,
  MCP_MAX_RESPONSE_BYTES: 1048576, // 1MB
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

test('WebIdCache - get, set, LRU, and TTL behavior', async (t) => {
  const cache = new WebIdCache(3, 1); // Max 3 items, 1s TTL
  const key1 = WebIdCache.buildKey(testConfig.PIWEBAPI_BASE_URL, '\\\\server\\tag1', 'IDOnly');
  const key2 = WebIdCache.buildKey(testConfig.PIWEBAPI_BASE_URL, '\\\\server\\tag2', 'IDOnly');
  const key3 = WebIdCache.buildKey(testConfig.PIWEBAPI_BASE_URL, '\\\\server\\tag3', 'IDOnly');
  const key4 = WebIdCache.buildKey(testConfig.PIWEBAPI_BASE_URL, '\\\\server\\tag4', 'IDOnly');

  cache.set(key1, 'webid1');
  cache.set(key2, 'webid2');
  cache.set(key3, 'webid3');

  assert.strictEqual(cache.get(key1), 'webid1');

  // Trigger LRU eviction by inserting 4th item. key2 should be evicted (key1 was accessed, key3 is newer)
  cache.set(key4, 'webid4');
  assert.strictEqual(cache.get(key2), null);
  assert.strictEqual(cache.get(key1), 'webid1');

  // Test TTL expiry
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.strictEqual(cache.get(key1), null);
});

test('MetadataCache - get, set, LRU, and TTL behavior', async (t) => {
  const cache = new MetadataCache(2, 1);
  cache.set('webid1', { type: 'point', pointType: 'Float32' });
  cache.set('webid2', { type: 'point', pointType: 'String' });

  assert.deepStrictEqual(cache.get('webid1'), { type: 'point', pointType: 'Float32' });

  // LRU eviction
  cache.set('webid3', { type: 'point', pointType: 'Int32' });
  assert.strictEqual(cache.get('webid2'), null);

  // TTL expiry
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.strictEqual(cache.get('webid1'), null);
});

test('enforceSizeGuard - dynamic truncation with binary search', () => {
  const payload = {
    items: [
      { id: 1, name: 'short-item' },
      { id: 2, name: 'very-long-item-name-to-cause-exceeding-limit' },
      { id: 3, name: 'another-item' },
      { id: 4, name: 'more-lengthy-data-to-blow-budget' }
    ]
  };

  const result = enforceSizeGuard(payload, 150);
  assert.strictEqual(result.truncated, true);
  assert.ok(result.items.length < 4);
});

test('PathResolver - resolves path direct and walks hierarchy on fallback', async (t) => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const mockPool = agent.get('https://pi-server.mcp.local');
  const client = new PiWebApiClient(
    { ...testConfig, dispatcher: mockPool },
    dummyLogger,
    dummyAuthProvider,
    dummyTrustProvider
  );

  const resolver = new PathResolver(client, testConfig, dummyLogger);

  // Mock direct lookup success
  mockPool.intercept({
    path: '/piwebapi/points?path=%5C%5Cserver%5Ctag1',
    method: 'GET'
  }).reply(200, { WebId: 'W1Point1WebId', Name: 'tag1' });

  const resolved = await resolver.resolve('\\\\server\\tag1', 'point');
  assert.strictEqual(resolved, 'W1Point1WebId');

  // Mock direct lookup 404, fallback to walking
  mockPool.intercept({
    path: '/piwebapi/points?path=%5C%5Cserver%5Ctag-walk',
    method: 'GET'
  }).reply(404, {});

  mockPool.intercept({
    path: '/piwebapi/dataservers?name=server',
    method: 'GET'
  }).reply(200, { WebId: 'ServerWebId', Name: 'server' });

  mockPool.intercept({
    path: '/piwebapi/dataservers/ServerWebId/points?nameFilter=tag-walk',
    method: 'GET'
  }).reply(200, {
    Items: [{ WebId: 'W1PointWalkedWebId', Name: 'tag-walk' }]
  });

  const resolvedWalked = await resolver.resolve('\\\\server\\tag-walk', 'point');
  assert.strictEqual(resolvedWalked, 'W1PointWalkedWebId');
});

test('WriteValidator - validates types, digital states, timestamps and future times', async (t) => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const mockPool = agent.get('https://pi-server.mcp.local');
  const client = new PiWebApiClient(
    { ...testConfig, dispatcher: mockPool },
    dummyLogger,
    dummyAuthProvider,
    dummyTrustProvider
  );

  // Mock metadata lookup
  client.metadataCache.set('numeric-webid', {
    webId: 'numeric-webid',
    name: 'FloatTag',
    pointType: 'Float32',
    future: false,
    resourceType: 'point'
  });

  client.metadataCache.set('future-webid', {
    webId: 'future-webid',
    name: 'FutureTag',
    pointType: 'Float32',
    future: true,
    resourceType: 'point'
  });

  client.metadataCache.set('digital-webid', {
    webId: 'digital-webid',
    name: 'DigitalTag',
    pointType: 'Digital',
    digitalSetName: 'Modes',
    future: false,
    path: '\\\\server\\DigitalTag',
    resourceType: 'point'
  });

  const validator = new WriteValidator(client, dummyLogger);

  // 1. Numeric check: fails on string
  await assert.rejects(
    validator.validate({
      webIdOrPath: 'numeric-webid',
      value: 'not-a-number',
      timestamp: new Date().toISOString()
    }),
    /Type mismatch/
  );

  // 2. Numeric check: succeeds on valid number
  const validWebId = await validator.validate({
    webIdOrPath: 'numeric-webid',
    value: 42.5,
    timestamp: new Date().toISOString()
  });
  assert.strictEqual(validWebId, 'numeric-webid');

  // 3. Future-timestamp check on non-future point: fails
  await assert.rejects(
    validator.validate({
      webIdOrPath: 'numeric-webid',
      value: 12,
      timestamp: new Date(Date.now() + 60000).toISOString() // Future
    }),
    /Future timestamp not allowed/
  );

  // 4. Future-timestamp check on future point: succeeds
  const futureWebId = await validator.validate({
    webIdOrPath: 'future-webid',
    value: 12,
    timestamp: new Date(Date.now() + 60000).toISOString()
  });
  assert.strictEqual(futureWebId, 'future-webid');

  // 5. Digital set validation: succeeds on valid state
  mockPool.intercept({
    path: '/piwebapi/dataservers?name=server',
    method: 'GET'
  }).reply(200, { WebId: 'ServerWebId' });

  mockPool.intercept({
    path: '/piwebapi/dataservers/ServerWebId/digitalstatesets',
    method: 'GET'
  }).reply(200, {
    Items: [{ Name: 'Modes', WebId: 'ModesSetWebId' }]
  });

  mockPool.intercept({
    path: '/piwebapi/digitalstatesets/ModesSetWebId/digitalstates',
    method: 'GET'
  }).reply(200, {
    Items: [
      { Name: 'On', Value: 1 },
      { Name: 'Off', Value: 0 }
    ]
  });

  const digitalWebId = await validator.validate({
    webIdOrPath: 'digital-webid',
    value: 'On',
    timestamp: new Date().toISOString()
  });
  assert.strictEqual(digitalWebId, 'digital-webid');

  // 6. Digital set validation: fails on invalid state
  mockPool.intercept({
    path: '/piwebapi/dataservers?name=server',
    method: 'GET'
  }).reply(200, { WebId: 'ServerWebId' });

  mockPool.intercept({
    path: '/piwebapi/dataservers/ServerWebId/digitalstatesets',
    method: 'GET'
  }).reply(200, {
    Items: [{ Name: 'Modes', WebId: 'ModesSetWebId' }]
  });

  mockPool.intercept({
    path: '/piwebapi/digitalstatesets/ModesSetWebId/digitalstates',
    method: 'GET'
  }).reply(200, {
    Items: [
      { Name: 'On', Value: 1 },
      { Name: 'Off', Value: 0 }
    ]
  });

  await assert.rejects(
    validator.validate({
      webIdOrPath: 'digital-webid',
      value: 'InvalidState',
      timestamp: new Date().toISOString()
    }),
    /Type mismatch: value "InvalidState" is not a valid state/
  );
});

test('PiWebApiClient - path-addressed read batch lookup on cache miss', async (t) => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const mockPool = agent.get('https://pi-server.mcp.local');
  const client = new PiWebApiClient(
    { ...testConfig, dispatcher: mockPool },
    dummyLogger,
    dummyAuthProvider,
    dummyTrustProvider
  );

  // Clear cache first
  client.webIdCache.clear();

  // Mock batch response: resolve + read
  mockPool.intercept({
    path: '/piwebapi/batch',
    method: 'POST'
  }).reply(200, loadFixture('batch/batch-path-resolve-read.json'));

  const res = await client.readCurrentValue('\\\\server\\tag1', null, null);
  assert.strictEqual(res.Value, 12.3);

  // Verify it is now cached
  const key = WebIdCache.buildKey(testConfig.PIWEBAPI_BASE_URL, '\\\\server\\tag1', 'IDOnly');
  assert.strictEqual(client.webIdCache.get(key), 'BatchResolvedWebId');
});

test('Tool Controllers - execution and integration', async (t) => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const mockPool = agent.get('https://pi-server.mcp.local');
  const client = new PiWebApiClient(
    { ...testConfig, dispatcher: mockPool },
    dummyLogger,
    dummyAuthProvider,
    dummyTrustProvider
  );

  const context = {
    gateway: client,
    config: testConfig,
    logger: dummyLogger,
    signal: null
  };

  // 1. listDataServersTool
  mockPool.intercept({
    path: '/piwebapi/dataservers?selectedFields=Items.WebId%3BItems.Name%3BItems.Path%3BItems.IsConnected%3BItems.ServerVersion&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, {
    Items: [{ WebId: 'Server1WebId', Name: 'server1', Path: '\\\\server1', IsConnected: true, ServerVersion: '1.0' }]
  });

  const resDataServers = await listDataServersTool.handler({}, context);
  const dataServers = JSON.parse(resDataServers.content[0].text);
  assert.strictEqual(dataServers[0].webId, 'Server1WebId');

  // 2. searchPointsTool
  mockPool.intercept({
    path: '/piwebapi/dataservers/Server1WebId/points?nameFilter=sinusoid&startIndex=0&maxCount=100&selectedFields=Items.WebId%3BItems.Name%3BItems.PointType%3BItems.PointClass%3BItems.DigitalSetName%3BItems.EngineeringUnits%3BItems.Descriptor&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, {
    Items: [{ WebId: 'Point1WebId', Name: 'sinusoid', PointType: 'Float32' }]
  });

  const resPoints = await searchPointsTool.handler({ server: 'Server1WebId', nameFilter: 'sinusoid' }, context);
  const pointsObj = JSON.parse(resPoints.content[0].text);
  assert.strictEqual(pointsObj.items[0].webId, 'Point1WebId');

  // 3. getValueTool
  mockPool.intercept({
    path: '/piwebapi/streams/Point1WebId/value?time=%2A&selectedFields=Timestamp%3BValue%3BUnitsAbbreviation%3BGood%3BQuestionable%3BSubstituted%3BAnnotated&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, {
    Timestamp: '2026-06-28T00:00:00Z',
    Value: 12.3,
    Good: true,
    Questionable: false,
    Substituted: false,
    Annotated: false
  });

  const resVal = await getValueTool.handler({ stream: 'Point1WebId' }, context);
  const valObj = JSON.parse(resVal.content[0].text);
  assert.strictEqual(valObj.value, 12.3);

  // 4. writeValueTool
  client.metadataCache.set('Point1WebId', {
    webId: 'Point1WebId',
    name: 'sinusoid',
    pointType: 'Float32',
    future: false,
    resourceType: 'point'
  });

  mockPool.intercept({
    path: '/piwebapi/streams/Point1WebId/value?updateOption=Replace&bufferOption=DoNotBuffer',
    method: 'POST',
    body: JSON.stringify({
      Timestamp: '2026-06-28T00:00:00Z',
      Value: 45.6,
      UnitsAbbreviation: undefined
    })
  }).reply(202, {});

  const resWrite = await writeValueTool.handler({
    target: 'Point1WebId',
    timestamp: '2026-06-28T00:00:00Z',
    value: 45.6
  }, context);
  assert.deepStrictEqual(JSON.parse(resWrite.content[0].text), { status: 'ok', accepted: 1 });

  // 5. serverStatusTool
  mockPool.intercept({
    path: '/piwebapi/system/status',
    method: 'GET'
  }).reply(200, {
    UpTime: 12345,
    State: 'Running'
  });

  mockPool.intercept({
    path: '/piwebapi/system/configuration',
    method: 'GET'
  }).reply(200, {
    Version: '1.2.3'
  });

  const resStatus = await serverStatusTool.handler({}, context);
  const statusObj = JSON.parse(resStatus.content[0].text);
  assert.strictEqual(statusObj.serverVersion, '1.2.3');
  assert.strictEqual(statusObj.state, 'Running');
});

test('Phase 3 Tool Controllers - Coverage and validation for remaining tools', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const mockPool = agent.get('https://pi-server.mcp.local');
  const client = new PiWebApiClient(
    { ...testConfig, dispatcher: mockPool },
    dummyLogger,
    dummyAuthProvider,
    dummyTrustProvider
  );

  const context = {
    gateway: client,
    config: testConfig,
    logger: dummyLogger,
    signal: null
  };

  // 1. listAssetServersTool
  mockPool.intercept({
    path: '/piwebapi/assetservers?selectedFields=Items.WebId%3BItems.Name%3BItems.Path%3BItems.IsConnected%3BItems.ServerVersion&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, {
    Items: [{ WebId: 'AssetServerWebId', Name: 'af-server', Path: '\\\\af-server', IsConnected: true, ServerVersion: '1.0' }]
  });
  const resAssetServers = await listAssetServersTool.handler({}, context);
  assert.strictEqual(JSON.parse(resAssetServers.content[0].text)[0].name, 'af-server');

  // 2. listAssetDatabasesTool
  mockPool.intercept({
    path: '/piwebapi/assetservers/AssetServerWebId/assetdatabases?selectedFields=Items.WebId%3BItems.Name%3BItems.Path%3BItems.Description&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, {
    Items: [{ WebId: 'DbWebId', Name: 'database1', Path: '\\\\af-server\\database1', Description: 'Test DB' }]
  });
  const resDatabases = await listAssetDatabasesTool.handler({ webId: 'AssetServerWebId' }, context);
  assert.strictEqual(JSON.parse(resDatabases.content[0].text)[0].name, 'database1');

  // 3. searchElementsTool
  mockPool.intercept({
    path: '/piwebapi/assetdatabases/DbWebId/elements?searchFullHierarchy=false&startIndex=0&maxCount=100&selectedFields=Items.WebId%3BItems.Name%3BItems.Path%3BItems.TemplateName%3BItems.CategoryNames%3BItems.HasChildren&webIdType=IDOnly&nameFilter=Pump%2A',
    method: 'GET'
  }).reply(200, {
    Items: [{ WebId: 'Element1WebId', Name: 'Pump01', Path: '\\\\af-server\\database1\\Pump01', TemplateName: 'PumpTemplate', CategoryNames: ['Pumps'], HasChildren: false }]
  });
  const resElements = await searchElementsTool.handler({ database: 'DbWebId', nameFilter: 'Pump*' }, context);
  assert.strictEqual(JSON.parse(resElements.content[0].text).items[0].name, 'Pump01');

  // 4. listChildElementsTool
  mockPool.intercept({
    path: '/piwebapi/elements/Element1WebId/elements?searchFullHierarchy=false&startIndex=0&maxCount=100&selectedFields=Items.WebId%3BItems.Name%3BItems.Path%3BItems.TemplateName%3BItems.HasChildren&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, { Items: [] });
  const resChildren = await listChildElementsTool.handler({ element: 'Element1WebId' }, context);
  assert.strictEqual(JSON.parse(resChildren.content[0].text).items.length, 0);

  // 5. searchAttributesTool
  mockPool.intercept({
    path: '/piwebapi/elements/Element1WebId/attributes?searchFullHierarchy=false&startIndex=0&maxCount=100&selectedFields=Items.WebId%3BItems.Name%3BItems.Path%3BItems.Type%3BItems.DefaultUnitsName%3BItems.DataReferencePlugIn&webIdType=IDOnly&showExcluded=false&showHidden=false',
    method: 'GET'
  }).reply(200, {
    Items: [{ WebId: 'Attr1WebId', Name: 'FlowRate', Path: '\\\\af-server\\database1\\Pump01|FlowRate', Type: 'Float32', DefaultUnitsName: 'gpm', DataReferencePlugIn: 'PI Point' }]
  });
  const resAttrs = await searchAttributesTool.handler({ scope: 'element', target: 'Element1WebId' }, context);
  assert.strictEqual(JSON.parse(resAttrs.content[0].text).items[0].name, 'FlowRate');

  // 6. searchEventFramesTool
  mockPool.intercept({
    path: '/piwebapi/assetdatabases/DbWebId/eventframes?searchMode=Overlapped&searchFullHierarchy=false&startIndex=0&maxCount=100&selectedFields=Items.WebId%3BItems.Name%3BItems.StartTime%3BItems.EndTime%3BItems.TemplateName%3BItems.Path&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, { Items: [] });
  const resEFs = await searchEventFramesTool.handler({ database: 'DbWebId' }, context);
  assert.strictEqual(JSON.parse(resEFs.content[0].text).items.length, 0);

  // 7. listTemplatesTool
  mockPool.intercept({
    path: '/piwebapi/assetdatabases/DbWebId/elementtemplates?startIndex=0&maxCount=100&selectedFields=Items.WebId%3BItems.Name%3BItems.Path%3BItems.InstanceType&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, { Items: [] });
  const resTemplates = await listTemplatesTool.handler({ database: 'DbWebId' }, context);
  assert.strictEqual(JSON.parse(resTemplates.content[0].text).items.length, 0);

  // 8. listCategoriesTool
  mockPool.intercept({
    path: '/piwebapi/assetdatabases/DbWebId/elementcategories?selectedFields=Items.WebId%3BItems.Name%3BItems.Path&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, { Items: [] });
  const resCats = await listCategoriesTool.handler({ database: 'DbWebId' }, context);
  assert.strictEqual(JSON.parse(resCats.content[0].text).length, 0);

  // 9. resolvePointTool
  mockPool.intercept({
    path: '/piwebapi/points/Point1WebId?selectedFields=WebId%3BName%3BPath%3BPointType%3BEngineeringUnits%3BDigitalSetName%3BSpan%3BZero%3BFuture&webIdType=Full',
    method: 'GET'
  }).reply(200, { WebId: 'Point1WebId', Name: 'sinusoid', PointType: 'Float32' });
  const resResolve = await resolvePointTool.handler({ point: 'Point1WebId' }, context);
  assert.strictEqual(JSON.parse(resResolve.content[0].text).name, 'sinusoid');

  // 10. getEndTool
  mockPool.intercept({
    path: '/piwebapi/streams/Point1WebId/end?selectedFields=Timestamp%3BValue%3BUnitsAbbreviation%3BGood%3BQuestionable%3BSubstituted%3BAnnotated&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, loadFixture('values/good-numeric.json'));
  const resEnd = await getEndTool.handler({ stream: 'Point1WebId' }, context);
  assert.strictEqual(JSON.parse(resEnd.content[0].text).value, 100.0);

  // 11. readRecordedTool (happy path / pagination)
  mockPool.intercept({
    path: '/piwebapi/streams/Point1WebId/recorded?startTime=2026-06-27T00%3A00%3A00.000Z&endTime=2026-06-28T00%3A00%3A00.000Z&boundaryType=Inside&includeFilteredValues=false&maxCount=1000&selectedFields=Items.Timestamp%3BItems.Value%3BItems.Good%3BItems.Questionable%3BItems.Substituted%3BItems.Annotated%3BUnitsAbbreviation&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, loadFixture('recorded/recorded-paged-page1.json'));
  const resRecorded = await readRecordedTool.handler({
    stream: 'Point1WebId',
    startTime: '2026-06-27T00:00:00.000Z',
    endTime: '2026-06-28T00:00:00.000Z'
  }, context);
  assert.strictEqual(JSON.parse(resRecorded.content[0].text).items[0].value, 10.0);

  // 12. readInterpolatedTool
  mockPool.intercept({
    path: '/piwebapi/streams/Point1WebId/interpolated?startTime=2026-06-27T00%3A00%3A00.000Z&endTime=2026-06-28T00%3A00%3A00.000Z&interval=1h&selectedFields=Items.Timestamp%3BItems.Value%3BItems.Good%3BItems.Questionable%3BItems.Substituted%3BItems.Annotated%3BUnitsAbbreviation&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, loadFixture('interpolated/interpolated-grid.json'));
  const resInterp = await readInterpolatedTool.handler({
    stream: 'Point1WebId',
    startTime: '2026-06-27T00:00:00.000Z',
    endTime: '2026-06-28T00:00:00.000Z',
    interval: '1h'
  }, context);
  assert.strictEqual(JSON.parse(resInterp.content[0].text).items[0].value, 50.0);

  // 13. readInterpolatedAtTimesTool
  mockPool.intercept({
    path: '/piwebapi/streams/Point1WebId/interpolatedattimes?time=2026-06-28T00%3A00%3A00.000Z&selectedFields=Items.Timestamp%3BItems.Value%3BItems.Good%3BItems.Questionable%3BItems.Substituted%3BItems.Annotated%3BUnitsAbbreviation&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, loadFixture('interpolated/interpolated-grid.json'));
  const resAtTimes = await readInterpolatedAtTimesTool.handler({
    stream: 'Point1WebId',
    times: ['2026-06-28T00:00:00.000Z']
  }, context);
  assert.strictEqual(JSON.parse(resAtTimes.content[0].text).items[0].value, 50.0);

  // 14. readPlotTool
  mockPool.intercept({
    path: '/piwebapi/streams/Point1WebId/plot?startTime=2026-06-27T00%3A00%3A00.000Z&endTime=2026-06-28T00%3A00%3A00.000Z&intervals=300&selectedFields=Items.Timestamp%3BItems.Value%3BItems.Good%3BItems.Questionable%3BItems.Substituted%3BItems.Annotated%3BUnitsAbbreviation&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, loadFixture('recorded/recorded-inside-empty.json'));
  const resPlot = await readPlotTool.handler({
    stream: 'Point1WebId',
    startTime: '2026-06-27T00:00:00.000Z',
    endTime: '2026-06-28T00:00:00.000Z'
  }, context);
  assert.strictEqual(JSON.parse(resPlot.content[0].text).items.length, 0);

  // 15. readSummaryTool
  mockPool.intercept({
    path: '/piwebapi/streams/Point1WebId/summary?calculationBasis=TimeWeighted&endTime=2026-06-28T00%3A00%3A00.000Z&sampleType=ExpressionRecordedValues&selectedFields=Items.Type%3BItems.Value.Timestamp%3BItems.Value.Value%3BItems.Value.Good%3BItems.Value.Questionable%3BItems.Value.Substituted%3BItems.Value.Annotated%3BItems.Value.UnitsAbbreviation&startTime=2026-06-27T00%3A00%3A00.000Z&summaryType=Average&timeType=Auto&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, {
    Items: [{ Type: 'Average', Value: { Timestamp: '2026-06-27T00:00:00Z', Value: 12.3, Good: true } }]
  });
  const resSummary = await readSummaryTool.handler({
    stream: 'Point1WebId',
    startTime: '2026-06-27T00:00:00.000Z',
    endTime: '2026-06-28T00:00:00.000Z',
    summaryType: ['Average']
  }, context);
  assert.strictEqual(JSON.parse(resSummary.content[0].text).items[0].type, 'Average');

  mockPool.intercept({
    path: '/piwebapi/streamsets/value?webId=Point1WebId&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, {
    Items: [{ WebId: 'Point1WebId', Name: 'sinusoid', Value: { Timestamp: '2026-06-28T00:00:00Z', Value: 12.3, Good: true } }]
  });
  const resValMulti = await getValueMultiTool.handler({ webIds: ['Point1WebId'] }, context);
  assert.strictEqual(JSON.parse(resValMulti.content[0].text).streams[0].value.value, 12.3);

  // 17. readRecordedMultiTool
  mockPool.intercept({
    path: '/piwebapi/streamsets/recorded?startTime=2026-06-27T00%3A00%3A00.000Z&endTime=2026-06-28T00%3A00%3A00.000Z&boundaryType=Inside&maxCount=1000&webId=Point1WebId&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, { Items: [] });
  const resRecMulti = await readRecordedMultiTool.handler({
    webIds: ['Point1WebId'],
    startTime: '2026-06-27T00:00:00.000Z',
    endTime: '2026-06-28T00:00:00.000Z'
  }, context);
  assert.strictEqual(JSON.parse(resRecMulti.content[0].text).streams.length, 0);

  // 18. readInterpolatedMultiTool
  mockPool.intercept({
    path: '/piwebapi/streamsets/interpolated?startTime=2026-06-27T00%3A00%3A00.000Z&endTime=2026-06-28T00%3A00%3A00.000Z&interval=1h&webId=Point1WebId&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, { Items: [] });
  const resIntMulti = await readInterpolatedMultiTool.handler({
    webIds: ['Point1WebId'],
    startTime: '2026-06-27T00:00:00.000Z',
    endTime: '2026-06-28T00:00:00.000Z',
    interval: '1h'
  }, context);
  assert.strictEqual(JSON.parse(resIntMulti.content[0].text).streams.length, 0);

  // 19. readSummaryMultiTool
  mockPool.intercept({
    path: '/piwebapi/streamsets/summary?startTime=2026-06-27T00%3A00%3A00.000Z&endTime=2026-06-28T00%3A00%3A00.000Z&summaryType=Average&calculationBasis=TimeWeighted&webId=Point1WebId&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, { Items: [] });
  const resSumMulti = await readSummaryMultiTool.handler({
    webIds: ['Point1WebId'],
    startTime: '2026-06-27T00:00:00.000Z',
    endTime: '2026-06-28T00:00:00.000Z',
    summaryType: ['Average']
  }, context);
  assert.strictEqual(JSON.parse(resSumMulti.content[0].text).streams.length, 0);

  // 20. writeValuesTool
  client.metadataCache.set('Point1WebId', {
    webId: 'Point1WebId',
    name: 'sinusoid',
    pointType: 'Float32',
    future: false,
    resourceType: 'point'
  });
  mockPool.intercept({
    path: '/piwebapi/streams/Point1WebId/recorded?updateOption=Replace&bufferOption=DoNotBuffer',
    method: 'POST',
    body: JSON.stringify([
      { Timestamp: '2026-06-28T00:00:00Z', Value: 12.3, UnitsAbbreviation: undefined },
      { Timestamp: '2026-06-28T00:01:00Z', Value: 14.5, UnitsAbbreviation: undefined }
    ])
  }).reply(202, {});
  const resWrites = await writeValuesTool.handler({
    target: 'Point1WebId',
    values: [
      { timestamp: '2026-06-28T00:00:00Z', value: 12.3 },
      { timestamp: '2026-06-28T00:01:00Z', value: 14.5 }
    ]
  }, context);
  assert.strictEqual(JSON.parse(resWrites.content[0].text).status, 'ok');

  // 21. writeValuesMultiTool
  client.metadataCache.set('Point2WebId', {
    webId: 'Point2WebId',
    name: 'sinusoid2',
    pointType: 'Float32',
    future: false,
    resourceType: 'point'
  });
  mockPool.intercept({
    path: '/piwebapi/streamsets/recorded?updateOption=Replace&bufferOption=DoNotBuffer',
    method: 'POST',
    body: JSON.stringify([
      {
        WebId: 'Point1WebId',
        Items: [{ Timestamp: '2026-06-28T00:00:00Z', Value: 12.3, UnitsAbbreviation: undefined }]
      },
      {
        WebId: 'Point2WebId',
        Items: [{ Timestamp: '2026-06-28T00:01:00Z', Value: 14.5, UnitsAbbreviation: undefined }]
      }
    ])
  }).reply(202, {});
  const resWritesMulti = await writeValuesMultiTool.handler({
    streams: [
      {
        target: 'Point1WebId',
        values: [{ timestamp: '2026-06-28T00:00:00Z', value: 12.3 }]
      },
      {
        target: 'Point2WebId',
        values: [{ timestamp: '2026-06-28T00:01:00Z', value: 14.5 }]
      }
    ]
  }, context);
  assert.strictEqual(JSON.parse(resWritesMulti.content[0].text).status, 'ok');
});

test('Write tools surface a PARTIAL_WRITE when PI Web API returns HTTP 207', async () => {
  // Intent: a per-value rejection (e.g. insufficient write permission, PI
  // substatus -10401) must NOT be reported to the caller as a successful write.
  // PI Web API signals this with HTTP 207 and a body of ordered substatuses.
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const mockPool = agent.get('https://pi-server.mcp.local');
  const client = new PiWebApiClient(
    { ...testConfig, dispatcher: mockPool },
    dummyLogger,
    dummyAuthProvider,
    dummyTrustProvider
  );
  const context = { gateway: client, config: testConfig, logger: dummyLogger, signal: null };

  client.metadataCache.set('Point1WebId', {
    webId: 'Point1WebId',
    name: 'sinusoid',
    pointType: 'Float32',
    future: false,
    resourceType: 'point'
  });

  // Two values supplied; one is rejected by the archive.
  mockPool.intercept({
    path: '/piwebapi/streams/Point1WebId/recorded?updateOption=Replace&bufferOption=DoNotBuffer',
    method: 'POST'
  }).reply(207, [
    null,
    { Substatus: 502, Errors: ['[-10401] No write access for the point.'] }
  ]);

  await assert.rejects(
    () => writeValuesTool.handler({
      target: 'Point1WebId',
      values: [
        { timestamp: '2026-06-28T00:00:00Z', value: 12.3 },
        { timestamp: '2026-06-28T00:01:00Z', value: 14.5 }
      ]
    }, context),
    (err) => {
      assert.strictEqual(err.category, 'PARTIAL_WRITE');
      assert.strictEqual(err.details.failed, 1);
      assert.strictEqual(err.details.accepted, 1);
      assert.strictEqual(err.details.failures[0].substatus, 502);
      return true;
    }
  );
});

test('resolveMetadata falls back to /attributes when a point lookup returns HTTP 400', async () => {
  // Intent: an AF attribute WebID is not a valid point WebID, so PI Web API
  // rejects /points/{webId} with HTTP 400 (not 404). Attribute targets must
  // still resolve, otherwise write_values_multi fails with a spurious error.
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const mockPool = agent.get('https://pi-server.mcp.local');
  const client = new PiWebApiClient(
    { ...testConfig, dispatcher: mockPool },
    dummyLogger,
    dummyAuthProvider,
    dummyTrustProvider
  );

  mockPool.intercept({
    path: '/piwebapi/points/AttrWebId123?selectedFields=WebId;Name;Path;PointType;DigitalSetName;EngineeringUnits;Step;Zero;Span;Future',
    method: 'GET'
  }).reply(400, { Errors: ['Unknown or invalid WebID format.'] });

  mockPool.intercept({
    path: '/piwebapi/attributes/AttrWebId123?selectedFields=WebId;Name;Path;Type;DigitalSetName;DefaultUnitsName;DataReferencePlugIn;Step;Zero;Span;Future',
    method: 'GET'
  }).reply(200, {
    WebId: 'AttrWebId123',
    Name: 'Temperature',
    Path: '\\\\af-server\\database1\\Reactor1|Temperature',
    Type: 'Double',
    DefaultUnitsName: 'degC',
    DataReferencePlugIn: 'PI Point'
  });

  const metadata = await client.resolveMetadata('AttrWebId123', null, null);
  assert.strictEqual(metadata.resourceType, 'attribute');
  assert.strictEqual(metadata.name, 'Temperature');
  assert.strictEqual(metadata.engineeringUnits, 'degC');
});

test('Multi-stream reads surface a PARTIAL envelope for per-stream failures', async () => {
  // Intent: a streamset bulk read returns HTTP 200 even when an individual
  // stream fails (the failing item carries an Errors array). Those failures
  // must NOT masquerade as empty streams; the good streams are returned and
  // each failure is surfaced with a sanitized reason (fail loud, no host leak).
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const mockPool = agent.get('https://pi-server.mcp.local');
  const client = new PiWebApiClient(
    { ...testConfig, dispatcher: mockPool },
    dummyLogger,
    dummyAuthProvider,
    dummyTrustProvider
  );
  const context = { gateway: client, config: testConfig, logger: dummyLogger, signal: null };

  mockPool.intercept({
    path: '/piwebapi/streamsets/recorded?startTime=2026-06-27T00%3A00%3A00.000Z&endTime=2026-06-28T00%3A00%3A00.000Z&boundaryType=Inside&maxCount=1000&webId=GoodWebId&webId=BadWebId&webIdType=IDOnly',
    method: 'GET'
  }).reply(200, {
    Items: [
      {
        WebId: 'GoodWebId',
        Name: 'sinusoid',
        Items: [{ Timestamp: '2026-06-27T01:00:00Z', Value: 1.5, Good: true }]
      },
      {
        WebId: 'BadWebId',
        Name: 'broken',
        Errors: ["Element '\\\\AF-SRV-01\\PlantDB\\Reactor1' was not found."]
      }
    ]
  });

  const res = await readRecordedMultiTool.handler({
    webIds: ['GoodWebId', 'BadWebId'],
    startTime: '2026-06-27T00:00:00.000Z',
    endTime: '2026-06-28T00:00:00.000Z'
  }, context);

  const parsed = JSON.parse(res.content[0].text);
  assert.strictEqual(parsed.streams.length, 1);
  assert.strictEqual(parsed.streams[0].webId, 'GoodWebId');
  assert.strictEqual(parsed.partial, true);
  assert.strictEqual(parsed.failures.length, 1);
  assert.strictEqual(parsed.failures[0].webId, 'BadWebId');
  assert.ok(!parsed.failures[0].reason.includes('AF-SRV-01'), 'failure reason must be sanitized');
});

test('normalizeTvq defaults quality to not-good when Good is absent', () => {
  // Intent: an upstream item missing Good is of unknown quality; defaulting it
  // to good would silently mislabel untrustworthy data as trustworthy.
  const tvq = normalizeTvq({ Timestamp: '2026-06-28T00:00:00Z', Value: 42 });
  assert.strictEqual(tvq.toJSON().good, false);

  const explicit = normalizeTvq({ Timestamp: '2026-06-28T00:00:00Z', Value: 42, Good: true });
  assert.strictEqual(explicit.toJSON().good, true);
});

test('enforceSizeGuard measures UTF-8 bytes, not UTF-16 code units', () => {
  // Intent: MCP_MAX_RESPONSE_BYTES is a byte budget. A payload of multi-byte
  // characters can sit under the cap by String.length yet blow past it in
  // bytes; the guard must truncate on the byte measure or oversized responses
  // leak through.
  const result = { items: [{ v: '°'.repeat(1000) }] }; // 1000 UTF-16 units, 2000 UTF-8 bytes
  const json = JSON.stringify(result);
  const maxBytes = 1500;
  assert.ok(json.length <= maxBytes, 'precondition: fits by UTF-16 length');
  assert.ok(Buffer.byteLength(json, 'utf8') > maxBytes, 'precondition: exceeds by bytes');

  const guarded = enforceSizeGuard(result, maxBytes);
  assert.strictEqual(guarded.truncated, true);
  assert.strictEqual(guarded.items.length, 0);
});

test('MetadataCache freezes entries so a reader cannot poison the shared copy', () => {
  // Intent: metadata is handed out by reference to every caller. A mutation of
  // one read (or of the object originally inserted) must not corrupt the entry
  // seen by others.
  const cache = new MetadataCache(10, 60);
  const original = { webId: 'W1', name: 'sinusoid', resourceType: 'point' };
  cache.set('W1', original);

  const got = cache.get('W1');
  assert.ok(Object.isFrozen(got), 'cached metadata must be frozen');

  // Mutating the object originally inserted must not affect the cached copy.
  original.name = 'tampered';
  assert.strictEqual(cache.get('W1').name, 'sinusoid');
});
