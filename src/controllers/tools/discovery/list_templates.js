import { z } from 'zod';
import { Paging } from '../../../domain/values/Paging.js';

export const listTemplatesTool = {
  name: 'pi.discovery.list_templates',
  description: 'List element templates in an AF database (used to build/interpret templateName filters)',
  inputSchema: {
    database: z.string().describe('WebID or Path of the AF Database'),
    pageSize: z.coerce.number().int().min(1).max(1000).default(100).optional(),
    pageToken: z.string().optional()
  },
  async handler(args, context) {
    const { gateway, signal } = context;
    const { database, pageSize = 100, pageToken } = args;

    let dbWebId = database;
    if (database.startsWith('\\\\')) {
      dbWebId = await gateway.resolvePathToWebId(database, 'database', signal);
    }

    const queryHash = Paging.generateQueryHash({ dbWebId });
    const paging = pageToken
      ? Paging.parseToken(pageToken, queryHash)
      : new Paging({ startIndex: 0, pageSize, queryHash });

    const basePath = new URL(gateway.config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const searchParams = new URLSearchParams();
    searchParams.set('startIndex', String(paging.startIndex));
    searchParams.set('maxCount', String(paging.pageSize));
    searchParams.set('selectedFields', 'Items.WebId;Items.Name;Items.Path;Items.InstanceType');
    searchParams.set('webIdType', 'IDOnly');

    const url = `${basePath}/assetdatabases/${dbWebId}/elementtemplates?${searchParams.toString()}`;
    const res = await gateway.request('GET', url, null, signal);
    
    const items = (res.Items || []).map(item => ({
      webId: item.WebId,
      name: item.Name,
      path: item.Path,
      instanceType: item.InstanceType
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
