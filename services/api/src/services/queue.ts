import { createClient, type RedisClientType } from 'redis';
import { config } from '../config.js';

export interface KexJobData {
  job_id: string;
  user_id: string;
  type: string;
  input: string;
  entity_types?: string[];
}

let client: RedisClientType | null = null;
let subscriber: RedisClientType | null = null;

const getClient = async (): Promise<RedisClientType> => {
  if (!client) {
    client = createClient({ url: config.redisUrl });
    client.on('error', (err) => console.error('[Redis] Client error:', err));
    await client.connect();
    console.log('[Redis] Connected');
  }
  return client;
};

/**
 * Push a KEX job to the Redis list that the KEX worker BLPOPs from.
 * Payload format matches what kex/src/main.py expects:
 *   { job_id, user_id, type: "text"|"url", input: <text or url string> }
 */
export const addKexJob = async (
  jobId: string,
  data: { userId: string; type: string; input: Record<string, unknown> }
): Promise<void> => {
  const redis = await getClient();

  // Map API job type to KEX worker input format
  let inputType = 'text';
  let inputValue = '';

  const entityTypes = data.input['entityTypes'] as string[] | undefined;

  if (data.type === 'kex_extract') {
    inputType = 'text';
    inputValue = (data.input['text'] as string) ?? '';
  } else if (data.type === 'kex_upload') {
    inputType = 'file';
    inputValue = JSON.stringify(data.input);
  }

  const payload: KexJobData = {
    job_id: jobId,
    user_id: data.userId,
    type: inputType,
    input: inputValue,
    ...(entityTypes && entityTypes.length > 0 ? { entity_types: entityTypes } : {}),
  };

  await redis.lPush('kex:jobs', JSON.stringify(payload));
  console.log(`[Queue] KEX job dispatched: ${jobId}`);
};

export interface FuseJobData {
  job_id: string;
  user_id: string;
  compilation_id: string;
  source_job_ids: string[];
  name: string;
}

/**
 * Push a FUSE merge job to the Redis list that the FUSE worker BLPOPs from.
 */
export const addFuseJob = async (
  jobId: string,
  data: {
    userId: string;
    compilationId: string;
    sourceJobIds: string[];
    name: string;
    matchRules?: Array<Record<string, unknown>>;
  }
): Promise<void> => {
  const redis = await getClient();

  const payload: FuseJobData & { match_rules?: unknown[] } = {
    job_id: jobId,
    user_id: data.userId,
    compilation_id: data.compilationId,
    source_job_ids: data.sourceJobIds,
    name: data.name,
    ...(data.matchRules ? { match_rules: data.matchRules } : {}),
  };

  await redis.lPush('fuse:jobs', JSON.stringify(payload));
  console.log(`[Queue] FUSE job dispatched: ${jobId}`);
};

/**
 * Subscribe to 'kex:results' channel for job completion notifications.
 * The callback receives parsed result objects.
 */
export const subscribeToResults = async (
  callback: (result: {
    job_id: string;
    status: 'completed' | 'failed' | 'processing';
    result?: Record<string, unknown>;
    error?: string;
  }) => void
): Promise<void> => {
  subscriber = createClient({ url: config.redisUrl });
  subscriber.on('error', (err) =>
    console.error('[Redis] Subscriber error:', err)
  );
  await subscriber.connect();

  const handler = (message: string) => {
    try {
      const data = JSON.parse(message);
      callback(data);
    } catch (err) {
      console.error('[Queue] Failed to parse result:', err);
    }
  };

  await subscriber.subscribe('kex:results', handler);
  await subscriber.subscribe('fuse:results', handler);

  console.log('[Redis] Subscribed to kex:results + fuse:results');
};

// ─── Queue depth & worker thread config ──────────────────────────────────────

export const getQueueDepth = async (): Promise<number> => {
  const redis = await getClient();
  return redis.lLen('kex:jobs');
};

export const getWorkerThreads = async (): Promise<number> => {
  const redis = await getClient();
  const val = await redis.get('kex:config:threads');
  return val ? parseInt(val, 10) : 1;
};

export const setWorkerThreads = async (threads: number): Promise<void> => {
  const redis = await getClient();
  await redis.set('kex:config:threads', String(threads));
  console.log(`[Queue] Worker threads set to ${threads}`);
};

export const closeQueue = async (): Promise<void> => {
  if (subscriber) {
    await subscriber.disconnect();
    subscriber = null;
  }
  if (client) {
    await client.disconnect();
    client = null;
  }
};
