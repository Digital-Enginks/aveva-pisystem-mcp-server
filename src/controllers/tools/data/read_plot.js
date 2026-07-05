import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { TimeRange } from '../../../domain/values/TimeRange.js';
import { normalizeTvq } from '../../../gateway/value-normalizer.js';
import { enforceSizeGuard } from '../../../gateway/response-size-guard.js';

export const readPlotTool = {
  name: 'pi.data.read_plot',
  description: 'Retrieve plot-decimated values from a single stream for visualization (decimated; not for calculations)',
  inputSchema: {
    stream: z.string().describe('WebID or Path of the stream'),
    startTime: z.string().default('*-1d').optional().describe('PI relative or absolute start time (default is *-1d)'),
    endTime: z.string().default('*').optional().describe('PI relative or absolute end time (default is *)'),
    intervals: z.coerce.number().int().min(1).max(2000).default(300).optional().describe('Number of intervals/buckets for plot decimation (range 1-2000, default is 300)')
  },
  async handler(args, context) {
    const { gateway, signal, config } = context;
    const { stream, startTime = '*-1d', endTime = '*', intervals = 300 } = args;

    // Validate time range
    let range;
    try {
      range = new TimeRange(startTime, endTime);
    } catch (err) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: `Invalid time range: ${err.message}`
      });
    }

    const queryParams = {
      startTime: range.startTime,
      endTime: range.endTime,
      intervals,
      selectedFields: 'Items.Timestamp;Items.Value;Items.Good;Items.Questionable;Items.Substituted;Items.Annotated;UnitsAbbreviation'
    };

    const res = await gateway.resolveAndRead(stream, 'plot', queryParams, signal);
    const items = (res.Items || []).map(item => normalizeTvq(item, res.UnitsAbbreviation).toJSON());

    const result = {
      items,
      unitsAbbreviation: res.UnitsAbbreviation || null,
      advisory: 'decimated — not for analytics'
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
