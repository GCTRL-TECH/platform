const requireEnv = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
};

export const config = {
  port: parseInt(process.env['PORT'] ?? '4000', 10),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',

  databaseUrl: requireEnv(
    'DATABASE_URL',
    'postgresql://GCTRL:GCTRL@localhost:5433/GCTRL'
  ),

  redisUrl: requireEnv('REDIS_URL', 'redis://localhost:6380'),

  neo4j: {
    uri: requireEnv('NEO4J_URI', 'bolt://localhost:7687'),
    user: requireEnv('NEO4J_USER', 'neo4j'),
    password: requireEnv('NEO4J_PASSWORD', 'password'),
  },

  jwt: {
    secret: requireEnv(
      'JWT_SECRET',
      'GCTRL-dev-jwt-secret-change-in-production'
    ),
    refreshSecret: requireEnv(
      'JWT_REFRESH_SECRET',
      'GCTRL-dev-refresh-secret-change-in-production'
    ),
    accessExpiresIn: '15m',
    refreshExpiresIn: '7d',
  },

  mail: {
    host: requireEnv('MAIL_HOST', 'localhost'),
    port: parseInt(process.env['MAIL_PORT'] ?? '1025', 10),
  },

  frontendUrl: requireEnv('FRONTEND_URL', 'http://localhost:3000'),

  kexWorkerUrl: requireEnv('KEX_WORKER_URL', 'http://localhost:4010'),

  qdrantUrl: requireEnv('QDRANT_URL', 'http://localhost:6333'),

  bcryptRounds: 12,

  uploadDir: process.env['UPLOAD_DIR'] ?? '/tmp/GCTRL-uploads',
} as const;

export type Config = typeof config;

