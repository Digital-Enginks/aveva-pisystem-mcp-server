import { z } from 'zod';
import { normalizeTvq } from '../../../gateway/value-normalizer.js';
import { enforceSizeGuard } from '../../../gateway/response-size-guard.js';

export const getValueTool = {
  name: 'pi.data.get_value',
  description: 'Retrieve the snapshot/current value of a single stream (PI Point or AF Attribute)',
  inputSchema: {
    stream: z.string().describe('WebID or Path of the stream'),
    time: z.string().default('*').optional().describe('PI relative or absolute time string (default is *)'),
    timeZone: z.string().optional().describe('Target timezone name, e.g., EST, UTC'),
    desiredUnits: z.string().optional().describe('Units abbreviation to perform read-side conversion to')
  },
  async handler(args, context) {
    const { gateway, signal, config } = context;
    const { stream, time = '*', timeZone, desiredUnits } = args;

    const queryParams = { time, timeZone, desiredUnits };
    // Set selected fields to keep it lean
    queryParams.selectedFields = 'Timestamp;Value;UnitsAbbreviation;Good;Questionable;Substituted;Annotated';
    
    const res = await gateway.resolveAndRead(stream, 'value', queryParams, signal);
    const tvq = normalizeTvq(res);

    const result = tvq ? tvq.toJSON() : {};
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
