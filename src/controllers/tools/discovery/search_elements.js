import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { Paging } from '../../../domain/values/Paging.js';

export const searchElementsTool = {
  name: 'pi.discovery.search_elements',
  description: 'Search AF elements in a database (primary asset discovery); supports AFSearch filters',
  inputSchema: {
    database: z.string().describe('WebID or Path of the AF Database'),
    nameFilter: z.string().optional().describe('Filter by element name (supports wildcards * and ?)'),
    templateName: z.string().optional().describe('Filter by element template name'),
    categoryName: z.string().optional().describe('Filter by category name'),
    elementType: z.enum(['Any', 'Standard', 'Template', 'Analyses', 'EnumerationValues', 'NotificationRules']).default('Any').optional(),
    searchFullHierarchy: z.boolean().default(false).optional().describe('True to search all levels, false for database root children only'),
    pageSize: z.coerce.number().int().min(1).max(1000).default(100).optional(),
    pageToken: z.string().optional()
  },
  async handler(args, context) {
    const { gateway, signal } = context;
    const {
      database, nameFilter, templateName, categoryName,
      elementType = 'Any', searchFullHierarchy = false, pageSize = 100, pageToken
    } = args;

    // Narrowing filter check
    if (!nameFilter && !templateName && !categoryName) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'Must supply at least one of nameFilter, templateName, or categoryName to narrow the search scope'
      });
    }

    let dbWebId = database;
    if (database.startsWith('\\\\')) {
      dbWebId = await gateway.resolvePathToWebId(database, 'database', signal);
    }

    // Pagination setup
    const queryHash = Paging.generateQueryHash({
      dbWebId, nameFilter, templateName, categoryName, elementType, searchFullHierarchy
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
    searchParams.set('selectedFields', 'Items.WebId;Items.Name;Items.Path;Items.TemplateName;Items.CategoryNames;Items.HasChildren');
    searchParams.set('webIdType', 'IDOnly');

    const url = `${basePath}/assetdatabases/${dbWebId}/elements?${searchParams.toString()}`;
    const res = await gateway.request('GET', url, null, signal);
    
    const items = (res.Items || []).map(item => ({
      webId: item.WebId,
      name: item.Name,
      path: item.Path,
      templateName: item.TemplateName,
      categoryNames: item.CategoryNames || [],
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
