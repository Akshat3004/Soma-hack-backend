import { query, getClient, pool } from '../db/pool.js';

/**
 * Builds the per-request GraphQL context. Resolvers reach the database
 * through `context.db` rather than importing the pool directly — this keeps
 * resolvers testable and gives you one place to add auth, loaders, etc.
 */
export async function buildContext({ req }) {
  return {
    req,
    db: { query, getClient, pool },
    // Add authenticated user, DataLoaders, request id, etc. here later.
  };
}
