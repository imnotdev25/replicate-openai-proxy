#!/bin/bash

# Script to set Cloudflare Worker secrets from .env file
# Usage: ./set-secrets.sh [environment]
# Environment can be: production, staging, or development (defaults to production)

set -e

ENV=${1:-production}
ENV_FILE=".env"

echo "Setting Cloudflare Worker secrets for environment: $ENV"
echo "Reading from: $ENV_FILE"

# Check if .env file exists
if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: $ENV_FILE file not found!"
    echo "Please create a .env file with your secrets:"
    echo "REPLICATE_API_TOKEN=your_replicate_token_here"
    echo "PROXY_API_KEY=your_proxy_api_key_here"
    exit 1
fi

# Source the .env file
source "$ENV_FILE"

# Function to set secret
set_secret() {
    local secret_name=$1
    local secret_value=$2

    if [[ -z "$secret_value" ]]; then
        echo "Warning: $secret_name is empty or not set in $ENV_FILE"
        return 1
    fi

    echo "Setting secret: $secret_name"
    if [[ "$ENV" == "production" ]]; then
        echo "$secret_value" | wrangler secret put "$secret_name"
    else
        echo "$secret_value" | wrangler secret put "$secret_name" --env "$ENV"
    fi

    if [[ $? -eq 0 ]]; then
        echo "✅ Successfully set $secret_name"
    else
        echo "❌ Failed to set $secret_name"
        return 1
    fi
}

# Set the secrets
echo "----------------------------------------"
set_secret "REPLICATE_API_TOKEN" "$REPLICATE_API_TOKEN"
echo "----------------------------------------"
set_secret "PROXY_API_KEY" "$PROXY_API_KEY"
echo "----------------------------------------"

echo ""
echo "🎉 All secrets have been set successfully!"
echo ""
echo "You can now deploy your worker with:"
if [[ "$ENV" == "production" ]]; then
    echo "  wrangler deploy"
else
    echo "  wrangler deploy --env $ENV"
fi
echo ""
echo "To verify secrets are set, run:"
if [[ "$ENV" == "production" ]]; then
    echo "  wrangler secret list"
else
    echo "  wrangler secret list --env $ENV"
fi