import { z } from 'zod';

export const listCategoriesTool = {
  name: 'pi.discovery.list_categories',
  description: 'List element categories in an AF database (used to build/interpret categoryName filters)',
  inputSchema: {
    database: z.string().describe('WebID or Path of the AF Database')
  },
  async handler(args, context) {
    const { gateway, signal } = context;
    const { database } = args;

    let dbWebId = database;
    if (database.startsWith('\\\\')) {
      dbWebId = await gateway.resolvePathToWebId(database, 'database', signal);
    }

    const basePath = new URL(gateway.config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const searchParams = new URLSearchParams();
    searchParams.set('selectedFields', 'Items.WebId;Items.Name;Items.Path');
    searchParams.set('webIdType', 'IDOnly');

    const url = `${basePath}/assetdatabases/${dbWebId}/elementcategories?${searchParams.toString()}`;
    const res = await gateway.request('GET', url, null, signal);
    
    const items = (res.Items || []).map(item => ({
      webId: item.WebId,
      name: item.Name,
      path: item.Path
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(items, null, 2)
        }
      ]
    };
  }
};
