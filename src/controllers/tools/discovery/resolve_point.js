import { z } from 'zod';

export const resolvePointTool = {
  name: 'pi.discovery.resolve_point',
  description: 'Resolve/inspect a single PI Point after discovery (verify writability and metadata properties)',
  inputSchema: {
    point: z.string().describe('WebID or Path of the PI Point')
  },
  async handler(args, context) {
    const { gateway, signal } = context;
    const { point } = args;

    let targetWebId = point;
    if (point.startsWith('\\\\')) {
      targetWebId = await gateway.resolvePathToWebId(point, 'point', signal);
    }

    const basePath = new URL(gateway.config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const searchParams = new URLSearchParams();
    searchParams.set('selectedFields', 'WebId;Name;Path;PointType;EngineeringUnits;DigitalSetName;Span;Zero;Future');
    searchParams.set('webIdType', 'Full');

    const url = `${basePath}/points/${targetWebId}?${searchParams.toString()}`;
    const res = await gateway.request('GET', url, null, signal);
    
    const details = {
      webId: res.WebId,
      name: res.Name,
      path: res.Path,
      pointType: res.PointType,
      engineeringUnits: res.EngineeringUnits,
      digitalSetName: res.DigitalSetName,
      span: res.Span,
      zero: res.Zero,
      future: Boolean(res.Future)
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(details, null, 2)
        }
      ]
    };
  }
};
