-- Dockyard — initial (squashed) schema.
--
-- This is the single migration for a fresh database: the exact DDL of the six
-- hand-written migrations that predate Drizzle (001_init .. 006_repo_is_the_source,
-- now in git history) folded down to their FINAL state. Intermediate shapes never
-- appear — the two constraints that were widened over time are written once, in
-- their final form:
--
--   templates.source  user | file | remote          (widened by 004, 005, 006)
--   tunnels.mode      quick | named | localtunnel   (widened by 003)
--
-- Every statement is idempotent (IF NOT EXISTS) and every constraint is declared
-- inline in its CREATE TABLE, so this file is a safe no-op when it is applied to
-- an existing database that already has the tables, indexes and constraints.
-- Drizzle's migrator splits the file on its statement-breakpoint markers, so
-- that exact marker text must not appear anywhere except between statements.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"scope_mode" text DEFAULT 'all' NOT NULL,
	"can_exec" boolean DEFAULT false NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('admin', 'operator', 'viewer')),
	CONSTRAINT "users_scope_mode_check" CHECK ("users"."scope_mode" in ('all', 'granted'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"detail" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"icon" text DEFAULT 'package' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"spec" jsonb NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_slug_key" UNIQUE("slug"),
	CONSTRAINT "templates_source_check" CHECK ("templates"."source" in ('user', 'file', 'remote'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"source" text DEFAULT 'template' NOT NULL,
	"template_slug" text,
	"spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stacks_source_check" CHECK ("stacks"."source" in ('template', 'user')),
	CONSTRAINT "stacks_status_check" CHECK ("stacks"."status" in ('running', 'stopped', 'partial', 'error')),
	CONSTRAINT "stacks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tunnels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"target_url" text NOT NULL,
	"container_id" text,
	"port" integer,
	"hostname" text,
	"zone_id" text,
	"tunnel_id" text,
	"credentials_path" text,
	"config_path" text,
	"status" text DEFAULT 'stopped' NOT NULL,
	"url" text,
	"pid" integer,
	"last_error" text,
	"auto_start" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tunnels_mode_check" CHECK ("tunnels"."mode" in ('quick', 'named', 'localtunnel')),
	CONSTRAINT "tunnels_status_check" CHECK ("tunnels"."status" in ('stopped', 'starting', 'running', 'error')),
	CONSTRAINT "tunnels_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"secret" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text,
	"label_key" text,
	"label_value" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_grants_resource_kind_check" CHECK ("user_grants"."resource_kind" in ('container', 'stack', 'volume', 'network', 'image', 'template', 'tunnel')),
	CONSTRAINT "user_grants_selector" CHECK (("user_grants"."resource_id" is not null and "user_grants"."label_key" is null and "user_grants"."label_value" is null) or ("user_grants"."resource_id" is null and "user_grants"."label_key" is not null and "user_grants"."label_value" is not null)),
	CONSTRAINT "user_grants_label_nonempty" CHECK ("user_grants"."label_key" is null or length(trim("user_grants"."label_key")) > 0),
	CONSTRAINT "user_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "user_grants_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at" desc);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stacks_slug_idx" ON "stacks" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "templates_source_idx" ON "templates" USING btree ("source");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_grants_user_id_idx" ON "user_grants" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_grants_unique_idx" ON "user_grants" USING btree ("user_id","resource_kind",coalesce("resource_id", ''),coalesce("label_key", ''),coalesce("label_value", ''));
