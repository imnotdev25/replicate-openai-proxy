// Rate limiting configuration
const GLOBAL_RATE_LIMIT = 100; // Max concurrent requests
const RATE_LIMIT_WINDOW = 60000; // Time window in ms (1 minute)
const MAX_QUEUE_SIZE = 1000; // Maximum queue size

// Rate limiting class adapted for Cloudflare Workers
class RateLimiter {
    constructor(maxRequests, windowMs, maxQueueSize) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.maxQueueSize = maxQueueSize;
        this.requests = [];
        this.queue = [];
        this.activeRequests = 0;
    }

    cleanup() {
        const now = Date.now();
        this.requests = this.requests.filter(timestamp => now - timestamp < this.windowMs);
    }

    async acquire() {
        return new Promise((resolve, reject) => {
            const now = Date.now();

            // Remove expired requests
            this.requests = this.requests.filter(timestamp => now - timestamp < this.windowMs);

            // Check if we can process immediately
            if (this.requests.length < this.maxRequests && this.activeRequests < this.maxRequests) {
                this.requests.push(now);
                this.activeRequests++;
                resolve();
                return;
            }

            // Check queue size limit
            if (this.queue.length >= this.maxQueueSize) {
                reject(new Error('Rate limit queue full'));
                return;
            }

            // Add to queue
            this.queue.push({ resolve, reject, timestamp: now });
            console.log(`Request queued. Queue size: ${this.queue.length}`);
        });
    }

    release() {
        this.activeRequests--;

        // Process next request in queue if available
        if (this.queue.length > 0) {
            const now = Date.now();
            this.requests = this.requests.filter(timestamp => now - timestamp < this.windowMs);

            if (this.requests.length < this.maxRequests) {
                const { resolve } = this.queue.shift();
                this.requests.push(now);
                this.activeRequests++;
                resolve();
            }
        }
    }

    getStats() {
        const now = Date.now();
        this.requests = this.requests.filter(timestamp => now - timestamp < this.windowMs);

        return {
            activeRequests: this.activeRequests,
            requestsInWindow: this.requests.length,
            queueSize: this.queue.length,
            maxRequests: this.maxRequests
        };
    }
}

// Global rate limiter instance
const globalRateLimiter = new RateLimiter(GLOBAL_RATE_LIMIT, RATE_LIMIT_WINDOW, MAX_QUEUE_SIZE);

// Request metrics tracking
const metrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    queuedRequests: 0,
    rateLimitedRequests: 0,
    averageProcessingTime: 0,
    processingTimes: []
};

// Model mappings configuration (from Node.js script)
const MODEL_MAPPINGS = {
    "deepseek-r1":"deepseek-ai/deepseek-r1",
    "gpt-4.1-nano":"openai/gpt-4.1-nano",
    "gpt-4.1-mini":"openai/gpt-4.1-mini",
    "gpt-4.1":"openai/gpt-4.1",
    "gpt-4o":"openai/gpt-4o",
    "gpt-4o-mini": "openai/gpt-4o-mini",
    "o1":"openai/o1",
    "o1-mini": "openai/o1-mini",
    "o4-mini":"openai/o4-mini",
    "gpt-5-structured": "openai/gpt-5-structured",
    "gpt-5-mini": "openai/gpt-5-mini",
    "gpt-5-nano": "openai/gpt-5-nano",
    "gpt-5": "openai/gpt-5",
    "gpt-oss-20b": "openai/gpt-oss-20b",
    "gpt-oss-120b": "openai/gpt-oss-120b",
    "deepseek-v3.1": "deepseek-ai/deepseek-v3.1",
    "deepseek-v3":"deepseek-ai/deepseek-v3",
    "claude-3.7-sonnet":"anthropic/claude-3.7-sonnet",
    "claude-3.5-haiku":"anthropic/claude-3.5-haiku",
    "claude-3.5-sonnet":"anthropic/claude-3.5-sonnet",
    "claude-4-sonnet":"anthropic/claude-4-sonnet",
    "llama-3.1-405b-instruct":"meta/meta-llama-3.1-405b-instruct",
    "llama-3-70b-instruct":"meta/meta-llama-3-70b-instruct",
    "llama-3-8b-instruct":"meta/meta-llama-3-8b-instruct"
};

const DEFAULT_MODEL = 'meta/meta-llama-3-8b-instruct';

// Helper function to set CORS headers (fixed)
function setCorsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400'
    };
}

// Helper function to send JSON response with proper CORS
function sendJsonResponse(statusCode, data) {
    return new Response(JSON.stringify(data), {
        status: statusCode,
        headers: {
            'Content-Type': 'application/json',
            ...setCorsHeaders()
        }
    });
}

// Helper function to send streaming response with proper CORS
function sendStreamingResponse(data) {
    return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...setCorsHeaders()
        }
    });
}

// Helper function to convert OpenAI messages to Replicate prompt
function convertMessagesToPrompt(messages) {
    let prompt = '';

    for (const message of messages) {
        if (message.role === 'system') {
            prompt += `System: ${message.content}\n\n`;
        } else if (message.role === 'user') {
            prompt += `Human: ${message.content}\n\n`;
        } else if (message.role === 'assistant') {
            prompt += `Assistant: ${message.content}\n\n`;
        }
    }

    prompt += 'Assistant: ';
    return prompt;
}

// Helper function to format Replicate response as OpenAI response
function formatAsOpenAIResponse(replicateOutput, model, usage = {}) {
    const content = Array.isArray(replicateOutput) ? replicateOutput.join('') : replicateOutput;

    return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: content.trim()
            },
            finish_reason: 'stop'
        }],
        usage: {
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || 0,
            total_tokens: usage.total_tokens || 0
        }
    };
}

// Helper function to authenticate API key
function authenticateApiKey(request, env) {
    const authHeader = request.headers.get('authorization');
    const expectedApiKey = env.PROXY_API_KEY;
    const clientIP = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

    if (!expectedApiKey) {
        console.error('Authentication error: Proxy API key not configured', {
            timestamp: new Date().toISOString(),
            clientIP
        });
        return {
            success: false,
            error: {
                message: 'Proxy API key not configured',
                type: 'configuration_error',
                code: 'missing_api_key'
            },
            statusCode: 500
        };
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn('Authentication failed: Missing or invalid authorization header', {
            authHeader: authHeader ? 'present but invalid format' : 'missing',
            clientIP,
            timestamp: new Date().toISOString()
        });
        return {
            success: false,
            error: {
                message: 'Missing or invalid authorization header',
                type: 'authentication_error',
                code: 'invalid_api_key'
            },
            statusCode: 401
        };
    }

    const apiKey = authHeader.substring(7); // Remove 'Bearer ' prefix

    if (apiKey !== expectedApiKey) {
        console.warn('Authentication failed: Invalid API key', {
            providedKeyLength: apiKey.length,
            clientIP,
            timestamp: new Date().toISOString()
        });
        return {
            success: false,
            error: {
                message: 'Invalid API key',
                type: 'authentication_error',
                code: 'invalid_api_key'
            },
            statusCode: 401
        };
    }

    console.log('Authentication successful', {
        clientIP,
        timestamp: new Date().toISOString()
    });
    return { success: true };
}

// Helper function to create cache key from request parameters
function createCacheKey(model, prompt, temperature, maxTokens) {
    const keyData = {
        model,
        prompt,
        temperature: temperature || 0.7,
        maxTokens: maxTokens || 'default'
    };

    const keyString = JSON.stringify(keyData);

    // Create hash if key is too long
    if (keyString.length > MAX_CACHE_KEY_LENGTH - CACHE_PREFIX.length) {
        // Simple hash function for long keys
        let hash = 0;
        for (let i = 0; i < keyString.length; i++) {
            const char = keyString.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return `${CACHE_PREFIX}${Math.abs(hash)}_${model}_${temperature}_${maxTokens || 'default'}`;
    }

    return `${CACHE_PREFIX}${btoa(keyString).replace(/[^a-zA-Z0-9]/g, '_')}`;
}

// Helper function to get cached response
async function getCachedResponse(cacheKey, env) {
    try {
        if (!env.CACHE_KV) {
            console.log('Cache KV not available, skipping cache lookup');
            return null;
        }

        const cachedData = await env.CACHE_KV.get(cacheKey, 'json');
        if (cachedData) {
            console.log('Cache hit:', { cacheKey });
            metrics.cacheHits++;
            return cachedData;
        } else {
            console.log('Cache miss:', { cacheKey });
            metrics.cacheMisses++;
            return null;
        }
    } catch (error) {
        console.error('Cache lookup error:', {
            error: error.message,
            cacheKey,
            timestamp: new Date().toISOString()
        });
        metrics.cacheMisses++;
        return null;
    }
}

// Helper function to cache response
async function setCachedResponse(cacheKey, responseData, env) {
    try {
        if (!env.CACHE_KV) {
            console.log('Cache KV not available, skipping cache set');
            return;
        }

        await env.CACHE_KV.put(cacheKey, JSON.stringify(responseData), {
            expirationTtl: CACHE_TTL
        });

        console.log('Response cached:', {
            cacheKey,
            ttl: CACHE_TTL,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Cache set error:', {
            error: error.message,
            cacheKey,
            timestamp: new Date().toISOString()
        });
    }
}
function updateMetrics(processingTime, success = true) {
    metrics.totalRequests++;
    if (success) {
        metrics.successfulRequests++;
    } else {
        metrics.failedRequests++;
    }

    metrics.processingTimes.push(processingTime);

    // Keep only last 1000 processing times for memory efficiency
    if (metrics.processingTimes.length > 1000) {
        metrics.processingTimes = metrics.processingTimes.slice(-1000);
    }

    // Calculate average processing time
    metrics.averageProcessingTime = metrics.processingTimes.reduce((sum, time) => sum + time, 0) / metrics.processingTimes.length;
}

// Chat completions handler with proper rate limiting and error handling
async function handleChatCompletions(request, env) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const clientIP = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    const startTime = Date.now();

    try {
        console.log('Chat completions request started:', {
            requestId,
            clientIP,
            rateLimiterStats: globalRateLimiter.getStats(),
            timestamp: new Date().toISOString()
        });

        // Acquire rate limit token
        try {
            await globalRateLimiter.acquire();
        } catch (error) {
            metrics.rateLimitedRequests++;
            console.warn('Rate limit exceeded:', {
                requestId,
                clientIP,
                error: error.message,
                rateLimiterStats: globalRateLimiter.getStats(),
                timestamp: new Date().toISOString()
            });

            return sendJsonResponse(429, {
                error: {
                    message: 'Rate limit exceeded. Please try again later.',
                    type: 'rate_limit_error',
                    code: 'rate_limit_exceeded',
                    retry_after: Math.ceil(RATE_LIMIT_WINDOW / 1000)
                }
            });
        }

        try {
            const body = await request.json();
            const { model, messages, max_tokens, temperature = 0.7, stream = false } = body;

            // Validate required fields
            if (!model || !messages) {
                console.warn('Chat completions validation error:', {
                    requestId,
                    error: 'Missing required fields',
                    hasModel: !!model,
                    hasMessages: !!messages,
                    timestamp: new Date().toISOString()
                });

                return sendJsonResponse(400, {
                    error: {
                        message: 'Missing required fields: model and messages are required',
                        type: 'invalid_request_error',
                        code: 'missing_required_fields'
                    }
                });
            }

            // Map OpenAI model to Replicate model
            const replicateModel = MODEL_MAPPINGS[model] || DEFAULT_MODEL;

            // Convert messages to prompt format
            const prompt = convertMessagesToPrompt(messages);

            console.log('Chat completions processing:', {
                requestId,
                model,
                replicateModel,
                messageCount: messages.length,
                maxTokens: max_tokens || 'not provided',
                temperature,
                stream,
                promptLength: prompt.length,
                timestamp: new Date().toISOString()
            });

            const replicateStartTime = Date.now();

            // Call Replicate API
            const response = await fetch('https://api.replicate.com/v1/predictions', {
                method: 'POST',
                headers: {
                    'Authorization': `Token ${env.REPLICATE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: replicateModel,
                    input: {
                        prompt: prompt,
                        max_new_tokens: max_tokens,
                        temperature: temperature
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Replicate API request failed:', {
                    requestId,
                    status: response.status,
                    statusText: response.statusText,
                    error: errorText,
                    timestamp: new Date().toISOString()
                });
                throw new Error(`Replicate API error: ${response.status} - ${errorText}`);
            }

            const prediction = await response.json();
            console.log('Replicate prediction created:', {
                requestId,
                predictionId: prediction.id,
                status: prediction.status,
                timestamp: new Date().toISOString()
            });

            // Poll for completion
            let result = prediction;
            let pollCount = 0;
            while (result.status === 'starting' || result.status === 'processing') {
                pollCount++;
                await new Promise(resolve => setTimeout(resolve, 1000));

                const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${result.id}`, {
                    headers: {
                        'Authorization': `Token ${env.REPLICATE_API_TOKEN}`
                    }
                });

                if (!pollResponse.ok) {
                    console.error('Replicate polling failed:', {
                        requestId,
                        predictionId: result.id,
                        pollCount,
                        status: pollResponse.status,
                        timestamp: new Date().toISOString()
                    });
                    throw new Error(`Replicate polling error: ${pollResponse.status}`);
                }

                result = await pollResponse.json();

                if (pollCount % 5 === 0) {
                    console.log('Replicate prediction polling:', {
                        requestId,
                        predictionId: result.id,
                        status: result.status,
                        pollCount,
                        timestamp: new Date().toISOString()
                    });
                }
            }

            if (result.status === 'failed') {
                console.error('Replicate prediction failed:', {
                    requestId,
                    predictionId: result.id,
                    error: result.error,
                    processingTime: Date.now() - startTime,
                    timestamp: new Date().toISOString()
                });
                throw new Error(`Replicate prediction failed: ${result.error}`);
            }

            const output = result.output;
            const processingTime = Date.now() - startTime;
            updateMetrics(processingTime, true);

            if (stream) {
                const content = Array.isArray(output) ? output.join('') : output;
                const streamResponse = {
                    id: `chatcmpl-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                        index: 0,
                        delta: {
                            role: 'assistant',
                            content: content.trim()
                        },
                        finish_reason: 'stop'
                    }]
                };

                console.log('Chat completions streaming completed:', {
                    requestId,
                    responseLength: content.length,
                    processingTime,
                    replicateTime: Date.now() - replicateStartTime,
                    timestamp: new Date().toISOString()
                });

                return sendStreamingResponse(streamResponse);
            } else {
                const response = formatAsOpenAIResponse(output, model);

                console.log('Chat completions completed successfully:', {
                    requestId,
                    responseLength: response.choices[0]?.message?.content?.length || 0,
                    processingTime,
                    replicateTime: Date.now() - replicateStartTime,
                    timestamp: new Date().toISOString()
                });

                return sendJsonResponse(200, response);
            }

        } catch (error) {
            const processingTime = Date.now() - startTime;
            updateMetrics(processingTime, false);

            console.error('Chat completions error:', {
                requestId,
                error: error.message,
                stack: error.stack,
                clientIP,
                processingTime,
                timestamp: new Date().toISOString()
            });

            if (error.message && error.message.includes('Replicate')) {
                return sendJsonResponse(502, {
                    error: {
                        message: 'Replicate API error',
                        type: 'upstream_error',
                        code: 'replicate_error'
                    }
                });
            } else {
                return sendJsonResponse(500, {
                    error: {
                        message: 'Internal server error',
                        type: 'server_error',
                        code: 'internal_error'
                    }
                });
            }
        }

    } finally {
        globalRateLimiter.release();
    }
}

// Completions handler
async function handleCompletions(request, env) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const clientIP = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    const startTime = Date.now();

    try {
        console.log('Completions request started:', {
            requestId,
            clientIP,
            rateLimiterStats: globalRateLimiter.getStats(),
            timestamp: new Date().toISOString()
        });

        try {
            await globalRateLimiter.acquire();
        } catch (error) {
            metrics.rateLimitedRequests++;
            console.warn('Rate limit exceeded:', {
                requestId,
                clientIP,
                error: error.message,
                rateLimiterStats: globalRateLimiter.getStats(),
                timestamp: new Date().toISOString()
            });

            return sendJsonResponse(429, {
                error: {
                    message: 'Rate limit exceeded. Please try again later.',
                    type: 'rate_limit_error',
                    code: 'rate_limit_exceeded',
                    retry_after: Math.ceil(RATE_LIMIT_WINDOW / 1000)
                }
            });
        }

        try {
            const body = await request.json();
            const { model, prompt, max_tokens, temperature = 0.7 } = body;

            if (!model || !prompt) {
                console.warn('Completions validation error:', {
                    requestId,
                    error: 'Missing required fields',
                    hasModel: !!model,
                    hasPrompt: !!prompt,
                    timestamp: new Date().toISOString()
                });

                return sendJsonResponse(400, {
                    error: {
                        message: 'Missing required fields: model and prompt are required',
                        type: 'invalid_request_error',
                        code: 'missing_required_fields'
                    }
                });
            }

            const replicateModel = MODEL_MAPPINGS[model] || DEFAULT_MODEL;

            console.log('Completions processing:', {
                requestId,
                model,
                replicateModel,
                promptLength: prompt.length,
                maxTokens: max_tokens || 'not provided',
                temperature,
                timestamp: new Date().toISOString()
            });

            const replicateStartTime = Date.now();

            const response = await fetch('https://api.replicate.com/v1/predictions', {
                method: 'POST',
                headers: {
                    'Authorization': `Token ${env.REPLICATE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: replicateModel,
                    input: {
                        prompt: prompt,
                        max_new_tokens: max_tokens,
                        temperature: temperature
                    }
                })
            });

            if (!response.ok) {
                throw new Error(`Replicate API error: ${response.status}`);
            }

            const prediction = await response.json();

            // Poll for completion
            let result = prediction;
            while (result.status === 'starting' || result.status === 'processing') {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${result.id}`, {
                    headers: {
                        'Authorization': `Token ${env.REPLICATE_API_TOKEN}`
                    }
                });
                result = await pollResponse.json();
            }

            if (result.status === 'failed') {
                throw new Error(`Replicate prediction failed: ${result.error}`);
            }

            const content = Array.isArray(result.output) ? result.output.join('') : result.output;

            const completionResponse = {
                id: `cmpl-${Date.now()}`,
                object: 'text_completion',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    text: content.trim(),
                    index: 0,
                    finish_reason: 'stop'
                }],
                usage: {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                }
            };

            const processingTime = Date.now() - startTime;
            updateMetrics(processingTime, true);

            console.log('Completions completed successfully:', {
                requestId,
                responseLength: content.length,
                processingTime,
                replicateTime: Date.now() - replicateStartTime,
                timestamp: new Date().toISOString()
            });

            return sendJsonResponse(200, completionResponse);

        } catch (error) {
            const processingTime = Date.now() - startTime;
            updateMetrics(processingTime, false);

            console.error('Completions error:', {
                requestId,
                error: error.message,
                stack: error.stack,
                clientIP,
                processingTime,
                timestamp: new Date().toISOString()
            });

            if (error.message && error.message.includes('Replicate')) {
                return sendJsonResponse(502, {
                    error: {
                        message: 'Replicate API error',
                        type: 'upstream_error',
                        code: 'replicate_error'
                    }
                });
            } else {
                return sendJsonResponse(500, {
                    error: {
                        message: 'Internal server error',
                        type: 'server_error',
                        code: 'internal_error'
                    }
                });
            }
        }

    } finally {
        globalRateLimiter.release();
    }
}

// Models handler
function handleModels() {
    const models = Object.keys(MODEL_MAPPINGS).map(model => ({
        id: model,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'replicate-proxy'
    }));

    return sendJsonResponse(200, {
        object: 'list',
        data: models
    });
}

// Health check handler with metrics
function handleHealth() {
    const rateLimiterStats = globalRateLimiter.getStats();

    return sendJsonResponse(200, {
        status: 'healthy',
        service: 'OpenAI to Replicate Proxy',
        timestamp: new Date().toISOString(),
        rateLimiter: {
            maxRequests: rateLimiterStats.maxRequests,
            activeRequests: rateLimiterStats.activeRequests,
            requestsInWindow: rateLimiterStats.requestsInWindow,
            queueSize: rateLimiterStats.queueSize,
            utilizationPercent: Math.round((rateLimiterStats.activeRequests / rateLimiterStats.maxRequests) * 100)
        },
        metrics: {
            totalRequests: metrics.totalRequests,
            successfulRequests: metrics.successfulRequests,
            failedRequests: metrics.failedRequests,
            rateLimitedRequests: metrics.rateLimitedRequests,
            successRate: metrics.totalRequests > 0 ? Math.round((metrics.successfulRequests / metrics.totalRequests) * 100) : 0,
            averageProcessingTime: Math.round(metrics.averageProcessingTime)
        }
    });
}

// Stats endpoint
function handleStats() {
    const rateLimiterStats = globalRateLimiter.getStats();

    return sendJsonResponse(200, {
        timestamp: new Date().toISOString(),
        rateLimiter: rateLimiterStats,
        metrics: metrics
    });
}

// Main worker handler
export default {
    async fetch(request, env, ctx) {
        const requestId = `req-${Date.now()}-${Math.random().toString(36)}`;
        const url = new URL(request.url);
        const pathname = url.pathname;
        const method = request.method;
        const clientIP = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
        const userAgent = request.headers.get('user-agent') || 'unknown';
        const country = request.cf?.country || 'unknown';

        console.log('Incoming request:', {
            requestId,
            method,
            pathname,
            clientIP,
            userAgent,
            country,
            timestamp: new Date().toISOString()
        });

        // Handle CORS preflight requests
        if (method === 'OPTIONS') {
            console.log('CORS preflight request:', { requestId, pathname });
            return new Response(null, {
                status: 204,
                headers: setCorsHeaders()
            });
        }

        // Health check endpoint (no auth required)
        if (pathname === '/health' && method === 'GET') {
            console.log('Health check request:', { requestId });
            return handleHealth();
        }

        // Stats endpoint (no auth required)
        if (pathname === '/stats' && method === 'GET') {
            console.log('Stats request:', { requestId });
            return handleStats();
        }

        // All /v1/* endpoints require authentication
        if (pathname.startsWith('/v1/')) {
            const authResult = authenticateApiKey(request, env);
            if (!authResult.success) {
                console.warn('Authentication failed for API endpoint:', {
                    requestId,
                    pathname,
                    statusCode: authResult.statusCode,
                    clientIP,
                    timestamp: new Date().toISOString()
                });
                return sendJsonResponse(authResult.statusCode, { error: authResult.error });
            }

            // Route to appropriate handler
            if (pathname === '/v1/chat/completions' && method === 'POST') {
                console.log('Routing to chat completions handler:', { requestId });
                return handleChatCompletions(request, env);
            } else if (pathname === '/v1/completions' && method === 'POST') {
                console.log('Routing to completions handler:', { requestId });
                return handleCompletions(request, env);
            } else if (pathname === '/v1/models' && method === 'GET') {
                console.log('Routing to models handler:', { requestId });
                return handleModels();
            } else {
                console.warn('Unknown API endpoint:', {
                    requestId,
                    pathname,
                    method,
                    clientIP,
                    timestamp: new Date().toISOString()
                });
                return sendJsonResponse(404, {
                    error: {
                        message: 'Not found',
                        type: 'invalid_request_error',
                        code: 'not_found'
                    }
                });
            }
        } else {
            console.warn('Request to unknown endpoint:', {
                requestId,
                pathname,
                method,
                clientIP,
                timestamp: new Date().toISOString()
            });
            return sendJsonResponse(404, {
                error: {
                    message: 'Not found',
                    type: 'invalid_request_error',
                    code: 'not_found'
                }
            });
        }
    }
};