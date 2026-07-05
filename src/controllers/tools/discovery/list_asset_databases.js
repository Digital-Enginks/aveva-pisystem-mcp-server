import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';

export const listAssetDatabasesTool = {
  name: 'pi.discovery.list_asset_databases',
  description: 'List AF databases on a given AF server',
  inputSchema: {
    webId: z.string().optional(),
    path: z.string().optional()
  },
  async handler(args, context) {
    const { gateway, signal } = context;
    const { webId, path } = args;

    // Mutually exclusive validation
    if ((!webId && !path) || (webId && path)) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'Must supply exactly one of webId or path'
      });
    }

    let targetWebId = webId;
    if (path) {
      targetWebId = await gateway.resolvePathToWebId(path, 'assetserver', signal);
    }

    const basePath = new URL(gateway.config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const searchParams = new URLSearchParams();
    searchParams.set('selectedFields', 'Items.WebId;Items.Name;Items.Path;Items.Description');
    searchParams.set('webIdType', 'IDOnly');

    const url = `${basePath}/assetservers/${targetWebId}/assetdatabases?${searchParams.toString()}`;
    const res = await gateway.request('GET', url, null, signal);
    
    const items = (res.Items || []).map(item => ({
      webId: item.WebId,
      name: item.Name,
      path: item.Path,
      description: item.Description
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
