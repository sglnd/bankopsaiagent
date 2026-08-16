export const config = {
  port: Number(process.env.PORT ?? 8960),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://bankops:bankops-local-change-me@postgres:5432/bankops',
  tenantId: process.env.BANKOPS_TENANT_ID ?? 'tenant-local',
  tenantName: process.env.BANKOPS_TENANT_NAME ?? '信息科技部',
  internalToken: process.env.BANKOPS_IDENTITY_INTERNAL_TOKEN ?? '',
  bootstrapUsername: process.env.BANKOPS_BOOTSTRAP_ADMIN_USERNAME ?? '',
  bootstrapPassword: process.env.BANKOPS_BOOTSTRAP_ADMIN_PASSWORD ?? '',
  bootstrapDisplayName: process.env.BANKOPS_BOOTSTRAP_ADMIN_DISPLAY_NAME ?? '平台管理员',
  sessionHours: Math.min(24, Math.max(1, Number(process.env.BANKOPS_SESSION_HOURS ?? 8))),
  cookieSecure: process.env.BANKOPS_COOKIE_SECURE === '1',
  registrationEnabled: process.env.BANKOPS_REGISTRATION_ENABLED !== '0',
}

if (!config.internalToken || config.internalToken.length < 24) {
  throw new Error('BANKOPS_IDENTITY_INTERNAL_TOKEN must contain at least 24 characters')
}
