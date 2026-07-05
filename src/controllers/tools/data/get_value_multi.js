import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { normalizeTvq } from '../../../gateway/value-normalizer.js';
import { collectStreamFailures, streamItemFailed } from '../../../gateway/multi-result.js';
import { enforceSizeGuard } from '../../../gateway/response-size-guard.js';

export const getValueMultiTool = {
  name: 'pi.data.get_value_multi',
  description: 'Retrieve snapshots/current values for multiple streams in one request (using parent AF Element or list of WebIDs/Paths)',
  inputSchema: {
    parent: z.string().optional().describe('WebID or Path of parent AF Element (targets all child attributes)'),
    webIds: z.array(z.string()).max(500).optional().describe('Array of WebIDs or Paths of target streams (max 500)'),
    time: z.string().optional().describe('PI relative or absolute time string'),
    categoryName: z.string().optional().describe('Filter parent attributes by category name'),
    templateName: z.string().optional().describe('Filter parent attributes by template name'),
    showHidden: z.boolean().default(false).optional().describe('True to return hidden attributes (parent mode)')
  },
  async handler(args, context) {
    const { gateway, signal, config } = context;
    const { parent, webIds, time, categoryName, templateName, showHidden = false } = args;

    // Validation
    if ((!parent && (!webIds || webIds.length === 0)) || (parent && webIds && webIds.length > 0)) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'Must supply exactly one of parent (string) or webIds (non-empty array of strings)'
      });
    }

    const target = parent || webIds;
    const res = await gateway.readCurrentValueMulti(target, time, categoryName, templateName, showHidden, null, signal);
    
    // Normalize multi stream collection. Per-stream failures (PI returns 200
    // with an Errors array on the failing item) are surfaced as a partial
    // envelope rather than silently appearing as empty streams.
    const items = res.Items || [];
    const failures = collectStreamFailures(items);
    const streams = items.filter(item => !streamItemFailed(item)).map(item => {
      const tvq = normalizeTvq(item.Value, item.UnitsAbbreviation);
      return {
        webId: item.WebId,
        name: item.Name,
        unitsAbbreviation: item.UnitsAbbreviation || null,
        value: tvq ? tvq.toJSON() : null
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
