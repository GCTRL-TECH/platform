import { pgTable, uuid, text, integer, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  tier: text('tier').notNull().default('free'),
  creditsBalance: integer('credits_balance').notNull().default(3000),
  overdraftLimit: integer('overdraft_limit').notNull().default(0),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  emailVerified: boolean('email_verified').notNull().default(false),
  suspended: boolean('suspended').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const licenses = pgTable('licenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  licenseKey: text('license_key').notNull().unique(),
  hardwareFingerprint: text('hardware_fingerprint'),
  status: text('status').notNull().default('inactive'),
  tier: text('tier').notNull().default('free'),
  gracePeriodEndsAt: timestamp('grace_period_ends_at'),
  seatReassignments: integer('seat_reassignments').notNull().default(0),
  lastReassignmentAt: timestamp('last_reassignment_at'),
  activatedAt: timestamp('activated_at'),
  lastHeartbeatAt: timestamp('last_heartbeat_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const tokenUsage = pgTable('token_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  licenseId: uuid('license_id').references(() => licenses.id),
  action: text('action').notNull(),
  charsProcessed: integer('chars_processed'),
  creditsSpent: integer('credits_spent').notNull(),
  isOverdraft: boolean('is_overdraft').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
  stripePriceId: text('stripe_price_id').notNull(),
  tier: text('tier').notNull(),
  status: text('status').notNull(),
  currentPeriodEnd: timestamp('current_period_end').notNull(),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id').references(() => users.id),
  action: text('action').notNull(),
  targetUserId: uuid('target_user_id').references(() => users.id),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const appVersions = pgTable('app_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: text('version').notNull(),
  channel: text('channel').notNull().default('stable'),
  updateRequired: boolean('update_required').notNull().default(false),
  changelog: text('changelog'),
  rolloutPercent: integer('rollout_percent').notNull().default(100),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
