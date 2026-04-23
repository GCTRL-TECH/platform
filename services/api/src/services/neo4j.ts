import neo4j, { Driver, Session, QueryResult } from 'neo4j-driver';
import { config } from '../config.js';

let driver: Driver | null = null;

export const getDriver = (): Driver => {
  if (!driver) {
    driver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
      {
        maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3h
        maxConnectionPoolSize: 50,
        connectionAcquisitionTimeout: 10000,
        logging: {
          level: config.nodeEnv === 'development' ? 'info' : 'warn',
          logger: (level, message) => {
            console.log(`[Neo4j][${level}] ${message}`);
          },
        },
      }
    );
  }
  return driver;
};

export const runQuery = async (
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<QueryResult> => {
  const session: Session = getDriver().session();
  try {
    return await session.run(cypher, params);
  } finally {
    await session.close();
  }
};

export const closeDriver = async (): Promise<void> => {
  if (driver) {
    await driver.close();
    driver = null;
  }
};

export { driver };
