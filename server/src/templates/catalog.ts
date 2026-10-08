// Dockyard — the built-in application template catalog (owner: agent 4).
//
// Every entry here is a REAL upstream image with its genuine tag, environment variables,
// ports and volume paths. No invented images, no renamed copies. Tags are pinned to a
// currently-published release (verified against the registry) rather than `latest` wherever a
// stable tag exists.
//
// `syncBuiltinTemplates()` upserts the catalog into the `templates` table (source='builtin',
// keyed on slug). It never overwrites a row whose source is 'user' and never clobbers a builtin
// row's created_at.

import { query, one } from '../db/pool.ts';
import { logger } from '../logger.ts';
import type { TemplateSpec } from './schema.ts';
import { validateSpec } from './schema.ts';

export function builtinTemplates(): TemplateSpec[] {
  return [
    {
      schemaVersion: 1,
      slug: 'postgres',
      name: 'PostgreSQL',
      category: 'database',
      icon: '🐘',
      description: 'The PostgreSQL object-relational database.',
      image: 'postgres',
      tag: '16-alpine',
      ports: [{ container: 5432, label: 'PostgreSQL', defaultHost: 5432 }],
      env: [
        {
          key: 'POSTGRES_PASSWORD',
          label: 'Superuser password',
          required: true,
          secret: true,
          description: 'Required. Password for the postgres superuser.',
        },
        { key: 'POSTGRES_USER', label: 'Superuser', default: 'postgres' },
        { key: 'POSTGRES_DB', label: 'Database', default: 'postgres' },
      ],
      volumes: [{ container: '/var/lib/postgresql/data', label: 'Data' }],
      restartPolicy: 'unless-stopped',
      healthcheck: {
        test: ['CMD-SHELL', 'pg_isready -U "${POSTGRES_USER:-postgres}"'],
        intervalSec: 10,
        timeoutSec: 5,
        retries: 5,
      },
      notes: 'POSTGRES_PASSWORD is required and must be set before deploying.',
      docsUrl: 'https://hub.docker.com/_/postgres',
    },
    {
      schemaVersion: 1,
      slug: 'mysql',
      name: 'MySQL',
      category: 'database',
      icon: '🐬',
      description: 'MySQL 8 LTS relational database.',
      image: 'mysql',
      tag: '8.4',
      ports: [{ container: 3306, label: 'MySQL', defaultHost: 3306 }],
      env: [
        {
          key: 'MYSQL_ROOT_PASSWORD',
          label: 'Root password',
          required: true,
          secret: true,
          description: 'Required. Password for the MySQL root account.',
        },
        { key: 'MYSQL_DATABASE', label: 'Database', description: 'Created on first start.' },
        { key: 'MYSQL_USER', label: 'User', description: 'Created on first start.' },
        { key: 'MYSQL_PASSWORD', label: 'User password', secret: true },
      ],
      volumes: [{ container: '/var/lib/mysql', label: 'Data' }],
      restartPolicy: 'unless-stopped',
      healthcheck: {
        test: ['CMD', 'mysqladmin', 'ping', '-h', '127.0.0.1'],
        intervalSec: 10,
        timeoutSec: 5,
        retries: 10,
      },
      notes: 'MYSQL_ROOT_PASSWORD is required. The data directory is initialised on first start only.',
      docsUrl: 'https://hub.docker.com/_/mysql',
    },
    {
      schemaVersion: 1,
      slug: 'redis',
      name: 'Redis',
      category: 'database',
      icon: '🧱',
      description: 'In-memory key/value store with optional persistence.',
      image: 'redis',
      tag: '7.4-alpine',
      ports: [{ container: 6379, label: 'Redis', defaultHost: 6379 }],
      env: [],
      volumes: [{ container: '/data', label: 'Data' }],
      restartPolicy: 'unless-stopped',
      healthcheck: {
        test: ['CMD', 'redis-cli', 'ping'],
        intervalSec: 10,
        timeoutSec: 3,
        retries: 5,
      },
      notes: 'Runs with the default configuration (no auth). Enable persistence via a custom command if needed.',
      docsUrl: 'https://hub.docker.com/_/redis',
    },
    {
      schemaVersion: 1,
      slug: 'mongodb',
      name: 'MongoDB',
      category: 'database',
      icon: '🍃',
      description: 'MongoDB document database.',
      image: 'mongo',
      tag: '7.0',
      ports: [{ container: 27017, label: 'MongoDB', defaultHost: 27017 }],
      env: [
        { key: 'MONGO_INITDB_ROOT_USERNAME', label: 'Root user', default: 'root' },
        {
          key: 'MONGO_INITDB_ROOT_PASSWORD',
          label: 'Root password',
          required: true,
          secret: true,
          description: 'Required to enable authentication on first start.',
        },
      ],
      volumes: [{ container: '/data/db', label: 'Data' }],
      restartPolicy: 'unless-stopped',
      healthcheck: {
        test: ['CMD', 'mongosh', '--quiet', '--eval', "db.adminCommand('ping')"],
        intervalSec: 10,
        timeoutSec: 5,
        retries: 10,
      },
      notes: 'Setting both the root user and password enables authentication on first start.',
      docsUrl: 'https://hub.docker.com/_/mongo',
    },
    {
      schemaVersion: 1,
      slug: 'adminer',
      name: 'Adminer',
      category: 'devtools',
      icon: '🗄️',
      description: 'Single-file database administration UI for MySQL, PostgreSQL and more.',
      image: 'adminer',
      tag: '4',
      ports: [{ container: 8080, label: 'Web UI', defaultHost: 8080 }],
      env: [
        {
          key: 'ADMINER_DEFAULT_SERVER',
          label: 'Default server',
          description: 'Hostname shown in the login form, e.g. a database container name.',
        },
      ],
      volumes: [],
      restartPolicy: 'unless-stopped',
      notes: 'Point it at a database container by hostname (both must share a Docker network).',
      docsUrl: 'https://hub.docker.com/_/adminer',
    },
    {
      schemaVersion: 1,
      slug: 'nginx',
      name: 'nginx',
      category: 'web',
      icon: '🌐',
      description: 'High-performance HTTP server and reverse proxy.',
      image: 'nginx',
      tag: '1.27-alpine',
      ports: [{ container: 80, label: 'HTTP', defaultHost: 8080 }],
      env: [],
      volumes: [{ container: '/usr/share/nginx/html', label: 'Web root' }],
      restartPolicy: 'unless-stopped',
      healthcheck: {
        test: ['CMD-SHELL', 'wget -q -O /dev/null http://127.0.0.1/ || exit 1'],
        intervalSec: 10,
        timeoutSec: 3,
        retries: 5,
      },
      docsUrl: 'https://hub.docker.com/_/nginx',
    },
    {
      schemaVersion: 1,
      slug: 'httpd',
      name: 'Apache httpd',
      category: 'web',
      icon: '🪶',
      description: 'The Apache HTTP Server.',
      image: 'httpd',
      tag: '2.4-alpine',
      ports: [{ container: 80, label: 'HTTP', defaultHost: 8080 }],
      env: [],
      volumes: [{ container: '/usr/local/apache2/htdocs', label: 'Web root' }],
      restartPolicy: 'unless-stopped',
      docsUrl: 'https://hub.docker.com/_/httpd',
    },
    {
      schemaVersion: 1,
      slug: 'wordpress',
      name: 'WordPress',
      category: 'web',
      icon: '📝',
      description: 'WordPress with the Apache web server.',
      image: 'wordpress',
      tag: '6.7-apache',
      ports: [{ container: 80, label: 'HTTP', defaultHost: 8080 }],
      env: [
        {
          key: 'WORDPRESS_DB_HOST',
          label: 'Database host',
          default: 'db:3306',
          description: 'host:port of your MySQL/MariaDB container.',
        },
        { key: 'WORDPRESS_DB_USER', label: 'Database user', default: 'wordpress' },
        {
          key: 'WORDPRESS_DB_PASSWORD',
          label: 'Database password',
          required: true,
          secret: true,
        },
        { key: 'WORDPRESS_DB_NAME', label: 'Database name', default: 'wordpress' },
      ],
      volumes: [{ container: '/var/www/html', label: 'Site' }],
      restartPolicy: 'unless-stopped',
      notes: 'WordPress needs a MySQL/MariaDB database. Deploy mysql first and point WORDPRESS_DB_HOST at it (e.g. my-mysql:3306).',
      docsUrl: 'https://hub.docker.com/_/wordpress',
    },
    {
      schemaVersion: 1,
      slug: 'node-app',
      name: 'Node.js app',
      category: 'devtools',
      icon: '🟩',
      description: 'Node.js 22 runtime serving a minimal HTTP server on port 3000.',
      image: 'node',
      tag: '22-alpine',
      ports: [{ container: 3000, label: 'HTTP', defaultHost: 3000 }],
      env: [{ key: 'NODE_ENV', label: 'Environment', default: 'production' }],
      volumes: [{ container: '/app', label: 'App code' }],
      restartPolicy: 'unless-stopped',
      command: [
        'node',
        '-e',
        "require('http').createServer((_,res)=>res.end('dockyard node-app ok\\n')).listen(3000)",
      ],
      notes: 'Replace the command and mount your code at /app to run a real application.',
      docsUrl: 'https://hub.docker.com/_/node',
    },
    {
      schemaVersion: 1,
      slug: 'python-app',
      name: 'Python app',
      category: 'devtools',
      icon: '🐍',
      description: 'Python 3.12 runtime serving a directory with the stdlib HTTP server on port 8000.',
      image: 'python',
      tag: '3.12-slim',
      ports: [{ container: 8000, label: 'HTTP', defaultHost: 8000 }],
      env: [{ key: 'PYTHONUNBUFFERED', label: 'Unbuffered output', default: '1' }],
      volumes: [{ container: '/app', label: 'App code' }],
      restartPolicy: 'unless-stopped',
      command: ['python', '-m', 'http.server', '8000', '--directory', '/app'],
      notes: 'Replace the command and mount your code at /app to run a real application.',
      docsUrl: 'https://hub.docker.com/_/python',
    },
    {
      schemaVersion: 1,
      slug: 'uptime-kuma',
      name: 'Uptime Kuma',
      category: 'monitoring',
      icon: '📈',
      description: 'Self-hosted uptime monitoring with status pages and alerts.',
      image: 'louislam/uptime-kuma',
      tag: '1.23.16',
      ports: [{ container: 3001, label: 'Web UI', defaultHost: 3001 }],
      env: [],
      volumes: [{ container: '/app/data', label: 'Data' }],
      restartPolicy: 'unless-stopped',
      docsUrl: 'https://github.com/louislam/uptime-kuma',
    },
    {
      schemaVersion: 1,
      slug: 'grafana',
      name: 'Grafana',
      category: 'monitoring',
      icon: '📊',
      description: 'Dashboards and observability UI.',
      image: 'grafana/grafana',
      tag: '11.4.0',
      ports: [{ container: 3000, label: 'Web UI', defaultHost: 3000 }],
      env: [
        { key: 'GF_SECURITY_ADMIN_USER', label: 'Admin user', default: 'admin' },
        {
          key: 'GF_SECURITY_ADMIN_PASSWORD',
          label: 'Admin password',
          default: 'admin',
          secret: true,
          description: 'Change this from the default before exposing Grafana.',
        },
      ],
      volumes: [{ container: '/var/lib/grafana', label: 'Data' }],
      restartPolicy: 'unless-stopped',
      notes: 'Default login is admin / the GF_SECURITY_ADMIN_PASSWORD value (default "admin"). Change it.',
      docsUrl: 'https://hub.docker.com/r/grafana/grafana',
    },
    {
      schemaVersion: 1,
      slug: 'prometheus',
      name: 'Prometheus',
      category: 'monitoring',
      icon: '🔥',
      description: 'Metrics collection and time-series database.',
      image: 'prom/prometheus',
      tag: 'v3.13.4',
      ports: [{ container: 9090, label: 'Web UI', defaultHost: 9090 }],
      env: [],
      volumes: [{ container: '/prometheus', label: 'Data' }],
      restartPolicy: 'unless-stopped',
      docsUrl: 'https://hub.docker.com/r/prom/prometheus',
    },
    {
      schemaVersion: 1,
      slug: 'minio',
      name: 'MinIO',
      category: 'storage',
      icon: '🪣',
      description: 'S3-compatible object storage server.',
      image: 'minio/minio',
      tag: 'RELEASE.2025-09-07T16-13-09Z',
      ports: [
        { container: 9000, label: 'S3 API', defaultHost: 9000 },
        { container: 9001, label: 'Console', defaultHost: 9001 },
      ],
      env: [
        { key: 'MINIO_ROOT_USER', label: 'Root user', default: 'minioadmin' },
        {
          key: 'MINIO_ROOT_PASSWORD',
          label: 'Root password',
          required: true,
          secret: true,
          description: 'Minimum 8 characters.',
        },
      ],
      volumes: [{ container: '/data', label: 'Data' }],
      restartPolicy: 'unless-stopped',
      command: ['server', '/data', '--console-address', ':9001'],
      notes: 'The S3 API is on 9000 and the web console on 9001. MINIO_ROOT_PASSWORD must be at least 8 characters.',
      docsUrl: 'https://min.io/docs/minio/container/index.html',
    },
    {
      schemaVersion: 1,
      slug: 'n8n',
      name: 'n8n',
      category: 'other',
      icon: '🔗',
      description: 'Fair-code workflow automation.',
      image: 'n8nio/n8n',
      tag: '1.123.84',
      ports: [{ container: 5678, label: 'Web UI', defaultHost: 5678 }],
      env: [
        {
          key: 'N8N_SECURE_COOKIE',
          label: 'Secure cookie',
          default: 'false',
          description: 'Set false when serving over plain HTTP.',
        },
        { key: 'GENERIC_TIMEZONE', label: 'Timezone', description: 'e.g. Europe/London' },
      ],
      volumes: [{ container: '/home/node/.n8n', label: 'Data' }],
      restartPolicy: 'unless-stopped',
      docsUrl: 'https://docs.n8n.io/hosting/',
    },
    {
      schemaVersion: 1,
      slug: 'rabbitmq',
      name: 'RabbitMQ',
      category: 'messaging',
      icon: '🐰',
      description: 'Message broker with the management web UI.',
      image: 'rabbitmq',
      tag: '4-management',
      ports: [
        { container: 5672, label: 'AMQP', defaultHost: 5672 },
        { container: 15672, label: 'Management UI', defaultHost: 15672 },
      ],
      env: [
        { key: 'RABBITMQ_DEFAULT_USER', label: 'Default user', default: 'admin' },
        {
          key: 'RABBITMQ_DEFAULT_PASS',
          label: 'Default password',
          required: true,
          secret: true,
        },
      ],
      volumes: [{ container: '/var/lib/rabbitmq', label: 'Data' }],
      restartPolicy: 'unless-stopped',
      healthcheck: {
        test: ['CMD', 'rabbitmq-diagnostics', '-q', 'ping'],
        intervalSec: 15,
        timeoutSec: 10,
        retries: 5,
      },
      notes: 'The management UI is on 15672; AMQP on 5672.',
      docsUrl: 'https://hub.docker.com/_/rabbitmq',
    },
    {
      schemaVersion: 1,
      slug: 'whoami',
      name: 'whoami',
      category: 'devtools',
      icon: '🪪',
      description: 'Tiny HTTP server that echoes request headers, useful for testing proxies and tunnels.',
      image: 'traefik/whoami',
      tag: 'v1.11.0',
      ports: [{ container: 80, label: 'HTTP', defaultHost: 8080 }],
      env: [],
      volumes: [],
      restartPolicy: 'unless-stopped',
      docsUrl: 'https://github.com/traefik/whoami',
    },
  ];
}

/**
 * Upsert the built-in catalog into the `templates` table.
 *
 *   - keyed on slug; existing builtin rows are refreshed (name/spec/...) but keep their created_at
 *   - a row with the same slug whose source is 'user' is left completely untouched
 *
 * Returns counts so the caller can log/verify the effect.
 */
export async function syncBuiltinTemplates(): Promise<{
  inserted: number;
  updated: number;
  skipped: number;
  total: number;
}> {
  const specs = builtinTemplates();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const spec of specs) {
    const res = await query<{ inserted: boolean }>(
      `insert into templates (slug, name, category, icon, description, spec, source)
       values ($1, $2, $3, $4, $5, $6::jsonb, 'builtin')
       on conflict (slug) do update
         set name = excluded.name,
             category = excluded.category,
             icon = excluded.icon,
             description = excluded.description,
             spec = excluded.spec,
             updated_at = now()
         where templates.source = 'builtin'
       returning (xmax = 0) as inserted`,
      [spec.slug, spec.name, spec.category, spec.icon, spec.description, JSON.stringify(spec)],
    );
    if (res.rowCount === 0) {
      skipped += 1; // a user row with this slug exists — never overwrite it
    } else if (res.rows[0]?.inserted) {
      inserted += 1;
    } else {
      updated += 1;
    }
  }

  return { inserted, updated, skipped, total: specs.length };
}

/**
 * Seed the builtins lazily: if the templates table is empty, sync the catalog. Called from the
 * template routes so the API works even when boot seeding was skipped.
 */
export async function ensureBuiltinTemplates(): Promise<boolean> {
  const row = await one<{ n: string }>('select count(*)::int as n from templates');
  if (row && Number(row.n) > 0) return false;
  const result = await syncBuiltinTemplates();
  logger.info('templates: seeded built-in catalog', { ...result });
  return true;
}

/** Look up a builtin spec by slug from the in-memory catalog (no DB round-trip). */
export function builtinSpecBySlug(slug: string): TemplateSpec | null {
  return builtinTemplates().find((s) => s.slug === slug) ?? null;
}

// Defensive: assert the catalog itself is internally valid at module load. A malformed builtin
// is a programming error, so fail loudly rather than shipping a broken template.
for (const spec of builtinTemplates()) {
  const result = validateSpec(spec);
  if (!result.ok) {
    throw new Error(`invalid builtin template "${spec.slug}": ${result.errors.join('; ')}`);
  }
}
