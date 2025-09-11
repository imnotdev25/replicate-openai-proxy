require('dotenv').config();
const http = require('http');
const url = require('url');
const Replicate = require('replicate');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GLOBAL_RATE_LIMIT = parseInt(process.env.GLOBAL_RATE_LIMIT) || 100; // Max concurrent requests
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW) || 60000; // Time window in ms (1 minute)
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE) || 1000; // Maximum queue size

// Initialize Replicate client
const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

// Rate limiting and queue management
class RateLimiter {
    constructor(maxRequests, windowMs, maxQueueSize) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.maxQueueSize = maxQueueSize;
        this.requests = [];
        this.queue = [];
        this.activeRequests = 0;

        // Clean up expired requests every minute
        setInterval(() => this.cleanup(), 60000);
    }

    cleanup() {
        const now = Date.now();
        this.requests = this.requests.filter(timestamp => now - timestamp < this.windowMs);
        console.log(`Rate limiter cleanup: ${this.requests.length} active requests in window`);
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

// Initialize global rate limiter
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
                    body: body.substring(0, 500),
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

    const apiKey = authHeader.substring(7);

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

// Helper function to update metrics
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

// Chat completions handler with async processing
async function handleChatCompletions(req, res) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
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

            sendJsonResponse(res, 429, {
                error: {
                    message: 'Rate limit exceeded. Please try again later.',
                    type: 'rate_limit_error',
                    code: 'rate_limit_exceeded',
                    retry_after: Math.ceil(RATE_LIMIT_WINDOW / 1000)
                }
            });
            return;
        }

        try {
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

            const replicateStartTime = Date.now();

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

                const processingTime = Date.now() - startTime;
                updateMetrics(processingTime, true);

                console.log('Chat completions streaming completed:', {
                    requestId,
                    responseLength: content.length,
                    processingTime,
                    replicateTime: Date.now() - replicateStartTime,
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
                const processingTime = Date.now() - startTime;
                updateMetrics(processingTime, true);

                console.log('Chat completions completed successfully:', {
                    requestId,
                    responseLength: response.choices[0]?.message?.content?.length || 0,
                    processingTime,
                    replicateTime: Date.now() - replicateStartTime,
                    timestamp: new Date().toISOString()
                });

                sendJsonResponse(res, 200, response);
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

    } finally {
        // Always release the rate limit token
        globalRateLimiter.release();
    }
}

// Completions handler with async processing
async function handleCompletions(req, res) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const startTime = Date.now();

    try {
        console.log('Completions request started:', {
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

            sendJsonResponse(res, 429, {
                error: {
                    message: 'Rate limit exceeded. Please try again later.',
                    type: 'rate_limit_error',
                    code: 'rate_limit_exceeded',
                    retry_after: Math.ceil(RATE_LIMIT_WINDOW / 1000)
                }
            });
            return;
        }

        try {
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

            const replicateStartTime = Date.now();

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

            const processingTime = Date.now() - startTime;
            updateMetrics(processingTime, true);

            console.log('Completions completed successfully:', {
                requestId,
                responseLength: content.length,
                processingTime,
                replicateTime: Date.now() - replicateStartTime,
                timestamp: new Date().toISOString()
            });

            sendJsonResponse(res, 200, response);

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

    } finally {
        // Always release the rate limit token
        globalRateLimiter.release();
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

// Health check handler with metrics
function handleHealth(req, res) {
    const rateLimiterStats = globalRateLimiter.getStats();

    sendJsonResponse(res, 200, {
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

// Stats endpoint for monitoring
function handleStats(req, res) {
    const rateLimiterStats = globalRateLimiter.getStats();

    sendJsonResponse(res, 200, {
        timestamp: new Date().toISOString(),
        rateLimiter: rateLimiterStats,
        metrics: metrics,
        system: {
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            cpuUsage: process.cpuUsage()
        }
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

    // Stats endpoint (no auth required)
    if (pathname === '/stats' && method === 'GET') {
        console.log('Stats request:', { requestId });
        handleStats(req, res);
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

        // Route to appropriate handler - all handlers are now async
        if (pathname === '/v1/chat/completions' && method === 'POST') {
            console.log('Routing to chat completions handler:', { requestId });
            handleChatCompletions(req, res).catch(error => {
                console.error('Unhandled error in chat completions handler:', {
                    requestId,
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
                sendJsonResponse(res, 500, {
                    error: {
                        message: 'Internal server error',
                        type: 'server_error',
                        code: 'internal_error'
                    }
                });
            });
        } else if (pathname === '/v1/completions' && method === 'POST') {
            console.log('Routing to completions handler:', { requestId });
            handleCompletions(req, res).catch(error => {
                console.error('Unhandled error in completions handler:', {
                    requestId,
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
                sendJsonResponse(res, 500, {
                    error: {
                        message: 'Internal server error',
                        type: 'server_error',
                        code: 'internal_error'
                    }
                });
            });
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

// Graceful shutdown handling
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
});

server.listen(PORT, () => {
    console.log(`OpenAI to Replicate Proxy server running on port ${PORT}`);
    console.log('Configuration:');
    console.log(`  Global Rate Limit: ${GLOBAL_RATE_LIMIT} requests`);
    console.log(`  Rate Limit Window: ${RATE_LIMIT_WINDOW / 1000} seconds`);
    console.log(`  Max Queue Size: ${MAX_QUEUE_SIZE}`);
    console.log('Available endpoints:');
    console.log('  POST /v1/chat/completions');
    console.log('  POST /v1/completions');
    console.log('  GET /v1/models');
    console.log('  GET /health');
    console.log('  GET /stats');

    // Log initial rate limiter stats
    setInterval(() => {
        const stats = globalRateLimiter.getStats();
        if (stats.activeRequests > 0 || stats.queueSize > 0) {
            console.log('Rate limiter stats:', stats);
        }
    }, 30000); // Log every 30 seconds if there's activity
});