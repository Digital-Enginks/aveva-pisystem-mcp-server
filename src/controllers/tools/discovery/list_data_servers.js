import { z } from 'zod';

export const listDataServersTool = {
  name: 'pi.discovery.list_data_servers',
  description: 'Enumerate PI Data Archive servers; entry point yielding the Data Archive WebID for tag search',
  inputSchema: {
    name: z.string().optional(),
    path: z.string().optional()
  },
  async handler(args, context) {
    const { gateway, signal } = context;
    const basePath = new URL(gateway.config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    
    const searchParams = new URLSearchParams();
    if (args.name) searchParams.set('name', args.name);
    if (args.path) searchParams.set('path', args.path);
    searchParams.set('selectedFields', 'Items.WebId;Items.Name;Items.Path;Items.IsConnected;Items.ServerVersion');
    searchParams.set('webIdType', 'IDOnly');

    const res = await gateway.request('GET', `${basePath}/dataservers?${searchParams.toString()}`, null, signal);
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
