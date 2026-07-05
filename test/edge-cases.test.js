// Phase 5 §5.4 edge-case catalog + §5.3.4 error-mapping obligations.
// These tests pin the project's ACTUAL behaviour (the implemented AppError
// taxonomy and sanitizer), not the aspirational code names in the plan text.
// Every test is named around the business reason the behaviour matters.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadFixture } from './helper.js';
import { assertValidTimedValue, assertNoInfraLeak } from './matchers.js';
import { normalizeTvq } from '../src/gateway/value-normalizer.js';
import { Quality } from '../src/domain/values/Quality.js';
import { TagPath } from '../src/domain/values/TagPath.js';
import { AppError, ErrorCategory } from '../src/errors/error-model.js';
import { sanitizeError } from '../src/errors/sanitizer.js';
import { handleMcpError } from '../src/errors/to-mcp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// 5.4.1 Value quality and type — the discriminated-union must survive intact
// ---------------------------------------------------------------------------

test('5.4.1#1 good numeric/string snapshots preserve UnitsAbbreviation and value kind', () => {
  const num = normalizeTvq(loadFixture('values/good-numeric.json'));
  assert.equal(num.valueKind, 'numeric');
  assert.equal(typeof num.value, 'number');
  assert.equal(num.quality.good, true);

  // Units are preserved verbatim when present, so a bare number is never unit-ambiguous.
  const annotated = normalizeTvq(loadFixture('values/annotated-numeric.json'));
  assert.equal(annotated.unitsAbbreviation, 'psi');
  // When the item omits units, the caller-supplied stream default is applied.
  const withDefault = normalizeTvq(loadFixture('values/good-numeric.json'), 'degC');
  assert.equal(withDefault.unitsAbbreviation, 'degC');

  const str = normalizeTvq(loadFixture('values/good-string.json'));
  assert.equal(str.valueKind, 'string');
  assert.equal(typeof str.value, 'string');
});

test('5.4.1#2 a Questionable value stays flagged so an operator never trusts suspect data', () => {
  const tvq = normalizeTvq(loadFixture('values/questionable-numeric.json'));
  assert.equal(tvq.quality.questionable, true);
});

test('5.4.1#3 a Substituted value is flagged, never silently treated as a raw measurement', () => {
  const tvq = normalizeTvq(loadFixture('values/substituted-numeric.json'));
  assert.equal(tvq.quality.substituted, true);
});

test('5.4.1#4 an Annotated value carries its flag so consumers can fetch the annotation', () => {
  const tvq = normalizeTvq(loadFixture('values/annotated-numeric.json'));
  assert.equal(tvq.quality.annotated, true);
});

test('5.4.1#5 a digital-state value is not assumed numeric (union branch)', () => {
  for (const f of ['values/digital-state-on.json', 'values/digital-state-off.json']) {
    const raw = loadFixture(f);
    assertValidTimedValue(raw, f);
    const tvq = normalizeTvq(raw);
    assert.equal(tvq.valueKind, 'digitalState');
    assert.equal(tvq.value.isSystem, false);
    assert.equal(typeof tvq.value.name, 'string');
  }
});

test('5.4.1#6 a system/error state couples to Good=false and never coerces to a number', () => {
  for (const f of ['values/system-state-no-data.json', 'values/system-state-io-timeout.json']) {
    const raw = loadFixture(f);
    assertValidTimedValue(raw, f);
    const tvq = normalizeTvq(raw);
    assert.equal(tvq.valueKind, 'systemState');
    assert.equal(tvq.value.isSystem, true);
    assert.equal(tvq.quality.good, false, 'system state must force Good=false (coupling rule)');
    assert.notEqual(tvq.value, 0, '"No Data"/"I/O Timeout" must never be coerced to 0');
  }
});

test('5.4.1#7 mixed-quality series preserves per-point quality with no aggregate clobbering', () => {
  const coll = loadFixture('recorded/recorded-mixed-quality.json');
  const tvqs = coll.Items.map((i) => normalizeTvq(i, coll.UnitsAbbreviation));
  // Distinct quality signatures must survive independently across the collection.
  assert.equal(tvqs[1].quality.questionable, true);
  assert.equal(tvqs[2].quality.substituted, true);
  assert.equal(tvqs[3].valueKind, 'systemState');
  assert.equal(tvqs[3].quality.good, false);
  assert.equal(tvqs[4].valueKind, 'digitalState');
  assert.equal(tvqs[4].quality.annotated, true);
});

test('5.2.2 an item missing Good defaults to NOT good, never silently labelled trustworthy', () => {
  // Our projections always request Good; an absent Good means an unprojected /
  // error item of unknown quality. Defaulting to good would mislabel bad data.
  const tvq = normalizeTvq({ Timestamp: '2026-06-20T00:00:00Z', Value: 5 });
  assert.equal(tvq.quality.good, false);
});

// ---------------------------------------------------------------------------
// 5.4.7 #50 Path handling — paths are modelled as structured values
// ---------------------------------------------------------------------------

test('5.4.7#50 a backslash-bearing PI path is modelled structurally, not string-concatenated', () => {
  const p = new TagPath('\\\\PI-SRV\\Plant\\Area1\\Reactor.Temperature');
  assert.equal(p.server, 'PI-SRV');
  assert.ok(p.path.startsWith('\\\\'), 'leading backslashes preserved verbatim for correct downstream encoding');
  assert.equal(p.isAf, true);
  // A value that does not start with the UNC marker is rejected, not coerced.
  assert.throws(() => new TagPath('PI-SRV/Plant/Area1'), /double backslashes/);
});

// ---------------------------------------------------------------------------
// 5.3.4 Error-mapper obligations — sanitizer, channel split, negative test
// ---------------------------------------------------------------------------

test('5.3.4 sanitizer strips a full battery of infra tokens (host, IP, URL, UNC, SPN, issuer, audience)', () => {
  const err = new AppError({
    category: ErrorCategory.UPSTREAM_PERMANENT,
    retryable: false,
    message: 'internal cause that must never surface',
    cause: new Error('SPNEGO Negotiate failed for HTTP/pi.plant.local at 10.20.30.40'),
    details: {
      Errors: [
        'Auth failed against https://aim.plant.local/identitymanager/ for audience https://pi.plant.local/piwebapi',
        "Element '\\\\AF-SRV-01\\PlantDB\\Reactor1' not found on host db.plant.local (10.20.30.40)"
      ]
    }
  });

  const sanitized = sanitizeError(err);

  // The static safe message is used; the raw cause text never appears.
  assert.equal(sanitized.message, 'The upstream PI System returned an unrecoverable error.');
  assertNoInfraLeak(sanitized, [
    'pi.plant.local',
    'aim.plant.local',
    'db.plant.local',
    'AF-SRV-01',
    '10.20.30.40',
    'identitymanager',
    'internal cause that must never surface'
  ]);
});

test('5.3.4 the LIMIT_EXCEEDED safe message never echoes the numeric capacity cap N', () => {
  const err = new AppError({
    category: ErrorCategory.LIMIT_EXCEEDED,
    retryable: false,
    message: 'greater than the maximum allowed (150000)'
  });
  const sanitized = sanitizeError(err);
  // Status-keyed mapping yields a generic hint; the server capacity (150000) is config-leak.
  assertNoInfraLeak(sanitized.message, ['150000']);
});

test('5.3.4 channel split: inbound-edge auth fails as a protocol McpError', () => {
  for (const category of [ErrorCategory.EDGE_UNAUTHENTICATED, ErrorCategory.EDGE_FORBIDDEN, ErrorCategory.INVALID_INPUT]) {
    const err = new AppError({ category, retryable: false, message: 'x' });
    assert.throws(() => handleMcpError(err), McpError,
      `${category} must surface on the protocol channel (McpError), never as a tool result`);
  }
});

test('5.3.4 channel split: an upstream PI auth denial arrives as a sanitized tool result, never protocol', () => {
  // UNAUTHORIZED is the mapped category for upstream PI 401/403. It must NOT throw.
  const err = new AppError({
    category: ErrorCategory.UNAUTHORIZED,
    retryable: false,
    message: 'PI denied the service principal',
    correlationId: 'corr-9',
    cause: new Error('Negotiate handshake rejected for HTTP/pi.plant.local')
  });
  const result = handleMcpError(err);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Authentication with the upstream PI System failed.');
  assertNoInfraLeak(result, ['pi.plant.local', 'Negotiate']);
});

test('5.3.4 negative test: a string value of "error" is data, not an error classification', () => {
  // The mapper must never classify a successful value on free text alone.
  const tvq = normalizeTvq({ Timestamp: '2026-06-20T00:00:00Z', Value: 'error', Good: true });
  assert.equal(tvq.valueKind, 'string');
  assert.equal(tvq.value, 'error');
  assert.equal(tvq.quality.good, true);
});

test('5.3.4 a non-AppError is sanitized to a generic INTERNAL result with no detail leak', () => {
  const sanitized = sanitizeError(new Error('boom at C:\\srv\\secret on host.plant.local'));
  assert.equal(sanitized.code, 'INTERNAL');
  assert.equal(sanitized.message, 'An unexpected internal server error occurred.');
  assertNoInfraLeak(sanitized, ['C:\\srv\\secret', 'host.plant.local', 'boom']);
});
