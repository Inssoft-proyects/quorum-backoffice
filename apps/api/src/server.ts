/**
 * HTTP server entrypoint. Imports buildApp, listens on API_PORT, and shuts
 * down gracefully on SIGTERM/SIGINT.
 */
import { buildApp } from './app';

async function main(): Promise<void> {
  const app = await buildApp();

  const host = app.config.API_HOST;
  const port = app.config.API_PORT;

  await app.listen({ host, port });
  app.log.info({ host, port }, 'server_listening');

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutdown_signal_received');
    try {
      await app.close();
      app.log.info('shutdown_complete');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown_failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal_startup_error', err);
  process.exit(1);
});
