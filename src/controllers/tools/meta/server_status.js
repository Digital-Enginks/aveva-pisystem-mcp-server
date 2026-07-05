import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';

export const serverStatusTool = {
  name: 'pi.meta.server_status',
  description: 'Report PI Web API status and configuration for health checks (requires admin privileges and MCP_ADMIN_IDENTITY_CONFIGURED)',
  inputSchema: {},
  async handler(args, context) {
    const { gateway, signal, config } = context;

    if (!config.MCP_ADMIN_IDENTITY_CONFIGURED) {
      throw new AppError({
        category: ErrorCategory.FEATURE_DISABLED,
        retryable: false,
        message: 'Admin status queries are disabled on this server because no admin-capable identity is configured.'
      });
    }

    const basePath = new URL(gateway.config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    
    // Query status
    const status = await gateway.request('GET', `${basePath}/system/status`, null, signal);
    
    // Query configuration for version info
    let version = null;
    try {
      const configRes = await gateway.request('GET', `${basePath}/system/configuration`, null, signal);
      version = configRes?.Version || configRes?.Items?.find(c => c.Name === 'Version')?.Value || null;
    } catch (_) {
      // Configuration read might fail if permission is strictly status-only
    }

    const result = {
      upTime: status?.UpTime || null,
      state: status?.State || null,
      serverVersion: version || status?.ServerVersion || 'Unknown'
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
