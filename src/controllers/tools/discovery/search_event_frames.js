import { z } from 'zod';
import { Paging } from '../../../domain/values/Paging.js';
import { TimeRange } from '../../../domain/values/TimeRange.js';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';

export const searchEventFramesTool = {
  name: 'pi.discovery.search_event_frames',
  description: 'Time-bounded discovery of AF event frames in a database',
  inputSchema: {
    database: z.string().describe('WebID or Path of the AF Database'),
    searchMode: z.enum([
      'Overlapped', 'Inclusive', 'InProgress',
      'BackwardFromStartTime', 'ForwardFromStartTime',
      'BackwardFromEndTime', 'ForwardFromEndTime',
      'BackwardInProgress', 'ForwardInProgress'
    ]).default('Overlapped').optional(),
    startTime: z.string().optional().describe('PI relative or absolute start time'),
    endTime: z.string().optional().describe('PI relative or absolute end time'),
    nameFilter: z.string().optional().describe('Filter by event frame name'),
    categoryName: z.string().optional().describe('Filter by category name'),
    templateName: z.string().optional().describe('Filter by template name'),
    referencedElementNameFilter: z.string().optional().describe('Filter by referenced element name'),
    severity: z.enum(['None', 'Information', 'Warning', 'Minor', 'Major', 'Critical']).default('None').optional(),
    searchFullHierarchy: z.boolean().default(false).optional(),
    pageSize: z.coerce.number().int().min(1).max(1000).default(100).optional(),
    pageToken: z.string().optional()
  },
  async handler(args, context) {
    const { gateway, signal } = context;
    const {
      database, searchMode = 'Overlapped', startTime, endTime,
      nameFilter, categoryName, templateName, referencedElementNameFilter,
      severity = 'None', searchFullHierarchy = false, pageSize = 100, pageToken
    } = args;

    // Backward*/Forward* modes anchor on startTime; PI rejects endTime with them.
    const directionalMode = /^(Backward|Forward)/.test(searchMode);
    if (directionalMode && endTime) {
      throw new AppError({
        category: ErrorCategory.INVALID_INPUT,
        retryable: false,
        message: `searchMode '${searchMode}' anchors on startTime; endTime is not allowed with Backward*/Forward* modes`
      });
    }

    // Validate times if provided
    let range = null;
    if (startTime || endTime) {
      try {
        range = new TimeRange(startTime || '*-1d', endTime || '*');
      } catch (err) {
        throw new AppError({
          category: ErrorCategory.INVALID_INPUT,
          retryable: false,
          message: `Time range validation failed: ${err.message}`
        });
      }
    }

    let dbWebId = database;
    if (database.startsWith('\\\\')) {
      dbWebId = await gateway.resolvePathToWebId(database, 'database', signal);
    }

    // Pagination setup
    const queryHash = Paging.generateQueryHash({
      dbWebId, searchMode,
      startTime: range?.startTime, endTime: range?.endTime,
      nameFilter, categoryName, templateName, referencedElementNameFilter,
      severity, searchFullHierarchy
    });
    const paging = pageToken
      ? Paging.parseToken(pageToken, queryHash)
      : new Paging({ startIndex: 0, pageSize, queryHash });

    const basePath = new URL(gateway.config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    const searchParams = new URLSearchParams();
    searchParams.set('searchMode', searchMode);
    if (range) {
      searchParams.set('startTime', range.startTime);
      if (!directionalMode) searchParams.set('endTime', range.endTime);
    }
    if (nameFilter) searchParams.set('nameFilter', nameFilter);
    if (categoryName) searchParams.set('categoryName', categoryName);
    if (templateName) searchParams.set('templateName', templateName);
    if (referencedElementNameFilter) searchParams.set('referencedElementNameFilter', referencedElementNameFilter);
    if (severity && severity !== 'None') searchParams.set('severity', severity);
    searchParams.set('searchFullHierarchy', String(searchFullHierarchy));
    searchParams.set('startIndex', String(paging.startIndex));
    searchParams.set('maxCount', String(paging.pageSize));
    searchParams.set('selectedFields', 'Items.WebId;Items.Name;Items.StartTime;Items.EndTime;Items.TemplateName;Items.Path');
    searchParams.set('webIdType', 'IDOnly');

    const url = `${basePath}/assetdatabases/${dbWebId}/eventframes?${searchParams.toString()}`;
    const res = await gateway.request('GET', url, null, signal);
    
    const items = (res.Items || []).map(item => ({
      webId: item.WebId,
      name: item.Name,
      startTime: item.StartTime,
      endTime: item.EndTime,
      templateName: item.TemplateName,
      path: item.Path
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
