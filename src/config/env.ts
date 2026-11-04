import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() ? value.trim() : undefined));

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    // Public URL of this API (used to build image URLs) and of the shop frontend (used in email links).
    API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
    APP_PUBLIC_URL: z.string().url().default('http://localhost:5173'),

    // Comma-separated list of origins allowed to call the API from a browser.
    CORS_ORIGINS: z.string().default(''),
    ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
    CUSTOMER_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    COOKIE_SECURE: booleanString.optional(),
    // Set when running behind a reverse proxy so request.ip is the real client address.
    TRUST_PROXY: booleanString.default('false'),

    // Product images are saved on disk here and served at /uploads/<file>.
    UPLOAD_DIR: z.string().default('uploads'),
    UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(20).default(5),

    // Email. Without SMTP_HOST, emails are written to the log instead of being sent (local dev).
    SMTP_HOST: optionalString,
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: booleanString.default('false'),
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,
    MAIL_FROM: z.string().default('Trầm Hương Địa Trung Tín <no-reply@localhost>'),
    EMAIL_WORKER_ENABLED: booleanString.default('true'),
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
    if (env.NODE_ENV === 'production' && !env.SMTP_HOST) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMTP_HOST'], message: 'Required in production (order emails)' });
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
