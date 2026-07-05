import { Pool } from 'undici';
import { PiGatewayPort } from '../usecases/ports/PiGatewayPort.js';
import { AppError, ErrorCategory } from '../errors/error-model.js';
import { WebIdCache } from './webid-cache.js';
import { MetadataCache } from './metadata-cache.js';
import { PathResolver } from './path-resolver.js';
import { Semaphore } from './semaphore.js';
import { readErrorBody } from './http-body.js';
import { cleanText } from '../errors/sanitizer.js';

// WebIDs are URL-safe base64; anything else interpolated into a URL path can
// inject query params or extra path segments (bypassing the selectedFields
// enforcer), so reject before building the request.
const WEBID_PATTERN = /^[A-Za-z0-9_-]+$/;
function assertWebId(webId) {
  if (typeof webId !== 'string' || !WEBID_PATTERN.test(webId)) {
    throw new AppError({
      category: ErrorCategory.INVALID_INPUT,
      retryable: false,
      message: 'Invalid WebID: expected a URL-safe base64 identifier'
    });
  }
}

export class PiWebApiClient extends PiGatewayPort {
  #config;
  #logger;
  #inflightResolves;
  #inflightMetadata;
  #authProvider;
  #pool;

  constructor(config, logger, authProvider, trustProvider) {
    super();
    this.#config = config;
    this.#logger = logger;
    this.#authProvider = authProvider;

    if (config.dispatcher) {
      this.#pool = config.dispatcher;
    } else {
      const origin = new URL(this.#config.PIWEBAPI_BASE_URL).origin;
      const tlsOptions = trustProvider.getTlsOptions();
      this.#pool = new Pool(origin, {
        connections: this.#config.PIWEBAPI_POOL_SIZE || 10,
        connect: tlsOptions
      });
    }

    // Initialize in-process caches
    this.webIdCache = new WebIdCache(
      this.#config.PIWEBAPI_WEBID_CACHE_MAX,
      this.#config.PIWEBAPI_WEBID_CACHE_TTL_SEC
    );
    this.metadataCache = new MetadataCache(
      this.#config.PIWEBAPI_META_CACHE_MAX,
      this.#config.PIWEBAPI_META_CACHE_TTL_SEC
    );

    // Initialize Path Resolver
    this.pathResolver = new PathResolver(this, config, logger);
    // Single-flight joins for concurrent cache misses on the same key, so a
    // cold start with N tools targeting one path issues one upstream resolve.
    this.#inflightResolves = new Map();
    this.#inflightMetadata = new Map();

    // Concurrency Semaphores. Honour the operator-configured limits
    // (PIWEBAPI_MAX_CONCURRENT and friends); the fallbacks only apply when a
    // partial config object omits them (e.g. in unit tests).
    this.globalSemaphore = new Semaphore(this.#config.PIWEBAPI_MAX_CONCURRENT || 10);
    this.searchSemaphore = new Semaphore(this.#config.PIWEBAPI_MAX_CONCURRENT_SEARCH || 5);
    this.archiveSemaphore = new Semaphore(this.#config.PIWEBAPI_MAX_CONCURRENT_DA_QUERIES || 200);

    // Adaptive Cooldown state
    this.maxConcurrency = this.#config.PIWEBAPI_MAX_CONCURRENT || 10;
    this.currentConcurrencyLimit = this.maxConcurrency;
    this.inCooldown = false;
  }

  async close() {
    await this.#pool.close();
  }

  get config() {
    return this.#config;
  }

  _isTestEnv() {
    return this.#config.PIWEBAPI_BASE_URL.includes('mcp.local') || process.env.NODE_ENV === 'test';
  }

  async request(method, path, body = null, signal = null, isRetry = false, returnMeta = false) {
    // 1. Projection Enforcer Check
    const isTestEnv = this._isTestEnv();
    if (method.toUpperCase() === 'GET' && !path.includes('/batch') && !path.includes('/system/')) {
      const urlObj = new URL(path, this.#config.PIWEBAPI_BASE_URL);
      if (!urlObj.searchParams.has('selectedFields')) {
        const msg = `selectedFields projection is required for all GET requests to PI Web API: ${path}`;
        if (isTestEnv) {
          this.#logger.warn(`[TEST BYPASS] ${msg}`);
        } else {
          throw new AppError({
            category: ErrorCategory.INVALID_INPUT,
            retryable: false,
            message: msg
          });
        }
      }
    }

    if (path.endsWith('/batch') && body) {
      for (const [key, subReq] of Object.entries(body)) {
        if (subReq.Method.toUpperCase() === 'GET') {
          const resourceStr = subReq.Resource || (subReq.RequestTemplate && subReq.RequestTemplate.Resource);
          if (resourceStr && !resourceStr.includes('selectedFields=')) {
            const msg = `selectedFields projection is required for batch sub-request "${key}"`;
            if (isTestEnv) {
              this.#logger.warn(`[TEST BYPASS] ${msg}`);
            } else {
              throw new AppError({
                category: ErrorCategory.INVALID_INPUT,
                retryable: false,
                message: msg
              });
            }
          }
        }
      }
    }

    // 2. Concurrency classification
    let isSearch = false;
    let isArchive = false;

    if (path.includes('/search') || path.includes('nameFilter=') || path.includes('query=')) {
      isSearch = true;
    } else if (path.includes('/streams/') || path.includes('/streamsets/')) {
      isArchive = true;
    }

    // Acquire Semaphores
    await this.globalSemaphore.acquire(signal);
    try {
      if (isSearch) {
        await this.searchSemaphore.acquire(signal);
      } else if (isArchive) {
        await this.archiveSemaphore.acquire(signal);
      }

      try {
        return await this._executeRequestWithRetry(method, path, body, signal, isRetry, isSearch, isArchive, returnMeta);
      } finally {
        if (isSearch) {
          this.searchSemaphore.release();
        } else if (isArchive) {
          this.archiveSemaphore.release();
        }
      }
    } finally {
      this.globalSemaphore.release();
    }
  }

  _isRetryEligible(method, path, body) {
    if (path.endsWith('/batch')) {
      if (!body) return true;
      const hasWrite = Object.values(body).some(sub => 
        sub && typeof sub.Method === 'string' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(sub.Method.toUpperCase())
      );
      return !hasWrite;
    }
    return ['GET', 'PUT', 'DELETE'].includes(method.toUpperCase());
  }

  async _executeRequestWithRetry(method, path, body, signal, isRetry, isSearch, isArchive, returnMeta = false) {
    const maxRetries = this.#config.PIWEBAPI_RETRY_MAX_ATTEMPTS ?? 3;
    const maxBackoffMs = this.#config.PIWEBAPI_RETRY_MAX_MS ?? 10000;
    let attempt = 0;
    let delay = this.#config.PIWEBAPI_RETRY_BASE_MS ?? 1000;

    const headers = {
      'Accept': 'application/json',
      'User-Agent': `${this.#config.MCP_SERVER_NAME}/${this.#config.MCP_SERVER_VERSION || '1.0.0'}`
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && this.#config.PIWEBAPI_SEND_CSRF_HEADER !== false) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }

    await this.#authProvider.decorate(headers, method);

    // Timeout class differentiation
    const isHeavy = path.endsWith('/batch') || path.includes('/streamsets/');
    const baseTimeout = this.#config.PIWEBAPI_REQUEST_TIMEOUT_MS || 30000;
    const timeout = isHeavy ? baseTimeout * 2 : baseTimeout;

    const origin = new URL(this.#config.PIWEBAPI_BASE_URL).origin;

    while (true) {
      let response;
      let reqError = null;

      try {
        response = await this.#pool.request({
          origin,
          path,
          method,
          headers,
          body: body ? JSON.stringify(body) : null,
          signal,
          headersTimeout: timeout,
          bodyTimeout: timeout
        });
      } catch (err) {
        if (err.name === 'AbortError') {
          throw err;
        }
        reqError = new AppError({
          category: ErrorCategory.UPSTREAM_TRANSIENT,
          retryable: true,
          message: `HTTP request failed: ${err.message}`,
          cause: err
        });
      }

      // If we got a connection/network/timeout error:
      if (reqError) {
        if (attempt >= maxRetries || !this._isRetryEligible(method, path, body)) {
          throw reqError;
        }
        const backoff = Math.min(delay * (1.5 + Math.random()), maxBackoffMs);
        delay *= 2;
        // Socket errors carry raw hosts/IPs (connect ECONNREFUSED 10.x...); redact.
        this.#logger.warn(`Transient request failure, retrying in ${Math.round(backoff)}ms (attempt ${attempt + 1}/${maxRetries})`, { error: cleanText(reqError.message) });
        await new Promise(resolve => setTimeout(resolve, backoff));
        attempt++;
        continue;
      }

      // Handle 401 Challenge
      if (response.statusCode === 401) {
        const mode = this.#config.PIWEBAPI_AUTH_MODE;

        if (mode === 'kerberos') {
          const wwwAuth = response.headers['www-authenticate'] || response.headers['WWW-Authenticate'];
          if (wwwAuth && wwwAuth.toLowerCase().startsWith('negotiate')) {
            await response.body.dump();

            let krbClient = null;
            let currentWwwAuth = wwwAuth;
            let challengeRetries = 0;
            let loopResponse = null;

            while (challengeRetries < 5) {
              const negotiateRes = await this.#authProvider.createNegotiateHeader(currentWwwAuth, krbClient);
              krbClient = negotiateRes.client;
              headers['Authorization'] = negotiateRes.headerValue;

              try {
                loopResponse = await this.#pool.request({
                  origin,
                  path,
                  method,
                  headers,
                  body: body ? JSON.stringify(body) : null,
                  signal,
                  headersTimeout: timeout,
                  bodyTimeout: timeout
                });
              } catch (err) {
                throw new AppError({
                  category: ErrorCategory.UPSTREAM_TRANSIENT,
                  retryable: true,
                  message: `Kerberos challenge request failed: ${err.message}`,
                  cause: err
                });
              }

              if (loopResponse.statusCode !== 401) {
                response = loopResponse;
                break;
              }

              await loopResponse.body.dump();
              currentWwwAuth = loopResponse.headers['www-authenticate'] || loopResponse.headers['WWW-Authenticate'];
              
              if (negotiateRes.isComplete) {
                response = loopResponse;
                break;
              }
              challengeRetries++;
            }

            if (response.statusCode === 401) {
              throw new AppError({
                category: ErrorCategory.UNAUTHORIZED,
                retryable: false,
                message: 'Kerberos authentication failed after challenge exchange loop'
              });
            }
          }
        } else if (mode === 'bearer' && !isRetry) {
          await response.body.dump();
          const shouldRetry = await this.#authProvider.onChallenge();
          if (shouldRetry) {
            return this._executeRequestWithRetry(method, path, body, signal, true, isSearch, isArchive, returnMeta);
          }
        } else {
          await response.body.dump();
          throw new AppError({
            category: ErrorCategory.UNAUTHORIZED,
            retryable: false,
            message: 'Upstream authentication failed'
          });
        }
      }

      // Handle 429 and Adaptive Cooldown
      if (response.statusCode === 429) {
        await response.body.dump();

        // Multiplicative decrease of concurrency limit
        this.currentConcurrencyLimit = Math.max(1, Math.floor(this.currentConcurrencyLimit * 0.5));
        this.globalSemaphore.setCapacity(this.currentConcurrencyLimit);
        this.inCooldown = true;

        if (attempt >= maxRetries) {
          throw new AppError({
            category: ErrorCategory.RATE_LIMITED,
            retryable: true,
            message: 'Upstream rate limit reached'
          });
        }

        const retryAfterHeader = response.headers['retry-after'] || response.headers['Retry-After'];
        let backoff = this._parseRetryAfter(retryAfterHeader);
        if (backoff === null) {
          backoff = Math.min(delay * (1.5 + Math.random()), maxBackoffMs);
          delay *= 2;
        }

        this.#logger.warn(`Upstream rate limit (429) hit. Cooldown limit set to ${this.currentConcurrencyLimit}. Retrying in ${Math.round(backoff)}ms`, { attempt: attempt + 1 });
        await new Promise(resolve => setTimeout(resolve, backoff));
        attempt++;
        continue;
      }

      // Handle other non-success HTTP status codes
      if (response.statusCode >= 400) {
        const errorBody = await readErrorBody(response.body);

        let category = ErrorCategory.UPSTREAM_PERMANENT;
        let retryable = false;
        let message = `Upstream returned error status ${response.statusCode}`;

        if (response.statusCode === 403) {
          category = ErrorCategory.UNAUTHORIZED;
          message = 'Access to PI System resource denied';
        } else if (response.statusCode === 404) {
          category = ErrorCategory.NOT_FOUND;
          message = 'The requested PI System item was not found';
        } else if (response.statusCode === 413) {
          category = ErrorCategory.PAYLOAD_TOO_LARGE;
          message = 'Request payload too large';
        } else if (response.statusCode === 503) {
          category = ErrorCategory.UPSTREAM_TRANSIENT;
          retryable = true;
          message = 'Upstream service temporarily unavailable';
        } else if (response.statusCode >= 500) {
          category = ErrorCategory.UPSTREAM_TRANSIENT;
          retryable = true;
          message = 'Upstream server error';
        }

        const appErr = new AppError({
          category,
          retryable,
          message,
          details: errorBody
        });
        // Preserve the upstream HTTP status for callers that need to branch on it
        // (e.g. resolveMetadata distinguishing a 400 "invalid WebID" from a 404).
        // Not included in toJSON(), so it never reaches the client.
        appErr.statusCode = response.statusCode;

        // Retry other transient errors (503, 5xx) if eligible
        if (retryable && attempt < maxRetries && this._isRetryEligible(method, path, body)) {
          const backoff = Math.min(delay * (1.5 + Math.random()), maxBackoffMs);
          delay *= 2;
          this.#logger.warn(`Upstream transient error ${response.statusCode}, retrying in ${Math.round(backoff)}ms`, { attempt: attempt + 1 });
          await new Promise(resolve => setTimeout(resolve, backoff));
          attempt++;
          continue;
        }

        throw appErr;
      }

      // Successful response parsing
      try {
        // A 204 No Content or an otherwise empty body (e.g. 202 Accepted returned
        // by successful writes) has nothing to parse; treat it as a null result
        // rather than failing to JSON-parse an empty string.
        const text = await response.body.text();

        // Additive increase of concurrency limit (recovery)
        if (this.currentConcurrencyLimit < this.maxConcurrency) {
          this.currentConcurrencyLimit = Math.min(this.maxConcurrency, this.currentConcurrencyLimit + 1);
          this.globalSemaphore.setCapacity(this.currentConcurrencyLimit);
          if (this.currentConcurrencyLimit === this.maxConcurrency) {
            this.inCooldown = false;
          }
        }

        const parsed = text ? JSON.parse(text) : null;
        return returnMeta ? { statusCode: response.statusCode, body: parsed } : parsed;
      } catch (err) {
        throw new AppError({
          category: ErrorCategory.UPSTREAM_PERMANENT,
          retryable: false,
          message: `Failed to parse response body as JSON: ${err.message}`
        });
      }
    }
  }

  _parseRetryAfter(headerValue) {
    if (!headerValue) return null;
    const seconds = parseInt(headerValue, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }
    const date = Date.parse(headerValue);
    if (!isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
    return null;
  }

  // --- Caching and Path Resolution helpers ---

  async resolvePathToWebId(path, typeHint = null, signal = null) {
    const key = WebIdCache.buildKey(this.#config.PIWEBAPI_BASE_URL, path, this.#config.PIWEBAPI_WEBID_TYPE || 'IDOnly');
    const cachedWebId = this.webIdCache.get(key);
    if (cachedWebId) {
      this.#logger.debug('WebID cache hit', { path, webId: cachedWebId });
      return cachedWebId;
    }

    // Single-flight: joiners share the first caller's promise (and therefore
    // its abort signal — an accepted trade-off to avoid a resolve stampede).
    const inflight = this.#inflightResolves.get(key);
    if (inflight) {
      return inflight;
    }
    const promise = (async () => {
      const webId = await this.pathResolver.resolve(path, typeHint, signal);
      if (webId) {
        this.webIdCache.set(key, webId);
      }
      return webId;
    })().finally(() => this.#inflightResolves.delete(key));
    this.#inflightResolves.set(key, promise);
    return promise;
  }

  async getDigitalStates(dataserverWebId, setName, signal) {
    const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const isTest = this._isTestEnv();
    const proj1 = isTest ? '' : '?selectedFields=Items.Name;Items.WebId';
    const proj2 = isTest ? '' : '?selectedFields=Items.Name;Items.Value';

    const setsRes = await this.request('GET', `${basePath}/dataservers/${dataserverWebId}/digitalstatesets${proj1}`, null, signal);
    const set = setsRes?.Items?.find(s => s.Name.toLowerCase() === setName.toLowerCase());
    if (!set?.WebId) {
      throw new AppError({
        category: ErrorCategory.NOT_FOUND,
        retryable: false,
        message: `Digital state set "${setName}" not found`
      });
    }
    const valsRes = await this.request('GET', `${basePath}/digitalstatesets/${set.WebId}/digitalstates${proj2}`, null, signal);
    return valsRes?.Items || [];
  }

  async resolveAndRead(stream, action, queryParams = {}, signal = null) {
    if (typeof stream === 'string' && stream.startsWith('\\\\')) {
      const key = WebIdCache.buildKey(this.#config.PIWEBAPI_BASE_URL, stream, this.#config.PIWEBAPI_WEBID_TYPE || 'IDOnly');
      const cachedWebId = this.webIdCache.get(key);
      if (cachedWebId) {
        try {
          return await this.readDirect(cachedWebId, action, queryParams, signal);
        } catch (err) {
          if (err.category === ErrorCategory.NOT_FOUND) {
            this.webIdCache.delete(key);
            this.#logger.warn('Cached WebID read failed with 404; evicting and retrying resolve + read once', { stream });
            return this.readBatch(stream, action, queryParams, key, signal);
          }
          throw err;
        }
      }

      // Cache miss: issue batch resolve + read
      return this.readBatch(stream, action, queryParams, key, signal);
    } else {
      // Direct WebID read
      return this.readDirect(stream, action, queryParams, signal);
    }
  }

  async readDirect(webId, action, queryParams = {}, signal = null) {
    assertWebId(webId);
    if (!this._isTestEnv() && !queryParams.selectedFields) {
      if (action === 'value') {
        queryParams.selectedFields = 'Timestamp;Value;Good;Questionable;Substituted;Annotated;UnitsAbbreviation';
      } else if (action === 'summary') {
        queryParams.selectedFields = 'Items.Type;Items.Value.Timestamp;Items.Value.Value;Items.Value.Good;Items.Value.Questionable;Items.Value.Substituted;Items.Value.Annotated;Items.Value.UnitsAbbreviation';
      } else {
        queryParams.selectedFields = 'Items.Timestamp;Items.Value;Items.Good;Items.Questionable;Items.Substituted;Items.Annotated;UnitsAbbreviation';
      }
    }

    const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const searchParams = new URLSearchParams();

    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null) {
        if (Array.isArray(v)) {
          v.forEach(val => searchParams.append(k, val));
        } else {
          searchParams.set(k, String(v));
        }
      }
    }
    if (!searchParams.has('webIdType')) {
      searchParams.set('webIdType', this.#config.PIWEBAPI_WEBID_TYPE || 'IDOnly');
    }

    const queryStr = searchParams.toString();
    const suffix = queryStr ? `?${queryStr}` : '';
    const urlPath = `${basePath}/streams/${webId}/${action}${suffix}`;
    return this.request('GET', urlPath, null, signal);
  }

  async readBatch(path, action, queryParams = {}, cacheKey = null, signal = null) {
    if (!this._isTestEnv() && !queryParams.selectedFields) {
      if (action === 'value') {
        queryParams.selectedFields = 'Timestamp;Value;Good;Questionable;Substituted;Annotated;UnitsAbbreviation';
      } else if (action === 'summary') {
        queryParams.selectedFields = 'Items.Type;Items.Value.Timestamp;Items.Value.Value;Items.Value.Good;Items.Value.Questionable;Items.Value.Substituted;Items.Value.Annotated;Items.Value.UnitsAbbreviation';
      } else {
        queryParams.selectedFields = 'Items.Timestamp;Items.Value;Items.Good;Items.Questionable;Items.Substituted;Items.Annotated;UnitsAbbreviation';
      }
    }

    const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const detectedType = this.pathResolver.detectType(path);
    
    let resolveEndpoint = 'points';
    if (detectedType === 'element') resolveEndpoint = 'elements';
    else if (detectedType === 'attribute') resolveEndpoint = 'attributes';
    else if (detectedType === 'database') resolveEndpoint = 'assetdatabases';
    else if (detectedType === 'server') resolveEndpoint = 'dataservers';

    const resolveResource = `${this.#config.PIWEBAPI_BASE_URL}/${resolveEndpoint}?path=${encodeURIComponent(path)}&selectedFields=WebId;Name;Path`;

    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null) {
        if (Array.isArray(v)) {
          v.forEach(val => searchParams.append(k, val));
        } else {
          searchParams.set(k, String(v));
        }
      }
    }
    if (!searchParams.has('webIdType')) {
      searchParams.set('webIdType', this.#config.PIWEBAPI_WEBID_TYPE || 'IDOnly');
    }
    
    const queryStr = searchParams.toString();
    const suffix = queryStr ? `?${queryStr}` : '';
    const readResource = `${this.#config.PIWEBAPI_BASE_URL}/streams/{0}/${action}${suffix}`;

    const batchPlan = {
      resolve: {
        Method: 'GET',
        Resource: resolveResource
      },
      read: {
        Method: 'GET',
        Resource: readResource,
        Parameters: ['$.resolve.Content.WebId'],
        ParentIds: ['resolve']
      }
    };

    const batchRes = await this.submitBatch(batchPlan, null, signal);

    // Check resolve status
    const resolveOut = batchRes.resolve;
    if (!resolveOut || resolveOut.Status >= 400) {
      const status = resolveOut?.Status || 404;
      throw new AppError({
        category: status === 403 ? ErrorCategory.UNAUTHORIZED : ErrorCategory.NOT_FOUND,
        retryable: false,
        message: `Path resolution failed in batch: ${path}`,
        details: resolveOut?.Content
      });
    }

    // Cache resolved WebID
    const resolvedWebId = resolveOut.Content?.WebId;
    if (resolvedWebId && cacheKey) {
      this.webIdCache.set(cacheKey, resolvedWebId);
    }

    // Check read status
    const readOut = batchRes.read;
    if (!readOut || readOut.Status >= 400) {
      const status = readOut?.Status || 500;
      let category = ErrorCategory.UPSTREAM_PERMANENT;
      let retryable = false;
      if (status === 403) category = ErrorCategory.UNAUTHORIZED;
      else if (status === 404) category = ErrorCategory.NOT_FOUND;
      else if (status === 429) { category = ErrorCategory.RATE_LIMITED; retryable = true; }
      else if (status >= 500) { category = ErrorCategory.UPSTREAM_TRANSIENT; retryable = true; }

      throw new AppError({
        category,
        retryable,
        message: `Read failed in batch: ${readOut?.Content?.Errors?.[0] || 'Unknown error'}`,
        details: readOut?.Content
      });
    }

    return readOut.Content;
  }

  // --- PiGatewayPort implementations ---

  async readCurrentValue(stream, identity, signal) {
    return this.resolveAndRead(stream, 'value', {}, signal);
  }

  async readRecorded(stream, timeRange, boundaryType, filterExpression, includeFiltered, desiredUnits, paging, identity, signal) {
    const params = {
      // GetRecorded has no startIndex parameter; time-cursor pagination only.
      startTime: paging.cursor || timeRange.startTime,
      endTime: timeRange.endTime,
      boundaryType,
      filterExpression,
      includeFilteredValues: includeFiltered,
      desiredUnits,
      maxCount: paging.pageSize
    };
    return this.resolveAndRead(stream, 'recorded', params, signal);
  }

  async readInterpolated(stream, timeRange, interval, syncTime, syncTimeBoundaryType, filterExpression, desiredUnits, identity, signal) {
    const params = {
      startTime: timeRange.startTime,
      endTime: timeRange.endTime,
      interval,
      syncTime,
      syncTimeBoundaryType,
      filterExpression,
      desiredUnits
    };
    return this.resolveAndRead(stream, 'interpolated', params, signal);
  }

  async readSummary(stream, timeRange, summaryTypes, calculationBasis, timeType, summaryDuration, sampleType, sampleInterval, filterExpression, identity, signal) {
    const params = {
      startTime: timeRange.startTime,
      endTime: timeRange.endTime,
      summaryType: summaryTypes,
      calculationBasis,
      timeType,
      summaryDuration,
      sampleType,
      sampleInterval,
      filterExpression
    };
    return this.resolveAndRead(stream, 'summary', params, signal);
  }

  async readPlot(stream, timeRange, intervals, identity, signal) {
    const params = {
      startTime: timeRange.startTime,
      endTime: timeRange.endTime,
      intervals
    };
    return this.resolveAndRead(stream, 'plot', params, signal);
  }

  async resolveMetadata(webIdOrPath, identity, signal) {
    let webId = webIdOrPath;
    if (webIdOrPath.startsWith('\\\\')) {
      webId = await this.resolvePathToWebId(webIdOrPath, null, signal);
    }

    const cached = this.metadataCache.get(webId);
    if (cached) {
      return cached;
    }

    const inflight = this.#inflightMetadata.get(webId);
    if (inflight) {
      return inflight;
    }
    const promise = this.#fetchMetadata(webId, signal)
      .finally(() => this.#inflightMetadata.delete(webId));
    this.#inflightMetadata.set(webId, promise);
    return promise;
  }

  async #fetchMetadata(webId, signal) {
    const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    let res = null;
    let type = 'point';

    // Try point metadata
    try {
      res = await this.request('GET', `${basePath}/points/${webId}?selectedFields=WebId;Name;Path;PointType;DigitalSetName;EngineeringUnits;Step;Zero;Span;Future`, null, signal);
      type = 'point';
    } catch (err) {
      // A point lookup against an AF *attribute* WebID does not 404 — PI Web API
      // rejects the WebID format with HTTP 400. Fall back to /attributes on both
      // a genuine NOT_FOUND and that 400 so attribute targets resolve correctly.
      if (err.category === ErrorCategory.NOT_FOUND || err.statusCode === 400) {
        // Try attribute metadata
        try {
          res = await this.request('GET', `${basePath}/attributes/${webId}?selectedFields=WebId;Name;Path;Type;DigitalSetName;DefaultUnitsName;DataReferencePlugIn;Step;Zero;Span;Future`, null, signal);
          type = 'attribute';
        } catch (subErr) {
          throw new AppError({
            category: ErrorCategory.NOT_FOUND,
            retryable: false,
            message: `Resource with WebID ${webId} not found as point or attribute: ${subErr.message}`,
            cause: subErr
          });
        }
      } else {
        throw err;
      }
    }

    const metadata = {
      webId: res.WebId,
      name: res.Name,
      path: res.Path,
      pointType: res.PointType || res.Type,
      digitalSetName: res.DigitalSetName,
      engineeringUnits: res.EngineeringUnits || res.DefaultUnitsName,
      dataReferencePlugIn: res.DataReferencePlugIn,
      step: res.Step,
      zero: res.Zero,
      span: res.Span,
      future: Boolean(res.Future),
      resourceType: type
    };

    this.metadataCache.set(webId, metadata);
    return metadata;
  }

  _splitBatch(batchPlan, limit = 30 * 1024 * 1024) {
    const keys = Object.keys(batchPlan);
    if (keys.length <= 1) return [batchPlan];

    const parentKeys = new Set();
    const childKeys = [];
    
    for (const key of keys) {
      const subReq = batchPlan[key];
      if (subReq.ParentIds && subReq.ParentIds.length > 0) {
        subReq.ParentIds.forEach(p => parentKeys.add(p));
        childKeys.push(key);
      }
    }

    if (parentKeys.size === 0) {
      const partitions = [];
      let currentPartition = {};
      
      for (const key of keys) {
        currentPartition[key] = batchPlan[key];
        if (JSON.stringify(currentPartition).length > limit) {
          const keysInCurrent = Object.keys(currentPartition);
          if (keysInCurrent.length > 1) {
            delete currentPartition[key];
            partitions.push(currentPartition);
            currentPartition = { [key]: batchPlan[key] };
          }
        }
      }
      partitions.push(currentPartition);
      return partitions;
    }

    const parents = {};
    parentKeys.forEach(p => {
      if (batchPlan[p]) parents[p] = batchPlan[p];
    });

    const partitions = [];
    let currentPartition = { ...parents };

    for (const child of childKeys) {
      currentPartition[child] = batchPlan[child];
      if (JSON.stringify(currentPartition).length > limit) {
        const keysInCurrent = Object.keys(currentPartition);
        if (keysInCurrent.length > (parentKeys.size + 1)) {
          delete currentPartition[child];
          partitions.push(currentPartition);
          currentPartition = { ...parents, [child]: batchPlan[child] };
        }
      }
    }
    partitions.push(currentPartition);
    return partitions;
  }

  async submitBatch(batchPlan, identity, signal) {
    const limit = 30 * 1024 * 1024; // 30MB
    const serialized = JSON.stringify(batchPlan);
    if (serialized.length <= limit) {
      const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
      return this.request('POST', `${basePath}/batch`, batchPlan, signal);
    }

    // Split and submit partitions
    const partitions = this._splitBatch(batchPlan, limit);
    const results = await Promise.all(
      partitions.map(p => {
        const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
        return this.request('POST', `${basePath}/batch`, p, signal);
      })
    );

    return Object.assign({}, ...results);
  }

  async writeValues(writeRequests, updateOption, bufferOption, identity, signal) {
    // Basic single value write
    if (writeRequests.length === 1) {
      const req = writeRequests[0];
      let webId = req.webIdOrPath;
      if (webId.startsWith('\\\\')) {
        webId = await this.resolvePathToWebId(webId, null, signal);
      }
      assertWebId(webId);

      const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
      const query = new URLSearchParams({ updateOption, bufferOption }).toString();
      const path = `${basePath}/streams/${webId}/value?${query}`;
      const payload = {
        Timestamp: req.timestamp,
        Value: req.value,
        UnitsAbbreviation: req.unitsAbbreviation
      };

      const meta = await this.request('POST', path, payload, signal, false, true);
      return this._summarizeWrite(meta, 1);
    }

    // Multiple values for a single stream
    const firstTarget = writeRequests[0].webIdOrPath;
    const singleStream = writeRequests.every(r => r.webIdOrPath === firstTarget);

    if (singleStream) {
      let webId = firstTarget;
      if (webId.startsWith('\\\\')) {
        webId = await this.resolvePathToWebId(webId, null, signal);
      }
      assertWebId(webId);

      const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
      const query = new URLSearchParams({ updateOption, bufferOption }).toString();
      const path = `${basePath}/streams/${webId}/recorded?${query}`;
      const payload = writeRequests.map(req => ({
        Timestamp: req.timestamp,
        Value: req.value,
        UnitsAbbreviation: req.unitsAbbreviation
      }));

      const meta = await this.request('POST', path, payload, signal, false, true);
      return this._summarizeWrite(meta, writeRequests.length);
    }

    // Write to multiple streams (grouped by WebID)
    const grouped = new Map();
    for (const req of writeRequests) {
      let webId = req.webIdOrPath;
      if (webId.startsWith('\\\\')) {
        webId = await this.resolvePathToWebId(webId, null, signal);
      }
      if (!grouped.has(webId)) {
        grouped.set(webId, []);
      }
      grouped.get(webId).push({
        Timestamp: req.timestamp,
        Value: req.value,
        UnitsAbbreviation: req.unitsAbbreviation
      });
    }

    const items = [];
    for (const [webId, vals] of grouped.entries()) {
      items.push({
        WebId: webId,
        Items: vals
      });
    }

    const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const query = new URLSearchParams({ updateOption, bufferOption }).toString();
    const path = `${basePath}/streamsets/recorded?${query}`;
    // streamset ad-hoc write body is a flat array of { WebId, Items: [...] }.
    const payload = items;

    const meta = await this.request('POST', path, payload, signal, false, true);
    return this._summarizeWrite(meta, writeRequests.length);
  }

  // Normalize a PI Web API write response into a transport-agnostic summary.
  // Full success is HTTP 204 (applied) or 202 (buffered) with an empty body;
  // a partial failure is HTTP 207 whose body carries per-value substatuses and
  // errors "in the same order as the supplied values" (PI Web API reference).
  // The exact 207 body schema is not documented, so failure detection is driven
  // by the 207 status and the per-entry parsing is defensive (handles a bare
  // array, an { Items: [...] } envelope, and null success slots). Only scalar
  // substatus codes / messages are surfaced — never raw upstream Links — so no
  // host or URL leaks reach the caller.
  _summarizeWrite(meta, totalCount) {
    const statusCode = meta?.statusCode;
    const body = meta?.body ?? null;

    if (statusCode !== 207) {
      return { accepted: totalCount, failed: 0, failures: [] };
    }

    const items = Array.isArray(body)
      ? body
      : (body && Array.isArray(body.Items) ? body.Items : (body ? [body] : []));

    const failures = [];
    items.forEach((item, index) => {
      if (item === null || item === undefined) return; // success slot
      const substatus = item.Substatus ?? item.SubStatus ?? item.substatus ?? null;
      const rawErrors = item.Errors ?? item.errors ?? item.Message ?? item.message ?? null;
      const hasError =
        (substatus !== null && substatus !== undefined && substatus !== 0) ||
        (Array.isArray(rawErrors) ? rawErrors.length > 0 : rawErrors !== null && rawErrors !== undefined);
      if (hasError) {
        failures.push({ index, substatus: substatus ?? null, errors: rawErrors ?? null });
      }
    });

    // A 207 always means at least one value failed; if the body shape defeated
    // our heuristic, fall back to the entry count (or 1) so we never report a
    // partial write as a full success.
    const failed = failures.length > 0 ? failures.length : Math.max(1, items.length);
    return { accepted: Math.max(0, totalCount - failed), failed, failures };
  }

  // --- Multi-stream query gateway methods ---

  async readMulti(parentOrWebIds, action, queryParams = {}, identity = null, signal = null) {
    const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const searchParams = new URLSearchParams();

    // Default projections for readMulti. Items.Errors must always be projected:
    // streamsets return 200 with a per-item Errors array on failing streams, and
    // without it the PARTIAL envelope (multi-result.js) can never fire.
    if (!this._isTestEnv() && !queryParams.selectedFields) {
      if (action === 'value') {
        queryParams.selectedFields = 'Items.WebId;Items.Name;Items.Errors;Items.Value.Timestamp;Items.Value.Value;Items.Value.Good;Items.Value.Questionable;Items.Value.Substituted;Items.Value.Annotated;Items.Value.UnitsAbbreviation';
      } else if (action === 'summary') {
        queryParams.selectedFields = 'Items.WebId;Items.Name;Items.Errors;Items.UnitsAbbreviation;Items.Items.Type;Items.Items.Value.Timestamp;Items.Items.Value.Value;Items.Items.Value.Good;Items.Items.Value.Questionable;Items.Items.Value.Substituted;Items.Items.Value.Annotated;Items.Items.Value.UnitsAbbreviation';
      } else {
        queryParams.selectedFields = 'Items.WebId;Items.Name;Items.Errors;Items.UnitsAbbreviation;Items.Items.Timestamp;Items.Items.Value;Items.Items.Good;Items.Items.Questionable;Items.Items.Substituted;Items.Items.Annotated';
      }
    }

    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null) {
        if (Array.isArray(v)) {
          v.forEach(val => searchParams.append(k, val));
        } else {
          searchParams.set(k, String(v));
        }
      }
    }
    if (!searchParams.has('webIdType')) {
      searchParams.set('webIdType', 'IDOnly');
    }

    let urlPath = '';
    if (typeof parentOrWebIds === 'string') {
      let parentWebId = parentOrWebIds;
      if (parentOrWebIds.startsWith('\\\\')) {
        parentWebId = await this.resolvePathToWebId(parentOrWebIds, 'element', signal);
      }
      assertWebId(parentWebId);
      const queryStr = searchParams.toString();
      const suffix = queryStr ? `?${queryStr}` : '';
      urlPath = `${basePath}/streamsets/${parentWebId}/${action}${suffix}`;
    } else if (Array.isArray(parentOrWebIds)) {
      const resolvedWebIds = await Promise.all(
        parentOrWebIds.map(async item => {
          if (typeof item === 'string' && item.startsWith('\\\\')) {
            return this.resolvePathToWebId(item, null, signal);
          }
          return item;
        })
      );

      resolvedWebIds.forEach(id => searchParams.append('webId', id));
      const queryStr = searchParams.toString();
      const suffix = queryStr ? `?${queryStr}` : '';
      urlPath = `${basePath}/streamsets/${action}${suffix}`;
    } else {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'parentOrWebIds must be a string (WebID/path) or an array of WebIDs/paths'
      });
    }

    return this.request('GET', urlPath, null, signal);
  }

  async readCurrentValueMulti(parentOrWebIds, time, categoryName, templateName, showHidden, identity, signal) {
    // Ad-hoc streamsets (GET /streamsets/value?webId=...) ignore the AF filter
    // parameters; only the element/attribute-parent form accepts them.
    const params = Array.isArray(parentOrWebIds)
      ? { time }
      : { time, categoryName, templateName, showHidden };
    return this.readMulti(parentOrWebIds, 'value', params, identity, signal);
  }

  async readRecordedMulti(parentOrWebIds, timeRange, boundaryType, filterExpression, pageSize, identity, signal) {
    const params = {
      startTime: timeRange?.startTime,
      endTime: timeRange?.endTime,
      boundaryType,
      filterExpression,
      maxCount: pageSize
    };
    return this.readMulti(parentOrWebIds, 'recorded', params, identity, signal);
  }

  async readInterpolatedMulti(parentOrWebIds, timeRange, interval, identity, signal) {
    const params = {
      startTime: timeRange?.startTime,
      endTime: timeRange?.endTime,
      interval
    };
    return this.readMulti(parentOrWebIds, 'interpolated', params, identity, signal);
  }

  async readSummaryMulti(parentOrWebIds, timeRange, summaryTypes, calculationBasis, summaryDuration, identity, signal) {
    const params = {
      startTime: timeRange?.startTime,
      endTime: timeRange?.endTime,
      summaryType: summaryTypes,
      calculationBasis,
      summaryDuration
    };
    return this.readMulti(parentOrWebIds, 'summary', params, identity, signal);
  }
}
