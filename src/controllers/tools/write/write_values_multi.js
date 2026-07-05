import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { WriteValidator } from '../../../gateway/write-validator.js';

export const writeValuesMultiTool = {
  name: 'pi.write.values_multi',
  description: 'Write multiple values to multiple streams in one request (requires write permissions and MCP_WRITE_TOOLS_ENABLED)',
  inputSchema: {
    streams: z.array(z.object({
      target: z.string().describe('WebID or Path of the target stream'),
      values: z.array(z.object({
        timestamp: z.string().describe('PI time or ISO-8601 timestamp'),
        value: z.any().describe('The value to write'),
        unitsAbbreviation: z.string().optional()
      })).max(500).describe('Array of values for this stream (max 500). REQUIRED.')
    })).max(500).describe('Array of streams and their values to write (max 500). REQUIRED.'),
    updateOption: z.enum(['Replace', 'Insert', 'NoReplace', 'ReplaceOnly', 'InsertNoCompression', 'Remove']).default('Replace').optional(),
    bufferOption: z.enum(['DoNotBuffer', 'BufferIfPossible', 'Buffer']).default('DoNotBuffer').optional(),
    allowDuplicateInsert: z.boolean().default(false).optional().describe('Set to true to explicitly acknowledge duplicate insertions')
  },
  async handler(args, context) {
    const { gateway, signal, config, logger } = context;
    const { 
      streams, updateOption = 'Replace', bufferOption = 'DoNotBuffer',
      allowDuplicateInsert = false
    } = args;

    if (!config.MCP_WRITE_TOOLS_ENABLED) {
      throw new AppError({
        category: ErrorCategory.WRITES_DISABLED,
        retryable: false,
        message: 'Write operations are currently disabled on the server.'
      });
    }

    if (!Array.isArray(streams) || streams.length === 0) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'streams parameter must be a non-empty array.'
      });
    }

    const validator = new WriteValidator(gateway, logger);
    const writeRequests = [];

    // Pre-dispatch validate everything
    for (const streamEntry of streams) {
      const { target, values } = streamEntry;
      if (!Array.isArray(values) || values.length === 0) {
        throw new AppError({
          category: ErrorCategory.INVALID_INPUT,
          retryable: false,
          message: `Stream target "${target}" has no values list`
        });
      }

      let resolvedWebId = target;
      if (target.startsWith('\\\\')) {
        resolvedWebId = await gateway.resolvePathToWebId(target, null, signal);
      }

      // One metadata/digital-state resolution per stream; values checked synchronously.
      const streamContext = await validator.resolveContext(resolvedWebId, signal);
      for (const val of values) {
        validator.checkValue(streamContext, {
          value: val.value,
          timestamp: val.timestamp,
          allowDuplicateInsert,
          updateOption
        });

        writeRequests.push({
          webIdOrPath: resolvedWebId,
          timestamp: val.timestamp,
          value: val.value,
          unitsAbbreviation: val.unitsAbbreviation
        });
      }
    }

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
