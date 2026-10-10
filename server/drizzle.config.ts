import { defineConfig } from 'drizzle-kit';

// Drizzle Kit config for the Dockyard server.
//
// Run from the server/ directory:  npx drizzle-kit generate
//
// `schema` is the single source of truth for the current (post-squash) shape;
// `out` receives the generated SQL and its meta journal. dbCredentials is only
// consulted by the commands that actually talk to a database (migrate/studio),
// never by `generate`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
