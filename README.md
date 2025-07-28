# OpenAI to Replicate Proxy - Cloudflare Worker

This is a serverless implementation of the OpenAI to Replicate proxy using Cloudflare Workers. It provides the same functionality as the Node.js version but runs on Cloudflare's edge network for global distribution and automatic scaling.

## Setup

### Prerequisites

1. **Cloudflare Account**: Sign up at https://cloudflare.com
2. **Wrangler CLI**: Install the Cloudflare Workers CLI
   ```bash
   npm install -g wrangler
   ```
3. **Replicate API Token**: Get from https://replicate.com/account/api-tokens

### Installation

1. **Navigate to worker directory**:
   ```bash
   cd worker
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Login to Cloudflare**:
   ```bash
   wrangler login
   ```

4. **Set environment variables**:
   ```bash
   # Set your Replicate API token
   wrangler secret put REPLICATE_API_TOKEN
   
   # Generate and set a secure proxy API key
   openssl rand -hex 32
   wrangler secret put PROXY_API_KEY
   ```

### Deployment

1. **Deploy to staging**:
   ```bash
   npm run deploy:staging
   ```

2. **Deploy to production**:
   ```bash
   npm run deploy:production
   ```

3. **Test locally**:
   ```bash
   npm run dev
   ```

## Usage

Once deployed, your worker will be available at:
- Production: `https://openai-replicate-proxy.your-subdomain.workers.dev`
- Staging: `https://openai-replicate-proxy-staging.your-subdomain.workers.dev`

### Example Usage

```bash
# Test the health endpoint
curl https://your-worker-url.workers.dev/health

# Chat completions
curl -X POST https://your-worker-url.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key_here" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "max_tokens": 100
  }'

# List models
curl https://your-worker-url.workers.dev/v1/models \
  -H "Authorization: Bearer your_proxy_api_key_here"
```

### Python Client Example

```python
import openai

# Point to your Cloudflare Worker
openai.api_base = "https://your-worker-url.workers.dev/v1"
openai.api_key = "your_proxy_api_key_here"

response = openai.ChatCompletion.create(
    model="gpt-3.5-turbo",
    messages=[
        {"role": "user", "content": "Hello from Cloudflare Workers!"}
    ]
)

print(response.choices[0].message.content)
```

## Configuration

### Environment Variables

Set these using `wrangler secret put`:

- `REPLICATE_API_TOKEN` - Your Replicate API token (required)
- `PROXY_API_KEY` - API key for proxy authentication (required)

### Model Mappings

The worker includes the same model mappings as the Node.js version:

| OpenAI Model | Replicate Model |
|--------------|------------------|
| gpt-3.5-turbo | meta/llama-2-7b-chat |
| gpt-4 | meta/llama-2-70b-chat |
| gpt-4-turbo | meta/llama-2-70b-chat |

To modify model mappings, edit the `MODEL_MAPPINGS` object in `index.js`.

## API Endpoints

- `POST /v1/chat/completions` - Chat completions (supports streaming)
- `POST /v1/completions` - Text completions (legacy)
- `GET /v1/models` - List available models
- `GET /health` - Health check (no auth required)

## Development

### Local Development

```bash
# Start local development server
npm run dev

# Test locally
curl http://localhost:8787/health
```

### Deployment Commands

```bash
# Deploy to staging
npm run deploy:staging

# Deploy to production  
npm run deploy:production

# View logs
wrangler tail

# View worker analytics
wrangler metrics
```

## Advantages of Cloudflare Worker Version

1. **Global Edge Network**: Deployed to 300+ locations worldwide
2. **Zero Cold Starts**: Instant execution with V8 isolates
3. **Automatic Scaling**: Handles millions of requests automatically
4. **Cost Effective**: Pay only for what you use
5. **Built-in Security**: DDoS protection and security features
6. **Easy Deployment**: Single command deployment
7. **Environment Management**: Staging and production environments

## Limitations

1. **CPU Time Limit**: 50ms for free tier, 30 seconds for paid
2. **Memory Limit**: 128MB per request
3. **Request Size**: 100MB maximum request size
4. **Streaming**: Simplified streaming implementation due to Worker limitations

## Monitoring

Cloudflare provides built-in monitoring:

- **Analytics**: Request volume, errors, latency
- **Logs**: Real-time log streaming with `wrangler tail`
- **Metrics**: Performance metrics with `wrangler metrics`
- **Alerts**: Set up alerts for errors or performance issues

## Custom Domains

To use a custom domain:

1. Add your domain to Cloudflare
2. Create a route in the Cloudflare dashboard
3. Point the route to your worker

## Security

- Environment variables are encrypted and secure
- API key authentication required for all endpoints
- CORS headers configured for cross-origin requests
- Built-in DDoS protection from Cloudflare

## Support

For issues specific to the Cloudflare Worker implementation:
1. Check Cloudflare Workers documentation
2. Use `wrangler tail` for debugging
3. Monitor worker analytics for performance issues
