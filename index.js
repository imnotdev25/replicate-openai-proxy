require('dotenv').config();
const http = require('http');
const url = require('url');
const Replicate = require('replicate');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Initialize Replicate client
const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

// Load model mappings from external JSON file
let modelConfig;
try {
    const configPath = path.join(__dirname, 'models.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    modelConfig = JSON.parse(configData);
} catch (error) {
    console.error('Error loading model configuration:', error);
    process.exit(1);
}

const MODEL_MAPPINGS = modelConfig.mappings;
const DEFAULT_MODEL = modelConfig.default_model;
const MODEL_CONFIGS = modelConfig.model_configs;

// Helper function to parse JSON from request body
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                console.error('JSON parsing error:', {
                    error: error.message,
                    body: body.substring(0, 500), // Log first 500 chars for debugging
                    timestamp: new Date().toISOString()
                });
                reject(error);
            }
        });
        req.on('error', (error) => {
            console.error('Request body reading error:', {
                error: error.message,
                timestamp: new Date().toISOString()
            });
            reject(error);
        });
    });
}

// Helper function to send JSON response
function sendJsonResponse(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data));
}

// Helper function to send streaming response
function sendStreamingResponse(res, data) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

// API Key authentication function
function authenticateApiKey(req) {
    const authHeader = req.headers.authorization;
    const expectedApiKey = process.env.PROXY_API_KEY;
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

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

// Chat completions handler
async function handleChatCompletions(req, res) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    try {
        console.log('Chat completions request started:', {
            requestId,
            clientIP,
            timestamp: new Date().toISOString()
        });

        const body = await parseRequestBody(req);
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
            sendJsonResponse(res, 400, {
                error: {
                    message: 'Missing required fields: model and messages are required',
                    type: 'invalid_request_error',
                    code: 'missing_required_fields'
                }
            });
            return;
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

        if (stream) {
            // Handle streaming response
            console.log('Starting streaming response:', { requestId });
            const output = await replicate.run(replicateModel, {
                input: {
                    prompt: prompt,
                    max_new_tokens: max_tokens,
                    temperature: temperature
                }
            });

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

            sendStreamingResponse(res, streamResponse);
        } else {
            // Handle regular response
            const output = await replicate.run(replicateModel, {
                input: {
                    prompt: prompt,
                    max_new_tokens: max_tokens,
                    temperature: temperature
                }
            });

            const response = formatAsOpenAIResponse(output, model);

            console.log('Chat completions completed successfully:', {
                requestId,
                responseLength: response.choices[0]?.message?.content?.length || 0,
                processingTime: Date.now() - startTime,
                timestamp: new Date().toISOString()
            });

            sendJsonResponse(res, 200, response);
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
            sendJsonResponse(res, 502, {
                error: {
                    message: 'Replicate API error',
                    type: 'upstream_error',
                    code: 'replicate_error'
                }
            });
        } else {
            sendJsonResponse(res, 500, {
                error: {
                    message: 'Internal server error',
                    type: 'server_error',
                    code: 'internal_error'
                }
            });
        }
    }
}

// Completions handler (legacy)
async function handleCompletions(req, res) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    try {
        console.log('Completions request started:', {
            requestId,
            clientIP,
            timestamp: new Date().toISOString()
        });

        const body = await parseRequestBody(req);
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
            sendJsonResponse(res, 400, {
                error: {
                    message: 'Missing required fields: model and prompt are required',
                    type: 'invalid_request_error',
                    code: 'missing_required_fields'
                }
            });
            return;
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

        const output = await replicate.run(replicateModel, {
            input: {
                prompt: prompt,
                max_new_tokens: max_tokens,
                temperature: temperature
            }
        });

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

        sendJsonResponse(res, 200, response);

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
            sendJsonResponse(res, 502, {
                error: {
                    message: 'Replicate API error',
                    type: 'upstream_error',
                    code: 'replicate_error'
                }
            });
        } else {
            sendJsonResponse(res, 500, {
                error: {
                    message: 'Internal server error',
                    type: 'server_error',
                    code: 'internal_error'
                }
            });
        }
    }
}

// Models handler
function handleModels(req, res) {
    const models = Object.keys(MODEL_MAPPINGS).map(model => ({
        id: model,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'replicate-proxy'
    }));

    sendJsonResponse(res, 200, {
        object: 'list',
        data: models
    });
}

// Health check handler
function handleHealth(req, res) {
    sendJsonResponse(res, 200, {
        status: 'healthy',
        service: 'OpenAI to Replicate Proxy',
        timestamp: new Date().toISOString()
    });
}

// Main request handler
function handleRequest(req, res) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36)}`;
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';

    // Log all incoming requests
    console.log('Incoming request:', {
        requestId,
        method,
        pathname,
        clientIP,
        userAgent,
        timestamp: new Date().toISOString()
    });

    // Handle CORS preflight requests
    if (method === 'OPTIONS') {
        console.log('CORS preflight request:', { requestId, pathname });
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
    }

    // Health check endpoint (no auth required)
    if (pathname === '/health' && method === 'GET') {
        console.log('Health check request:', { requestId });
        handleHealth(req, res);
        return;
    }

    // All /v1/* endpoints require authentication
    if (pathname.startsWith('/v1/')) {
        const authResult = authenticateApiKey(req);
        if (!authResult.success) {
            console.warn('Authentication failed for API endpoint:', {
                requestId,
                pathname,
                statusCode: authResult.statusCode,
                clientIP,
                timestamp: new Date().toISOString()
            });
            sendJsonResponse(res, authResult.statusCode, { error: authResult.error });
            return;
        }

        // Route to appropriate handler
        if (pathname === '/v1/chat/completions' && method === 'POST') {
            console.log('Routing to chat completions handler:', { requestId });
            handleChatCompletions(req, res);
        } else if (pathname === '/v1/completions' && method === 'POST') {
            console.log('Routing to completions handler:', { requestId });
            handleCompletions(req, res);
        } else if (pathname === '/v1/models' && method === 'GET') {
            console.log('Routing to models handler:', { requestId });
            handleModels(req, res);
        } else {
            console.warn('Unknown API endpoint:', {
                requestId,
                pathname,
                method,
                clientIP,
                timestamp: new Date().toISOString()
            });
            sendJsonResponse(res, 404, {
                error: {
                    message: 'Not found',
                    type: 'invalid_request_error',
                    code: 'not_found'
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
        sendJsonResponse(res, 404, {
            error: {
                message: 'Not found',
                type: 'invalid_request_error',
                code: 'not_found'
            }
        });
    }
}

// Create and start HTTP server
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
    console.log(`OpenAI to Replicate Proxy server running on port ${PORT}`);
    console.log('Available endpoints:');
    console.log('  POST /v1/chat/completions');
    console.log('  POST /v1/completions');
    console.log('  GET /v1/models');
    console.log('  GET /health');
});
