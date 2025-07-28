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
                reject(error);
            }
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

    if (!expectedApiKey) {
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
    try {
        const body = await parseRequestBody(req);
        const { model, messages, max_tokens = 500, temperature = 0.7, stream = false } = body;

        // Map OpenAI model to Replicate model
        const replicateModel = MODEL_MAPPINGS[model] || DEFAULT_MODEL;

        // Convert messages to prompt format
        const prompt = convertMessagesToPrompt(messages);

        console.log(`Using Replicate model: ${replicateModel}`);
        console.log(`Prompt: ${prompt.substring(0, 200)}...`);

        if (stream) {
            // Handle streaming response
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
            sendJsonResponse(res, 200, response);
        }

    } catch (error) {
        console.error('Error calling Replicate:', error);
        sendJsonResponse(res, 500, {
            error: {
                message: 'Internal server error',
                type: 'server_error',
                code: 'internal_error'
            }
        });
    }
}

// Completions handler (legacy)
async function handleCompletions(req, res) {
    try {
        const body = await parseRequestBody(req);
        const { model, prompt, max_tokens = 500, temperature = 0.7 } = body;

        // Map OpenAI model to Replicate model
        const replicateModel = MODEL_MAPPINGS[model] || DEFAULT_MODEL;

        console.log(`Using Replicate model: ${replicateModel}`);
        console.log(`Prompt: ${prompt.substring(0, 200)}...`);

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

        sendJsonResponse(res, 200, response);

    } catch (error) {
        console.error('Error calling Replicate:', error);
        sendJsonResponse(res, 500, {
            error: {
                message: 'Internal server error',
                type: 'server_error',
                code: 'internal_error'
            }
        });
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
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // Handle CORS preflight requests
    if (method === 'OPTIONS') {
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
        handleHealth(req, res);
        return;
    }

    // All /v1/* endpoints require authentication
    if (pathname.startsWith('/v1/')) {
        const authResult = authenticateApiKey(req);
        if (!authResult.success) {
            sendJsonResponse(res, authResult.statusCode, { error: authResult.error });
            return;
        }

        // Route to appropriate handler
        if (pathname === '/v1/chat/completions' && method === 'POST') {
            handleChatCompletions(req, res);
        } else if (pathname === '/v1/completions' && method === 'POST') {
            handleCompletions(req, res);
        } else if (pathname === '/v1/models' && method === 'GET') {
            handleModels(req, res);
        } else {
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
