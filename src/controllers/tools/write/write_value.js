import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { WriteValidator } from '../../../gateway/write-validator.js';

export const writeValueTool = {
  name: 'pi.write.value',
  description: 'Write a single value to a PI Point or writable AF Attribute (requires write permissions and MCP_WRITE_TOOLS_ENABLED)',
  inputSchema: {
    target: z.string().describe('WebID or Path of the target stream'),
    timestamp: z.string().describe('PI time or ISO-8601 timestamp for the value'),
    value: z.any().describe('The value to write (numeric, string, or digital-state)'),
    unitsAbbreviation: z.string().optional().describe('Optional units abbreviation of the value'),
    updateOption: z.enum(['Replace', 'Insert', 'NoReplace', 'ReplaceOnly', 'InsertNoCompression', 'Remove']).default('Replace').optional(),
    bufferOption: z.enum(['DoNotBuffer', 'BufferIfPossible', 'Buffer']).default('DoNotBuffer').optional(),
    allowDuplicateInsert: z.boolean().default(false).optional().describe('Set to true to explicitly acknowledge duplicate insertions for Insert/InsertNoCompression options')
  },
  async handler(args, context) {
    const { gateway, signal, config, logger } = context;
    const { 
      target, timestamp, value, unitsAbbreviation, 
      updateOption = 'Replace', bufferOption = 'DoNotBuffer', 
      allowDuplicateInsert = false
    } = args;

    // Durability check
    if (!config.MCP_WRITE_TOOLS_ENABLED) {
      throw new AppError({
        category: ErrorCategory.WRITES_DISABLED,
        retryable: false,
        message: 'Write operations are currently disabled on the server.'
      });
    }

    const validator = new WriteValidator(gateway, logger);
    const resolvedWebId = await validator.validate({
      webIdOrPath: target,
      timestamp,
      value,
      unitsAbbreviation,
      allowDuplicateInsert,
      updateOption
    }, signal);

    const writeRequests = [{
      webIdOrPath: resolvedWebId,
      timestamp,
      value,
      unitsAbbreviation
    }];

    const summary = await gateway.writeValues(writeRequests, updateOption, bufferOption, null, signal);

    if (summary.failed > 0) {
      throw new AppError({
        category: ErrorCategory.PARTIAL_WRITE,
        retryable: false,
        message: 'The value could not be written to the PI System.',
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
