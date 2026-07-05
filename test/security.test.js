import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import process from 'node:process';
import { MockAgent, setGlobalDispatcher, Agent } from 'undici';
import { EdgeAuthenticator } from '../src/protocol/edge-auth.js';
import { EdgeRateLimiter } from '../src/protocol/rate-limit.js';
import { validateAuthPolicy } from '../src/security/auth-policy.js';
import { createAuthProvider } from '../src/security/auth-provider.js';
import { BasicAuthProvider } from '../src/gateway/auth/basic-provider.js';
import { AnonymousAuthProvider } from '../src/gateway/auth/anonymous-provider.js';
import { BearerAuthProvider } from '../src/gateway/auth/bearer-provider.js';
import { KerberosAuthProvider, overrideKerberos } from '../src/gateway/auth/kerberos-provider.js';
import { TrustProvider } from '../src/gateway/trust.js';
import { PiWebApiClient } from '../src/gateway/pi-web-api-client.js';

// Setup Mock RSA Keypair for Inbound JWT tests
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const testJwk = publicKey.export({ format: 'jwk' });
testJwk.alg = 'RS256';
testJwk.use = 'sig';
testJwk.kid = 'test-kid-123';

function createSignedJwt(payload, kid = 'test-kid-123', alg = 'RS256') {
  const header = { alg, typ: 'JWT', kid };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${headerB64}.${payloadB64}`);
  const signatureB64 = sign.sign(privateKey, 'base64url');
  
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

test('Inbound Edge Authentication - none mode', async () => {
  const config = {
    MCP_EDGE_AUTH_MODE: 'none',
    MCP_HTTP_BIND: '127.0.0.1'
  };
  const auth = new EdgeAuthenticator(config, mockLogger);
  const result = await auth.authenticate({});
  assert.equal(result.user, 'anonymous');
  assert.deepEqual(result.roles, []);
});

test('Inbound Edge Authentication - mtls mode success', async () => {
  const config = {
    MCP_EDGE_AUTH_MODE: 'mtls'
  };
  const auth = new EdgeAuthenticator(config, mockLogger);
  const mockReq = {
    socket: {
      authorized: true,
      getPeerCertificate: () => ({
        subject: { CN: 'my-trusted-client' }
      })
    }
  };
  const result = await auth.authenticate(mockReq);
  assert.equal(result.user, 'my-trusted-client');
  assert.ok(result.roles.includes('read'));
});

test('Inbound Edge Authentication - mtls mode failure', async () => {
  const config = {
    MCP_EDGE_AUTH_MODE: 'mtls'
  };
  const auth = new EdgeAuthenticator(config, mockLogger);
  const mockReq = {
    socket: {
      authorized: false,
      getPeerCertificate: () => null
    }
  };
  await assert.rejects(
    async () => auth.authenticate(mockReq),
    (err) => err.category === 'EDGE_UNAUTHENTICATED'
  );
});

test('Inbound Edge Authentication - bearer mode validation', async () => {
  // Setup MockAgent for JWKS endpoint
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const jwksPool = mockAgent.get('https://identity.mcp.local');
  jwksPool.intercept({
    path: '/jwks',
    method: 'GET'
  }).reply(200, {
    keys: [testJwk]
  }).persist();

  const config = {
    MCP_EDGE_AUTH_MODE: 'bearer',
    MCP_EDGE_JWKS_URL: 'https://identity.mcp.local/jwks',
    MCP_EDGE_AUDIENCE: 'mcp-server-api'
  };

  const auth = new EdgeAuthenticator(config, mockLogger);

  // 1. Success case
  const validToken = createSignedJwt({
    sub: 'user-john',
    roles: ['operator', 'admin'],
    aud: 'mcp-server-api',
    exp: Math.floor(Date.now() / 1000) + 120
  });

  const successReq = {
    headers: { authorization: `Bearer ${validToken}` }
  };
  const user = await auth.authenticate(successReq);
  assert.equal(user.user, 'user-john');
  assert.ok(user.roles.includes('operator'));

  // 2. Mismatch audience
  const badAudToken = createSignedJwt({
    sub: 'user-john',
    aud: 'wrong-audience',
    exp: Math.floor(Date.now() / 1000) + 120
  });
  const badAudReq = { headers: { authorization: `Bearer ${badAudToken}` } };
  await assert.rejects(
    async () => auth.authenticate(badAudReq),
    (err) => err.category === 'EDGE_UNAUTHENTICATED' && err.message.includes('Audience mismatch')
  );

  // 3. Expired token
  const expiredToken = createSignedJwt({
    sub: 'user-john',
    aud: 'mcp-server-api',
    exp: Math.floor(Date.now() / 1000) - 60
  });
  const expiredReq = { headers: { authorization: `Bearer ${expiredToken}` } };
  await assert.rejects(
    async () => auth.authenticate(expiredReq),
    (err) => err.category === 'EDGE_UNAUTHENTICATED' && err.message.includes('expired')
  );
});

test('Inbound Edge Authentication - write tools authorization', () => {
  const config = {
    MCP_WRITE_TOOLS_ENABLED: true,
    MCP_EDGE_AUTH_MODE: 'bearer',
    MCP_EDGE_WRITE_ROLES: 'admin,supervisor'
  };
  const auth = new EdgeAuthenticator(config, mockLogger);

  // 1. Authorized role
  const authInfo = { roles: ['operator', 'admin'] };
  assert.ok(auth.authorizeWrite(authInfo));

  // 2. Unauthorized role
  const unauthInfo = { roles: ['operator'] };
  assert.throws(
    () => auth.authorizeWrite(unauthInfo),
    (err) => err.category === 'EDGE_FORBIDDEN'
  );

  // 3. Master switch disabled
  const disabledConfig = {
    MCP_WRITE_TOOLS_ENABLED: false
  };
  const disabledAuth = new EdgeAuthenticator(disabledConfig, mockLogger);
  assert.throws(
    () => disabledAuth.authorizeWrite(authInfo),
    (err) => err.category === 'WRITES_DISABLED'
  );
});

test('Authentication Policy Validator', () => {
  // Reject NODE_TLS_REJECT_UNAUTHORIZED === '0'
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  assert.throws(
    () => validateAuthPolicy({}),
    (err) => err.category === 'INTERNAL' && err.message.includes('NODE_TLS_REJECT_UNAUTHORIZED=0')
  );
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  // Basic over HTTP check
  const basicHttpConfig = {
    PIWEBAPI_AUTH_MODE: 'basic',
    PIWEBAPI_BASE_URL: 'http://insecure-piwebapi/piwebapi',
    PIWEBAPI_BASIC_USER: 'test-user',
    PIWEBAPI_BASIC_PASSWORD_RESOLVED: 'test-pass'
  };
  assert.throws(
    () => validateAuthPolicy(basicHttpConfig),
    (err) => err.category === 'INTERNAL' && err.message.includes('HTTPS')
  );
});

test('Basic Authentication Strategy Provider', async () => {
  const config = {
    PIWEBAPI_BASIC_USER: 'admin',
    PIWEBAPI_BASIC_PASSWORD_RESOLVED: 'secret123'
  };
  const provider = new BasicAuthProvider(config, mockLogger);
  const headers = {};
  await provider.decorate(headers);
  assert.equal(headers['Authorization'], 'Basic YWRtaW46c2VjcmV0MTIz');
});

test('Bearer/OIDC Strategy Provider - discovery and caching', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const aimPool = mockAgent.get('https://aim.pi.local');
  
  // Intercept OIDC Discovery
  aimPool.intercept({
    path: '/.well-known/openid-configuration',
    method: 'GET'
  }).reply(200, {
    token_endpoint: 'https://aim.pi.local/oauth/token'
  });

  // Intercept Token Request
  aimPool.intercept({
    path: '/oauth/token',
    method: 'POST',
    body: 'grant_type=client_credentials&client_id=mcp-client&client_secret=aim-secret-key'
  }).reply(200, {
    access_token: 'jwt-access-token-123',
    expires_in: 3600
  });

  const config = {
    PIWEBAPI_BEARER_ISSUER: 'https://aim.pi.local',
    PIWEBAPI_BEARER_CLIENT_ID: 'mcp-client',
    PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED: 'aim-secret-key',
    PIWEBAPI_BEARER_GRANT: 'client_credentials',
    dispatcher: mockAgent
  };

  const trustProvider = new TrustProvider({
    PIWEBAPI_TLS_VERIFY: true
  }, mockLogger);

  const provider = new BearerAuthProvider(config, mockLogger, trustProvider);
  
  // Run health probe which fetches discovery + token
  await provider.healthProbe();

  const headers = {};
  await provider.decorate(headers);
  assert.equal(headers['Authorization'], 'Bearer jwt-access-token-123');

  // Verify caching does not hit network again (no new intercept added, if it did it would error due to missing mock)
  const headers2 = {};
  await provider.decorate(headers2);
  assert.equal(headers2['Authorization'], 'Bearer jwt-access-token-123');
});

test('Bearer/OIDC Strategy Provider - single flight deduplication', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const aimPool = mockAgent.get('https://aim.pi.local');
  
  aimPool.intercept({
    path: '/.well-known/openid-configuration',
    method: 'GET'
  }).reply(200, {
    token_endpoint: 'https://aim.pi.local/oauth/token'
  }).persist();

  // Slow reply to check single flight deduplication
  aimPool.intercept({
    path: '/oauth/token',
    method: 'POST'
  }).reply(200, () => {
    return new Promise(resolve => {
      setTimeout(() => {
        resolve({
          access_token: 'jwt-slow-token',
          expires_in: 300
        });
      }, 50);
    });
  });

  const config = {
    PIWEBAPI_BEARER_ISSUER: 'https://aim.pi.local',
    PIWEBAPI_BEARER_CLIENT_ID: 'mcp-client',
    PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED: 'aim-secret-key',
    dispatcher: mockAgent
  };

  const trustProvider = new TrustProvider({}, mockLogger);
  const provider = new BearerAuthProvider(config, mockLogger, trustProvider);

  // Trigger two concurrent decorations
  const h1 = {};
  const h2 = {};
  await Promise.all([
    provider.decorate(h1),
    provider.decorate(h2)
  ]);

  assert.equal(h1['Authorization'], 'Bearer jwt-slow-token');
  assert.equal(h2['Authorization'], 'Bearer jwt-slow-token');
});

test('Kerberos SPNEGO Challenge Loop over undici client', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  // Mock GSSAPI calls in test context
  const mockKrbClient = {
    step: async (token) => {
      if (token === '') return 'Leg1ClientResponseToken';
      if (token === 'ServerLeg1Challenge') return 'Leg2ClientResponseToken';
      throw new Error('Unexpected token');
    },
    complete: false
  };

  const mockKerberos = {
    initializeClient: async (spn) => {
      assert.equal(spn, 'HTTP/pi-server.mcp.local');
      return mockKrbClient;
    }
  };
  overrideKerberos(mockKerberos);

  const piPool = mockAgent.get('https://pi-server.mcp.local');

  // Intercept 1: Request without credentials -> returns 401 with Negotiate challenge
  piPool.intercept({
    path: '/piwebapi/streams/test-stream/value?webIdType=IDOnly',
    method: 'GET'
  }).reply(401, 'Unauthorized', {
    headers: { 'WWW-Authenticate': 'Negotiate' }
  });

  // Intercept 2: First step ticket client -> returns 401 with continuation leg
  piPool.intercept({
    path: '/piwebapi/streams/test-stream/value?webIdType=IDOnly',
    method: 'GET',
    headers: {
      'Authorization': 'Negotiate Leg1ClientResponseToken'
    }
  }).reply(401, 'Unauthorized', {
    headers: { 'WWW-Authenticate': 'Negotiate ServerLeg1Challenge' }
  });

  // Intercept 3: Second step ticket client -> returns 200 success
  piPool.intercept({
    path: '/piwebapi/streams/test-stream/value?webIdType=IDOnly',
    method: 'GET',
    headers: {
      'Authorization': 'Negotiate Leg2ClientResponseToken'
    }
  }).reply(200, {
    Timestamp: '2026-06-28T00:00:00Z',
    Value: 99.9,
    Good: true
  });

  const config = {
    PIWEBAPI_AUTH_MODE: 'kerberos',
    PIWEBAPI_BASE_URL: 'https://pi-server.mcp.local/piwebapi',
    PIWEBAPI_KERBEROS_SPN: 'HTTP/pi-server.mcp.local',
    PIWEBAPI_REQUEST_TIMEOUT_MS: 5000,
    dispatcher: mockAgent
  };

  const trustProvider = new TrustProvider({}, mockLogger);
  const authProvider = createAuthProvider(config, mockLogger, trustProvider);
  const client = new PiWebApiClient(config, mockLogger, authProvider, trustProvider);

  const res = await client.readCurrentValue('test-stream', 'caller-identity');
  assert.equal(res.Value, 99.9);
  
  await client.close();
});

test('TLS TrustProvider - Fingerprint Pinning and checkServerIdentity', () => {
  const hash = crypto.createHash('sha256').update('test-cert-data').digest('hex');
  
  const config = {
    PIWEBAPI_TLS_VERIFY: true,
    PIWEBAPI_TLS_PIN_SHA256: hash
  };

  const trustProvider = new TrustProvider(config, mockLogger);
  const tlsOpts = trustProvider.getTlsOptions();

  assert.ok(tlsOpts.checkServerIdentity);

  // We mock a certificate that passes standard hostname check for 'localhost'
  const successCert = {
    subject: { CN: 'localhost' },
    subjectaltname: 'DNS:localhost',
    raw: Buffer.from('test-cert-data')
  };

  // Simulate verification success
  const successRes = tlsOpts.checkServerIdentity('localhost', successCert);
  assert.equal(successRes, undefined);

  // Simulate verification failure (fingerprint mismatch)
  const failCert = {
    subject: { CN: 'localhost' },
    subjectaltname: 'DNS:localhost',
    raw: Buffer.from('different-cert-data')
  };
  const failRes = tlsOpts.checkServerIdentity('localhost', failCert);
  assert.ok(failRes instanceof Error);
});

test('Authentication Policy Validator - additional rules', () => {
  // 1. HTTP and TLS verify false check
  assert.throws(
    () => validateAuthPolicy({
      MCP_TRANSPORT: 'http',
      PIWEBAPI_TLS_VERIFY: false
    }),
    (err) => err.message.includes('HTTP transport mode')
  );

  // 2. HTTP edge auth none not loopback check
  assert.throws(
    () => validateAuthPolicy({
      MCP_TRANSPORT: 'http',
      MCP_EDGE_AUTH_MODE: 'none',
      MCP_HTTP_BIND: '0.0.0.0'
    }),
    (err) => err.message.includes('loopback')
  );

  // 3. Kerberos missing SPN check
  assert.throws(
    () => validateAuthPolicy({
      PIWEBAPI_AUTH_MODE: 'kerberos'
    }),
    (err) => err.message.includes('SPN')
  );

  // 4. Bearer missing options check
  assert.throws(
    () => validateAuthPolicy({
      PIWEBAPI_AUTH_MODE: 'bearer'
    }),
    (err) => err.message.includes('PIWEBAPI_BEARER_ISSUER')
  );

  assert.throws(
    () => validateAuthPolicy({
      PIWEBAPI_AUTH_MODE: 'bearer',
      PIWEBAPI_BEARER_ISSUER: 'https://aim.pi.local'
    }),
    (err) => err.message.includes('PIWEBAPI_BEARER_CLIENT_ID')
  );

  assert.throws(
    () => validateAuthPolicy({
      PIWEBAPI_AUTH_MODE: 'bearer',
      PIWEBAPI_BEARER_ISSUER: 'https://aim.pi.local',
      PIWEBAPI_BEARER_CLIENT_ID: 'client'
    }),
    (err) => err.message.includes('secret')
  );

  // 5. Basic missing user check
  assert.throws(
    () => validateAuthPolicy({
      PIWEBAPI_AUTH_MODE: 'basic'
    }),
    (err) => err.message.includes('USER')
  );

  assert.throws(
    () => validateAuthPolicy({
      PIWEBAPI_AUTH_MODE: 'basic',
      PIWEBAPI_BASIC_USER: 'user'
    }),
    (err) => err.message.includes('password')
  );

  // 6. Anonymous checks
  assert.throws(
    () => validateAuthPolicy({
      PIWEBAPI_AUTH_MODE: 'anonymous',
      PIWEBAPI_ALLOW_ANONYMOUS: false
    }),
    (err) => err.message.includes('ALLOW_ANONYMOUS')
  );

  assert.throws(
    () => validateAuthPolicy({
      PIWEBAPI_AUTH_MODE: 'anonymous',
      PIWEBAPI_ALLOW_ANONYMOUS: true,
      MCP_READ_ONLY: false
    }),
    (err) => err.message.includes('MCP_READ_ONLY')
  );

  // 7. Write tools check
  assert.throws(
    () => validateAuthPolicy({
      MCP_WRITE_TOOLS_ENABLED: true,
      MCP_READ_ONLY: true
    }),
    (err) => err.message.includes('MCP_READ_ONLY')
  );

  assert.throws(
    () => validateAuthPolicy({
      MCP_WRITE_TOOLS_ENABLED: true,
      MCP_READ_ONLY: false,
      MCP_TRANSPORT: 'http',
      MCP_EDGE_AUTH_MODE: 'none',
      MCP_HTTP_BIND: '127.0.0.1'
    }),
    (err) => err.message.includes('Edge authentication is required')
  );

  assert.throws(
    () => validateAuthPolicy({
      MCP_WRITE_TOOLS_ENABLED: true,
      MCP_READ_ONLY: false,
      MCP_TRANSPORT: 'http',
      MCP_EDGE_AUTH_MODE: 'bearer'
    }),
    (err) => err.message.includes('MCP_EDGE_WRITE_ROLES')
  );
});

test('TLS TrustProvider - custom CA loading and SIGHUP reload', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const tls = await import('node:tls');

  const tempDir = './scratch';
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }
  const tempCertFile = path.join(tempDir, 'temp-ca.pem');
  // Simple fake self-signed cert PEM shape
  const testPem = '-----BEGIN CERTIFICATE-----\nMIIB7TCCAVagAwIBAgIUdG\n-----END CERTIFICATE-----';
  fs.writeFileSync(tempCertFile, testPem);

  const config = {
    PIWEBAPI_TLS_CA_FILE: tempCertFile,
    PIWEBAPI_TLS_CA_RELOAD: true
  };

  const trustProvider = new TrustProvider(config, mockLogger);
  const tlsOpts = trustProvider.getTlsOptions();
  
  assert.ok(tlsOpts.ca.length > tls.rootCertificates.length);

  // Simulate SIGHUP by calling internal builder or triggering signal
  process.emit('SIGHUP');

  // Clean up
  try {
    fs.unlinkSync(tempCertFile);
  } catch (_) {}
});

test('Bearer/OIDC Strategy Provider - discovery failure', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const aimPool = mockAgent.get('https://aim.pi.local');
  
  aimPool.intercept({
    path: '/.well-known/openid-configuration',
    method: 'GET'
  }).reply(500, 'Discovery failure');

  const config = {
    PIWEBAPI_BEARER_ISSUER: 'https://aim.pi.local',
    PIWEBAPI_BEARER_CLIENT_ID: 'mcp-client',
    PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED: 'aim-secret-key',
    dispatcher: mockAgent
  };

  const trustProvider = new TrustProvider({}, mockLogger);
  const provider = new BearerAuthProvider(config, mockLogger, trustProvider);

  await assert.rejects(
    async () => provider.healthProbe(),
    (err) => err.category === 'UPSTREAM_PERMANENT' && err.message.includes('discovery failed')
  );
});

test('Bearer/OIDC Strategy Provider - discovery success, token failure', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const aimPool = mockAgent.get('https://aim.pi.local');
  
  aimPool.intercept({
    path: '/.well-known/openid-configuration',
    method: 'GET'
  }).reply(200, {
    token_endpoint: 'https://aim.pi.local/oauth/token'
  }).persist();

  aimPool.intercept({
    path: '/oauth/token',
    method: 'POST'
  }).reply(400, 'Invalid client credentials');

  const config = {
    PIWEBAPI_BEARER_ISSUER: 'https://aim.pi.local',
    PIWEBAPI_BEARER_CLIENT_ID: 'mcp-client',
    PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED: 'aim-secret-key',
    dispatcher: mockAgent
  };

  const trustProvider = new TrustProvider({}, mockLogger);
  const provider = new BearerAuthProvider(config, mockLogger, trustProvider);

  await assert.rejects(
    async () => provider.healthProbe(),
    (err) => err.category === 'UPSTREAM_TRANSIENT' && err.message.includes('Failed to acquire OIDC token')
  );
});

test('Bearer/OIDC Strategy Provider - password grant fallback', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const aimPool = mockAgent.get('https://aim.pi.local');
  
  aimPool.intercept({
    path: '/.well-known/openid-configuration',
    method: 'GET'
  }).reply(200, {
    token_endpoint: 'https://aim.pi.local/oauth/token'
  }).persist();

  aimPool.intercept({
    path: '/oauth/token',
    method: 'POST',
    body: 'grant_type=password&client_id=mcp-client&client_secret=aim-secret-key&username=service-acc&password=pass-123'
  }).reply(200, {
    access_token: 'jwt-pwd-token',
    expires_in: 3600
  });

  const config = {
    PIWEBAPI_BEARER_ISSUER: 'https://aim.pi.local',
    PIWEBAPI_BEARER_CLIENT_ID: 'mcp-client',
    PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED: 'aim-secret-key',
    PIWEBAPI_BEARER_GRANT: 'password',
    PIWEBAPI_BASIC_USER: 'service-acc',
    PIWEBAPI_BASIC_PASSWORD_RESOLVED: 'pass-123',
    dispatcher: mockAgent
  };

  const trustProvider = new TrustProvider({}, mockLogger);
  const provider = new BearerAuthProvider(config, mockLogger, trustProvider);

  await provider.healthProbe();
  const headers = {};
  await provider.decorate(headers);
  assert.equal(headers['Authorization'], 'Bearer jwt-pwd-token');
});

test('KerberosAuthProvider - GSSAPI initialization and step failures', async () => {
  const mockKrbClient = {
    step: async () => {
      throw new Error('GSSAPI internal failure');
    },
    complete: false
  };
  const mockKerberos = {
    initializeClient: async () => mockKrbClient
  };
  overrideKerberos(mockKerberos);

  const config = {
    PIWEBAPI_KERBEROS_SPN: 'HTTP/pi-server.mcp.local'
  };
  const provider = new KerberosAuthProvider(config, mockLogger);
  
  await assert.rejects(
    async () => provider.createNegotiateHeader('Negotiate token-1'),
    (err) => err.category === 'UNAUTHORIZED' && err.message.includes('Kerberos ticket generation failed')
  );
});

test('EdgeAuthenticator - bad algorithm or missing kid', async () => {
  const config = {
    MCP_EDGE_AUTH_MODE: 'bearer',
    MCP_EDGE_JWKS_URL: 'https://identity.mcp.local/jwks'
  };
  const auth = new EdgeAuthenticator(config, mockLogger);

  // 1. Missing kid in token
  const noKidToken = createSignedJwt({ sub: 'user-john' }, null);
  await assert.rejects(
    async () => auth.verifyJwt(noKidToken),
    (err) => err.message.includes('missing key ID')
  );

  // 2. HS256 algorithm in token
  const hs256Token = createSignedJwt({ sub: 'user-john' }, 'test-kid-123', 'HS256');
  await assert.rejects(
    async () => auth.verifyJwt(hs256Token),
    (err) => err.message.includes('Unsupported JWT algorithm')
  );
});

test('createAuthProvider - unsupported mode', () => {
  assert.throws(
    () => createAuthProvider({ PIWEBAPI_AUTH_MODE: 'invalid' }, mockLogger, {}),
    (err) => err.category === 'INTERNAL' && err.message.includes('Unsupported')
  );
});

test('TrustProvider - file load failure', () => {
  assert.throws(
    () => new TrustProvider({ PIWEBAPI_TLS_CA_FILE: 'nonexistent-file.pem' }, mockLogger),
    (err) => err.category === 'INTERNAL' && err.message.includes('Failed to load TLS CA file')
  );
});

test('EdgeAuthenticator - header validation and invalid mode errors', async () => {
  const bearerAuth = new EdgeAuthenticator({ MCP_EDGE_AUTH_MODE: 'bearer' }, mockLogger);
  
  // Missing auth header
  await assert.rejects(
    async () => bearerAuth.authenticate({ headers: {} }),
    (err) => err.category === 'EDGE_UNAUTHENTICATED' && err.message.includes('Missing')
  );

  // Non-bearer header
  await assert.rejects(
    async () => bearerAuth.authenticate({ headers: { authorization: 'Basic 123' } }),
    (err) => err.category === 'EDGE_UNAUTHENTICATED' && err.message.includes('malformed')
  );

  // Invalid mode
  const invalidAuth = new EdgeAuthenticator({ MCP_EDGE_AUTH_MODE: 'invalid' }, mockLogger);
  await assert.rejects(
    async () => invalidAuth.authenticate({}),
    (err) => err.category === 'EDGE_UNAUTHENTICATED' && err.message.includes('Unsupported')
  );
});

test('EdgeAuthenticator - JWKS caching validation', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const jwksPool = mockAgent.get('https://identity.mcp.local');
  
  // Register intercept that responds only once
  jwksPool.intercept({
    path: '/jwks',
    method: 'GET'
  }).reply(200, {
    keys: [testJwk]
  });

  const config = {
    MCP_EDGE_AUTH_MODE: 'bearer',
    MCP_EDGE_JWKS_URL: 'https://identity.mcp.local/jwks'
  };

  const auth = new EdgeAuthenticator(config, mockLogger);
  
  // First verify: fetches JWKS from endpoint
  const t1 = createSignedJwt({ sub: 'john', exp: Math.floor(Date.now() / 1000) + 60 });
  const c1 = await auth.verifyJwt(t1);
  assert.equal(c1.sub, 'john');

  // Second verify: resolves JWKS from cache without network query (no mock is configured for a second request, so if it queried it would throw)
  const t2 = createSignedJwt({ sub: 'doe', exp: Math.floor(Date.now() / 1000) + 60 });
  const c2 = await auth.verifyJwt(t2);
  assert.equal(c2.sub, 'doe');
});

test('BearerAuthProvider - password grant configuration missing options', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const aimPool = mockAgent.get('https://aim.pi.local');
  aimPool.intercept({
    path: '/.well-known/openid-configuration',
    method: 'GET'
  }).reply(200, {
    token_endpoint: 'https://aim.pi.local/oauth/token'
  }).persist();

  const config = {
    PIWEBAPI_BEARER_ISSUER: 'https://aim.pi.local',
    PIWEBAPI_BEARER_CLIENT_ID: 'mcp-client',
    PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED: 'aim-secret-key',
    PIWEBAPI_BEARER_GRANT: 'password',
    dispatcher: mockAgent
  };
  const trustProvider = new TrustProvider({}, mockLogger);
  const provider = new BearerAuthProvider(config, mockLogger, trustProvider);

  // Triggering fetch token directly should throw configuration error
  await assert.rejects(
    async () => provider.healthProbe(),
    (err) => err.category === 'INTERNAL' && err.message.includes('required for password grant')
  );
});

test('BearerAuthProvider - challenge callback invalidation', async () => {
  const config = {
    PIWEBAPI_BEARER_ISSUER: 'https://aim.pi.local',
    PIWEBAPI_BEARER_CLIENT_ID: 'mcp-client',
    PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED: 'aim-secret-key'
  };
  const trustProvider = new TrustProvider({}, mockLogger);
  const provider = new BearerAuthProvider(config, mockLogger, trustProvider);

  const shouldRetry = await provider.onChallenge();
  assert.equal(shouldRetry, true);
});

test('EdgeAuthenticator - missing exp claim and nbf check', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const jwksPool = mockAgent.get('https://identity.mcp.local');
  jwksPool.intercept({
    path: '/jwks',
    method: 'GET'
  }).reply(200, {
    keys: [testJwk]
  }).persist();

  const config = {
    MCP_EDGE_AUTH_MODE: 'bearer',
    MCP_EDGE_JWKS_URL: 'https://identity.mcp.local/jwks'
  };
  const auth = new EdgeAuthenticator(config, mockLogger);

  // JWT with missing exp
  const noExpToken = createSignedJwt({ sub: 'user-john' });
  const req1 = { headers: { authorization: `Bearer ${noExpToken}` } };
  await assert.rejects(
    async () => auth.authenticate(req1),
    (err) => err.message.includes('missing expiration claim')
  );

  // JWT with inactive nbf
  const now = Math.floor(Date.now() / 1000);
  const inactiveToken = createSignedJwt({
    sub: 'user-john',
    exp: now + 3600,
    nbf: now + 60
  });
  const req2 = { headers: { authorization: `Bearer ${inactiveToken}` } };
  await assert.rejects(
    async () => auth.authenticate(req2),
    (err) => err.message.includes('not active yet')
  );
});

test('EdgeAuthenticator - JWKS fetch cooldown', async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const jwksPool = mockAgent.get('https://identity.mcp.local');
  
  jwksPool.intercept({
    path: '/jwks',
    method: 'GET'
  }).reply(200, {
    keys: [testJwk]
  });

  const config = {
    MCP_EDGE_AUTH_MODE: 'bearer',
    MCP_EDGE_JWKS_URL: 'https://identity.mcp.local/jwks'
  };

  const auth = new EdgeAuthenticator(config, mockLogger);
  
  const now = Math.floor(Date.now() / 1000);
  const t1 = createSignedJwt({ sub: 'john', exp: now + 60 });
  await auth.verifyJwt(t1);

  const t2 = createSignedJwt({ sub: 'doe', exp: now + 60 }, 'non-existent-kid-abc');
  await assert.rejects(
    async () => auth.verifyJwt(t2),
    (err) => err.message.includes('not found in JWKS')
  );
});

test('EdgeRateLimiter - memory exhaustion protection size cap and cleanup delete', async () => {
  const limiter = new EdgeRateLimiter(10, 1000);

  // Add 10000 callers to trigger capacity check
  for (let i = 0; i < 10000; i++) {
    limiter.checkLimit(`caller-${i}`);
  }

  assert.throws(
    () => limiter.checkLimit('new-caller-10001'),
    (err) => err.message.includes('capacity exceeded')
  );

  // Test cleanup deleting expired entries
  const shortLimiter = new EdgeRateLimiter(10, 2);
  shortLimiter.checkLimit('caller-temp');
  await new Promise(resolve => setTimeout(resolve, 5));
  shortLimiter.cleanup();
  // Map size should now be 0 since it expired and got deleted
  shortLimiter.checkLimit('caller-temp'); // should not throw, it was deleted and restarted

  // Test single-caller limit throws error
  const limitLimiter = new EdgeRateLimiter(2, 1000);
  limitLimiter.checkLimit('caller-x');
  limitLimiter.checkLimit('caller-x');
  assert.throws(
    () => limitLimiter.checkLimit('caller-x'),
    (err) => err.category === 'RATE_LIMITED' && err.message.includes('Too many requests')
  );
});

test('TrustProvider - MTLS client certificate loading and verify setting', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const configVerifyFalse = {
    PIWEBAPI_TLS_VERIFY: false
  };
  const trust1 = new TrustProvider(configVerifyFalse, mockLogger);
  assert.equal(trust1.getTlsOptions().rejectUnauthorized, false);

  const trust2 = new TrustProvider({}, mockLogger);
  assert.equal(trust2.getTlsOptions().rejectUnauthorized, true);

  // Failure to load client cert file throws AppError
  assert.throws(
    () => new TrustProvider({ PIWEBAPI_CLIENT_CERT_FILE: 'nonexistent-cert.pem' }, mockLogger),
    (err) => err.category === 'INTERNAL' && err.message.includes('Failed to load TLS client cert')
  );

  // Success path loading cert and mapping key
  const tempCertFile = path.resolve('test-temp-client-cert.pem');
  fs.writeFileSync(tempCertFile, 'cert-data-xyz');
  try {
    const configCert = {
      PIWEBAPI_CLIENT_CERT_FILE: tempCertFile,
      PIWEBAPI_CLIENT_CERT_KEY_RESOLVED: 'client-key-data-123'
    };
    const trust3 = new TrustProvider(configCert, mockLogger);
    const opts = trust3.getTlsOptions();
    assert.equal(opts.cert, 'cert-data-xyz');
    assert.equal(opts.key, 'client-key-data-123');
  } finally {
    if (fs.existsSync(tempCertFile)) {
      fs.unlinkSync(tempCertFile);
    }
  }
});


