import { Router, Request, Response } from 'express';
import { eq, and, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import {
  ontologies,
  ontologyEntityTypes,
  ontologyProperties,
  ontologyMatchRules,
} from '../models/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

// ─── Pre-built Templates ──────────────────────────────────────────────────────

const TEMPLATES = [
  {
    name: 'CRM',
    description: 'Customer Relationship Management',
    entityTypes: ['company', 'contact', 'account', 'deal', 'activity'],
    source: 'template',
  },
  {
    name: 'Supply Chain',
    description: 'Supply chain and logistics',
    entityTypes: ['product', 'supplier', 'shipment', 'warehouse', 'order'],
    source: 'template',
  },
  {
    name: 'Healthcare',
    description: 'Healthcare and medical',
    entityTypes: ['patient', 'condition', 'medication', 'provider', 'procedure'],
    source: 'template',
  },
  {
    name: 'Legal',
    description: 'Legal and compliance',
    entityTypes: ['contract', 'party', 'clause', 'jurisdiction', 'regulation'],
    source: 'template',
  },
  {
    name: 'Finance',
    description: 'Financial services',
    entityTypes: ['transaction', 'account', 'counterparty', 'instrument', 'portfolio'],
    source: 'template',
  },
];

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const createOntologySchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().max(2000).optional(),
  scope: z.enum(['private', 'shared', 'public']).optional().default('private'),
  parentOntologyId: z.string().uuid().optional(),
});

const updateOntologySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  scope: z.enum(['private', 'shared', 'public']).optional(),
});

const createEntityTypeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  qid: z.string().max(255).optional(),
  aliases: z.array(z.string()).optional().default([]),
  description: z.string().optional(),
  parentQid: z.string().max(255).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional().default(0.8),
  color: z.string().max(50).optional(),
});

const updateEntityTypeSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  qid: z.string().max(255).optional(),
  aliases: z.array(z.string()).optional(),
  description: z.string().optional(),
  parentQid: z.string().max(255).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  color: z.string().max(50).optional(),
});

const createPropertySchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  dataType: z.string().max(100).optional().default('string'),
  required: z.boolean().optional().default(false),
  searchable: z.boolean().optional().default(true),
  weightInMatching: z.number().min(0).max(10).optional().default(1.0),
});

const createMatchRuleSchema = z.object({
  entityTypeA: z.string().min(1).max(255),
  entityTypeB: z.string().min(1).max(255),
  canMatch: z.boolean().optional().default(true),
  similarityMetric: z.string().max(100).optional().default('jaccard'),
  threshold: z.number().min(0).max(1).optional().default(0.85),
  blockingStrategy: z.string().max(100).optional(),
  propertiesToMatch: z.array(z.string()).optional().default([]),
});

const importOntologySchema = z.object({
  data: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    scope: z.enum(['private', 'shared', 'public']).optional(),
    source: z.string().optional(),
    entityTypes: z.array(z.any()).optional().default([]),
    matchRules: z.array(z.any()).optional().default([]),
  }),
});

// ─── Helper: verify ontology ownership ───────────────────────────────────────

async function getOntologyForUser(
  ontologyId: string,
  userId: string,
  userRole: string
): Promise<typeof ontologies.$inferSelect | null> {
  const [ont] = await db
    .select()
    .from(ontologies)
    .where(eq(ontologies.id, ontologyId))
    .limit(1);

  if (!ont) return null;

  // Public/shared ontologies are readable by all (write still requires ownership)
  if (userRole === 'admin') return ont;
  if (ont.userId === userId) return ont;
  if (ont.scope === 'public' || ont.scope === 'shared') return ont;

  return null;
}

// ─── Helper: update entity type count ────────────────────────────────────────

async function refreshEntityTypeCount(ontologyId: string): Promise<void> {
  const rows = await db
    .select({ id: ontologyEntityTypes.id })
    .from(ontologyEntityTypes)
    .where(eq(ontologyEntityTypes.ontologyId, ontologyId));

  await db
    .update(ontologies)
    .set({ entityTypeCount: rows.length, updatedAt: new Date() })
    .where(eq(ontologies.id, ontologyId));
}

// ─── GET /ontologies/templates ────────────────────────────────────────────────
// NOTE: must be before /:id to avoid route conflict

router.get(
  '/templates',
  requireAuth,
  async (_req: Request, res: Response): Promise<void> => {
    res.json({ templates: TEMPLATES });
  }
);

// ─── GET /ontologies ──────────────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;

    try {
      let rows: (typeof ontologies.$inferSelect)[];

      if (userRole === 'admin') {
        rows = await db.select().from(ontologies);
      } else {
        rows = await db
          .select()
          .from(ontologies)
          .where(
            or(
              eq(ontologies.userId, userId),
              eq(ontologies.scope, 'shared'),
              eq(ontologies.scope, 'public')
            )
          );
      }

      res.json({ ontologies: rows });
    } catch (err) {
      console.error('[ontologies GET]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /ontologies ─────────────────────────────────────────────────────────

router.post(
  '/',
  requireAuth,
  validate(createOntologySchema),
  async (req: Request, res: Response): Promise<void> => {
    const { name, description, scope, parentOntologyId } =
      req.body as z.infer<typeof createOntologySchema>;
    const userId = req.user!.sub;

    try {
      const [ontology] = await db
        .insert(ontologies)
        .values({
          userId,
          name,
          description: description ?? null,
          scope: scope || 'private',
          parentOntologyId: parentOntologyId ?? null,
          entityTypeCount: 0,
          version: 1,
        })
        .returning();

      if (!ontology) {
        res.status(500).json({ error: 'Failed to create ontology' });
        return;
      }

      res.status(201).json({ ontology });
    } catch (err) {
      console.error('[ontologies POST]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /ontologies/:id ──────────────────────────────────────────────────────

router.get(
  '/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const ontologyId = req.params['id'];

    if (!ontologyId) {
      res.status(400).json({ error: 'Ontology ID is required' });
      return;
    }

    try {
      const ontology = await getOntologyForUser(ontologyId, userId, userRole);
      if (!ontology) {
        res.status(404).json({ error: 'Ontology not found' });
        return;
      }

      // Load entity types with properties
      const entityTypes = await db
        .select()
        .from(ontologyEntityTypes)
        .where(eq(ontologyEntityTypes.ontologyId, ontologyId));

      const entityTypeIds = entityTypes.map((et) => et.id);
      let properties: (typeof ontologyProperties.$inferSelect)[] = [];
      if (entityTypeIds.length > 0) {
        // Fetch properties for all entity types
        properties = await db
          .select()
          .from(ontologyProperties)
          .where(
            entityTypeIds.length === 1
              ? eq(ontologyProperties.entityTypeId, entityTypeIds[0]!)
              : or(...entityTypeIds.map((id) => eq(ontologyProperties.entityTypeId, id)))
          );
      }

      // Load match rules
      const matchRules = await db
        .select()
        .from(ontologyMatchRules)
        .where(eq(ontologyMatchRules.ontologyId, ontologyId));

      // Attach properties to entity types
      const entityTypesWithProps = entityTypes.map((et) => ({
        ...et,
        properties: properties.filter((p) => p.entityTypeId === et.id),
      }));

      res.json({
        ontology: {
          ...ontology,
          entityTypes: entityTypesWithProps,
          matchRules,
        },
      });
    } catch (err) {
      console.error('[ontologies/:id GET]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── PUT /ontologies/:id ──────────────────────────────────────────────────────

router.put(
  '/:id',
  requireAuth,
  validate(updateOntologySchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const ontologyId = req.params['id'];
    const updates = req.body as z.infer<typeof updateOntologySchema>;

    if (!ontologyId) {
      res.status(400).json({ error: 'Ontology ID is required' });
      return;
    }

    try {
      const [existing] = await db
        .select()
        .from(ontologies)
        .where(eq(ontologies.id, ontologyId))
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: 'Ontology not found' });
        return;
      }

      if (existing.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Access denied: must be owner or admin' });
        return;
      }

      const setValues: Partial<typeof ontologies.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (updates.name !== undefined) setValues.name = updates.name;
      if (updates.description !== undefined) setValues.description = updates.description;
      if (updates.scope !== undefined) setValues.scope = updates.scope;

      const [updated] = await db
        .update(ontologies)
        .set(setValues)
        .where(eq(ontologies.id, ontologyId))
        .returning();

      res.json({ ontology: updated });
    } catch (err) {
      console.error('[ontologies/:id PUT]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── DELETE /ontologies/:id ───────────────────────────────────────────────────

router.delete(
  '/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const ontologyId = req.params['id'];

    if (!ontologyId) {
      res.status(400).json({ error: 'Ontology ID is required' });
      return;
    }

    try {
      const [existing] = await db
        .select({ id: ontologies.id, userId: ontologies.userId })
        .from(ontologies)
        .where(eq(ontologies.id, ontologyId))
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: 'Ontology not found' });
        return;
      }

      if (existing.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Only the owner or admin can delete this ontology' });
        return;
      }

      await db.delete(ontologies).where(eq(ontologies.id, ontologyId));
      res.json({ ok: true, deleted: ontologyId });
    } catch (err) {
      console.error('[ontologies/:id DELETE]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /ontologies/:id/entity-types ────────────────────────────────────────

router.post(
  '/:id/entity-types',
  requireAuth,
  validate(createEntityTypeSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const ontologyId = req.params['id'];
    const body = req.body as z.infer<typeof createEntityTypeSchema>;

    if (!ontologyId) {
      res.status(400).json({ error: 'Ontology ID is required' });
      return;
    }

    try {
      const ontology = await getOntologyForUser(ontologyId, userId, userRole);
      if (!ontology) {
        res.status(404).json({ error: 'Ontology not found' });
        return;
      }

      if (ontology.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Access denied: must be owner or admin' });
        return;
      }

      const [entityType] = await db
        .insert(ontologyEntityTypes)
        .values({
          ontologyId,
          name: body.name,
          qid: body.qid ?? null,
          aliases: body.aliases || [],
          description: body.description ?? null,
          parentQid: body.parentQid ?? null,
          confidenceThreshold: body.confidenceThreshold ?? 0.8,
          color: body.color ?? null,
        })
        .returning();

      if (!entityType) {
        res.status(500).json({ error: 'Failed to create entity type' });
        return;
      }

      await refreshEntityTypeCount(ontologyId);

      res.status(201).json({ entityType });
    } catch (err) {
      console.error('[ontologies/:id/entity-types POST]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── PUT /ontologies/:id/entity-types/:typeId ─────────────────────────────────

router.put(
  '/:id/entity-types/:typeId',
  requireAuth,
  validate(updateEntityTypeSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const ontologyId = req.params['id'];
    const typeId = req.params['typeId'];
    const body = req.body as z.infer<typeof updateEntityTypeSchema>;

    if (!ontologyId || !typeId) {
      res.status(400).json({ error: 'Ontology ID and type ID are required' });
      return;
    }

    try {
      const ontology = await getOntologyForUser(ontologyId, userId, userRole);
      if (!ontology) {
        res.status(404).json({ error: 'Ontology not found' });
        return;
      }

      if (ontology.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Access denied: must be owner or admin' });
        return;
      }

      const [existing] = await db
        .select({ id: ontologyEntityTypes.id })
        .from(ontologyEntityTypes)
        .where(
          and(
            eq(ontologyEntityTypes.id, typeId),
            eq(ontologyEntityTypes.ontologyId, ontologyId)
          )
        )
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: 'Entity type not found' });
        return;
      }

      const setValues: Partial<typeof ontologyEntityTypes.$inferInsert> = {};
      if (body.name !== undefined) setValues.name = body.name;
      if (body.qid !== undefined) setValues.qid = body.qid;
      if (body.aliases !== undefined) setValues.aliases = body.aliases;
      if (body.description !== undefined) setValues.description = body.description;
      if (body.parentQid !== undefined) setValues.parentQid = body.parentQid;
      if (body.confidenceThreshold !== undefined) setValues.confidenceThreshold = body.confidenceThreshold;
      if (body.color !== undefined) setValues.color = body.color;

      const [updated] = await db
        .update(ontologyEntityTypes)
        .set(setValues)
        .where(eq(ontologyEntityTypes.id, typeId))
        .returning();

      res.json({ entityType: updated });
    } catch (err) {
      console.error('[ontologies/:id/entity-types/:typeId PUT]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── DELETE /ontologies/:id/entity-types/:typeId ──────────────────────────────

router.delete(
  '/:id/entity-types/:typeId',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const ontologyId = req.params['id'];
    const typeId = req.params['typeId'];

    if (!ontologyId || !typeId) {
      res.status(400).json({ error: 'Ontology ID and type ID are required' });
      return;
    }

    try {
      const ontology = await getOntologyForUser(ontologyId, userId, userRole);
      if (!ontology) {
        res.status(404).json({ error: 'Ontology not found' });
        return;
      }

      if (ontology.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Access denied: must be owner or admin' });
        return;
      }

      await db
        .delete(ontologyEntityTypes)
        .where(
          and(
            eq(ontologyEntityTypes.id, typeId),
            eq(ontologyEntityTypes.ontologyId, ontologyId)
          )
        );

      await refreshEntityTypeCount(ontologyId);

      res.json({ ok: true, deleted: typeId });
    } catch (err) {
      console.error('[ontologies/:id/entity-types/:typeId DELETE]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /ontologies/:id/entity-types/:typeId/properties ─────────────────────

router.post(
  '/:id/entity-types/:typeId/properties',
  requireAuth,
  validate(createPropertySchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const ontologyId = req.params['id'];
    const typeId = req.params['typeId'];
    const body = req.body as z.infer<typeof createPropertySchema>;

    if (!ontologyId || !typeId) {
      res.status(400).json({ error: 'Ontology ID and type ID are required' });
      return;
    }

    try {
      const ontology = await getOntologyForUser(ontologyId, userId, userRole);
      if (!ontology) {
        res.status(404).json({ error: 'Ontology not found' });
        return;
      }

      if (ontology.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Access denied: must be owner or admin' });
        return;
      }

      const [entityType] = await db
        .select({ id: ontologyEntityTypes.id })
        .from(ontologyEntityTypes)
        .where(
          and(
            eq(ontologyEntityTypes.id, typeId),
            eq(ontologyEntityTypes.ontologyId, ontologyId)
          )
        )
        .limit(1);

      if (!entityType) {
        res.status(404).json({ error: 'Entity type not found' });
        return;
      }

      const [property] = await db
        .insert(ontologyProperties)
        .values({
          entityTypeId: typeId,
          name: body.name,
          dataType: body.dataType || 'string',
          required: body.required ?? false,
          searchable: body.searchable ?? true,
          weightInMatching: body.weightInMatching ?? 1.0,
        })
        .returning();

      res.status(201).json({ property });
    } catch (err) {
      console.error('[ontologies/:id/entity-types/:typeId/properties POST]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── DELETE /ontologies/:id/properties/:propId ────────────────────────────────

router.delete(
  '/:id/properties/:propId',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const ontologyId = req.params['id'];
    const propId = req.params['propId'];

    if (!ontologyId || !propId) {
      res.status(400).json({ error: 'Ontology ID and property ID are required' });
      return;
    }

    try {
      const ontology = await getOntologyForUser(ontologyId, userId, userRole);
      if (!ontology) {
        res.status(404).json({ error: 'Ontology not found' });
        return;
      }

      if (ontology.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Access denied: must be owner or admin' });
        return;
      }

      // Verify property belongs to an entity type in this ontology
      const [prop] = await db
        .select({
          id: ontologyProperties.id,
          entityTypeId: ontologyProperties.entityTypeId,
        })
        .from(ontologyProperties)
        .innerJoin(
          ontologyEntityTypes,
          eq(ontologyProperties.entityTypeId, ontologyEntityTypes.id)
        )
        .where(
          and(
            eq(ontologyProperties.id, propId),
            eq(ontologyEntityTypes.ontologyId, ontologyId)
          )
        )
        .limit(1);

      if (!prop) {
        res.status(404).json({ error: 'Property not found' });
        return;
      }

      await db.delete(ontologyProperties).where(eq(ontologyProperties.id, propId));

      res.json({ ok: true, deleted: propId });
    } catch (err) {
      console.error('[ontologies/:id/properties/:propId DELETE]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /ontologies/:id/match-rules ─────────────────────────────────────────

router.post(
  '/:id/match-rules',
  requireAuth,
  validate(createMatchRuleSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const ontologyId = req.params['id'];
    const body = req.body as z.infer<typeof createMatchRuleSchema>;

    if (!ontologyId) {
      res.status(400).json({ error: 'Ontology ID is required' });
      return;
    }

    try {
      const ontology = await getOntologyForUser(ontologyId, userId, userRole);
      if (!ontology) {
        res.status(404).json({ error: 'Ontology not found' });
        return;
      }

      if (ontology.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Access denied: must be owner or admin' });
        return;
      }

      const [matchRule] = await db
        .insert(ontologyMatchRules)
        .values({
          ontologyId,
          entityTypeA: body.entityTypeA,
          entityTypeB: body.entityTypeB,
          canMatch: body.canMatch ?? true,
          similarityMetric: body.similarityMetric || 'jaccard',
          threshold: body.threshold ?? 0.85,
          blockingStrategy: body.blockingStrategy ?? null,
          propertiesToMatch: body.propertiesToMatch || [],
        })
        .returning();

      res.status(201).json({ matchRule });
    } catch (err) {
      console.error('[ontologies/:id/match-rules POST]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── DELETE /ontologies/:id/match-rules/:ruleId ───────────────────────────────

router.delete(
  '/:id/match-rules/:ruleId',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const ontologyId = req.params['id'];
    const ruleId = req.params['ruleId'];

    if (!ontologyId || !ruleId) {
      res.status(400).json({ error: 'Ontology ID and rule ID are required' });
      return;
    }

    try {
      const ontology = await getOntologyForUser(ontologyId, userId, userRole);
      if (!ontology) {
        res.status(404).json({ error: 'Ontology not found' });
        return;
      }

      if (ontology.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Access denied: must be owner or admin' });
        return;
      }

      await db
        .delete(ontologyMatchRules)
        .where(
          and(
            eq(ontologyMatchRules.id, ruleId),
            eq(ontologyMatchRules.ontologyId, ontologyId)
          )
        );

      res.json({ ok: true, deleted: ruleId });
    } catch (err) {
      console.error('[ontologies/:id/match-rules/:ruleId DELETE]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /ontologies/:id/export ──────────────────────────────────────────────

router.post(
  '/:id/export',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const ontologyId = req.params['id'];

    if (!ontologyId) {
      res.status(400).json({ error: 'Ontology ID is required' });
      return;
    }

    try {
      const ontology = await getOntologyForUser(ontologyId, userId, userRole);
      if (!ontology) {
        res.status(404).json({ error: 'Ontology not found' });
        return;
      }

      const entityTypes = await db
        .select()
        .from(ontologyEntityTypes)
        .where(eq(ontologyEntityTypes.ontologyId, ontologyId));

      const entityTypeIds = entityTypes.map((et) => et.id);
      let properties: (typeof ontologyProperties.$inferSelect)[] = [];
      if (entityTypeIds.length > 0) {
        properties = await db
          .select()
          .from(ontologyProperties)
          .where(
            entityTypeIds.length === 1
              ? eq(ontologyProperties.entityTypeId, entityTypeIds[0]!)
              : or(...entityTypeIds.map((id) => eq(ontologyProperties.entityTypeId, id)))
          );
      }

      const matchRules = await db
        .select()
        .from(ontologyMatchRules)
        .where(eq(ontologyMatchRules.ontologyId, ontologyId));

      const exportData = {
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        name: ontology.name,
        description: ontology.description,
        scope: ontology.scope,
        source: ontology.source,
        entityTypes: entityTypes.map((et) => ({
          name: et.name,
          qid: et.qid,
          aliases: et.aliases,
          description: et.description,
          parentQid: et.parentQid,
          confidenceThreshold: et.confidenceThreshold,
          color: et.color,
          properties: properties
            .filter((p) => p.entityTypeId === et.id)
            .map((p) => ({
              name: p.name,
              dataType: p.dataType,
              required: p.required,
              searchable: p.searchable,
              weightInMatching: p.weightInMatching,
            })),
        })),
        matchRules: matchRules.map((r) => ({
          entityTypeA: r.entityTypeA,
          entityTypeB: r.entityTypeB,
          canMatch: r.canMatch,
          similarityMetric: r.similarityMetric,
          threshold: r.threshold,
          blockingStrategy: r.blockingStrategy,
          propertiesToMatch: r.propertiesToMatch,
        })),
      };

      res.json({ export: exportData });
    } catch (err) {
      console.error('[ontologies/:id/export POST]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /ontologies/import ──────────────────────────────────────────────────

router.post(
  '/import',
  requireAuth,
  validate(importOntologySchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { data } = req.body as z.infer<typeof importOntologySchema>;

    try {
      // Create ontology
      const [ontology] = await db
        .insert(ontologies)
        .values({
          userId,
          name: data.name,
          description: data.description ?? null,
          scope: data.scope || 'private',
          source: data.source || 'import',
          entityTypeCount: 0,
          version: 1,
        })
        .returning();

      if (!ontology) {
        res.status(500).json({ error: 'Failed to create ontology during import' });
        return;
      }

      // Import entity types + properties
      const entityTypes = (data.entityTypes as Record<string, unknown>[]) || [];
      for (const et of entityTypes) {
        const [entityType] = await db
          .insert(ontologyEntityTypes)
          .values({
            ontologyId: ontology.id,
            name: (et['name'] as string) || 'Unknown',
            qid: (et['qid'] as string) ?? null,
            aliases: (et['aliases'] as string[]) || [],
            description: (et['description'] as string) ?? null,
            parentQid: (et['parentQid'] as string) ?? null,
            confidenceThreshold: (et['confidenceThreshold'] as number) ?? 0.8,
            color: (et['color'] as string) ?? null,
          })
          .returning();

        if (!entityType) continue;

        const props = (et['properties'] as Record<string, unknown>[]) || [];
        for (const p of props) {
          await db.insert(ontologyProperties).values({
            entityTypeId: entityType.id,
            name: (p['name'] as string) || 'property',
            dataType: (p['dataType'] as string) || 'string',
            required: (p['required'] as boolean) ?? false,
            searchable: (p['searchable'] as boolean) ?? true,
            weightInMatching: (p['weightInMatching'] as number) ?? 1.0,
          });
        }
      }

      // Import match rules
      const matchRules = (data.matchRules as Record<string, unknown>[]) || [];
      for (const r of matchRules) {
        await db.insert(ontologyMatchRules).values({
          ontologyId: ontology.id,
          entityTypeA: (r['entityTypeA'] as string) || '',
          entityTypeB: (r['entityTypeB'] as string) || '',
          canMatch: (r['canMatch'] as boolean) ?? true,
          similarityMetric: (r['similarityMetric'] as string) || 'jaccard',
          threshold: (r['threshold'] as number) ?? 0.85,
          blockingStrategy: (r['blockingStrategy'] as string) ?? null,
          propertiesToMatch: (r['propertiesToMatch'] as string[]) || [],
        });
      }

      await refreshEntityTypeCount(ontology.id);

      const [finalOntology] = await db
        .select()
        .from(ontologies)
        .where(eq(ontologies.id, ontology.id))
        .limit(1);

      res.status(201).json({ ontology: finalOntology });
    } catch (err) {
      console.error('[ontologies/import POST]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
