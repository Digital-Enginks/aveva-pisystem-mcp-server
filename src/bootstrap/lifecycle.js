import process from 'node:process';

export class LifecycleManager {
  #logger;
  #shutdownFunctions;
  #isShuttingDown;

  constructor(logger) {
    this.#logger = logger;
    this.#shutdownFunctions = [];
    this.#isShuttingDown = false;
  }

  registerShutdown(name, fn) {
    this.#shutdownFunctions.push({ name, fn });
  }

  async runProbes(probes = []) {
    this.#logger.info('Executing startup health probes');
    for (const probe of probes) {
      try {
        await probe.fn();
        this.#logger.info(`Startup probe succeeded: ${probe.name}`);
      } catch (err) {
        this.#logger.fatal(`Startup probe failed: ${probe.name}`, { error: err.message });
        throw err;
      }
    }
  }

  setupSignalHandlers() {
    const handleSignal = async (signal) => {
      if (this.#isShuttingDown) {
        this.#logger.warn(`Received ${signal} but shutdown is already in progress`);
        return;
      }

      this.#isShuttingDown = true;
      this.#logger.info(`Received ${signal}, initiating graceful shutdown`);

      // Set timeout for hard exit
      const timer = setTimeout(() => {
        this.#logger.error('Shutdown timed out, forcing exit');
        process.exit(1);
      }, 10000);
      timer.unref();

      for (const item of this.#shutdownFunctions) {
        try {
          this.#logger.info(`Running shutdown hook: ${item.name}`);
          await item.fn();
        } catch (err) {
          this.#logger.error(`Error during shutdown hook: ${item.name}`, { error: err.message });
        }
      }

      clearTimeout(timer);
      this.#logger.info('Graceful shutdown completed successfully');
      process.exit(0);
    };

    process.on('SIGINT', () => handleSignal('SIGINT'));
    process.on('SIGTERM', () => handleSignal('SIGTERM'));
  }

  setupProcessErrorHandlers() {
    const handleFatal = async (kind, err) => {
      // Logger redacts via pino config; never let the raw error hit stdout.
      this.#logger.fatal(`${kind}, initiating shutdown`, { error: err?.message || String(err) });

      if (this.#isShuttingDown) {
        process.exit(1);
      }
      this.#isShuttingDown = true;

      const timer = setTimeout(() => {
        process.exit(1);
      }, 10000);
      timer.unref();

      for (const item of this.#shutdownFunctions) {
        try {
          await item.fn();
        } catch (hookErr) {
          this.#logger.error(`Error during shutdown hook: ${item.name}`, { error: hookErr.message });
        }
      }
      process.exit(1);
    };

    process.on('unhandledRejection', (reason) => handleFatal('Unhandled promise rejection', reason));
    process.on('uncaughtException', (err) => handleFatal('Uncaught exception', err));
  }
}
