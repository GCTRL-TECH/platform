import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  boolean,
  integer,
  real,
  timestamp,
  text,
  jsonb,
  inet,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ─── Enums ───────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', [
  'viewer',
  'analyst',
  'editor',
  'admin',
]);

export const userClearanceEnum = pgEnum('user_clearance', [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
]);

export const jobTypeEnum = pgEnum('job_type', [
  'kex_extract',
  'kex_upload',
  'fuse_merge',
]);

export const jobStatusEnum = pgEnum('job_status', [
  'pending',
  'processing',
  'completed',
  'failed',
]);

export const ontologyScopeEnum = pgEnum('ontology_scope', [
  'private',
  'shared',
  'public',
]);

// ─── Tables ──────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('viewer'),
  clearance: userClearanceEnum('clearance').notNull().default('PUBLIC'),
  emailVerified: boolean('email_verified').notNull().default(false),
  verificationToken: varchar('verification_token', { length: 255 }),
  resetToken: varchar('reset_token', { length: 255 }),
  resetTokenExpires: timestamp('reset_token_expires', { withTimezone: true }),
  tokensBalance: integer('tokens_balance').notNull().default(50),
  tier: varchar('tier', { length: 50 }).notNull().default('free'),
  defaultOntologyId: uuid('default_ontology_id'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  keyHash: varchar('key_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull().default('Default'),
  scopes: text('scopes').array().default([]),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const jobBatches = pgTable('job_batches', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 500 }).notNull(),
  source: varchar('source', { length: 100 }),
  sourceMetadata: jsonb('source_metadata').$type<Record<string, unknown>>().default({}),
  totalJobs: integer('total_jobs').notNull().default(0),
  completedJobs: integer('completed_jobs').notNull().default(0),
  failedJobs: integer('failed_jobs').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const triggerTypeEnum = pgEnum('trigger_type', ['cron', 'change_detection']);
export const triggerModuleEnum = pgEnum('trigger_module', ['kex', 'fuse', 'compilation']);
export const triggerStatusEnum = pgEnum('trigger_status', ['active', 'paused', 'error']);

export const triggers = pgTable('triggers', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  module: triggerModuleEnum('module').notNull(),
  type: triggerTypeEnum('type').notNull(),
  status: triggerStatusEnum('status').notNull().default('active'),
  cronSchedule: varchar('cron_schedule', { length: 100 }),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  lastError: text('last_error'),
  runCount: integer('run_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  type: jobTypeEnum('type').notNull(),
  status: jobStatusEnum('status').notNull().default('pending'),
  input: jsonb('input').notNull().default({}),
  result: jsonb('result'),
  error: text('error'),
  batchId: uuid('batch_id').references(() => jobBatches.id, { onDelete: 'set null' }),
  triggerId: uuid('trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const tokenUsage = pgTable('token_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  action: varchar('action', { length: 100 }).notNull(),
  tokensSpent: integer('tokens_spent').notNull(),
  jobId: uuid('job_id').references(() => jobs.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  action: varchar('action', { length: 100 }).notNull(),
  resourceType: varchar('resource_type', { length: 100 }),
  resourceId: varchar('resource_id', { length: 255 }),
  details: jsonb('details').default({}),
  ipAddress: inet('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Ontology Tables ──────────────────────────────────────────────────────────

export const ontologies = pgTable('ontologies', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  version: integer('version').notNull().default(1),
  parentOntologyId: uuid('parent_ontology_id'),
  scope: ontologyScopeEnum('scope').notNull().default('private'),
  source: varchar('source', { length: 255 }),
  entityTypeCount: integer('entity_type_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ontologyEntityTypes = pgTable('ontology_entity_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  ontologyId: uuid('ontology_id')
    .notNull()
    .references(() => ontologies.id, { onDelete: 'cascade' }),
  qid: varchar('qid', { length: 255 }),
  name: varchar('name', { length: 255 }).notNull(),
  aliases: text('aliases').array().default([]),
  description: text('description'),
  parentQid: varchar('parent_qid', { length: 255 }),
  confidenceThreshold: real('confidence_threshold').default(0.8),
  color: varchar('color', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ontologyProperties = pgTable('ontology_properties', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityTypeId: uuid('entity_type_id')
    .notNull()
    .references(() => ontologyEntityTypes.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  dataType: varchar('data_type', { length: 100 }).notNull().default('string'),
  required: boolean('required').notNull().default(false),
  searchable: boolean('searchable').notNull().default(true),
  weightInMatching: real('weight_in_matching').default(1.0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ontologyMatchRules = pgTable('ontology_match_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  ontologyId: uuid('ontology_id')
    .notNull()
    .references(() => ontologies.id, { onDelete: 'cascade' }),
  entityTypeA: varchar('entity_type_a', { length: 255 }).notNull(),
  entityTypeB: varchar('entity_type_b', { length: 255 }).notNull(),
  canMatch: boolean('can_match').notNull().default(true),
  similarityMetric: varchar('similarity_metric', { length: 100 }).default('jaccard'),
  threshold: real('threshold').default(0.85),
  blockingStrategy: varchar('blocking_strategy', { length: 100 }),
  propertiesToMatch: text('properties_to_match').array().default([]),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const compilations = pgTable('compilations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  sourceJobIds: uuid('source_job_ids')
    .array()
    .default(sql`'{}'`),
  classification: userClearanceEnum('classification').notNull().default('PUBLIC'),
  version: integer('version').notNull().default(1),
  cronSchedule: varchar('cron_schedule', { length: 100 }),
  cronMode: varchar('cron_mode', { length: 20 }).default('incremental'),
  lastRefreshAt: timestamp('last_refresh_at', { withTimezone: true }),
  nodeCount: integer('node_count').notNull().default(0),
  edgeCount: integer('edge_count').notNull().default(0),
  entityCount: integer('entity_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  linkCount: integer('link_count').notNull().default(0),
  ontologyId: uuid('ontology_id').references(() => ontologies.id, { onDelete: 'set null' }),
  ontologyVersion: integer('ontology_version'),
  folderId: uuid('folder_id'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const compilationAcl = pgTable('compilation_acl', {
  id: uuid('id').primaryKey().defaultRandom(),
  compilationId: uuid('compilation_id')
    .notNull()
    .references(() => compilations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  permission: varchar('permission', { length: 20 }).notNull().default('read'),
  grantedBy: uuid('granted_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const kgFolders = pgTable('kg_folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  parentFolderId: uuid('parent_folder_id'),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Relations ───────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  apiKeys: many(apiKeys),
  jobs: many(jobs),
  tokenUsage: many(tokenUsage),
  auditLogs: many(auditLog),
  compilations: many(compilations),
  compilationAcl: many(compilationAcl),
  ontologies: many(ontologies),
  conversations: many(conversations),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  user: one(users, { fields: [jobs.userId], references: [users.id] }),
  tokenUsage: many(tokenUsage),
}));

export const tokenUsageRelations = relations(tokenUsage, ({ one }) => ({
  user: one(users, { fields: [tokenUsage.userId], references: [users.id] }),
  job: one(jobs, { fields: [tokenUsage.jobId], references: [jobs.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  user: one(users, { fields: [auditLog.userId], references: [users.id] }),
}));

export const compilationsRelations = relations(compilations, ({ one, many }) => ({
  owner: one(users, { fields: [compilations.userId], references: [users.id] }),
  acl: many(compilationAcl),
  ontology: one(ontologies, { fields: [compilations.ontologyId], references: [ontologies.id] }),
}));

export const ontologiesRelations = relations(ontologies, ({ one, many }) => ({
  owner: one(users, { fields: [ontologies.userId], references: [users.id] }),
  parent: one(ontologies, {
    fields: [ontologies.parentOntologyId],
    references: [ontologies.id],
    relationName: 'ontologyParent',
  }),
  children: many(ontologies, { relationName: 'ontologyParent' }),
  entityTypes: many(ontologyEntityTypes),
  matchRules: many(ontologyMatchRules),
  compilations: many(compilations),
}));

export const ontologyEntityTypesRelations = relations(ontologyEntityTypes, ({ one, many }) => ({
  ontology: one(ontologies, { fields: [ontologyEntityTypes.ontologyId], references: [ontologies.id] }),
  properties: many(ontologyProperties),
}));

export const ontologyPropertiesRelations = relations(ontologyProperties, ({ one }) => ({
  entityType: one(ontologyEntityTypes, {
    fields: [ontologyProperties.entityTypeId],
    references: [ontologyEntityTypes.id],
  }),
}));

export const ontologyMatchRulesRelations = relations(ontologyMatchRules, ({ one }) => ({
  ontology: one(ontologies, { fields: [ontologyMatchRules.ontologyId], references: [ontologies.id] }),
}));

export const compilationAclRelations = relations(compilationAcl, ({ one }) => ({
  compilation: one(compilations, {
    fields: [compilationAcl.compilationId],
    references: [compilations.id],
  }),
  user: one(users, { fields: [compilationAcl.userId], references: [users.id] }),
  grantedByUser: one(users, {
    fields: [compilationAcl.grantedBy],
    references: [users.id],
    relationName: 'aclGranter',
  }),
}));

export const kgFoldersRelations = relations(kgFolders, ({ one, many }) => ({
  owner: one(users, { fields: [kgFolders.userId], references: [users.id] }),
  parent: one(kgFolders, {
    fields: [kgFolders.parentFolderId],
    references: [kgFolders.id],
    relationName: 'folderParent',
  }),
  children: many(kgFolders, { relationName: 'folderParent' }),
}));

// ─── RAG Tables ───────────────────────────────────────────────────────────────

export const ragModeEnum = pgEnum('rag_mode', ['standard', 'incognito']);

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  compilationId: uuid('compilation_id').references(() => compilations.id, {
    onDelete: 'set null',
  }),
  title: varchar('title', { length: 500 }).notNull().default('New conversation'),
  model: varchar('model', { length: 255 }).notNull().default('ollama:llama3.2'),
  mode: ragModeEnum('mode').notNull().default('standard'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 20 }).notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  cypherQuery: text('cypher_query'),
  sources: jsonb('sources').default([]),
  confidence: real('confidence'),
  graphTrace: jsonb('graph_trace'),
  tokensUsed: integer('tokens_used'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── RAG Relations ────────────────────────────────────────────────────────────

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  compilation: one(compilations, {
    fields: [conversations.compilationId],
    references: [compilations.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

// ─── Type Exports ─────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type TokenUsage = typeof tokenUsage.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;

export type UserRole = 'viewer' | 'analyst' | 'editor' | 'admin';
export type UserClearance = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
export type JobType = 'kex_extract' | 'kex_upload' | 'fuse_merge';
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type Compilation = typeof compilations.$inferSelect;
export type NewCompilation = typeof compilations.$inferInsert;
export type CompilationAcl = typeof compilationAcl.$inferSelect;
export type NewCompilationAcl = typeof compilationAcl.$inferInsert;
export type AclPermission = 'read' | 'write' | 'admin';
export type CronMode = 'incremental' | 'full';

export type Ontology = typeof ontologies.$inferSelect;
export type NewOntology = typeof ontologies.$inferInsert;
export type OntologyEntityType = typeof ontologyEntityTypes.$inferSelect;
export type NewOntologyEntityType = typeof ontologyEntityTypes.$inferInsert;
export type OntologyProperty = typeof ontologyProperties.$inferSelect;
export type NewOntologyProperty = typeof ontologyProperties.$inferInsert;
export type OntologyMatchRule = typeof ontologyMatchRules.$inferSelect;
export type NewOntologyMatchRule = typeof ontologyMatchRules.$inferInsert;
export type OntologyScope = 'private' | 'shared' | 'public';

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type RagMode = 'standard' | 'incognito';

export type KgFolder = typeof kgFolders.$inferSelect;
export type NewKgFolder = typeof kgFolders.$inferInsert;

// ─── OAuth Connectors ─────────────────────────────────────────────────────

export const connectorProviderEnum = pgEnum('connector_provider', [
  'google',
  'microsoft',
  'slack',
  'github',
]);

export const oauthConnectors = pgTable('oauth_connectors', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  provider: connectorProviderEnum('provider').notNull(),
  label: varchar('label', { length: 255 }).notNull(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  scopes: jsonb('scopes').$type<string[]>().default([]),
  providerAccountId: varchar('provider_account_id', { length: 255 }),
  providerEmail: varchar('provider_email', { length: 255 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  isActive: boolean('is_active').default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const connectorSyncJobs = pgTable('connector_sync_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  connectorId: uuid('connector_id').notNull().references(() => oauthConnectors.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  sourceType: varchar('source_type', { length: 50 }).notNull(), // 'drive_file', 'gmail_thread', 'calendar_event', 'onedrive_file', 'outlook_email'
  sourceId: varchar('source_id', { length: 500 }).notNull(), // external resource ID
  sourceName: varchar('source_name', { length: 1000 }),
  kexJobId: uuid('kex_job_id').references(() => jobs.id),
  status: varchar('status', { length: 20 }).default('pending').notNull(),
  error: text('error'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const connectorConfigs = pgTable('connector_configs', {
  id: uuid('id').defaultRandom().primaryKey(),
  provider: varchar('provider', { length: 50 }).notNull().unique(),
  clientId: text('client_id').notNull(),
  clientSecret: text('client_secret').notNull(),
  extra: jsonb('extra').$type<Record<string, unknown>>().default({}),
  isActive: boolean('is_active').default(true),
  updatedBy: uuid('updated_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type ConnectorConfig = typeof connectorConfigs.$inferSelect;
export type NewConnectorConfig = typeof connectorConfigs.$inferInsert;

export type OAuthConnector = typeof oauthConnectors.$inferSelect;
export type NewOAuthConnector = typeof oauthConnectors.$inferInsert;
export type ConnectorSyncJob = typeof connectorSyncJobs.$inferSelect;
export type NewConnectorSyncJob = typeof connectorSyncJobs.$inferInsert;

export type JobBatch = typeof jobBatches.$inferSelect;
export type NewJobBatch = typeof jobBatches.$inferInsert;
export type Trigger = typeof triggers.$inferSelect;
export type NewTrigger = typeof triggers.$inferInsert;
