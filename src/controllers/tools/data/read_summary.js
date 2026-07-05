import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { TimeRange } from '../../../domain/values/TimeRange.js';
import { normalizeTvq } from '../../../gateway/value-normalizer.js';
import { enforceSizeGuard } from '../../../gateway/response-size-guard.js';

export const readSummaryTool = {
  name: 'pi.data.read_summary',
  description: 'Retrieve statistical/aggregation summaries from a single stream over a time range',
  inputSchema: {
    stream: z.string().describe('WebID or Path of the stream'),
    startTime: z.string().default('*-1d').optional().describe('PI relative or absolute start time'),
    endTime: z.string().default('*').optional().describe('PI relative or absolute end time'),
    summaryType: z.array(z.enum([
      'Total', 'Average', 'Minimum', 'Maximum', 'Range', 'StdDev',
      'PopulationStdDev', 'Count', 'PercentGood', 'TotalWithUOM', 'All', 'AllForNonNumeric'
    ])).describe('Array of summary calculations to perform. REQUIRED.'),
    calculationBasis: z.enum([
      'TimeWeighted', 'EventWeighted', 'TimeWeightedContinuous', 'TimeWeightedDiscrete',
      'EventWeightedExcludeMostRecentEvent', 'EventWeightedExcludeEarliestEvent', 'EventWeightedIncludeBothEnds'
    ]).default('TimeWeighted').optional(),
    timeType: z.enum(['Auto', 'EarliestTime', 'MostRecentTime']).default('Auto').optional(),
    summaryDuration: z.string().optional().describe('PI timespan (e.g. 1h, 1d) to request bucketed/interval summaries'),
    sampleType: z.enum(['ExpressionRecordedValues', 'Interval']).default('ExpressionRecordedValues').optional(),
    sampleInterval: z.string().optional().describe('PI timespan sample interval. Required if sampleType is Interval.'),
    filterExpression: z.string().optional().describe('PI expression filter for summarized values')
  },
  async handler(args, context) {
    const { gateway, signal, config } = context;
    const { 
      stream, startTime = '*-1d', endTime = '*', summaryType, 
      calculationBasis = 'TimeWeighted', timeType = 'Auto', summaryDuration,
      sampleType = 'ExpressionRecordedValues', sampleInterval, filterExpression
    } = args;

    if (!Array.isArray(summaryType) || summaryType.length === 0) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'summaryType parameter must be a non-empty array of calculations.'
      });
    }

    if (sampleType === 'Interval' && (!sampleInterval || sampleInterval.trim() === '')) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'sampleInterval parameter is required when sampleType is Interval.'
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
      summaryType,
      calculationBasis,
      timeType,
      summaryDuration,
      sampleType,
      sampleInterval,
      filterExpression,
      selectedFields: 'Items.Type;Items.Value.Timestamp;Items.Value.Value;Items.Value.Good;Items.Value.Questionable;Items.Value.Substituted;Items.Value.Annotated;Items.Value.UnitsAbbreviation'
    };

    const res = await gateway.resolveAndRead(stream, 'summary', queryParams, signal);
    
    // Normalize summaries collection
    const items = (res.Items || []).map(item => {
      const tvq = normalizeTvq(item.Value);
      return {
        type: item.Type,
        value: tvq ? tvq.toJSON() : null
      };
    });

    // Summary responses carry units inside each Items[].Value, not at the top level.
    const unitsAbbreviation = (res.Items || [])
      .map(item => item.Value?.UnitsAbbreviation)
      .find(Boolean) || null;

    const result = {
      items,
      unitsAbbreviation
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
