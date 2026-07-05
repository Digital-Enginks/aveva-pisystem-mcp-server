import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { WriteValidator } from '../../../gateway/write-validator.js';

export const writeValuesTool = {
  name: 'pi.write.values',
  description: 'Write multiple recorded values to a single stream (requires write permissions and MCP_WRITE_TOOLS_ENABLED)',
  inputSchema: {
    target: z.string().describe('WebID or Path of the target stream'),
    values: z.array(z.object({
      timestamp: z.string().describe('PI time or ISO-8601 timestamp'),
      value: z.any().describe('The value to write'),
      unitsAbbreviation: z.string().optional()
    })).max(500).describe('Array of values to write (max 500). REQUIRED.'),
    updateOption: z.enum(['Replace', 'Insert', 'NoReplace', 'ReplaceOnly', 'InsertNoCompression', 'Remove']).default('Replace').optional(),
    bufferOption: z.enum(['DoNotBuffer', 'BufferIfPossible', 'Buffer']).default('DoNotBuffer').optional(),
    allowDuplicateInsert: z.boolean().default(false).optional().describe('Set to true to explicitly acknowledge duplicate insertions')
  },
  async handler(args, context) {
    const { gateway, signal, config, logger } = context;
    const { 
      target, values, updateOption = 'Replace', bufferOption = 'DoNotBuffer',
      allowDuplicateInsert = false
    } = args;

    if (!config.MCP_WRITE_TOOLS_ENABLED) {
      throw new AppError({
        category: ErrorCategory.WRITES_DISABLED,
        retryable: false,
        message: 'Write operations are currently disabled on the server.'
      });
    }

    if (!Array.isArray(values) || values.length === 0) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'values parameter must be a non-empty array of write requests.'
      });
    }

    const validator = new WriteValidator(gateway, logger);
    let resolvedWebId = target;
    if (target.startsWith('\\\\')) {
      resolvedWebId = await gateway.resolvePathToWebId(target, null, signal);
    }

    // Resolve target metadata (and digital states) once, then check every
    // value against it; all values target the same stream.
    const validationContext = await validator.resolveContext(resolvedWebId, signal);
    for (const val of values) {
      validator.checkValue(validationContext, {
        value: val.value,
        timestamp: val.timestamp,
        allowDuplicateInsert,
        updateOption
      });
    }

    const writeRequests = values.map(val => ({
      webIdOrPath: resolvedWebId,
      timestamp: val.timestamp,
      value: val.value,
      unitsAbbreviation: val.unitsAbbreviation
    }));

    const summary = await gateway.writeValues(writeRequests, updateOption, bufferOption, null, signal);

    if (summary.failed > 0) {
      throw new AppError({
        category: ErrorCategory.PARTIAL_WRITE,
        retryable: false,
        message: 'Some values could not be written to the PI System.',
        details: { accepted: summary.accepted, failed: summary.failed, failures: summary.failures }
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ status: 'ok', accepted: summary.accepted }, null, 2)
        }
      ]
    };
  }
};
