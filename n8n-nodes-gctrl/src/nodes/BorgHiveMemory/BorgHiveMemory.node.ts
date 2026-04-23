import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { GCTRLApiRequest } from '../../shared/GCTRLApiClient';

/**
 * GCTRL Memory node for n8n AI Agents.
 *
 * Works as an AI memory provider: the agent can store and recall
 * knowledge across workflow executions using GCTRL's knowledge graph.
 *
 * Unlike in-memory or Redis memory, this creates structured entities
 * and vector embeddings - so the agent's memory is queryable, fuseable,
 * and part of the larger knowledge graph.
 */

// Minimal LangChain-compatible memory interface
class GCTRLMemoryProvider {
	private ctx: IExecuteFunctions | ISupplyDataFunctions;
	private compilationId: string;
	private sessionId: string;

	constructor(
		ctx: IExecuteFunctions | ISupplyDataFunctions,
		compilationId: string,
		sessionId: string,
	) {
		this.ctx = ctx;
		this.compilationId = compilationId;
		this.sessionId = sessionId;
	}

	async loadMemoryVariables(_values: Record<string, unknown>): Promise<Record<string, string>> {
		// Query GCTRL for this session's memory
		const body: IDataObject = {
			question: `What do you remember from session ${this.sessionId}?`,
		};
		if (this.compilationId) {
			body.compilationId = this.compilationId;
		}

		try {
			const result = await GCTRLApiRequest(
				this.ctx as IExecuteFunctions,
				'POST',
				'/rag/query',
				body,
			);
			return {
				history: (result.answer as string) || '',
			};
		} catch {
			return { history: '' };
		}
	}

	async saveContext(
		inputValues: Record<string, string>,
		outputValues: Record<string, string>,
	): Promise<void> {
		const input = inputValues.input || inputValues.human || '';
		const output = outputValues.output || outputValues.ai || '';

		if (!input && !output) return;

		const text = `Session ${this.sessionId} conversation:\nHuman: ${input}\nAI: ${output}`;

		try {
			await GCTRLApiRequest(
				this.ctx as IExecuteFunctions,
				'POST',
				'/kex/extract',
				{ text, title: `Memory: ${this.sessionId}` } as IDataObject,
			);
		} catch {
			// Non-fatal: don't break the workflow if memory save fails
		}
	}

	async clear(): Promise<void> {
		// No-op: GCTRL knowledge is append-only (version-controlled)
	}
}

export class GCTRLMemory implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GCTRL Memory',
		name: 'GCTRLMemory',
		icon: 'file:GCTRL.svg',
		group: ['transform'],
		version: 1,
		description: 'Use GCTRL as persistent knowledge graph memory for AI agents. Memory survives across workflow executions and is queryable.',
		defaults: {
			name: 'GCTRL Memory',
		},
		// This is a memory provider for AI agents
		inputs: [],
		outputs: [
			{
				type: 'ai_memory',
				displayName: 'Memory',
			},
		],
		credentials: [
			{
				name: 'GCTRLApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'This node provides persistent memory backed by GCTRL knowledge graphs. Connect it to an AI Agent node.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Session ID',
				name: 'sessionIdType',
				type: 'options',
				default: 'fromInput',
				options: [
					{
						name: 'Connected Chat Trigger Node',
						value: 'fromInput',
						description: 'Uses sessionId from a connected Chat Trigger',
					},
					{
						name: 'Define Below',
						value: 'customKey',
						description: 'Use a custom expression or static text',
					},
				],
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				displayOptions: {
					show: { sessionIdType: ['fromInput'] },
				},
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				displayOptions: {
					show: { sessionIdType: ['customKey'] },
				},
			},
			{
				displayName: 'Compilation ID',
				name: 'compilationId',
				type: 'string',
				default: '',
				description: 'Optional: scope memory to a specific knowledge graph. Leave empty to use all graphs.',
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions): Promise<SupplyData> {
		const sessionId = this.getNodeParameter('sessionId', 0, 'default') as string;
		const compilationId = this.getNodeParameter('compilationId', 0, '') as string;

		const memory = new GCTRLMemoryProvider(this, compilationId, sessionId);

		return {
			response: memory,
		};
	}
}

