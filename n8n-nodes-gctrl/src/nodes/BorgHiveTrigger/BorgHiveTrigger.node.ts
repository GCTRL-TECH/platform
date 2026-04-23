import {
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
	INodeExecutionData,
	IDataObject,
} from 'n8n-workflow';
import { GCTRLApiRequest } from '../../shared/GCTRLApiClient';

export class GCTRLTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GCTRL Trigger',
		name: 'GCTRLTrigger',
		icon: 'file:GCTRL.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Triggers when a GCTRL extraction or fusion job completes',
		defaults: {
			name: 'GCTRL Trigger',
		},
		polling: true,
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'GCTRLApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				options: [
					{
						name: 'Extraction Completed',
						value: 'extractionCompleted',
						description: 'Triggers when a KEX extraction job completes',
					},
					{
						name: 'Fusion Completed',
						value: 'fusionCompleted',
						description: 'Triggers when a FUSE merge job completes',
					},
					{
						name: 'Any Job Completed',
						value: 'anyCompleted',
						description: 'Triggers on any completed job',
					},
				],
				default: 'extractionCompleted',
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const event = this.getNodeParameter('event') as string;
		const webhookData = this.getWorkflowStaticData('node');
		const lastChecked = (webhookData.lastChecked as string) || new Date(0).toISOString();

		// Fetch recent jobs
		let jobs: IDataObject[] = [];

		if (event === 'extractionCompleted' || event === 'anyCompleted') {
			const kexResult = await GCTRLApiRequest(this, 'GET', '/kex/jobs');
			const kexJobs = (kexResult.jobs as IDataObject[]) || [];
			jobs.push(...kexJobs);
		}

		if (event === 'fusionCompleted' || event === 'anyCompleted') {
			const fuseResult = await GCTRLApiRequest(this, 'GET', '/fuse/jobs');
			const fuseJobs = (fuseResult.jobs as IDataObject[]) || [];
			jobs.push(...fuseJobs);
		}

		// Filter to completed jobs since last check
		const newJobs = jobs.filter((job) => {
			const completedAt = job.completedAt as string;
			return (
				job.status === 'completed' &&
				completedAt &&
				new Date(completedAt) > new Date(lastChecked)
			);
		});

		webhookData.lastChecked = new Date().toISOString();

		if (newJobs.length === 0) {
			return null;
		}

		return [newJobs.map((job) => ({ json: job }))];
	}
}

