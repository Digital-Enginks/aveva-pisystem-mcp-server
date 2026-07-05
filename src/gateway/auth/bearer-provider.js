import { Agent, request } from 'undici';
import { AuthProvider } from '../../security/auth-provider-base.js';
import { AppError, ErrorCategory } from '../../errors/error-model.js';
import { readErrorBody } from '../http-body.js';

export class BearerAuthProvider extends AuthProvider {
  #config;
  #logger;
  #tlsOptions;
  #dispatcher;
  #issuer;
  #clientId;
  #clientSecret;
  #tokenEndpoint;
  #cachedToken;
  #expiryTime; // Timestamp in ms
  #tokenPromise;

  constructor(config, logger, trustProvider) {
    super();
    this.#config = config;
    this.#logger = logger;
    this.#tlsOptions = trustProvider.getTlsOptions();
    this.#dispatcher = config.dispatcher || new Agent({ connect: this.#tlsOptions });

    this.#issuer = config.PIWEBAPI_BEARER_ISSUER;
    this.#clientId = config.PIWEBAPI_BEARER_CLIENT_ID;
    this.#clientSecret = config.PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED;

    this.#cachedToken = null;
    this.#expiryTime = 0;
    this.#tokenPromise = null;
  }

  async #discover() {
    if (this.#tokenEndpoint) return;

    const discoveryUrl = new URL('.well-known/openid-configuration', this.#issuer).toString();
    this.#logger.debug('Fetching OIDC discovery configuration', { url: discoveryUrl });

    try {
      const response = await request(discoveryUrl, {
        method: 'GET',
        dispatcher: this.#dispatcher,
        headers: {
          'Accept': 'application/json'
        }
      });

      if (response.statusCode !== 200) {
        throw new Error(`Discovery endpoint returned status ${response.statusCode}`);
      }

      const data = await response.body.json();
      if (!data.token_endpoint) {
        throw new Error('OIDC discovery document missing token_endpoint');
      }

      this.#tokenEndpoint = data.token_endpoint;
      this.#logger.debug('OIDC token endpoint discovered', { endpoint: this.#tokenEndpoint });
    } catch (err) {
      throw new AppError({
        category: ErrorCategory.UPSTREAM_PERMANENT,
        retryable: false,
        message: `OIDC discovery failed for issuer ${this.#issuer}: ${err.message}`
      });
    }
  }

  async #fetchToken() {
    await this.#discover();

    const params = new URLSearchParams();
    const grantType = this.#config.PIWEBAPI_BEARER_GRANT || 'client_credentials';
    params.append('grant_type', grantType);
    params.append('client_id', this.#clientId);
    params.append('client_secret', this.#clientSecret);

    if (this.#config.PIWEBAPI_BEARER_SCOPE) {
      params.append('scope', this.#config.PIWEBAPI_BEARER_SCOPE);
    }
    if (this.#config.PIWEBAPI_BEARER_AUDIENCE) {
      params.append('audience', this.#config.PIWEBAPI_BEARER_AUDIENCE);
      params.append('resource', this.#config.PIWEBAPI_BEARER_AUDIENCE); // Contingency resource param
    }

    if (grantType === 'password') {
      if (!this.#config.PIWEBAPI_BASIC_USER || !this.#config.PIWEBAPI_BASIC_PASSWORD_RESOLVED) {
        throw new AppError({
          category: ErrorCategory.INTERNAL,
          retryable: false,
          message: 'Basic user and password configuration are required for password grant fallback'
        });
      }
      params.append('username', this.#config.PIWEBAPI_BASIC_USER);
      params.append('password', this.#config.PIWEBAPI_BASIC_PASSWORD_RESOLVED);
    }

    this.#logger.debug('Requesting Bearer token from OIDC provider', { grantType, endpoint: this.#tokenEndpoint });

    try {
      const response = await request(this.#tokenEndpoint, {
        method: 'POST',
        dispatcher: this.#dispatcher,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: params.toString()
      });

      if (response.statusCode !== 200) {
        const bodyText = await readErrorBody(response.body);
        throw new Error(`Token endpoint returned status ${response.statusCode}: ${bodyText}`);
      }

      const data = await response.body.json();
      if (!data.access_token) {
        throw new Error('Token response missing access_token');
      }

      const expiresIn = data.expires_in || 3600; // Default 1 hour
      this.#cachedToken = data.access_token;
      this.#expiryTime = Date.now() + (expiresIn * 1000);

      this.#logger.debug('Successfully acquired OIDC token', { expiresInSeconds: expiresIn });
      return this.#cachedToken;
    } catch (err) {
      throw new AppError({
        category: ErrorCategory.UPSTREAM_TRANSIENT,
        retryable: true,
        message: `Failed to acquire OIDC token: ${err.message}`
      });
    }
  }

  async #getOrRefreshToken() {
    const skew = (this.#config.PIWEBAPI_BEARER_SKEW_SEC || 60) * 1000;
    const lead = (this.#config.PIWEBAPI_BEARER_REFRESH_LEAD_SEC || 30) * 1000;
    const now = Date.now();

    // 1. Token is expired or in skew window (or does not exist yet) -> Block and fetch
    if (!this.#cachedToken || now >= this.#expiryTime - skew) {
      if (!this.#tokenPromise) {
        this.#tokenPromise = this.#fetchToken().finally(() => {
          this.#tokenPromise = null;
        });
      }
      return this.#tokenPromise;
    }

    // 2. Token is still valid, but within the proactive refresh window -> Trigger background fetch (non-blocking)
    if (now >= this.#expiryTime - skew - lead) {
      if (!this.#tokenPromise) {
        this.#logger.debug('Proactive OIDC token refresh triggered');
        this.#tokenPromise = this.#fetchToken().finally(() => {
          this.#tokenPromise = null;
        });
        // Catch background errors so they don't bubble out to the current request
        this.#tokenPromise.catch(err => {
          this.#logger.warn('Background OIDC token refresh failed', { error: err.message });
        });
      }
    }

    return this.#cachedToken;
  }

  async decorate(headers) {
    const token = await this.#getOrRefreshToken();
    headers['Authorization'] = `Bearer ${token}`;
  }

  async onChallenge(req, response) {
    // If we received a 401 with Bearer token, our token may have been revoked or is invalid.
    // Invalidate the cache and attempt a single re-acquisition.
    this.#cachedToken = null;
    this.#expiryTime = 0;
    return true; // Request should be retried exactly once
  }

  async healthProbe() {
    await this.#discover();
    await this.#getOrRefreshToken();
    return true;
  }
}
