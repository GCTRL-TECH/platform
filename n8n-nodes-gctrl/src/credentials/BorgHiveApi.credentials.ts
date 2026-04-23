import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class GCTRLApi implements ICredentialType {
	name = 'GCTRLApi';
	displayName = 'GCTRL API';
	documentationUrl = 'https://docs.GCTRL.ai/api';
	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:4000',
			placeholder: 'http://localhost:4000',
			description: 'The base URL of the GCTRL API (without /api)',
		},
		{
			displayName: 'Authentication Method',
			name: 'authMethod',
			type: 'options',
			default: 'apiKey',
			options: [
				{
					name: 'API Key',
					value: 'apiKey',
					description: 'Use a GCTRL API key',
				},
				{
					name: 'Email & Password',
					value: 'emailPassword',
					description: 'Use email and password (JWT auto-refresh)',
				},
			],
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: {
				show: { authMethod: ['apiKey'] },
			},
		},
		{
			displayName: 'Email',
			name: 'email',
			type: 'string',
			default: '',
			placeholder: 'admin@GCTRL.dev',
			displayOptions: {
				show: { authMethod: ['emailPassword'] },
			},
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: {
				show: { authMethod: ['emailPassword'] },
			},
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/health',
			method: 'GET',
		},
	};
}

