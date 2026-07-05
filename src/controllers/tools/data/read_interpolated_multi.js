import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { TimeRange } from '../../../domain/values/TimeRange.js';
import { normalizeTvq } from '../../../gateway/value-normalizer.js';
import { collectStreamFailures, streamItemFailed } from '../../../gateway/multi-result.js';
import { enforceSizeGuard } from '../../../gateway/response-size-guard.js';

export const readInterpolatedMultiTool = {
  name: 'pi.data.read_interpolated_multi',
  description: 'Retrieve evenly-spaced interpolated values for multiple streams',
  inputSchema: {
    parent: z.string().optional().describe('WebID or Path of parent AF Element'),
    webIds: z.array(z.string()).max(500).optional().describe('Array of WebIDs or Paths of target streams (max 500)'),
    startTime: z.string().default('*-1d').optional().describe('PI relative or absolute start time'),
    endTime: z.string().default('*').optional().describe('PI relative or absolute end time'),
    interval: z.string().describe('PI timespan, e.g. 1h, 10m, 30s. REQUIRED.')
  },
  async handler(args, context) {
    const { gateway, signal, config } = context;
    const { parent, webIds, startTime = '*-1d', endTime = '*', interval } = args;

    // Validation
    if ((!parent && (!webIds || webIds.length === 0)) || (parent && webIds && webIds.length > 0)) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'Must supply exactly one of parent (string) or webIds (non-empty array of strings)'
      });
    }

    if (!interval || interval.trim() === '') {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'interval parameter is required for multi-stream interpolated reads.'
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

    const target = parent || webIds;
    const res = await gateway.readInterpolatedMulti(target, range, interval, null, signal);

    // Per-stream failures (PI returns 200 with an Errors array on the failing
    // item) are surfaced as a partial envelope, never silently dropped.
    const resItems = res.Items || [];
    const failures = collectStreamFailures(resItems);
    const streams = resItems.filter(item => !streamItemFailed(item)).map(item => {
      const items = (item.Items || []).map(val => normalizeTvq(val, item.UnitsAbbreviation).toJSON());
      return {
        webId: item.WebId,
        name: item.Name,
        unitsAbbreviation: item.UnitsAbbreviation || null,
        items
      };
    });

    const result = { streams };
    if (failures.length > 0) {
      result.partial = true;
      result.failures = failures;
    }
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
