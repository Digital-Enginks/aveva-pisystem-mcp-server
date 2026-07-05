import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { TimeRange } from '../../../domain/values/TimeRange.js';
import { normalizeTvq } from '../../../gateway/value-normalizer.js';
import { collectStreamFailures, streamItemFailed } from '../../../gateway/multi-result.js';
import { enforceSizeGuard } from '../../../gateway/response-size-guard.js';

export const readRecordedMultiTool = {
  name: 'pi.data.read_recorded_multi',
  description: 'Retrieve recorded values for multiple streams (parent AF Element or list of WebIDs/Paths)',
  inputSchema: {
    parent: z.string().optional().describe('WebID or Path of parent AF Element'),
    webIds: z.array(z.string()).max(500).optional().describe('Array of WebIDs or Paths of target streams (max 500)'),
    startTime: z.string().default('*-1d').optional().describe('PI relative or absolute start time'),
    endTime: z.string().default('*').optional().describe('PI relative or absolute end time'),
    boundaryType: z.enum(['Inside', 'Outside', 'Interpolated']).default('Inside').optional(),
    filterExpression: z.string().optional().describe('PI expression filter for returned values'),
    pageSize: z.coerce.number().int().min(1).max(1000).default(1000).optional().describe('Maximum items to return per stream')
  },
  async handler(args, context) {
    const { gateway, signal, config } = context;
    const { parent, webIds, startTime = '*-1d', endTime = '*', boundaryType = 'Inside', filterExpression, pageSize = 1000 } = args;

    // Validation
    if ((!parent && (!webIds || webIds.length === 0)) || (parent && webIds && webIds.length > 0)) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'Must supply exactly one of parent (string) or webIds (non-empty array of strings)'
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
    const res = await gateway.readRecordedMulti(target, range, boundaryType, filterExpression, pageSize, null, signal);

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
