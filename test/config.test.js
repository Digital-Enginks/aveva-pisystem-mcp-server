import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';

const baseEnv = {
  PIWEBAPI_BASE_URL: 'https://example.com/piwebapi',
  MCP_TRANSPORT: 'stdio',
  PIWEBAPI_AUTH_MODE: 'anonymous',
  PIWEBAPI_ALLOW_ANONYMOUS: 'true',
  MCP_READ_ONLY: 'true',
  PIWEBAPI_REQUEST_TIMEOUT_MS: '5000',
  MCP_SERVER_NAME: 'test-server',
  MCP_SERVER_VERSION: '1.0.0'
};

test('Config Loader - Validates baseline configuration successfully', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.MCP_SERVER_NAME, 'test-server');
  assert.equal(config.PIWEBAPI_AUTH_MODE, 'anonymous');
});

test('Config Loader - Fails when missing required field', () => {
  const env = { ...baseEnv };
  delete env.PIWEBAPI_BASE_URL;
  assert.throws(() => {
    loadConfig(env);
  }, /PIWEBAPI_BASE_URL/);
});

test('Config Loader - Enforces Bearer and Kerberos exclusivity', () => {
  const env = {
    ...baseEnv,
    PIWEBAPI_AUTH_MODE: 'kerberos',
    PIWEBAPI_KERBEROS_SPN: 'HTTP/example.com',
    PIWEBAPI_BEARER_ISSUER: 'https://aim.example.com'
  };
  assert.throws(() => {
    loadConfig(env);
  }, /Bearer options cannot be configured when/);
});

test('Config Loader - Resolves file-based secrets correctly', () => {
  const tempFile = path.resolve('test-temp-secret.txt');
  fs.writeFileSync(tempFile, 'file-password-123\n');

  try {
    const env = {
      ...baseEnv,
      PIWEBAPI_AUTH_MODE: 'basic',
      PIWEBAPI_BASIC_USER: 'admin',
      PIWEBAPI_BASIC_PASSWORD_FILE: tempFile
    };
    const config = loadConfig(env);
    assert.equal(config.PIWEBAPI_BASIC_PASSWORD_RESOLVED, 'file-password-123');
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
});

test('Config Loader - Schema Refinements Validation Checks', () => {
  // Helper to expect Zod issues
  const assertThrowsMessage = (env, pattern) => {
    assert.throws(() => loadConfig(env), pattern);
  };

  // 1. Missing HTTP Bind when transport is http
  assertThrowsMessage({
    ...baseEnv,
    MCP_TRANSPORT: 'http',
    MCP_HTTP_PORT: '8080'
  }, /MCP_HTTP_BIND/);

  // 2. Missing HTTP Port when transport is http
  assertThrowsMessage({
    ...baseEnv,
    MCP_TRANSPORT: 'http',
    MCP_HTTP_BIND: '127.0.0.1'
  }, /MCP_HTTP_PORT/);

  // 3. HTTP mode but TLS verification disabled
  assertThrowsMessage({
    ...baseEnv,
    MCP_TRANSPORT: 'http',
    MCP_HTTP_BIND: '127.0.0.1',
    MCP_HTTP_PORT: '8080',
    PIWEBAPI_TLS_VERIFY: 'false'
  }, /TLS verification cannot be disabled/);

  // 4. Edge Auth Mode none on non-loopback
  assertThrowsMessage({
    ...baseEnv,
    MCP_TRANSPORT: 'http',
    MCP_HTTP_BIND: '0.0.0.0',
    MCP_HTTP_PORT: '8080',
    MCP_EDGE_AUTH_MODE: 'none'
  }, /cannot be 'none' unless binding to a loopback/);

  // 5. Forbidden NODE_TLS_REJECT_UNAUTHORIZED=0
  const originalTLSReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    assertThrowsMessage(baseEnv, /NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden/);
  } finally {
    if (originalTLSReject === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTLSReject;
    }
  }

  // 6. Missing Kerberos SPN
  assertThrowsMessage({
    ...baseEnv,
    PIWEBAPI_AUTH_MODE: 'kerberos'
  }, /PIWEBAPI_KERBEROS_SPN is required/);

  // 7. Missing Bearer Issuer
  assertThrowsMessage({
    ...baseEnv,
    PIWEBAPI_AUTH_MODE: 'bearer',
    PIWEBAPI_BEARER_CLIENT_ID: 'client',
    PIWEBAPI_BEARER_CLIENT_SECRET: 'secret'
  }, /PIWEBAPI_BEARER_ISSUER is required/);

  // 8. Missing Bearer Client ID
  assertThrowsMessage({
    ...baseEnv,
    PIWEBAPI_AUTH_MODE: 'bearer',
    PIWEBAPI_BEARER_ISSUER: 'https://issuer.com',
    PIWEBAPI_BEARER_CLIENT_SECRET: 'secret'
  }, /PIWEBAPI_BEARER_CLIENT_ID is required/);

  // 9. Bearer Secret check: multiple/none secrets
  assertThrowsMessage({
    ...baseEnv,
    PIWEBAPI_AUTH_MODE: 'bearer',
    PIWEBAPI_BEARER_ISSUER: 'https://issuer.com',
    PIWEBAPI_BEARER_CLIENT_ID: 'client'
  }, /Bearer client secret must be supplied/);

  // 10. Missing Basic User
  assertThrowsMessage({
    ...baseEnv,
    PIWEBAPI_AUTH_MODE: 'basic',
    PIWEBAPI_BASIC_PASSWORD: 'password'
  }, /PIWEBAPI_BASIC_USER is required/);

  // 11. Basic Password check: none secrets
  assertThrowsMessage({
    ...baseEnv,
    PIWEBAPI_AUTH_MODE: 'basic',
    PIWEBAPI_BASIC_USER: 'user'
  }, /Basic password must be supplied/);

  // 12. Anonymous Mode allowance missing
  assertThrowsMessage({
    ...baseEnv,
    PIWEBAPI_AUTH_MODE: 'anonymous',
    PIWEBAPI_ALLOW_ANONYMOUS: 'false'
  }, /ALLOW_ANONYMOUS must be explicitly true/);

  // 13. Anonymous Mode write tools check
  assertThrowsMessage({
    ...baseEnv,
    PIWEBAPI_AUTH_MODE: 'anonymous',
    PIWEBAPI_ALLOW_ANONYMOUS: 'true',
    MCP_READ_ONLY: 'false'
  }, /MCP_READ_ONLY must be true/);

  // 14. Write Tools enabled but read-only true
  assertThrowsMessage({
    ...baseEnv,
    MCP_WRITE_TOOLS_ENABLED: 'true',
    MCP_READ_ONLY: 'true'
  }, /Cannot enable write tools when MCP_READ_ONLY/);

  // 15. Write Tools over HTTP with auth none
  assertThrowsMessage({
    ...baseEnv,
    MCP_TRANSPORT: 'http',
    MCP_HTTP_BIND: '127.0.0.1',
    MCP_HTTP_PORT: '8080',
    MCP_WRITE_TOOLS_ENABLED: 'true',
    MCP_READ_ONLY: 'false',
    MCP_EDGE_AUTH_MODE: 'none'
  }, /Edge authentication is required to enable write tools/);

  // 16. Write Tools over HTTP missing roles
  assertThrowsMessage({
    ...baseEnv,
    MCP_TRANSPORT: 'http',
    MCP_HTTP_BIND: '127.0.0.1',
    MCP_HTTP_PORT: '8080',
    MCP_WRITE_TOOLS_ENABLED: 'true',
    MCP_READ_ONLY: 'false',
    MCP_EDGE_AUTH_MODE: 'bearer'
  }, /MCP_EDGE_WRITE_ROLES must be specified/);
});

test('Config Loader - Resolves secrets and handles error conditions', () => {
  // 1. Successful environment reference resolution
  process.env.TEST_ENV_PASSWORD = 'env-secret-999';
  try {
    const env = {
      ...baseEnv,
      PIWEBAPI_AUTH_MODE: 'basic',
      PIWEBAPI_BASIC_USER: 'admin',
      PIWEBAPI_BASIC_PASSWORD_REF: 'TEST_ENV_PASSWORD'
    };
    const config = loadConfig(env);
    assert.equal(config.PIWEBAPI_BASIC_PASSWORD_RESOLVED, 'env-secret-999');
  } finally {
    delete process.env.TEST_ENV_PASSWORD;
  }

  // 2. Direct Bearer client secret resolution
  const bearerEnv = {
    ...baseEnv,
    PIWEBAPI_AUTH_MODE: 'bearer',
    PIWEBAPI_BEARER_ISSUER: 'https://aim.example.com',
    PIWEBAPI_BEARER_CLIENT_ID: 'mcp-client',
    PIWEBAPI_BEARER_CLIENT_SECRET: 'bearer-direct-secret-123'
  };
  const configBearer = loadConfig(bearerEnv);
  assert.equal(configBearer.PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED, 'bearer-direct-secret-123');

  // 3. Throw on non-existent file secret
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      PIWEBAPI_AUTH_MODE: 'basic',
      PIWEBAPI_BASIC_USER: 'admin',
      PIWEBAPI_BASIC_PASSWORD_FILE: 'nonexistent-secret-file.txt'
    }),
    /Failed to read secret from file/
  );

  // 4. Throw on missing environment reference variable
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      PIWEBAPI_AUTH_MODE: 'basic',
      PIWEBAPI_BASIC_USER: 'admin',
      PIWEBAPI_BASIC_PASSWORD_REF: 'NON_EXISTENT_ENV_VARIABLE_XYZ'
    }),
    /Failed to resolve secret reference/
  );

  // 5. Client cert key file resolution
  const tempKeyFile = path.resolve('test-temp-key.pem');
  fs.writeFileSync(tempKeyFile, 'key-data-abc');
  try {
    const certEnv = {
      ...baseEnv,
      PIWEBAPI_CLIENT_CERT_KEY_FILE: tempKeyFile
    };
    const configCert = loadConfig(certEnv);
    assert.equal(configCert.PIWEBAPI_CLIENT_CERT_KEY_RESOLVED, 'key-data-abc');
  } finally {
    if (fs.existsSync(tempKeyFile)) {
      fs.unlinkSync(tempKeyFile);
    }
  }
});

