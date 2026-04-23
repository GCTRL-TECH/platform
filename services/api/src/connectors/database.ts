/**
 * Database Connectors
 * Connect directly to external databases, query tables/collections,
 * and convert data to text for KEX extraction.
 *
 * Supports: PostgreSQL, MySQL, MongoDB
 */

export interface DatabaseConfig {
  type: 'postgresql' | 'mysql' | 'mongodb';
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
}

export interface TableInfo {
  name: string;
  schema?: string;
  rowCount?: number;
  columns?: Array<{ name: string; type: string }>;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
}

// ─── PostgreSQL ──────────────────────────────────────────────────────────────

export async function listPostgresTables(config: DatabaseConfig): Promise<TableInfo[]> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    const result = await client.query(`
      SELECT table_schema, table_name,
        (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = t.table_schema) as col_count
      FROM information_schema.tables t
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `);

    return result.rows.map((r: Record<string, unknown>) => ({
      name: r.table_name as string,
      schema: r.table_schema as string,
      columns: [],
    }));
  } finally {
    await client.end();
  }
}

export async function queryPostgres(config: DatabaseConfig, query: string, limit = 1000): Promise<QueryResult> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
    query_timeout: 30000,
  });

  try {
    await client.connect();
    // Safety: add LIMIT if not present
    const safeQuery = query.trim().toLowerCase().includes('limit')
      ? query
      : `${query} LIMIT ${limit}`;
    const result = await client.query(safeQuery);
    const columns = result.fields.map((f: { name: string }) => f.name);

    return {
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? 0,
      columns,
    };
  } finally {
    await client.end();
  }
}

// ─── MySQL ───────────────────────────────────────────────────────────────────

export async function listMysqlTables(config: DatabaseConfig): Promise<TableInfo[]> {
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl: config.ssl ? {} : undefined,
    connectTimeout: 10000,
  });

  try {
    const [rows] = await connection.query('SHOW TABLES');
    const tables = (rows as Record<string, string>[]).map((r) => ({
      name: Object.values(r)[0] as string,
    }));
    return tables;
  } finally {
    await connection.end();
  }
}

export async function queryMysql(config: DatabaseConfig, query: string, limit = 1000): Promise<QueryResult> {
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl: config.ssl ? {} : undefined,
    connectTimeout: 10000,
  });

  try {
    const safeQuery = query.trim().toLowerCase().includes('limit')
      ? query
      : `${query} LIMIT ${limit}`;
    const [rows, fields] = await connection.query(safeQuery);
    const columns = (fields as Array<{ name: string }>).map((f) => f.name);

    return {
      rows: rows as Record<string, unknown>[],
      rowCount: (rows as unknown[]).length,
      columns,
    };
  } finally {
    await connection.end();
  }
}

// ─── MongoDB ─────────────────────────────────────────────────────────────────

export async function listMongoCollections(config: DatabaseConfig): Promise<TableInfo[]> {
  const { MongoClient } = await import('mongodb');
  const uri = `mongodb://${config.username}:${config.password}@${config.host}:${config.port}/${config.database}`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });

  try {
    await client.connect();
    const db = client.db(config.database);
    const collections = await db.listCollections().toArray();

    return collections.map((c) => ({ name: c.name }));
  } finally {
    await client.close();
  }
}

export async function queryMongo(config: DatabaseConfig, collection: string, filter: Record<string, unknown> = {}, limit = 1000): Promise<QueryResult> {
  const { MongoClient } = await import('mongodb');
  const uri = `mongodb://${config.username}:${config.password}@${config.host}:${config.port}/${config.database}`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });

  try {
    await client.connect();
    const db = client.db(config.database);
    const docs = await db.collection(collection).find(filter).limit(limit).toArray();

    const columns = docs.length > 0 ? Object.keys(docs[0]!) : [];

    return {
      rows: docs as Record<string, unknown>[],
      rowCount: docs.length,
      columns,
    };
  } finally {
    await client.close();
  }
}

// ─── Convert query results to text for KEX ───────────────────────────────────

export function queryResultToText(result: QueryResult, tableName: string): string {
  if (result.rows.length === 0) return `Table "${tableName}" is empty.`;

  const lines: string[] = [
    `Table: ${tableName}`,
    `Columns: ${result.columns.join(', ')}`,
    `Rows: ${result.rowCount}`,
    '',
  ];

  for (const row of result.rows) {
    const parts = result.columns
      .map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return null;
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
        if (str.length > 500) return `${col}: ${str.slice(0, 500)}...`;
        return `${col}: ${str}`;
      })
      .filter(Boolean);
    lines.push(parts.join(' | '));
  }

  return lines.join('\n');
}
