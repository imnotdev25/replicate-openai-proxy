// Cloudflare Worker implementation of OpenAI to Replicate proxy

// Model mappings configuration
const MODEL_MAPPINGS = {
    'gpt-3.5-turbo': 'meta/llama-2-7b-chat',
    'gpt-3.5-turbo-16k': 'meta/llama-2-7b-chat',
    'gpt-4': 'meta/llama-2-70b-chat',
    'gpt-4-turbo': 'meta/llama-2-70b-chat',
    'gpt-4-turbo-preview': 'meta/llama-2-70b-chat',
    'gpt-4-32k': 'meta/llama-2-70b-chat',
    'text-davinci-003': 'meta/llama-2-7b-chat',
    'text-davinci-002': 'meta/llama-2-7b-chat',
    'text-curie-001': 'meta/llama-2-7b-chat',
    'text-babbage-001': 'meta/llama-2-7b-chat',
    'text-ada-001': 'meta/llama-2-7b-chat'
};

const DEFAULT_MODEL = 'meta/llama-2-7b-chat';

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

// Helper function to call Replicate API
async function callReplicateAPI(model, input, env, requestId = 'unknown') {
    const startTime = Date.now();

    try {
        console.log('Replicate API call started:', {
            requestId,
            model,
            inputKeys: Object.keys(input),
            timestamp: new Date().toISOString()
        });

        const response = await fetch('https://api.replicate.com/v1/predictions', {
            method: 'POST',
            headers: {
                'Authorization': `Token ${env.REPLICATE_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                version: await getModelVersion(model, env),
                input: input
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

            if (pollCount % 5 === 0) { // Log every 5th poll
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

        console.log('Replicate API call completed successfully:', {
            requestId,
            predictionId: result.id,
            status: result.status,
            processingTime: Date.now() - startTime,
            pollCount,
            outputLength: Array.isArray(result.output) ? result.output.length : (result.output ? result.output.toString().length : 0),
            timestamp: new Date().toISOString()
        });

        return result.output;

    } catch (error) {
        console.error('Replicate API call error:', {
            requestId,
            model,
            error: error.message,
            processingTime: Date.now() - startTime,
            timestamp: new Date().toISOString()
        });
        throw error;
    }
}

// Helper function to get model version (simplified - in production you'd cache these)
async function getModelVersion(model, env) {
    // For demo purposes, using hardcoded versions
    // In production, you'd fetch these from Replicate API and cache them
    const modelVersions = {
        'meta/llama-2-7b-chat': '13c3cdee13ee059ab779f0291d29054dab00a47dad8261375654de5540165fb0',
        'meta/llama-2-70b-chat': '02e509c789964a7ea8736978a43525956ef40397be9033abf9fd2badfe68c9e3'
    };

    return modelVersions[model] || modelVersions['meta/llama-2-7b-chat'];
}

// Chat completions handler
async function handleChatCompletions(request, env) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36)}`;
    const clientIP = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

    try {
        console.log('Chat completions request started:', {
            requestId,
            clientIP,
            timestamp: new Date().toISOString()
        });

        const body = await request.json();
        const { model, messages, max_tokens = 500, temperature = 0.7, stream = false } = body;

        // Validate required fields
        if (!model || !messages) {
            console.warn('Chat completions validation error:', {
                requestId,
                error: 'Missing required fields',
                hasModel: !!model,
                hasMessages: !!messages,
                timestamp: new Date().toISOString()
            });
            return new Response(JSON.stringify({
                error: {
                    message: 'Missing required fields: model and messages are required',
                    type: 'invalid_request_error',
                    code: 'missing_required_fields'
                }
            }), {
                status: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
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
            maxTokens: max_tokens,
            temperature,
            stream,
            promptLength: prompt.length,
            timestamp: new Date().toISOString()
        });

        const startTime = Date.now();

        const input = {
            prompt: prompt,
            max_new_tokens: max_tokens,
            temperature: temperature
        };

        if (stream) {
            // For streaming, we'll simulate it since Cloudflare Workers have limitations
            console.log('Starting streaming response:', { requestId });
            const output = await callReplicateAPI(replicateModel, input, env, requestId);
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
                processingTime: Date.now() - startTime,
                timestamp: new Date().toISOString()
            });

            return new Response(`data: ${JSON.stringify(streamResponse)}\n\ndata: [DONE]\n\n`, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        } else {
            // Handle regular response
            const output = await callReplicateAPI(replicateModel, input, env, requestId);
            const response = formatAsOpenAIResponse(output, model);

            console.log('Chat completions completed successfully:', {
                requestId,
                responseLength: response.choices[0]?.message?.content?.length || 0,
                processingTime: Date.now() - startTime,
                timestamp: new Date().toISOString()
            });

            return new Response(JSON.stringify(response), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }

    } catch (error) {
        console.error('Chat completions error:', {
            requestId,
            error: error.message,
            stack: error.stack,
            clientIP,
            timestamp: new Date().toISOString()
        });

        // Check if it's a Replicate API error
        if (error.message && error.message.includes('Replicate')) {
            return new Response(JSON.stringify({
                error: {
                    message: 'Replicate API error',
                    type: 'upstream_error',
                    code: 'replicate_error'
                }
            }), {
                status: 502,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        } else {
            return new Response(JSON.stringify({
                error: {
                    message: 'Internal server error',
                    type: 'server_error',
                    code: 'internal_error'
                }
            }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
    }
}

// Completions handler (legacy)
async function handleCompletions(request, env) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36)}`;
    const clientIP = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

    try {
        console.log('Completions request started:', {
            requestId,
            clientIP,
            timestamp: new Date().toISOString()
        });

        const body = await request.json();
        const { model, prompt, max_tokens = 500, temperature = 0.7 } = body;

        // Validate required fields
        if (!model || !prompt) {
            console.warn('Completions validation error:', {
                requestId,
                error: 'Missing required fields',
                hasModel: !!model,
                hasPrompt: !!prompt,
                timestamp: new Date().toISOString()
            });
            return new Response(JSON.stringify({
                error: {
                    message: 'Missing required fields: model and prompt are required',
                    type: 'invalid_request_error',
                    code: 'missing_required_fields'
                }
            }), {
                status: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }

        // Map OpenAI model to Replicate model
        const replicateModel = MODEL_MAPPINGS[model] || DEFAULT_MODEL;

        console.log('Completions processing:', {
            requestId,
            model,
            replicateModel,
            promptLength: prompt.length,
            maxTokens: max_tokens,
            temperature,
            timestamp: new Date().toISOString()
        });

        const startTime = Date.now();

        const input = {
            prompt: prompt,
            max_new_tokens: max_tokens,
            temperature: temperature
        };

        const output = await callReplicateAPI(replicateModel, input, env, requestId);
        const content = Array.isArray(output) ? output.join('') : output;

        const response = {
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

        console.log('Completions completed successfully:', {
            requestId,
            responseLength: content.length,
            processingTime: Date.now() - startTime,
            timestamp: new Date().toISOString()
        });

        return new Response(JSON.stringify(response), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });

    } catch (error) {
        console.error('Completions error:', {
            requestId,
            error: error.message,
            stack: error.stack,
            clientIP,
            timestamp: new Date().toISOString()
        });

        // Check if it's a Replicate API error
        if (error.message && error.message.includes('Replicate')) {
            return new Response(JSON.stringify({
                error: {
                    message: 'Replicate API error',
                    type: 'upstream_error',
                    code: 'replicate_error'
                }
            }), {
                status: 502,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        } else {
            return new Response(JSON.stringify({
                error: {
                    message: 'Internal server error',
                    type: 'server_error',
                    code: 'internal_error'
                }
            }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
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

    return new Response(JSON.stringify({
        object: 'list',
        data: models
    }), {
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

// Health check handler
function handleHealth() {
    return new Response(JSON.stringify({
        status: 'healthy',
        service: 'OpenAI to Replicate Proxy (Cloudflare Worker)',
        timestamp: new Date().toISOString()
    }), {
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
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

        // Log all incoming requests
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
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
                }
            });
        }

        // Health check endpoint (no auth required)
        if (pathname === '/health' && method === 'GET') {
            console.log('Health check request:', { requestId });
            return handleHealth();
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
                return new Response(JSON.stringify({ error: authResult.error }), {
                    status: authResult.statusCode,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                });
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
                return new Response(JSON.stringify({
                    error: {
                        message: 'Not found',
                        type: 'invalid_request_error',
                        code: 'not_found'
                    }
                }), {
                    status: 404,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            }
        } else {
            // Unknown endpoint
            console.warn('Request to unknown endpoint:', {
                requestId,
                pathname,
                method,
                clientIP,
                timestamp: new Date().toISOString()
            });
            return new Response(JSON.stringify({
                error: {
                    message: 'Not found',
                    type: 'invalid_request_error',
                    code: 'not_found'
                }
            }), {
                status: 404,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
    }
};
