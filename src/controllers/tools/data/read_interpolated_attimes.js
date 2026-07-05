import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { normalizeTvq } from '../../../gateway/value-normalizer.js';
import { enforceSizeGuard } from '../../../gateway/response-size-guard.js';

export const readInterpolatedAtTimesTool = {
  name: 'pi.data.read_interpolated_attimes',
  description: 'Retrieve interpolated values from a single stream at explicit arbitrary timestamps',
  inputSchema: {
    stream: z.string().describe('WebID or Path of the stream'),
    times: z.array(z.string()).describe('Array of PI relative or absolute time strings at which to interpolate (min 1). REQUIRED.'),
    filterExpression: z.string().optional().describe('PI expression filter for returned values')
  },
  async handler(args, context) {
    const { gateway, signal, config } = context;
    const { stream, times, filterExpression } = args;

    if (!Array.isArray(times) || times.length === 0) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'times parameter must be a non-empty array of time strings.'
      });
    }

    const queryParams = {
      time: times,
      filterExpression,
      selectedFields: 'Items.Timestamp;Items.Value;Items.Good;Items.Questionable;Items.Substituted;Items.Annotated;UnitsAbbreviation'
    };

    const res = await gateway.resolveAndRead(stream, 'interpolatedattimes', queryParams, signal);
    const items = (res.Items || []).map(item => normalizeTvq(item, res.UnitsAbbreviation).toJSON());

    const result = {
      items,
      unitsAbbreviation: res.UnitsAbbreviation || null
    };

    const maxBytes = config.MCP_MAX_RESPONSE_BYTES || 1048576;
    const guarded = enforceSizeGuard(result, maxBytes);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(guarded, null, 2)
        }
      ]
    };
  }
};
