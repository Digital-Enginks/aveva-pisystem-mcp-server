import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { Paging } from '../../../domain/values/Paging.js';
import { TimeRange } from '../../../domain/values/TimeRange.js';
import { normalizeTvq } from '../../../gateway/value-normalizer.js';
import { enforceSizeGuard } from '../../../gateway/response-size-guard.js';

export const readRecordedTool = {
  name: 'pi.data.read_recorded',
  description: 'Retrieve recorded/archived values from a single stream over a time range',
  inputSchema: {
    stream: z.string().describe('WebID or Path of the stream'),
    startTime: z.string().default('*-1d').optional().describe('PI relative or absolute start time (default is *-1d)'),
    endTime: z.string().default('*').optional().describe('PI relative or absolute end time (default is *)'),
    boundaryType: z.enum(['Inside', 'Outside', 'Interpolated']).default('Inside').optional(),
    filterExpression: z.string().optional().describe('PI expression filter for returned values'),
    includeFilteredValues: z.boolean().default(false).optional().describe('True to return filtered values with quality annotated'),
    desiredUnits: z.string().optional().describe('Units abbreviation to perform read-side conversion to'),
    pageSize: z.coerce.number().int().min(1).max(1000).default(1000).optional(),
    pageToken: z.string().optional()
  },
  async handler(args, context) {
    const { gateway, signal, config } = context;
    const { 
      stream, startTime = '*-1d', endTime = '*', boundaryType = 'Inside', 
      filterExpression, includeFilteredValues = false, desiredUnits, pageSize = 1000, pageToken 
    } = args;

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

    // Pagination setup
    const queryHash = Paging.generateQueryHash({ 
      stream, startTime: range.startTime, endTime: range.endTime, boundaryType, 
      filterExpression, includeFilteredValues, desiredUnits 
    });
    const paging = pageToken
      ? Paging.parseToken(pageToken, queryHash)
      : new Paging({ startIndex: 0, pageSize, queryHash });

    // GetRecorded has no startIndex parameter: pagination advances startTime
    // past the last returned timestamp, carried in the token as a raw PI cursor.
    const queryParams = {
      startTime: paging.cursor || range.startTime,
      endTime: range.endTime,
      boundaryType,
      filterExpression,
      includeFilteredValues,
      desiredUnits,
      maxCount: paging.pageSize,
      selectedFields: 'Items.Timestamp;Items.Value;Items.Good;Items.Questionable;Items.Substituted;Items.Annotated;UnitsAbbreviation'
    };

    const res = await gateway.resolveAndRead(stream, 'recorded', queryParams, signal);

    const fetched = res.Items || [];
    // Values at the cursor timestamp were already returned on the previous page.
    const rawItems = paging.cursor ? fetched.filter(item => item.Timestamp !== paging.cursor) : fetched;
    const items = rawItems.map(item => normalizeTvq(item, res.UnitsAbbreviation).toJSON());

    const hasMore = fetched.length === paging.pageSize && rawItems.length > 0;
    const result = {
      items,
      unitsAbbreviation: res.UnitsAbbreviation || null,
      hasMore,
      nextPageToken: hasMore ? paging.nextWithCursor(rawItems[rawItems.length - 1].Timestamp).toToken() : undefined
    };

    const maxBytes = config.MCP_MAX_RESPONSE_BYTES || 1048576;
    const guarded = enforceSizeGuard(result, maxBytes, (truncatedCount) => {
      return paging.nextWithCursor(rawItems[truncatedCount - 1].Timestamp).toToken();
    });

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
