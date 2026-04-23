export interface UsageRecord {
  action: string;
  chars_processed: number;
  credits_spent: number;
  timestamp?: string;
}

export class UsageQueue {
  private queue: UsageRecord[] = [];

  enqueue(record: Omit<UsageRecord, 'timestamp'>) {
    this.queue.push({ ...record, timestamp: new Date().toISOString() });
  }

  flush(): UsageRecord[] {
    const records = [...this.queue];
    this.queue = [];
    return records;
  }

  size(): number { return this.queue.length; }
}

export const usageQueue = new UsageQueue();
