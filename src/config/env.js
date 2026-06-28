import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  pccBaseUrl: process.env.PCC_BASE_URL || 'https://hackathon.prod.pulsefoundry.ai',

  // Prefer DATABASE_URL; otherwise fall back to discrete PG* vars.
  databaseUrl: process.env.DATABASE_URL || null,
  // Enable SSL for managed/remote Postgres (Render, Heroku, Supabase, etc.).
  dbSsl: process.env.PGSSL === 'true',
  db: {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'aib_pulse',
  },
};
