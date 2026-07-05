import { z } from 'zod';
import { normalizeTvq } from '../../../gateway/value-normalizer.js';
import { enforceSizeGuard } from '../../../gateway/response-size-guard.js';

export const getEndTool = {
  name: 'pi.data.get_end',
  description: 'Retrieve the most recent end-of-stream value (GetEnd primitive for live snapshots)',
  inputSchema: {
    stream: z.string().describe('WebID or Path of the stream')
  },
  async handler(args, context) {
    const { gateway, signal, config } = context;
    const { stream } = args;

    const queryParams = {
      selectedFields: 'Timestamp;Value;UnitsAbbreviation;Good;Questionable;Substituted;Annotated'
    };

    const res = await gateway.resolveAndRead(stream, 'end', queryParams, signal);
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
