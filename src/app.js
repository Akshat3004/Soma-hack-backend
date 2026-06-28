import express from 'express';
import cors from 'cors';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';

import { typeDefs } from './graphql/typeDefs.js';
import { resolvers } from './graphql/resolvers.js';
import { buildContext } from './graphql/context.js';
import { healthcheck } from './db/pool.js';

/**
 * Creates the Express app with Apollo GraphQL mounted at /graphql.
 * Returns { app, apollo } so the caller controls start/stop lifecycle.
 */
export async function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Plain REST health endpoint (handy for load balancers / quick curls).
  app.get('/health', async (_req, res) => {
    let db = false;
    try {
      db = await healthcheck();
    } catch {
      db = false;
    }
    res.json({ status: 'ok', db });
  });

  const apollo = new ApolloServer({
    typeDefs,
    resolvers,
  });
  await apollo.start();

  app.use(
    '/graphql',
    expressMiddleware(apollo, {
      context: buildContext,
    }),
  );

  return { app, apollo };
}
