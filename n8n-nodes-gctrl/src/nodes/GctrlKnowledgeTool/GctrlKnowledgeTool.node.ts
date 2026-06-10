import {
	IExecuteFunctions,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { gctrlApiRequest } from '../../shared/GctrlApiClient';

/**
 * Ground Control Knowledge Tool for n8n AI Agents.
 *
 * Gives AI agents the ability to query Ground Control knowledge graphs
 * as a tool during their reasoning process. The agent can ask
 * questions about structured knowledge and get grounded answers
 * with sources and confidence scores.
 */

class GctrlKnowledgeToolProvider {
	private ctx: IExecuteFunctions | ISupplyDataFunctions;
	private compilationId: string;
	private toolDescription: string;

	name = 'gctrl_knowledge';
	description: string;

	constructor(
		ctx: IExecuteFunctions | ISupplyDataFunctions,
		compilationId: string,
		toolDescription: string,
	) {
		this.ctx = ctx;
		this.compilationId = compilationId;
		this.toolDescription = toolDescription;
		this.description = toolDescription;
	}

	async call(input: string): Promise<string> {
		const body: IDataObject = { question: input };
		if (this.compilationId) {
			body.compilationId = this.compilationId;
		}

		try {
			const result = await gctrlApiRequest(
				this.ctx as IExecuteFunctions,
				'POST',
				'/rag/query',
				body,
			);

			const answer = (result.answer as string) || 'No answer found.';
			const confidence = result.confidence as number;
			const sources = result.sources as IDataObject[];

			let response = answer;
			if (confidence) {
				response += `\n\nConfidence: ${Math.round(confidence * 100)}%`;
			}
			if (sources && sources.length > 0) {
				const sourceNames = sources
					.slice(0, 5)
					.map((s) => `- ${s.type}: ${s.name || s.content || 'unknown'}`)
					.join('\n');
				response += `\n\nSources:\n${sourceNames}`;
			}

			return response;
		} catch (error) {
			return `Error querying Ground Control: ${(error as Error).message}`;
		}
	}
}

export class GctrlKnowledgeTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Ground Control Knowledge Tool',
		name: 'gctrlKnowledgeTool',
		icon: 'file:gctrl.svg',
		group: ['transform'],
		version: 1,
		description: 'Give AI agents access to Ground Control knowledge graphs. Agents can query structured knowledge and get grounded answers.',
		defaults: {
			name: 'Ground Control Knowledge',
		},
		inputs: [],
		outputs: [
			{
				type: 'ai_tool',
				displayName: 'Tool',
			},
		],
		credentials: [
			{
				name: 'gctrlApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Connect this tool to an AI Agent node. The agent will be able to query your knowledge graphs.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Tool Description',
				name: 'toolDescription',
				type: 'string',
				typeOptions: { rows: 3 },
				default: 'Search the Ground Control knowledge graph for information about entities, relationships, and facts. Use this tool when you need to find specific information from the structured knowledge base.',
				description: 'Description shown to the AI agent so it knows when to use this tool',
			},
			{
				displayName: 'Compilation ID',
				name: 'compilationId',
				type: 'string',
				default: '',
				description: 'Optional: scope queries to a specific knowledge graph. Leave empty to search all.',
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions): Promise<SupplyData> {
		const compilationId = this.getNodeParameter('compilationId', 0, '') as string;
		const toolDescription = this.getNodeParameter('toolDescription', 0, '') as string;

		const tool = new GctrlKnowledgeToolProvider(this, compilationId, toolDescription);

		return {
			response: tool,
		};
	}
}
