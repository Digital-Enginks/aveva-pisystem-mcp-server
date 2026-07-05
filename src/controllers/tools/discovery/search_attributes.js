import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { Paging } from '../../../domain/values/Paging.js';

export const searchAttributesTool = {
  name: 'pi.discovery.search_attributes',
  description: 'Find AF attributes - database-wide or per-element scope',
  inputSchema: {
    scope: z.enum(['database', 'element']).describe('Search scope: database-wide or per-element'),
    target: z.string().describe('WebID or Path of the target AF Database or AF Element'),
    nameFilter: z.string().optional().describe('Filter by attribute name (supports wildcards * and ?)'),
    categoryName: z.string().optional().describe('Filter by category name (element scope)'),
    templateName: z.string().optional().describe('Filter by attribute template name (element scope)'),
    valueType: z.string().optional().describe('Filter by attribute value type, e.g., Double, Int32 (element scope)'),
    searchFullHierarchy: z.boolean().default(false).optional().describe('True to search all sub-elements recursively'),
    showExcluded: z.boolean().default(false).optional().describe('True to show excluded attributes (element scope)'),
    showHidden: z.boolean().default(false).optional().describe('True to show hidden attributes (element scope)'),
    pageSize: z.coerce.number().int().min(1).max(1000).default(100).optional(),
    pageToken: z.string().optional()
  },
  async handler(args, context) {
    const { gateway, signal } = context;
    const {
      scope, target, nameFilter, categoryName, templateName, valueType,
      searchFullHierarchy = false, showExcluded = false, showHidden = false, pageSize = 100, pageToken
    } = args;

    // categoryName/templateName/valueType/showExcluded/showHidden only apply to the
    // element-scoped attribute collection, not the database-wide attribute search.
    if (scope === 'database' && (categoryName || templateName || valueType || showExcluded || showHidden)) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: 'Parameters categoryName, templateName, valueType, showExcluded, showHidden are only supported on element-scoped searches.'
      });
    }

    let targetWebId = target;
    if (target.startsWith('\\\\')) {
      targetWebId = await gateway.resolvePathToWebId(target, scope, signal);
    }

    // Pagination setup
    const queryHash = Paging.generateQueryHash({
      scope, targetWebId, nameFilter, categoryName, templateName, valueType,
      searchFullHierarchy, showExcluded, showHidden
    });
    const paging = pageToken
      ? Paging.parseToken(pageToken, queryHash)
      : new Paging({ startIndex: 0, pageSize, queryHash });

    const basePath = new URL(gateway.config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const searchParams = new URLSearchParams();
    searchParams.set('searchFullHierarchy', String(searchFullHierarchy));
    searchParams.set('startIndex', String(paging.startIndex));
    searchParams.set('maxCount', String(paging.pageSize));
    searchParams.set('selectedFields', 'Items.WebId;Items.Name;Items.Path;Items.Type;Items.DefaultUnitsName;Items.DataReferencePlugIn');
    searchParams.set('webIdType', 'IDOnly');

    let url = '';
    if (scope === 'database') {
      if (nameFilter) searchParams.set('attributeNameFilter', nameFilter);
      url = `${basePath}/assetdatabases/${targetWebId}/elementattributes?${searchParams.toString()}`;
    } else {
      if (nameFilter) searchParams.set('nameFilter', nameFilter);
      if (categoryName) searchParams.set('categoryName', categoryName);
      if (templateName) searchParams.set('templateName', templateName);
      if (valueType) searchParams.set('valueType', valueType);
      searchParams.set('showExcluded', String(showExcluded));
      searchParams.set('showHidden', String(showHidden));
      url = `${basePath}/elements/${targetWebId}/attributes?${searchParams.toString()}`;
    }

    const res = await gateway.request('GET', url, null, signal);
    
    const items = (res.Items || []).map(item => ({
      webId: item.WebId,
      name: item.Name,
      path: item.Path,
      type: item.Type,
      defaultUnitsName: item.DefaultUnitsName,
      dataReferencePlugIn: item.DataReferencePlugIn
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
