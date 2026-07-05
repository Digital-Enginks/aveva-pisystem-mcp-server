import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { TimeRange } from '../../../domain/values/TimeRange.js';
import { normalizeTvq } from '../../../gateway/value-normalizer.js';
import { enforceSizeGuard } from '../../../gateway/response-size-guard.js';

export const readInterpolatedTool = {
  name: 'pi.data.read_interpolated',
  description: 'Retrieve evenly-spaced interpolated values from a single stream over a time range',
  inputSchema: {
    stream: z.string().describe('WebID or Path of the stream'),
    startTime: z.string().default('*-1d').optional().describe('PI relative or absolute start time (default is *-1d)'),
    endTime: z.string().default('*').optional().describe('PI relative or absolute end time (default is *)'),
    interval: z.string().describe('PI timespan, e.g. 1h, 10m, 30s. REQUIRED.'),
    syncTime: z.string().optional().describe('PI time string specifying time alignment anchor'),
    syncTimeBoundaryType: z.enum(['Inside', 'Outside']).optional(),
    filterExpression: z.string().optional().describe('PI expression filter for returned values'),
    desiredUnits: z.string().optional().describe('Units abbreviation to perform read-side conversion to')
  },
  async handler(args, context) {
    const { gateway, signal, config } = context;
    const { 
      stream, startTime = '*-1d', endTime = '*', interval, 
      syncTime, syncTimeBoundaryType, filterExpression, desiredUnits 
    } = args;

    if (!interval || interval.trim() === '') {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'interval parameter is required for interpolated reads.'
      });
    }

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
      interval,
      syncTime,
      syncTimeBoundaryType,
      filterExpression,
      desiredUnits,
      selectedFields: 'Items.Timestamp;Items.Value;Items.Good;Items.Questionable;Items.Substituted;Items.Annotated;UnitsAbbreviation'
    };

    const res = await gateway.resolveAndRead(stream, 'interpolated', queryParams, signal);
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
