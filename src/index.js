import { createApp } from './app.js';
import { config } from './config/env.js';
import { pool } from './db/pool.js';

async function main() {
  const { app, apollo } = await createApp();

  const server = app.listen(config.port, () => {
    console.log(`🚀 Server ready at http://localhost:${config.port}`);
    console.log(`   GraphQL:    http://localhost:${config.port}/graphql`);
    console.log(`   Health:     http://localhost:${config.port}/health`);
  });

  // Graceful shutdown.
  const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down...`);
    server.close();
    await apollo.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
