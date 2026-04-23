/**
 * Multi-model LLM service
 * Supports: Ollama (local), OpenAI, Anthropic, OpenRouter
 * Config is per-request — no global API key storage
 */

export interface LLMConfig {
  provider: 'ollama' | 'openai' | 'anthropic' | 'openrouter';
  model: string;
  apiKey?: string;   // required for cloud providers
  baseUrl?: string;  // override for ollama or openrouter
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  tokensUsed: number;
  model: string;
}

// Default Ollama base URL — matches docker-compose OLLAMA_BASE env
const DEFAULT_OLLAMA_BASE =
  process.env['OLLAMA_BASE'] || 'http://ollama:11434';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildMessages(
  systemPrompt: string,
  userMessage: string,
  context?: string,
  priorMessages?: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];

  // Add conversation history so answers build on each other
  if (priorMessages && priorMessages.length > 0) {
    // Keep last 10 messages to avoid context overflow
    const recent = priorMessages.slice(-10);
    for (const msg of recent) {
      messages.push({
        role: msg.role === 'human' ? 'user' : msg.role === 'ai' ? 'assistant' : msg.role,
        content: msg.content,
      });
    }
  }

  if (context) {
    messages.push({
      role: 'user',
      content: `Context from knowledge graph:\n${context}\n\nQuestion: ${userMessage}`,
    });
  } else {
    messages.push({ role: 'user', content: userMessage });
  }

  return messages;
}

function countApproxTokens(text: string): number {
  // Rough approximation: 4 chars per token
  return Math.ceil(text.length / 4);
}

// ─── Provider implementations ─────────────────────────────────────────────────

async function callOllama(
  config: LLMConfig,
  systemPrompt: string,
  userMessage: string,
  context?: string,
  priorMessages?: Array<{ role: string; content: string }>,
): Promise<LLMResponse> {
  const base = (config.baseUrl ?? DEFAULT_OLLAMA_BASE).replace(/\/$/, '');
  const messages = buildMessages(systemPrompt, userMessage, context, priorMessages);

  const body = {
    model: config.model,
    messages,
    stream: false,
    options: {
      temperature: config.temperature ?? 0.1,
    },
  };

  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    message?: { content: string };
    response?: string;
    eval_count?: number;
    prompt_eval_count?: number;
  };

  return {
    content: data.message?.content ?? data.response ?? '',
    tokensUsed: (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0),
    model: `ollama:${config.model}`,
  };
}

async function callOpenAI(
  config: LLMConfig,
  systemPrompt: string,
  userMessage: string,
  context?: string
): Promise<LLMResponse> {
  if (!config.apiKey) {
    throw new Error('OpenAI API key is required');
  }

  const messages = buildMessages(systemPrompt, userMessage, context);
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0.1,
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { total_tokens: number };
    model: string;
  };

  const content = data.choices[0]?.message.content ?? '';
  return {
    content,
    tokensUsed: data.usage?.total_tokens ?? countApproxTokens(content),
    model: `openai:${data.model}`,
  };
}

async function callAnthropic(
  config: LLMConfig,
  systemPrompt: string,
  userMessage: string,
  context?: string
): Promise<LLMResponse> {
  if (!config.apiKey) {
    throw new Error('Anthropic API key is required');
  }

  const userContent = context
    ? `Context from knowledge graph:\n${context}\n\nQuestion: ${userMessage}`
    : userMessage;

  const body = {
    model: config.model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    temperature: config.temperature ?? 0.1,
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
    model: string;
  };

  const content = data.content.find((b) => b.type === 'text')?.text ?? '';
  const tokensUsed =
    (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

  return {
    content,
    tokensUsed: tokensUsed || countApproxTokens(content),
    model: `anthropic:${data.model}`,
  };
}

async function callOpenRouter(
  config: LLMConfig,
  systemPrompt: string,
  userMessage: string,
  context?: string
): Promise<LLMResponse> {
  if (!config.apiKey) {
    throw new Error('OpenRouter API key is required');
  }

  const base = (config.baseUrl ?? 'https://openrouter.ai').replace(/\/$/, '');
  const messages = buildMessages(systemPrompt, userMessage, context);

  const body = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0.1,
  };

  const response = await fetch(`${base}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'HTTP-Referer': 'https://GCTRL.app',
      'X-Title': 'GCTRL RAG',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { total_tokens: number };
    model: string;
  };

  const content = data.choices[0]?.message.content ?? '';
  return {
    content,
    tokensUsed: data.usage?.total_tokens ?? countApproxTokens(content),
    model: `openrouter:${data.model ?? config.model}`,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateResponse(
  config: LLMConfig,
  systemPrompt: string,
  userMessage: string,
  context?: string,
  priorMessages?: Array<{ role: string; content: string }>,
): Promise<LLMResponse> {
  switch (config.provider) {
    case 'ollama':
      return callOllama(config, systemPrompt, userMessage, context, priorMessages);
    case 'openai':
      return callOpenAI(config, systemPrompt, userMessage, context);
    case 'anthropic':
      return callAnthropic(config, systemPrompt, userMessage, context);
    case 'openrouter':
      return callOpenRouter(config, systemPrompt, userMessage, context);
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown LLM provider: ${String(_exhaustive)}`);
    }
  }
}

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  provider: 'ollama',
  model: 'llama3.2',
  baseUrl: DEFAULT_OLLAMA_BASE,
  temperature: 0.1,
};

/**
 * Fetch available Ollama models from local instance.
 * Returns empty array on failure (Ollama might not be running).
 */
export async function listOllamaModels(): Promise<
  Array<{ name: string; size: number }>
> {
  try {
    const base = DEFAULT_OLLAMA_BASE.replace(/\/$/, '');
    const response = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      models?: Array<{ name: string; size: number }>;
    };
    return data.models ?? [];
  } catch {
    return [];
  }
}

