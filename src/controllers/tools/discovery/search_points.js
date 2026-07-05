import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { Paging } from '../../../domain/values/Paging.js';

export const searchPointsTool = {
  name: 'pi.discovery.search_points',
  description: 'Search/list PI Points (tags) on a Data Archive server; the supported tag-discovery path',
  inputSchema: {
    server: z.string().describe('WebID or Path of the Data Archive server'),
    nameFilter: z.string().describe('Tag name filter (supports wildcards * and ?). Min length 1.'),
    pageSize: z.coerce.number().int().min(1).max(1000).default(100).optional(),
    pageToken: z.string().optional(),
    confirmBroad: z.boolean().default(false).optional()
  },
  async handler(args, context) {
    const { gateway, signal } = context;
    const { server, nameFilter, pageSize = 100, pageToken, confirmBroad } = args;

    if (!nameFilter || nameFilter.trim() === '') {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'nameFilter must be a non-empty string'
      });
    }

    if (nameFilter === '*' && confirmBroad !== true) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'Unbounded tag search ("*") is blocked to protect performance unless confirmBroad: true is explicitly supplied.'
      });
    }

    let serverWebId = server;
    if (server.startsWith('\\\\')) {
      serverWebId = await gateway.resolvePathToWebId(server, 'dataserver', signal);
    }

    // Pagination setup
    const queryHash = Paging.generateQueryHash({ serverWebId, nameFilter });
    const paging = pageToken
      ? Paging.parseToken(pageToken, queryHash)
      : new Paging({ startIndex: 0, pageSize, queryHash });

    const basePath = new URL(gateway.config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const searchParams = new URLSearchParams();
    searchParams.set('nameFilter', nameFilter);
    searchParams.set('startIndex', String(paging.startIndex));
    searchParams.set('maxCount', String(paging.pageSize));
    searchParams.set('selectedFields', 'Items.WebId;Items.Name;Items.PointType;Items.PointClass;Items.DigitalSetName;Items.EngineeringUnits;Items.Descriptor');
    searchParams.set('webIdType', 'IDOnly');

    const url = `${basePath}/dataservers/${serverWebId}/points?${searchParams.toString()}`;
    const res = await gateway.request('GET', url, null, signal);
    const items = (res.Items || []).map(item => ({
      webId: item.WebId,
      name: item.Name,
      pointType: item.PointType,
      pointClass: item.PointClass,
      digitalSetName: item.DigitalSetName,
      engineeringUnits: item.EngineeringUnits,
      descriptor: item.Descriptor
    }));

    const hasMore = items.length === paging.pageSize;
    const result = {
      items,
      hasMore,
      nextPageToken: hasMore ? paging.next(items.length).toToken() : undefined
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }
};
