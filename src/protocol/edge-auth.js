import crypto from 'node:crypto';
import { request } from 'undici';
import { AppError, ErrorCategory } from '../errors/error-model.js';

export class EdgeAuthenticator {
  #config;
  #logger;
  #jwksCache;
  #jwksTimestamp;
  #jwksPromise;

  constructor(config, logger) {
    this.#config = config;
    this.#logger = logger;
    this.#jwksCache = null;
    this.#jwksTimestamp = 0;
    this.#jwksPromise = null;
  }

  async authenticate(req) {
    const mode = this.#config.MCP_EDGE_AUTH_MODE || 'none';

    if (mode === 'none') {
      return { user: 'anonymous', roles: [] };
    }

    if (mode === 'mtls') {
      const cert = req.socket.getPeerCertificate();
      if (!cert || !req.socket.authorized) {
        throw new AppError({
          category: ErrorCategory.EDGE_UNAUTHENTICATED,
          retryable: false,
          message: 'Client certificate authentication failed or not provided'
        });
      }
      
      const subject = cert.subject?.CN || 'client-cert';
      // Least privilege: a valid client cert is read-only unless the operator
      // explicitly grants more via MCP_EDGE_MTLS_ROLES (e.g. "read,write").
      const roles = this.#config.MCP_EDGE_MTLS_ROLES
        ? this.#config.MCP_EDGE_MTLS_ROLES.split(',').map(r => r.trim()).filter(Boolean)
        : ['read'];
      return { user: subject, roles };
    }

    if (mode === 'bearer') {
      const authHeader = req.headers.authorization || req.headers.Authorization;
      if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
        throw new AppError({
          category: ErrorCategory.EDGE_UNAUTHENTICATED,
          retryable: false,
          message: 'Missing or malformed Authorization header'
        });
      }

      const token = authHeader.slice(7).trim();
      try {
        const claims = await this.verifyJwt(token);

        if (this.#config.MCP_EDGE_ISSUER && claims.iss !== this.#config.MCP_EDGE_ISSUER) {
          throw new Error('Issuer mismatch');
        }

        if (this.#config.MCP_EDGE_AUDIENCE) {
          const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
          if (!aud.includes(this.#config.MCP_EDGE_AUDIENCE)) {
            throw new Error('Audience mismatch');
          }
        }

        const now = Math.floor(Date.now() / 1000);
        if (!claims.exp) {
          throw new Error('Token is missing expiration claim (exp)');
        }
        if (now >= claims.exp) {
          throw new Error('Token has expired');
        }
        if (claims.nbf && now < claims.nbf) {
          throw new Error('Token is not active yet (nbf)');
        }

        return {
          user: claims.sub || claims.email || 'bearer-caller',
          roles: Array.isArray(claims.roles) ? claims.roles : (claims.roles ? [claims.roles] : [])
        };
      } catch (err) {
        this.#logger.warn('Inbound JWT validation failed', { error: err.message });
        throw new AppError({
          category: ErrorCategory.EDGE_UNAUTHENTICATED,
          retryable: false,
          message: `Token validation failed: ${err.message}`
        });
      }
    }

    throw new AppError({
      category: ErrorCategory.EDGE_UNAUTHENTICATED,
      retryable: false,
      message: `Unsupported edge authentication mode: ${mode}`
    });
  }

  async verifyJwt(token) {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('JWT must have exactly 3 parts');
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

    if (header.alg !== 'RS256') {
      throw new Error(`Unsupported JWT algorithm: ${header.alg}. Only RS256 is supported.`);
    }

    const kid = header.kid;
    if (!kid) {
      throw new Error('JWT header missing key ID (kid)');
    }

    const jwk = await this.getJwksKey(kid);
    if (!jwk) {
      throw new Error(`Key ID "${kid}" not found in JWKS`);
    }

    const publicKey = crypto.createPublicKey({
      format: 'jwk',
      key: jwk
    });

    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(`${headerB64}.${payloadB64}`);
    
    const signature = Buffer.from(signatureB64, 'base64url');
    const isValid = verify.verify(publicKey, signature);
    if (!isValid) {
      throw new Error('Invalid JWT signature');
    }

    return payload;
  }

  async getJwksKey(kid) {
    const cacheTTL = 300000; // 5 minutes
    const minFetchCooldown = 15000; // 15 seconds
    const now = Date.now();

    if (this.#jwksCache) {
      const key = this.#jwksCache.find(k => k.kid === kid);
      if (key) return key;

      // In case of cache miss, do not refetch if we did so very recently (DDoS defense)
      if (now - this.#jwksTimestamp < minFetchCooldown) {
        return null;
      }
    }

    if (!this.#jwksPromise) {
      this.#jwksPromise = this.fetchJwks().finally(() => {
        this.#jwksPromise = null;
      });
    }

    const keys = await this.#jwksPromise;
    const key = keys.find(k => k.kid === kid);
    return key || null;
  }

  async fetchJwks() {
    const jwksUrl = this.#config.MCP_EDGE_JWKS_URL;
    if (!jwksUrl) {
      throw new Error('MCP_EDGE_JWKS_URL is not configured');
    }

    this.#logger.debug('Fetching JWKS for edge validation', { url: jwksUrl });

    try {
      const response = await request(jwksUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });

      if (response.statusCode !== 200) {
        throw new Error(`JWKS endpoint returned status ${response.statusCode}`);
      }

      const data = await response.body.json();
      if (!data.keys || !Array.isArray(data.keys)) {
        throw new Error('JWKS document missing keys array');
      }

      this.#jwksCache = data.keys;
      this.#jwksTimestamp = Date.now();
      return this.#jwksCache;
    } catch (err) {
      throw new Error(`Failed to fetch JWKS: ${err.message}`);
    }
  }

  authorizeWrite(authInfo) {
    if (!this.#config.MCP_WRITE_TOOLS_ENABLED) {
      throw new AppError({
        category: ErrorCategory.WRITES_DISABLED,
        retryable: false,
        message: 'Write operations are disabled on this server'
      });
    }

    const mode = this.#config.MCP_EDGE_AUTH_MODE || 'none';
    if (mode === 'none' && this.#config.MCP_TRANSPORT === 'http') {
      throw new AppError({
        category: ErrorCategory.EDGE_FORBIDDEN,
        retryable: false,
        message: 'Write tools are disabled when edge authentication is none'
      });
    }

    if (mode === 'none') {
      return true;
    }

    const allowedRoles = this.#config.MCP_EDGE_WRITE_ROLES
      ? this.#config.MCP_EDGE_WRITE_ROLES.split(',').map(r => r.trim())
      : [];

    const callerRoles = authInfo?.roles || [];
    const hasWriteRole = callerRoles.some(role => allowedRoles.includes(role));

    if (!hasWriteRole) {
      throw new AppError({
        category: ErrorCategory.EDGE_FORBIDDEN,
        retryable: false,
        message: 'Caller is not authorized to execute write operations'
      });
    }

    return true;
  }
}
