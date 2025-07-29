# OpenAI to Replicate Proxy

A proxy server that translates OpenAI API calls to use Replicate's SDK instead. This allows you to use OpenAI-compatible clients while leveraging Replicate's models.

## Features

- **OpenAI API Compatibility**: Supports `/v1/chat/completions`, `/v1/completions`, and `/v1/models` endpoints
- **Lightweight**: Built with Node.js built-in HTTP module (no Express dependency)
- **Model Mapping**: Automatically maps OpenAI models to equivalent Replicate models
- **Streaming Support**: Handles both regular and streaming responses
- **API Key Authentication**: Secure access with Bearer token authentication
- **Error Handling**: Proper error responses in OpenAI format

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set up environment variables**:
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and add your configuration:
   ```
   REPLICATE_API_TOKEN=your_replicate_api_token_here
   PROXY_API_KEY=your_secure_proxy_api_key_here
   ```

   - Get your Replicate API token from: https://replicate.com/account/api-tokens
   - Generate a secure API key for your proxy:
     ```bash
     openssl rand -hex 32
     ```

3. **Start the server**:

   **Option A: Local Development**
   ```bash
   npm start
   ```

   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

   **Option B: Docker**
   ```bash
   # Build and run with Docker
   docker build -t openai-replicate-proxy .
   docker run -p 3000:3000 --env-file .env openai-replicate-proxy
   ```

   **Option C: Docker Compose**
   ```bash
   # Run with docker-compose
   docker-compose up -d
   ```

   **Option D: Cloudflare Worker (Serverless)**
   ```bash
   # Navigate to worker directory
   cd worker
   
   # Install dependencies and deploy
   npm install
   wrangler login
   wrangler secret put REPLICATE_API_TOKEN
   wrangler secret put PROXY_API_KEY
   npm run deploy:production
   ```

## Usage

The proxy runs on `http://localhost:3000` by default. You can use any OpenAI-compatible client by pointing it to your proxy server.

### Example with curl

#### Basic Chat Completions

```bash
# Simple chat completion
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key_here" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "max_tokens": 100
  }'

# Multi-turn conversation
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key_here" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is the capital of France?"},
      {"role": "assistant", "content": "The capital of France is Paris."},
      {"role": "user", "content": "What is its population?"}
    ],
    "max_tokens": 150,
    "temperature": 0.7
  }'

# Chat completion with streaming
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key_here" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [
      {"role": "user", "content": "Write a short story about a robot."}
    ],
    "max_tokens": 200,
    "stream": true
  }'
```

#### Legacy Completions

```bash
# Simple completion
curl -X POST http://localhost:3000/v1/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key_here" \
  -d '{
    "model": "text-davinci-003",
    "prompt": "The future of AI is",
    "max_tokens": 100,
    "temperature": 0.8
  }'

# Completion with custom parameters
curl -X POST http://localhost:3000/v1/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key_here" \
  -d '{
    "model": "text-davinci-002",
    "prompt": "Explain quantum computing in simple terms:",
    "max_tokens": 200,
    "temperature": 0.5,
    "top_p": 0.9,
    "frequency_penalty": 0.1
  }'
```

#### Model Information

```bash
# List all available models
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer your_proxy_api_key_here"

# Get specific model information
curl http://localhost:3000/v1/models/gpt-3.5-turbo \
  -H "Authorization: Bearer your_proxy_api_key_here"
```

#### Testing Different Deployment Options

```bash
# Local development server
export PROXY_URL="http://localhost:3000"

# Docker deployment
export PROXY_URL="http://localhost:3000"

# Cloudflare Worker deployment
export PROXY_URL="https://your-worker.your-subdomain.workers.dev"

# Test any deployment
curl -X POST $PROXY_URL/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key_here" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Test message"}],
    "max_tokens": 50
  }'
```

#### Error Testing

```bash
# Test without authentication (should return 401)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-3.5-turbo", "messages": [{"role": "user", "content": "test"}]}'

# Test with invalid model (should return 400)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key_here" \
  -d '{
    "model": "invalid-model",
    "messages": [{"role": "user", "content": "test"}]
  }'

# Test health endpoint
curl http://localhost:3000/health
```

### Example with OpenAI Python client

```python
import openai

# Point the client to your proxy
openai.api_base = "http://localhost:3000/v1"
openai.api_key = "your_proxy_api_key_here"  # Use your proxy API key

response = openai.ChatCompletion.create(
    model="gpt-3.5-turbo",
    messages=[
        {"role": "user", "content": "Hello, how are you?"}
    ]
)

print(response.choices[0].message.content)
```

## Model Configuration

The proxy uses an external `models.json` file for model mappings and configuration. You can customize this file to:

- Add new model mappings
- Change default models
- Configure model-specific settings

### Current Model Mappings

| OpenAI Model | Replicate Model |
|--------------|------------------|
| gpt-3.5-turbo | meta/llama-2-7b-chat |
| gpt-3.5-turbo-16k | meta/llama-2-7b-chat |
| gpt-4 | meta/llama-2-70b-chat |
| gpt-4-turbo | meta/llama-2-70b-chat |
| gpt-4-32k | meta/llama-2-70b-chat |
| text-davinci-003 | meta/llama-2-7b-chat |
| text-davinci-002 | meta/llama-2-7b-chat |

### Customizing Models

Edit `models.json` to add or modify model mappings:

```json
{
  "mappings": {
    "gpt-3.5-turbo": "meta/llama-2-7b-chat",
    "custom-model": "your/custom-replicate-model"
  },
  "default_model": "meta/llama-2-7b-chat",
  "model_configs": {
    "meta/llama-2-7b-chat": {
      "max_tokens": 4096,
      "temperature_range": [0.1, 2.0],
      "supports_streaming": true
    }
  }
}
```

## API Endpoints

- `POST /v1/chat/completions` - Chat completions (supports streaming)
- `POST /v1/completions` - Text completions (legacy)
- `GET /v1/models` - List available models
- `GET /health` - Health check

## Configuration

Environment variables:

- `REPLICATE_API_TOKEN` - Your Replicate API token (required)
- `PROXY_API_KEY` - API key for proxy authentication (required, generate with `openssl rand -hex 32`)
- `PORT` - Server port (optional, defaults to 3000)

## Deployment Options

The proxy supports multiple deployment methods to suit different needs:

### 1. Local Development
Run directly on your machine for development and testing.

### 2. Docker Deployment

The proxy includes Docker support for easy containerization and deployment.

### Docker Files

- `Dockerfile` - Multi-stage build with Node.js Alpine image
- `docker-compose.yml` - Complete deployment setup
- `.dockerignore` - Optimized build context

### Docker Features

- **Security**: Runs as non-root user
- **Health Checks**: Built-in health monitoring
- **Production Ready**: Optimized for production deployment
- **Environment Variables**: Full support for configuration via environment

### Deployment Commands

```bash
# Build the image
docker build -t openai-replicate-proxy .

# Run with environment file
docker run -p 3000:3000 --env-file .env openai-replicate-proxy

# Or use docker-compose for easier management
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the service
docker-compose down
```


## Notes

- The proxy converts OpenAI's message format to Replicate's prompt format
- Streaming responses are supported but simplified (single chunk response)
- Usage statistics in responses are currently placeholder values
- You can modify the `models.json` file to use different Replicate models
- Docker deployment includes health checks and runs as non-root user for security
