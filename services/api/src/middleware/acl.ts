import { Request, Response, NextFunction } from 'express';
import { UserClearance } from '../models/schema.js';

// Clearance hierarchy: higher index = higher clearance
export const CLEARANCE_LEVELS: UserClearance[] = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
];

export const getClearanceLevel = (clearance: UserClearance): number => {
  return CLEARANCE_LEVELS.indexOf(clearance);
};

export const canAccess = (
  userClearance: UserClearance,
  resourceClearance: UserClearance
): boolean => {
  return getClearanceLevel(userClearance) >= getClearanceLevel(resourceClearance);
};

/**
 * Middleware that attaches clearance-based Neo4j filter clauses to the request.
 * Routes that query Neo4j should use req.neo4jClearanceFilter in their Cypher WHERE clause.
 *
 * Usage in Cypher:
 *   WHERE node._classification IN $allowedClassifications
 */
export const classificationFilter = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const userLevel = getClearanceLevel(req.user.clearance);
  const allowed = CLEARANCE_LEVELS.slice(0, userLevel + 1);

  // Attach to request for downstream use
  (req as Request & { neo4jClearanceFilter: UserClearance[] }).neo4jClearanceFilter = allowed;

  next();
};

// Augment Express Request type
declare global {
  namespace Express {
    interface Request {
      neo4jClearanceFilter?: UserClearance[];
    }
  }
}
