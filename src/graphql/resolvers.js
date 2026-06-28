import { healthcheck } from '../db/pool.js';

/**
 * Resolver map. Mirror the structure of your typeDefs here.
 * Each resolver receives (parent, args, context, info).
 * `context.db` exposes the query helpers — see ../context.js.
 */
export const resolvers = {
  Query: {
    _health: () => 'ok',
    _dbHealth: async () => {
      try {
        return await healthcheck();
      } catch {
        return false;
      }
    },
  },
};
