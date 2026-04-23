import {
	IHttpRequestMethods,
	IHttpRequestOptions,
	IDataObject,
} from 'n8n-workflow';

/**
 * Shared API client for GCTRL nodes.
 * Handles JWT login for email/password auth, API key pass-through, and token caching.
 *
 * Uses a loose context type to support IExecuteFunctions, IPollFunctions,
 * IHookFunctions, ISupplyDataFunctions, etc. without union headaches.
 */

// Minimal interface that all n8n function contexts share
interface IContextLike {
	getCredentials(type: string): Promise<IDataObject>;
	getNode(): { name: string; type: string; typeVersion: number; position: [number, number] };
	helpers: {
		httpRequest(options: IHttpRequestOptions): Promise<unknown>;
	};
}

// Simple in-memory JWT cache (per n8n process lifetime)
const tokenCache: Map<string, { token: string; expiry: number }> = new Map();

export async function getAuthToken(ctx: IContextLike): Promise<string> {
	const credentials = await ctx.getCredentials('GCTRLApi');
	const authMethod = credentials.authMethod as string;

	if (authMethod === 'apiKey') {
		return credentials.apiKey as string;
	}

	// Email/password: login and cache JWT
	const email = credentials.email as string;
	const password = credentials.password as string;
	const baseUrl = credentials.baseUrl as string;
	const cacheKey = `${baseUrl}:${email}`;

	const cached = tokenCache.get(cacheKey);
	if (cached && cached.expiry > Date.now() + 60_000) {
		return cached.token;
	}

	const options: IHttpRequestOptions = {
		url: `${baseUrl}/api/auth/login`,
		method: 'POST' as IHttpRequestMethods,
		body: { email, password },
		json: true,
	};

	const response = (await ctx.helpers.httpRequest(options)) as { token: string };
	if (!response.token) {
		throw new Error('GCTRL login failed: no token in response');
	}

	tokenCache.set(cacheKey, {
		token: response.token,
		expiry: Date.now() + 14 * 60 * 1000, // 14 min (JWT lasts 15)
	});

	return response.token;
}

export async function GCTRLApiRequest(
	ctx: IContextLike,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<IDataObject> {
	const credentials = await ctx.getCredentials('GCTRLApi');
	const baseUrl = credentials.baseUrl as string;
	const token = await getAuthToken(ctx);

	const options: IHttpRequestOptions = {
		url: `${baseUrl}/api${path}`,
		method,
		headers: {
			Authorization: `Bearer ${token}`,
		},
		json: true,
	};

	if (body && Object.keys(body).length > 0) {
		options.body = body;
	}

	if (qs && Object.keys(qs).length > 0) {
		options.qs = qs;
	}

	try {
		return (await ctx.helpers.httpRequest(options)) as IDataObject;
	} catch (error) {
		throw error;
	}
}

