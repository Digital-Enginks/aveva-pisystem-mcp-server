import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export function createStdioTransport() {
  // Guard stdout from any accidental pollution: console.log, console.info and
  // console.debug all write to fd1 and would corrupt the JSON-RPC stream.
  const originals = {
    log: console.log,
    info: console.info,
    debug: console.debug
  };
  for (const method of Object.keys(originals)) {
    console[method] = function (...args) {
      console.error('[STDOUT POLLUTION GUARDED]:', ...args);
    };
  }

  const transport = new StdioServerTransport();

  // Expose a cleanup method to restore the original console methods if needed
  transport.restoreConsole = () => {
    for (const [method, fn] of Object.entries(originals)) {
      console[method] = fn;
    }
  };

  return transport;
}
