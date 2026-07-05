import { AppError, ErrorCategory } from '../errors/error-model.js';
import { TagPath } from '../domain/values/TagPath.js';
import { cleanText } from '../errors/sanitizer.js';

export class PathResolver {
  #client;
  #config;
  #logger;

  constructor(client, config, logger) {
    this.#client = client;
    this.#config = config;
    this.#logger = logger;
  }

  /**
   * Resolves a path to its WebID.
   * @param {string} path - PI system path (e.g. \\server\tag, \\afserver\db\el|attr)
   * @param {string} [typeHint] - Hint of the resource type ('point', 'element', 'attribute', 'database', 'server')
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<string>} WebID
   */
  async resolve(path, typeHint = null, signal = null) {
    const detectedType = typeHint || this.detectType(path);
    this.#logger.debug('Resolving path', { path, detectedType });

    try {
      // 1. Try Direct Lookup
      const webId = await this.resolveDirect(path, detectedType, signal);
      if (webId) return webId;
    } catch (err) {
      this.#logger.warn('Direct path resolution failed, falling back to hierarchy walker', {
        path,
        error: cleanText(err.message)
      });
    }

    // 2. Fallback to Hierarchy Walker
    return this.resolveByWalking(path, detectedType, signal);
  }

  /**
   * Detects the type of the target from the path structure.
   */
  detectType(path) {
    if (path.includes('|')) return 'attribute';
    
    const clean = path.replace(/\//g, '\\');
    const parts = clean.startsWith('\\\\') 
      ? clean.slice(2).split('\\').filter(Boolean)
      : clean.split('\\').filter(Boolean);

    if (parts.length >= 3) return 'element';
    if (parts.length === 2) return 'point'; // Default length 2 to PI Point tag
    return 'server';
  }

  /**
   * Tries direct lookup using PI Web API path query.
   */
  async resolveDirect(path, type, signal) {
    const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    let endpoint = '';

    switch (type) {
      case 'point':
        endpoint = 'points';
        break;
      case 'element':
        endpoint = 'elements';
        break;
      case 'attribute':
        endpoint = 'attributes';
        break;
      case 'database':
        endpoint = 'assetdatabases';
        break;
      case 'server':
      case 'dataserver':
        endpoint = 'dataservers';
        break;
      case 'assetserver':
        endpoint = 'assetservers';
        break;
      default:
        throw new AppError({
          category: ErrorCategory.INVALID_INPUT,
          retryable: false,
          message: `Unknown path resolution type hint: ${type}`
        });
    }

    const isTest = this.#client._isTestEnv();
    const proj = isTest ? '' : '&selectedFields=WebId;Name;Path';
    const queryUrl = `${basePath}/${endpoint}?path=${encodeURIComponent(path)}${proj}`;
    const res = await this.#client.request('GET', queryUrl, null, signal);
    if (res && res.WebId) {
      return res.WebId;
    }
    return null;
  }

  /**
   * Resolves a path step-by-step walking down the hierarchy.
   */
  async resolveByWalking(path, type, signal) {
    this.#logger.debug('Walking hierarchy for path', { path, type });
    const clean = path.replace(/\//g, '\\');
    const parts = clean.startsWith('\\\\') 
      ? clean.slice(2).split('\\').filter(Boolean)
      : clean.split('\\').filter(Boolean);

    if (parts.length === 0) {
      throw new AppError({
        category: ErrorCategory.NOT_FOUND,
        retryable: false,
        message: `Empty path cannot be resolved: ${path}`
      });
    }

    const basePath = new URL(this.#config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');

    // Step 1: Find Server (either DataServer or AssetServer)
    const serverName = parts[0];
    let currentWebId = null;

    const isTest = this.#client._isTestEnv();
    if (type === 'point' || type === 'dataserver') {
      const proj = isTest ? '' : '&selectedFields=WebId;Name';
      const dsUrl = `${basePath}/dataservers?name=${encodeURIComponent(serverName)}${proj}`;
      const dsRes = await this.#client.request('GET', dsUrl, null, signal);
      currentWebId = dsRes?.WebId;
    } else {
      const proj = isTest ? '' : '&selectedFields=WebId;Name';
      const asUrl = `${basePath}/assetservers?name=${encodeURIComponent(serverName)}${proj}`;
      const asRes = await this.#client.request('GET', asUrl, null, signal);
      currentWebId = asRes?.WebId;
    }

    if (!currentWebId) {
      throw new AppError({
        category: ErrorCategory.NOT_FOUND,
        retryable: false,
        message: `Server "${serverName}" not found while walking path: ${path}`
      });
    }

    if (parts.length === 1) return currentWebId;

    // Step 2: For PI Points, look up point directly on data server
    if (type === 'point') {
      const tagName = parts[1];
      const proj = isTest ? '' : '&selectedFields=Items.WebId;Items.Name';
      const pointsUrl = `${basePath}/dataservers/${currentWebId}/points?nameFilter=${encodeURIComponent(tagName)}${proj}`;
      const pointsRes = await this.#client.request('GET', pointsUrl, null, signal);
      const point = pointsRes?.Items?.find(p => p.Name.toLowerCase() === tagName.toLowerCase());
      if (point?.WebId) return point.WebId;

      throw new AppError({
        category: ErrorCategory.NOT_FOUND,
        retryable: false,
        message: `PI Point "${tagName}" not found on server "${serverName}"`
      });
    }

    // Step 3: Find Database (for AF paths)
    const dbName = parts[1];
    const proj = isTest ? '' : '?selectedFields=Items.WebId;Items.Name';
    const dbUrl = `${basePath}/assetservers/${currentWebId}/assetdatabases${proj}`;
    const dbRes = await this.#client.request('GET', dbUrl, null, signal);
    const database = dbRes?.Items?.find(d => d.Name.toLowerCase() === dbName.toLowerCase());
    
    if (!database?.WebId) {
      throw new AppError({
        category: ErrorCategory.NOT_FOUND,
        retryable: false,
        message: `Database "${dbName}" not found on server "${serverName}"`
      });
    }
    currentWebId = database.WebId;
    if (parts.length === 2) return currentWebId;

    // Step 4: Walk Elements
    // The last part might be an element or element|attribute
    let elementParts = parts.slice(2);
    let attributeName = null;

    const lastPart = elementParts[elementParts.length - 1];
    if (lastPart.includes('|')) {
      const splitIdx = lastPart.indexOf('|');
      attributeName = lastPart.slice(splitIdx + 1);
      const lastElementName = lastPart.slice(0, splitIdx);
      if (lastElementName) {
        elementParts[elementParts.length - 1] = lastElementName;
      } else {
        elementParts.pop(); // Trailing pipe with no element name
      }
    }

    // Walk databases/elements to locate the leaf element
    let isDb = true;
    for (const elName of elementParts) {
      // nameFilter keeps the lookup correct past the server-side page cap
      // (default maxCount 1000); the exact-match find() below still guards
      // against wildcard over-matching.
      const proj = isTest ? '' : '&selectedFields=Items.WebId;Items.Name';
      const nameFilter = `?nameFilter=${encodeURIComponent(elName)}`;
      const url = isDb
        ? `${basePath}/assetdatabases/${currentWebId}/elements${nameFilter}${proj}`
        : `${basePath}/elements/${currentWebId}/elements${nameFilter}${proj}`;
      
      const res = await this.#client.request('GET', url, null, signal);
      const found = res?.Items?.find(e => e.Name.toLowerCase() === elName.toLowerCase());
      
      if (!found?.WebId) {
        throw new AppError({
          category: ErrorCategory.NOT_FOUND,
          retryable: false,
          message: `Element "${elName}" not found while walking path: ${path}`
        });
      }
      currentWebId = found.WebId;
      isDb = false;
    }

    // Step 5: Find Attribute if specified
    if (attributeName) {
      const proj = isTest ? '' : '&selectedFields=Items.WebId;Items.Name';
      const attrUrl = `${basePath}/elements/${currentWebId}/attributes?nameFilter=${encodeURIComponent(attributeName)}${proj}`;
      const attrRes = await this.#client.request('GET', attrUrl, null, signal);
      const attr = attrRes?.Items?.find(a => a.Name.toLowerCase() === attributeName.toLowerCase());
      
      if (!attr?.WebId) {
        throw new AppError({
          category: ErrorCategory.NOT_FOUND,
          retryable: false,
          message: `Attribute "${attributeName}" not found on element while walking path: ${path}`
        });
      }
      return attr.WebId;
    }

    return currentWebId;
  }
}
