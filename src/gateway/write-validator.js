import { AppError, ErrorCategory } from '../errors/error-model.js';
import { TagPath } from '../domain/values/TagPath.js';

const NUMERIC_TYPES = ['float16', 'float32', 'float64', 'single', 'double', 'int16', 'int32', 'integer'];

export class WriteValidator {
  #client;
  #logger;

  constructor(client, logger) {
    this.#client = client;
    this.#logger = logger;
  }

  /**
   * Resolves everything needed to validate writes to a single target: its
   * metadata and, for digital points, the set of legal states. This is the
   * costly part (cache lookups / network), so callers writing many values to
   * the same stream should call it once and reuse the returned context with
   * checkValue().
   *
   * @param {string} webIdOrPath - WebID or PI system path of the target stream
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<object>} Validation context for the target
   */
  async resolveContext(webIdOrPath, signal = null) {
    let metadata;
    try {
      metadata = await this.#client.resolveMetadata(webIdOrPath, null, signal);
    } catch (err) {
      throw new AppError({
        category: ErrorCategory.NOT_FOUND,
        retryable: false,
        message: `Target resource not found for write: ${webIdOrPath}`,
        cause: err
      });
    }

    // Reject attributes that are not backed by a writable PI Point reference.
    if (metadata.resourceType === 'attribute' && metadata.dataReferencePlugIn !== 'PI Point') {
      throw new AppError({
        category: ErrorCategory.UNAUTHORIZED,
        retryable: false,
        message: `Write rejected: attribute "${metadata.name}" is read-only (DataReference: ${metadata.dataReferencePlugIn || 'none'})`
      });
    }

    const pointType = String(metadata.pointType || '').toLowerCase();

    let digitalStates = null;
    if (pointType.includes('digital') && metadata.digitalSetName) {
      if (!metadata.path || typeof metadata.path !== 'string') {
        throw new AppError({
          category: ErrorCategory.INVALID_INPUT,
          retryable: false,
          message: `Cannot validate digital states for "${metadata.name}": resolved metadata has no usable system path`
        });
      }
      const serverName = new TagPath(metadata.path).server;
      const dsWebId = await this.#client.resolvePathToWebId(`\\\\${serverName}`, 'dataserver', signal);
      if (dsWebId) {
        digitalStates = await this.#client.getDigitalStates(dsWebId, metadata.digitalSetName, signal);
      }
    }

    return { metadata, pointType, digitalStates };
  }

  /**
   * Validates a single value/timestamp against a previously resolved context.
   * Synchronous: no I/O happens here, so a stream's whole value list can be
   * checked in a tight loop after a single resolveContext().
   *
   * @param {object} context - Result of resolveContext()
   * @param {object} value - { value, timestamp, allowDuplicateInsert, updateOption }
   */
  checkValue(context, { value, timestamp, allowDuplicateInsert, updateOption }) {
    const { metadata, pointType, digitalStates } = context;

    if (NUMERIC_TYPES.some(t => pointType.includes(t))) {
      // Reject NaN/Infinity and any non-number; no silent string coercion.
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new AppError({
          category: ErrorCategory.INVALID_INPUT,
          retryable: false,
          message: `Type mismatch: value for numeric point "${metadata.name}" must be a finite number`
        });
      }
    } else if (pointType.includes('string')) {
      if (typeof value !== 'string') {
        throw new AppError({
          category: ErrorCategory.INVALID_INPUT,
          retryable: false,
          message: `Type mismatch: value for string point "${metadata.name}" must be a string`
        });
      }
    } else if (pointType.includes('digital') && digitalStates) {
      const isValid = digitalStates.some(s =>
        (typeof value === 'string' && s.Name.toLowerCase() === value.toLowerCase()) ||
        (typeof value === 'number' && s.Value === value)
      );
      if (!isValid) {
        throw new AppError({
          category: ErrorCategory.INVALID_INPUT,
          retryable: false,
          message: `Type mismatch: value "${value}" is not a valid state in set "${metadata.digitalSetName}" for point "${metadata.name}"`
        });
      }
    }

    if (!timestamp || typeof timestamp !== 'string' || timestamp.trim() === '') {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: `Invalid timestamp format: "${timestamp}"`
      });
    }

    // Absolute timestamps are checked here for the future-write guard. PI relative
    // or abbreviated time expressions (e.g. "*", "*-1h", "Yesterday") are valid PI
    // time per the tool contract but are not parseable by Date.parse, so they are
    // left for PI Web API to validate on write.
    const parsedMs = Date.parse(timestamp);
    if (!Number.isNaN(parsedMs) && parsedMs > Date.now() && !metadata.future) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: `Future timestamp not allowed: point "${metadata.name}" is not future-enabled`
      });
    }

    if ((updateOption === 'Insert' || updateOption === 'InsertNoCompression') && allowDuplicateInsert !== true) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: `Insert write operations require allowDuplicateInsert=true parameter to acknowledge duplicate insertion`
      });
    }
  }

  /**
   * Validates a single write request and returns the resolved WebID.
   * Convenience wrapper around resolveContext()/checkValue() for callers
   * writing exactly one value.
   *
   * @param {object} writeRequest - { webIdOrPath, timestamp, value, unitsAbbreviation, updateOption, allowDuplicateInsert }
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<string>} The resolved WebID
   */
  async validate(writeRequest, signal = null) {
    const { webIdOrPath, timestamp, value, allowDuplicateInsert, updateOption } = writeRequest;
    this.#logger.debug('Validating write request', { webIdOrPath, timestamp, value });

    const context = await this.resolveContext(webIdOrPath, signal);
    this.checkValue(context, { value, timestamp, allowDuplicateInsert, updateOption });
    return context.metadata.webId;
  }
}
