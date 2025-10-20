# SpecialNeeds Infrastructure

**Purpose:** Cloudflare Workers and CDN configurations that apply across SpecialNeeds.com services

## Overview

This repository contains **ONLY** Cloudflare-specific infrastructure:

- Cloudflare Workers
- CDN caching rules
- Security headers
- Edge computing configurations

**Important:** This repo is NOT for Docker, nginx, or service-specific infrastructure. Each service (API, Client, Admin) manages its own deployment configs in their respective repositories.

## Cloudflare Workers

### 1. meilisearch-proxy
Cloudflare Worker that proxies Meilisearch search requests from the client to the Meilisearch instance.

**Purpose:**
- Secure access to Meilisearch from client-side
- API key management at the edge
- Rate limiting and caching

### 2. devapi-specialneeds
Development API worker for testing and staging environments.

### 3. special-needs
Main Cloudflare Worker for the SpecialNeeds.com platform.

## Deployment

All workers are deployed via:
- **Wrangler CLI:** `wrangler deploy`
- **Cloudflare Dashboard:** Manual deployment through web interface

## Setup

Each worker has its own `package.json` and `wrangler.toml`. Navigate to the worker directory and follow its specific setup instructions.

```bash
cd cloudflare/workers/meilisearch-proxy
npm install
wrangler deploy
```

## Environment Variables

Each worker manages its own environment variables through:
- `wrangler.toml` configuration
- Cloudflare Dashboard secrets
- `.env` files (local development only)

## Tech Stack

- **Platform:** Cloudflare Workers
- **Runtime:** V8 isolates
- **CLI:** Wrangler
- **Language:** JavaScript/TypeScript

## Documentation

Worker-specific documentation is in each worker's directory.
