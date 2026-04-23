import { db } from '../db/index.js';
import { appVersions } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';

export async function getCurrentVersion(tier: string): Promise<{
  version: string;
  updateAvailable: boolean;
  updateRequired: boolean;
}> {
  const [latest] = await db.select()
    .from(appVersions)
    .where(eq(appVersions.channel, 'stable'))
    .orderBy(desc(appVersions.createdAt))
    .limit(1);

  if (!latest) {
    return { version: '1.0.0', updateAvailable: false, updateRequired: false };
  }

  return {
    version: latest.version,
    updateAvailable: true,
    updateRequired: latest.updateRequired,
  };
}
