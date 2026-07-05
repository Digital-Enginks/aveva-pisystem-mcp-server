import { z } from 'zod';
import { Paging } from '../../../domain/values/Paging.js';

export const listChildElementsTool = {
  name: 'pi.discovery.list_child_elements',
  description: 'Drill-down: list/search child elements of one element',
  inputSchema: {
    element: z.string().describe('WebID or Path of the parent AF Element'),
    nameFilter: z.string().optional().describe('Filter by child element name (supports wildcards * and ?)'),
    templateName: z.string().optional().describe('Filter by template name'),
    categoryName: z.string().optional().describe('Filter by category name'),
    elementType: z.enum(['Any', 'Standard', 'Template', 'Analyses', 'EnumerationValues', 'NotificationRules']).default('Any').optional(),
    searchFullHierarchy: z.boolean().default(false).optional().describe('True to search recursively down the child element tree'),
    pageSize: z.coerce.number().int().min(1).max(1000).default(100).optional(),
    pageToken: z.string().optional()
  },
  async handler(args, context) {
    const { gateway, signal } = context;
    const { 
      element, nameFilter, templateName, categoryName, 
      elementType = 'Any', searchFullHierarchy = false, pageSize = 100, pageToken 
    } = args;

    let elementWebId = element;
    if (element.startsWith('\\\\')) {
      elementWebId = await gateway.resolvePathToWebId(element, 'element', signal);
    }

    // Pagination setup
    const queryHash = Paging.generateQueryHash({ 
      elementWebId, nameFilter, templateName, categoryName, elementType, searchFullHierarchy 
    });
    const paging = pageToken
      ? Paging.parseToken(pageToken, queryHash)
      : new Paging({ startIndex: 0, pageSize, queryHash });

    const basePath = new URL(gateway.config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const searchParams = new URLSearchParams();
    if (nameFilter) searchParams.set('nameFilter', nameFilter);
    if (templateName) searchParams.set('templateName', templateName);
    if (categoryName) searchParams.set('categoryName', categoryName);
    if (elementType && elementType !== 'Any') searchParams.set('elementType', elementType);
    searchParams.set('searchFullHierarchy', String(searchFullHierarchy));
    searchParams.set('startIndex', String(paging.startIndex));
    searchParams.set('maxCount', String(paging.pageSize));
    searchParams.set('selectedFields', 'Items.WebId;Items.Name;Items.Path;Items.TemplateName;Items.HasChildren');
    searchParams.set('webIdType', 'IDOnly');

    const url = `${basePath}/elements/${elementWebId}/elements?${searchParams.toString()}`;
    const res = await gateway.request('GET', url, null, signal);
    
    const items = (res.Items || []).map(item => ({
      webId: item.WebId,
      name: item.Name,
      path: item.Path,
      templateName: item.TemplateName,
      hasChildren: Boolean(item.HasChildren)
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
