/**
 * GraphQL schema (SDL).
 *
 * This is a placeholder. Drop your real schema in here later — add types,
 * queries, and mutations. The `_health` query exists so the server has at
 * least one valid root field to start with.
 *
 * Tip: as the schema grows, split this into multiple files and combine them
 * with an array of typeDefs, e.g. `typeDefs: [base, patient, billing]`.
 */
export const typeDefs = /* GraphQL */ `
  type Query {
    """Liveness probe — returns "ok" when the GraphQL server is up."""
    _health: String!

    """Verifies the server can reach PostgreSQL."""
    _dbHealth: Boolean!
  }
`;
