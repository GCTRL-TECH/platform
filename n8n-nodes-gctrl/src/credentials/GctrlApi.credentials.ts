import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class GctrlApi implements ICredentialType {
	name = 'gctrlApi';
	displayName = 'Ground Control API';
	documentationUrl = 'https://docs.gctrl.tech/api';
	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:4000',
			placeholder: 'http://localhost:4000',
			description: 'The base URL of the Ground Control API (without /api)',
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
					description: 'Use a Ground Control API key',
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
			placeholder: 'admin@gctrl.tech',
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
