import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IDataObject,
} from 'n8n-workflow';
import { gctrlApiRequest } from '../../shared/GctrlApiClient';

/**
 * Provenance for a knowledge write: where the text came from, so the extracted
 * facts stay traceable in the graph.
 *
 * The configured "Source Reference" wins. When it is empty we fall back to what
 * the incoming item already carries — a file handed over by a previous node
 * (binary file name, with its folder when known), or a path/URL field on the
 * item's JSON. That way the origin travels along even when nobody configured
 * anything, which is the only way provenance actually happens in a workflow.
 */
function resolveSourceRef(explicit: string, item: INodeExecutionData | undefined): string | undefined {
	if (explicit) return explicit;
	if (!item) return undefined;

	for (const binary of Object.values(item.binary ?? {})) {
		const fileName = binary?.fileName;
		if (fileName) {
			const directory = binary.directory;
			return directory ? `${directory}/${fileName}` : fileName;
		}
	}

	const json = (item.json ?? {}) as IDataObject;
	for (const key of ['sourceRef', 'filePath', 'fileName', 'url', 'webUrl', 'link']) {
		const value = json[key];
		if (typeof value === 'string' && value) return value;
	}

	return undefined;
}

export class Gctrl implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Ground Control',
		name: 'gctrl',
		icon: 'file:gctrl.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Interact with Ground Control knowledge graphs - extract, query, fuse, search, and manage structured knowledge',
		defaults: {
			name: 'Ground Control',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'gctrlApi',
				required: true,
			},
		],
		properties: [
			// ─── Resource ────────────────────────────────────────────────────
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Knowledge', value: 'knowledge', description: 'Extract and store knowledge' },
					{ name: 'Query', value: 'query', description: 'Query knowledge graphs' },
					{ name: 'Graph', value: 'graph', description: 'Manage knowledge graphs (compilations)' },
					{ name: 'Fusion', value: 'fusion', description: 'Merge graphs together' },
					{ name: 'Entity', value: 'entity', description: 'Search and browse entities' },
					{ name: 'Ontology', value: 'ontology', description: 'Manage ontologies' },
				],
				default: 'knowledge',
			},

			// ─── Knowledge Operations ────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['knowledge'] } },
				options: [
					{ name: 'Extract', value: 'extract', description: 'Extract knowledge from text', action: 'Extract knowledge from text' },
					{ name: 'Store', value: 'store', description: 'Store knowledge (with title)', action: 'Store knowledge' },
					{ name: 'Upload File', value: 'upload', description: 'Upload a file for extraction', action: 'Upload file for extraction' },
					{ name: 'List Jobs', value: 'listJobs', description: 'List extraction jobs', action: 'List extraction jobs' },
					{ name: 'Get Job', value: 'getJob', description: 'Get extraction job status', action: 'Get extraction job status' },
				],
				default: 'extract',
			},

			// ─── Query Operations ────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['query'] } },
				options: [
					{ name: 'Ask Question', value: 'ask', description: 'Ask a natural language question', action: 'Ask a question' },
					{ name: 'Get Schema', value: 'schema', description: 'Get knowledge graph schema', action: 'Get graph schema' },
				],
				default: 'ask',
			},

			// ─── Graph Operations ────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['graph'] } },
				options: [
					{ name: 'List', value: 'list', description: 'List all knowledge graphs', action: 'List knowledge graphs' },
					{ name: 'Get', value: 'get', description: 'Get a specific knowledge graph', action: 'Get knowledge graph' },
					{ name: 'Create', value: 'create', description: 'Create a new compilation', action: 'Create knowledge graph' },
					{ name: 'Refresh', value: 'refresh', description: 'Trigger a manual refresh', action: 'Refresh knowledge graph' },
					{ name: 'Delete', value: 'delete', description: 'Delete a compilation', action: 'Delete knowledge graph' },
				],
				default: 'list',
			},

			// ─── Fusion Operations ────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['fusion'] } },
				options: [
					{ name: 'Merge', value: 'merge', description: 'Merge extraction jobs into a graph', action: 'Merge graphs' },
					{ name: 'Get Job', value: 'getJob', description: 'Get fusion job status', action: 'Get fusion job status' },
					{ name: 'List Jobs', value: 'listJobs', description: 'List fusion jobs', action: 'List fusion jobs' },
				],
				default: 'merge',
			},

			// ─── Entity Operations ───────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['entity'] } },
				options: [
					{ name: 'Search', value: 'search', description: 'Search entities by name or type', action: 'Search entities' },
				],
				default: 'search',
			},

			// ─── Ontology Operations ─────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['ontology'] } },
				options: [
					{ name: 'List', value: 'list', description: 'List all ontologies', action: 'List ontologies' },
				],
				default: 'list',
			},

			// ═══════════════════════════════════════════════════════════════════
			// PARAMETERS
			// ═══════════════════════════════════════════════════════════════════

			// ─── Text input (extract, store, ask) ────────────────────────────
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 6 },
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['knowledge'],
						operation: ['extract', 'store'],
					},
				},
				description: 'The text content to extract knowledge from or store',
			},
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['knowledge'],
						operation: ['store'],
					},
				},
				description: 'Optional title for the stored knowledge',
			},
			{
				displayName: 'Source Reference',
				name: 'sourceRef',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['knowledge'],
						operation: ['extract', 'store'],
					},
				},
				description:
					'Optional: where this knowledge comes from (file path, URL, ticket ID, run identifier), kept with the extraction so facts stay traceable. Leave empty to take the origin from the incoming item (a file from a previous node, or its url/filePath field) — or, for Store, from the title.',
			},
			{
				displayName: 'Question',
				name: 'question',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['query'],
						operation: ['ask'],
					},
				},
				description: 'Natural language question about the knowledge graph',
			},

			// ─── Compilation ID (various) ────────────────────────────────────
			{
				displayName: 'Compilation ID',
				name: 'compilationId',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['query'],
						operation: ['ask'],
					},
				},
				description: 'Optional: query a specific graph. Leave empty to search all.',
			},
			{
				displayName: 'Compilation ID',
				name: 'compilationId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['graph'],
						operation: ['get', 'refresh', 'delete'],
					},
				},
			},

			// ─── Graph Create params ─────────────────────────────────────────
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['graph'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Classification',
				name: 'classification',
				type: 'options',
				options: [
					{ name: 'Public', value: 'PUBLIC' },
					{ name: 'Internal', value: 'INTERNAL' },
					{ name: 'Confidential', value: 'CONFIDENTIAL' },
					{ name: 'Restricted', value: 'RESTRICTED' },
				],
				default: 'INTERNAL',
				displayOptions: {
					show: {
						resource: ['graph'],
						operation: ['create'],
					},
				},
			},

			// ─── Fusion Merge params ─────────────────────────────────────────
			{
				displayName: 'Name',
				name: 'fusionName',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['fusion'],
						operation: ['merge'],
					},
				},
				description: 'Name for the fused knowledge graph',
			},
			{
				displayName: 'Source Job IDs',
				name: 'sourceJobIds',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['fusion'],
						operation: ['merge'],
					},
				},
				description: 'Comma-separated extraction job IDs to merge',
			},
			{
				displayName: 'Target Compilation ID',
				name: 'targetCompilationId',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['fusion'],
						operation: ['merge'],
					},
				},
				description: 'Optional: enrich an existing graph instead of creating a new one',
			},

			// ─── Entity Search params ────────────────────────────────────────
			{
				displayName: 'Search Query',
				name: 'searchQuery',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['entity'],
						operation: ['search'],
					},
				},
				description: 'Entity name or partial match',
			},
			{
				displayName: 'Entity Type',
				name: 'entityType',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['entity'],
						operation: ['search'],
					},
				},
				description: 'Optional: filter by entity type (e.g. "person", "company")',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 20,
				displayOptions: {
					show: {
						resource: ['entity'],
						operation: ['search'],
					},
				},
			},

			// ─── Job ID (various) ────────────────────────────────────────────
			{
				displayName: 'Job ID',
				name: 'jobId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						operation: ['getJob'],
					},
				},
			},

			// ─── Ontology ID (optional, for extract) ─────────────────────────
			{
				displayName: 'Ontology ID',
				name: 'ontologyId',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['knowledge'],
						operation: ['extract'],
					},
				},
				description: 'Optional: guide extraction with a specific ontology',
			},
			{
				displayName: 'Discovery Mode',
				name: 'discoveryMode',
				type: 'options',
				options: [
					{ name: 'Discover (Find All Types)', value: 'discover' },
					{ name: 'Strict (Ontology Only)', value: 'strict' },
				],
				default: 'discover',
				displayOptions: {
					show: {
						resource: ['knowledge'],
						operation: ['extract'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const resource = this.getNodeParameter('resource', i) as string;
			const operation = this.getNodeParameter('operation', i) as string;

			let responseData: IDataObject;

			// ─── Knowledge ──────────────────────────────────────────────────
			if (resource === 'knowledge') {
				if (operation === 'extract') {
					const text = this.getNodeParameter('text', i) as string;
					const ontologyId = this.getNodeParameter('ontologyId', i, '') as string;
					const discoveryMode = this.getNodeParameter('discoveryMode', i, 'discover') as string;
					const configuredSourceRef = this.getNodeParameter('sourceRef', i, '') as string;
					const body: IDataObject = { text, discoveryMode };
					if (ontologyId) body.ontologyId = ontologyId;
					const sourceRef = resolveSourceRef(configuredSourceRef, items[i]);
					if (sourceRef) body.sourceRef = sourceRef;
					responseData = await gctrlApiRequest(this, 'POST', '/kex/extract', body);

				} else if (operation === 'store') {
					const text = this.getNodeParameter('text', i) as string;
					const title = this.getNodeParameter('title', i, '') as string;
					const configuredSourceRef = this.getNodeParameter('sourceRef', i, '') as string;
					const body: IDataObject = { text };
					if (title) body.title = title;
					// Origin, best first: what was configured, else what the item carries,
					// else the title — a named note beats no origin at all.
					const sourceRef = resolveSourceRef(configuredSourceRef, items[i]) ?? (title || undefined);
					if (sourceRef) body.sourceRef = sourceRef;
					responseData = await gctrlApiRequest(this, 'POST', '/kex/extract', body);

				} else if (operation === 'listJobs') {
					responseData = await gctrlApiRequest(this, 'GET', '/kex/jobs');

				} else if (operation === 'getJob') {
					const jobId = this.getNodeParameter('jobId', i) as string;
					responseData = await gctrlApiRequest(this, 'GET', `/kex/jobs/${jobId}`);

				} else {
					responseData = {};
				}

			// ─── Query ──────────────────────────────────────────────────────
			} else if (resource === 'query') {
				if (operation === 'ask') {
					const question = this.getNodeParameter('question', i) as string;
					const compilationId = this.getNodeParameter('compilationId', i, '') as string;
					const body: IDataObject = { question };
					if (compilationId) body.compilationId = compilationId;
					responseData = await gctrlApiRequest(this, 'POST', '/rag/query', body);

				} else if (operation === 'schema') {
					responseData = await gctrlApiRequest(this, 'GET', '/kg/schema');

				} else {
					responseData = {};
				}

			// ─── Graph ──────────────────────────────────────────────────────
			} else if (resource === 'graph') {
				if (operation === 'list') {
					responseData = await gctrlApiRequest(this, 'GET', '/kg/compilations');

				} else if (operation === 'get') {
					const compilationId = this.getNodeParameter('compilationId', i) as string;
					responseData = await gctrlApiRequest(this, 'GET', `/kg/compilations/${compilationId}`);

				} else if (operation === 'create') {
					const name = this.getNodeParameter('name', i) as string;
					const classification = this.getNodeParameter('classification', i) as string;
					responseData = await gctrlApiRequest(this, 'POST', '/kg/compilations', {
						name,
						classification,
					});

				} else if (operation === 'refresh') {
					const compilationId = this.getNodeParameter('compilationId', i) as string;
					responseData = await gctrlApiRequest(this, 'POST', `/kg/compilations/${compilationId}/refresh`);

				} else if (operation === 'delete') {
					const compilationId = this.getNodeParameter('compilationId', i) as string;
					responseData = await gctrlApiRequest(this, 'DELETE', `/kg/compilations/${compilationId}`);

				} else {
					responseData = {};
				}

			// ─── Fusion ─────────────────────────────────────────────────────
			} else if (resource === 'fusion') {
				if (operation === 'merge') {
					const name = this.getNodeParameter('fusionName', i) as string;
					const sourceJobIdsStr = this.getNodeParameter('sourceJobIds', i) as string;
					const targetCompilationId = this.getNodeParameter('targetCompilationId', i, '') as string;
					const sourceJobIds = sourceJobIdsStr.split(',').map((s) => s.trim()).filter(Boolean);
					const body: IDataObject = { name, sourceJobIds };
					if (targetCompilationId) body.targetCompilationId = targetCompilationId;
					responseData = await gctrlApiRequest(this, 'POST', '/fuse/merge', body);

				} else if (operation === 'getJob') {
					const jobId = this.getNodeParameter('jobId', i) as string;
					responseData = await gctrlApiRequest(this, 'GET', `/fuse/jobs/${jobId}`);

				} else if (operation === 'listJobs') {
					responseData = await gctrlApiRequest(this, 'GET', '/fuse/jobs');

				} else {
					responseData = {};
				}

			// ─── Entity ─────────────────────────────────────────────────────
			} else if (resource === 'entity') {
				if (operation === 'search') {
					const query = this.getNodeParameter('searchQuery', i) as string;
					const entityType = this.getNodeParameter('entityType', i, '') as string;
					const limit = this.getNodeParameter('limit', i, 20) as number;
					const qs: IDataObject = { query, limit };
					if (entityType) qs.entityType = entityType;
					responseData = await gctrlApiRequest(this, 'GET', '/kg/entities/search', undefined, qs);

				} else {
					responseData = {};
				}

			// ─── Ontology ───────────────────────────────────────────────────
			} else if (resource === 'ontology') {
				if (operation === 'list') {
					responseData = await gctrlApiRequest(this, 'GET', '/ontologies');
				} else {
					responseData = {};
				}

			} else {
				responseData = {};
			}

			returnData.push({ json: responseData });
		}

		return [returnData];
	}
}
