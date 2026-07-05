import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { handleMcpError } from '../errors/to-mcp.js';

const { version: packageVersion } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
);

// Discovery Tools
import { listDataServersTool } from '../controllers/tools/discovery/list_data_servers.js';
import { listAssetServersTool } from '../controllers/tools/discovery/list_asset_servers.js';
import { listAssetDatabasesTool } from '../controllers/tools/discovery/list_asset_databases.js';
import { searchPointsTool } from '../controllers/tools/discovery/search_points.js';
import { searchElementsTool } from '../controllers/tools/discovery/search_elements.js';
import { listChildElementsTool } from '../controllers/tools/discovery/list_child_elements.js';
import { searchAttributesTool } from '../controllers/tools/discovery/search_attributes.js';
import { searchEventFramesTool } from '../controllers/tools/discovery/search_event_frames.js';
import { listTemplatesTool } from '../controllers/tools/discovery/list_templates.js';
import { listCategoriesTool } from '../controllers/tools/discovery/list_categories.js';
import { resolvePointTool } from '../controllers/tools/discovery/resolve_point.js';

// Data Retrieval Tools
import { getValueTool } from '../controllers/tools/data/get_value.js';
import { getValueMultiTool } from '../controllers/tools/data/get_value_multi.js';
import { getEndTool } from '../controllers/tools/data/get_end.js';
import { readRecordedTool } from '../controllers/tools/data/read_recorded.js';
import { readRecordedMultiTool } from '../controllers/tools/data/read_recorded_multi.js';
import { readInterpolatedTool } from '../controllers/tools/data/read_interpolated.js';
import { readInterpolatedMultiTool } from '../controllers/tools/data/read_interpolated_multi.js';
import { readInterpolatedAtTimesTool } from '../controllers/tools/data/read_interpolated_attimes.js';
import { readPlotTool } from '../controllers/tools/data/read_plot.js';
import { readSummaryTool } from '../controllers/tools/data/read_summary.js';
import { readSummaryMultiTool } from '../controllers/tools/data/read_summary_multi.js';

// Ingestion/Write Tools
import { writeValueTool } from '../controllers/tools/write/write_value.js';
import { writeValuesTool } from '../controllers/tools/write/write_values.js';
import { writeValuesMultiTool } from '../controllers/tools/write/write_values_multi.js';

// Meta status
import { serverStatusTool } from '../controllers/tools/meta/server_status.js';

const READ_TOOLS = [
  listDataServersTool,
  listAssetServersTool,
  listAssetDatabasesTool,
  searchPointsTool,
  searchElementsTool,
  listChildElementsTool,
  searchAttributesTool,
  searchEventFramesTool,
  listTemplatesTool,
  listCategoriesTool,
  resolvePointTool,
  getValueTool,
  getValueMultiTool,
  getEndTool,
  readRecordedTool,
  readRecordedMultiTool,
  readInterpolatedTool,
  readInterpolatedMultiTool,
  readInterpolatedAtTimesTool,
  readPlotTool,
  readSummaryTool,
  readSummaryMultiTool,
  serverStatusTool
];

const WRITE_TOOLS = [writeValueTool, writeValuesTool, writeValuesMultiTool];

// MCP tool annotations are advisory hints for clients. Reads never mutate PI and
// are safely repeatable; writes append to (and may overwrite) the PI archive, so
// they are flagged destructive and non-idempotent. Every tool talks to an external
// PI System, so openWorldHint is true throughout.
const READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true
});

const WRITE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
});

/**
 * Build an McpServer with every permitted tool registered.
 *
 * Stateless HTTP mode constructs a fresh server per request and passes the
 * caller authenticated at the transport edge via `authContext`; stdio mode
 * builds the server once and passes `authContext: null` (local trust).
 *
 * @param {object} config           Validated configuration.
 * @param {object} logger           Root logger.
 * @param {{generate: () => string}} idProvider  Correlation-id source.
 * @param {object} gateway          PI Web API gateway adapter.
 * @param {?{authorizeWrite: () => void}} [authContext]  Per-request edge caller; null for stdio.
 */
export function buildServer(config, logger, idProvider, gateway, authContext = null) {
  const server = new McpServer(
    {
      name: config.MCP_SERVER_NAME,
      version: config.MCP_SERVER_VERSION || packageVersion
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  const register = (tool, annotations, requiresWrite) => {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations
      },
      async (args, extra) => {
        const correlationId = idProvider.generate();
        const reqLogger = logger.child({ correlationId, tool: tool.name });

        try {
          // Write authorization is decided per call against the caller that was
          // authenticated at the transport edge. There is no edge caller over
          // stdio (local trust), so authContext is null and the registration
          // gate below is the only control.
          if (requiresWrite && authContext) {
            authContext.authorizeWrite();
          }

          return await tool.handler(args, {
            logger: reqLogger,
            config,
            gateway,
            signal: extra?.signal,
            correlationId
          });
        } catch (err) {
          reqLogger.error('Tool execution failed', { error: err.message });
          return handleMcpError(err);
        }
      }
    );
  };

  for (const tool of READ_TOOLS) {
    register(tool, READ_ANNOTATIONS, false);
  }

  // Write tools are only registered — and therefore only advertised in
  // tools/list — when writes are explicitly enabled. A disabled capability is
  // never exposed. (config.superRefine guarantees that enabling writes over HTTP
  // also requires edge auth and a non-empty MCP_EDGE_WRITE_ROLES.)
  if (config.MCP_WRITE_TOOLS_ENABLED) {
    for (const tool of WRITE_TOOLS) {
      register(tool, WRITE_ANNOTATIONS, true);
    }
  }

  return server;
}
