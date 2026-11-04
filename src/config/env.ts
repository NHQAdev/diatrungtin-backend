import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    // Comma-separated list of origins allowed to call the API from a browser.
    CORS_ORIGINS: z.string().default(''),
    ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
    COOKIE_SECURE: booleanString.optional(),
    // Set when running behind a reverse proxy so request.ip is the real client address.
    TRUST_PROXY: booleanString.default('false'),
  })
  .transform((env) => ({
    ...env,
    CORS_ORIGINS: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
  }))
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGINS'], message: 'Required in production' });
    }
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['COOKIE_SECURE'], message: 'Must be true in production' });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // Print variable names and problems only, never values.
    const problems = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  return result.data;
}
