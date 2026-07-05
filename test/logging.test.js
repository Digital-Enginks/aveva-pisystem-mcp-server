import test from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../src/security/redactor.js';

test('Redactor - Scrubs credentials and JWT tokens from strings', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const authorization = 'Bearer ' + jwt;
  const connectionString = 'Server=myServer;User ID=myUser;Password=myPassword;';
  
  assert.equal(scrub(jwt), '[REDACTED]');
  assert.equal(scrub(authorization), '[REDACTED]');
  assert.ok(!scrub(connectionString).includes('myPassword'));
  assert.ok(scrub(connectionString).includes('Password=[REDACTED]'));
});

test('Redactor - Redacts Kerberos SPNs', () => {
  const logStr = 'Attempting Kerberos auth with SPN HTTP/piwebapi.domain.local';
  const scrubbed = scrub(logStr);
  assert.ok(!scrubbed.includes('HTTP/piwebapi'));
  assert.ok(scrubbed.includes('[REDACTED]'));
});

test('Redactor - Recursively redacts objects', () => {
  const sensitiveObj = {
    user: 'admin',
    password: 'super-secret-password',
    meta: {
      clientSecret: 'secret-token-123'
    }
  };

  const scrubbed = scrub(sensitiveObj);
  assert.equal(scrubbed.password, '[REDACTED]');
  assert.equal(scrubbed.meta.clientSecret, '[REDACTED]');
  assert.equal(scrubbed.user, 'admin');
});
