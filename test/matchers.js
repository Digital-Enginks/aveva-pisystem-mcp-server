// Custom matchers for recurring PI Web API shapes (§5.1.1 toolchain item).
// Centralizing shape checks here means fixture/shape drift fails in ONE place
// rather than being silently re-asserted ad hoc across many test files.
import assert from 'node:assert/strict';

/**
 * Assert an object is a well-formed PI Web API timed-value (TVQ) object.
 * The Value field is a discriminated union: number | string | null | digital/system-state object.
 */
export function assertValidTimedValue(obj, label = 'timed-value') {
  assert.ok(obj && typeof obj === 'object', `${label}: must be an object`);
  assert.equal(typeof obj.Timestamp, 'string', `${label}: Timestamp must be a string`);
  assert.ok(!Number.isNaN(Date.parse(obj.Timestamp)), `${label}: Timestamp must be parseable`);
  assert.equal(typeof obj.Good, 'boolean', `${label}: Good must be a boolean`);

  const v = obj.Value;
  const isUnionMember =
    typeof v === 'number' ||
    typeof v === 'string' ||
    v === null ||
    (v && typeof v === 'object' &&
      typeof v.Name === 'string' &&
      typeof v.Value === 'number' &&
      typeof v.IsSystem === 'boolean');
  assert.ok(isUnionMember, `${label}: Value must be number|string|null|state-object, got ${JSON.stringify(v)}`);

  // Quality coupling rule: a system-state value must carry Good=false.
  if (v && typeof v === 'object' && v.IsSystem === true) {
    assert.equal(obj.Good, false, `${label}: a system-state value must have Good=false`);
  }
}

/**
 * Assert that `text` (a sanitized, client-facing string or its JSON form)
 * contains NONE of the supplied infrastructure tokens. This is the assertion
 * that encodes WHY the sanitizer exists — it can only pass if redaction is real.
 */
export function assertNoInfraLeak(text, forbiddenTokens, label = 'sanitized output') {
  const haystack = typeof text === 'string' ? text : JSON.stringify(text);
  for (const token of forbiddenTokens) {
    assert.ok(
      !haystack.includes(token),
      `${label}: must not leak infrastructure token "${token}" — found in: ${haystack}`
    );
  }
}
