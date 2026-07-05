import { z } from 'zod';

export const listAssetServersTool = {
  name: 'pi.discovery.list_asset_servers',
  description: 'Enumerate PI AF asset servers; entry point for AF discovery',
  inputSchema: {},
  async handler(args, context) {
    const { gateway, signal } = context;
    const basePath = new URL(gateway.config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    
    const searchParams = new URLSearchParams();
    searchParams.set('selectedFields', 'Items.WebId;Items.Name;Items.Path;Items.IsConnected;Items.ServerVersion');
    searchParams.set('webIdType', 'IDOnly');

    const res = await gateway.request('GET', `${basePath}/assetservers?${searchParams.toString()}`, null, signal);
    const items = (res.Items || []).map(item => ({
      webId: item.WebId,
      name: item.Name,
      path: item.Path,
      isConnected: Boolean(item.IsConnected),
      serverVersion: item.ServerVersion
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
