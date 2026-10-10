// Dockyard — Drizzle ORM schema (drizzle-orm/pg-core).
//
// This file describes the CURRENT, post-squash shape of the Dockyard database:
// the exact DDL of migrations/001_init.sql as amended by 002..006. It is the
// source of truth for `drizzle-kit generate`; the generated migration under
// server/drizzle/ recreates a fresh database in one shot.
//
// Notes on fidelity (why some names are set explicitly):
//   * Every CHECK constraint carries the name Postgres assigned to the inline
//     column check in the original DDL (e.g. templates_source_check), because the
//     legacy migrations drop/recreate those checks by name. The check text is
//     written to match the FINAL, widened form only — the intermediate
//     ('builtin','user') / ('builtin','user','file') states never appear.
//   * Foreign keys are declared with the `foreignKey()` helper and an explicit
//     `name` so the constraint names match Postgres's auto-naming
//     (<table>_<column>_fkey) rather than Drizzle's default
//     (<table>_<column>_<reftable>_<refcol>_fk).
//   * UNIQUE columns use the table-level `unique()` helper with an explicit name
//     for the same reason (<table>_<column>_key).
//   * `schema_migrations` is deliberately NOT defined: it belongs to the legacy
//     file-based runner, not to the application schema, and Drizzle keeps its own
//     journal.
//
// The file is plain, erasable TypeScript (no `enum`, no decorators) so Node's
// native type stripping can load it directly.

import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('admin'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    // Added by 002_scopes.sql.
    scopeMode: text('scope_mode').notNull().default('all'),
    canExec: boolean('can_exec').notNull().default(false),
  },
  (t) => [
    unique('users_email_key').on(t.email),
    check('users_role_check', sql`${t.role} in ('admin', 'operator', 'viewer')`),
    check('users_scope_mode_check', sql`${t.scopeMode} in ('all', 'granted')`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
    foreignKey({
      name: 'sessions_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    detail: jsonb('detail'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Plain `created_at DESC` (Postgres default null ordering, NULLS FIRST).
    // Drizzle's `.desc()` renders as `DESC NULLS LAST`, which is a different
    // index, so the ordering is written as raw SQL to match the live database.
    index('audit_log_created_at_idx').on(sql`${t.createdAt} desc`),
    foreignKey({
      name: 'audit_log_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('set null'),
  ],
);

export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull().default('other'),
    icon: text('icon').notNull().default('package'),
    description: text('description').notNull().default(''),
    spec: jsonb('spec').notNull(),
    // FINAL value set after 006_repo_is_the_source.sql: 'builtin' was removed and
    // its rows deleted, leaving user/file/remote.
    source: text('source').notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('templates_slug_key').on(t.slug),
    index('templates_source_idx').on(t.source),
    check('templates_source_check', sql`${t.source} in ('user', 'file', 'remote')`),
  ],
);

export const stacks = pgTable(
  'stacks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    source: text('source').notNull().default('template'),
    templateSlug: text('template_slug'),
    spec: jsonb('spec').notNull().default(sql`'{}'::jsonb`),
    values: jsonb('values').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('running'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stacks_slug_idx').on(t.slug),
    check('stacks_source_check', sql`${t.source} in ('template', 'user')`),
    check('stacks_status_check', sql`${t.status} in ('running', 'stopped', 'partial', 'error')`),
    foreignKey({
      name: 'stacks_created_by_fkey',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
  ],
);

export const tunnels = pgTable(
  'tunnels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // FINAL value set after 003_localtunnel.sql: 'localtunnel' was added.
    mode: text('mode').notNull(),
    targetUrl: text('target_url').notNull(),
    containerId: text('container_id'),
    port: integer('port'),
    hostname: text('hostname'),
    zoneId: text('zone_id'),
    tunnelId: text('tunnel_id'),
    credentialsPath: text('credentials_path'),
    configPath: text('config_path'),
    status: text('status').notNull().default('stopped'),
    url: text('url'),
    pid: integer('pid'),
    lastError: text('last_error'),
    autoStart: boolean('auto_start').notNull().default(false),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tunnels_mode_check', sql`${t.mode} in ('quick', 'named', 'localtunnel')`),
    check('tunnels_status_check', sql`${t.status} in ('stopped', 'starting', 'running', 'error')`),
    foreignKey({
      name: 'tunnels_created_by_fkey',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
  ],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  secret: boolean('secret').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userGrants = pgTable(
  'user_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    resourceKind: text('resource_kind').notNull(),
    resourceId: text('resource_id'),
    labelKey: text('label_key'),
    labelValue: text('label_value'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('user_grants_user_id_idx').on(t.userId),
    uniqueIndex('user_grants_unique_idx').on(
      t.userId,
      t.resourceKind,
      sql`coalesce(${t.resourceId}, '')`,
      sql`coalesce(${t.labelKey}, '')`,
      sql`coalesce(${t.labelValue}, '')`,
    ),
    check(
      'user_grants_resource_kind_check',
      sql`${t.resourceKind} in ('container', 'stack', 'volume', 'network', 'image', 'template', 'tunnel')`,
    ),
    // Exactly one selector form: either an explicit resource id, or a label pair.
    check(
      'user_grants_selector',
      sql`(${t.resourceId} is not null and ${t.labelKey} is null and ${t.labelValue} is null) or (${t.resourceId} is null and ${t.labelKey} is not null and ${t.labelValue} is not null)`,
    ),
    check('user_grants_label_nonempty', sql`${t.labelKey} is null or length(trim(${t.labelKey})) > 0`),
    foreignKey({
      name: 'user_grants_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'user_grants_created_by_fkey',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
  ],
);
