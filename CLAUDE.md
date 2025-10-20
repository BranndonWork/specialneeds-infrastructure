# CLAUDE.md - SpecialNeeds Infrastructure

This file provides context for AI assistants working with the SpecialNeeds Infrastructure repository.

## Repository Overview

**Repository:** specialneeds-infrastructure
**Purpose:** Cloudflare-specific infrastructure ONLY
**Tech Stack:** Cloudflare Workers, Wrangler CLI, JavaScript/TypeScript
**Deployment:** Cloudflare dashboard or Wrangler CLI

## Project Context

This repository contains ONLY Cloudflare-specific infrastructure for SpecialNeeds.com:

- Cloudflare Workers (edge computing)
- CDN caching rules
- Security headers
- Edge computing configurations

### What This Repository Is

✅ **DOES contain:**
- Cloudflare Workers
- Worker configurations (wrangler.toml)
- Edge computing logic
- CDN rules and configs
- Security header configurations

### What This Repository Is NOT

❌ **DOES NOT contain:**
- Docker configurations → Live in service repos (specialneeds-api, etc.)
- nginx configs → Live in service repos
- Service-specific infrastructure → Live in respective repositories
- Database configurations → specialneeds-api
- Application servers → Service-specific repos

## Architecture

### Tech Stack
- **Platform:** Cloudflare Workers (V8 isolates)
- **Runtime:** JavaScript/TypeScript on edge
- **CLI:** Wrangler for deployment
- **Deployment:** Edge network (global CDN)

### Directory Structure
```
specialneeds-infrastructure/
├── docs/                          # Documentation
├── scripts/                       # Utility scripts (if any)
├── cloudflare/
│   └── workers/
│       ├── meilisearch-proxy/    # Search proxy worker
│       ├── devapi-specialneeds/  # Dev API worker
│       └── special-needs/        # Main worker
└── README.md
```

## Deployed Workers

### 1. meilisearch-proxy

**Purpose:** Proxy Meilisearch search requests from client to Meilisearch instance

**Features:**
- Secure access to Meilisearch from client-side
- API key management at the edge
- Rate limiting
- Response caching for performance

**Deployment:**
```bash
cd cloudflare/workers/meilisearch-proxy
npm install
wrangler deploy
```

### 2. devapi-specialneeds

**Purpose:** Development API worker for testing and staging environments

**Features:**
- Development-specific routing
- Testing utilities
- Staging environment support

**Deployment:**
```bash
cd cloudflare/workers/devapi-specialneeds
npm install
wrangler deploy
```

### 3. special-needs

**Purpose:** Main Cloudflare Worker for the SpecialNeeds.com platform

**Features:**
- Main edge logic
- Request routing
- Security headers
- Performance optimizations

**Deployment:**
```bash
cd cloudflare/workers/special-needs
npm install
wrangler deploy
```

## Development Environment

### Prerequisites
- Node.js 16+
- Wrangler CLI: `npm install -g wrangler`
- Cloudflare account

### Worker Setup
```bash
cd cloudflare/workers/[worker-name]
npm install
wrangler dev  # Local development
wrangler deploy  # Deploy to Cloudflare
```

### Local Development
```bash
# Start local development server
wrangler dev

# Test worker locally
curl http://localhost:8787
```

## Important Notes for AI Assistants

### When Working on Workers

1. **Edge Computing Constraints**
   - Workers have CPU time limits (10-50ms typically)
   - Memory constraints (128MB)
   - No filesystem access
   - Limited standard libraries
   - Use edge-optimized code

2. **Worker Structure**
   - Export `fetch` handler as default
   - Handle requests and return responses
   - Use async/await for async operations
   - Implement proper error handling

3. **Environment Variables**
   - Configure in wrangler.toml or dashboard
   - Access via `env` parameter
   - Store secrets in Cloudflare Secrets
   - Never commit secrets to git

4. **Performance**
   - Minimize cold start time
   - Cache responses when appropriate
   - Use KV storage for persistence
   - Optimize for edge execution

5. **Security**
   - Validate all inputs
   - Sanitize user data
   - Implement rate limiting
   - Use appropriate CORS headers
   - Set security headers (CSP, etc.)

### Common Patterns

**Basic worker structure:**
```javascript
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // Handle request
      if (url.pathname === '/api/search') {
        return handleSearch(request, env);
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      return new Response('Internal error', { status: 500 });
    }
  }
};
```

**Proxying requests:**
```javascript
async function proxyRequest(request, targetUrl, env) {
  const url = new URL(request.url);
  const proxyUrl = new URL(targetUrl);
  proxyUrl.pathname = url.pathname;

  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${env.API_KEY}`);

  return fetch(proxyUrl.toString(), {
    method: request.method,
    headers: headers,
    body: request.body,
  });
}
```

**Caching responses:**
```javascript
async function handleRequest(request, env, ctx) {
  const cache = caches.default;
  let response = await cache.match(request);

  if (!response) {
    response = await fetch(request);
    ctx.waitUntil(cache.put(request, response.clone()));
  }

  return response;
}
```

**Rate limiting:**
```javascript
async function rateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP');
  const key = `rate_limit:${ip}`;

  const count = await env.KV.get(key);
  if (count > 100) {
    return new Response('Rate limit exceeded', { status: 429 });
  }

  await env.KV.put(key, (parseInt(count || '0') + 1).toString(), {
    expirationTtl: 60
  });

  return null;  // Allow request
}
```

### Debugging

- **Local testing:** `wrangler dev` for local development
- **Logs:** `wrangler tail` to stream production logs
- **Console logs:** Use `console.log()` for debugging
- **Testing:** Write tests with Miniflare or Vitest

### Configuration Files

**wrangler.toml:**
```toml
name = "my-worker"
main = "src/index.js"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"

[[kv_namespaces]]
binding = "KV"
id = "your-kv-namespace-id"

[env.staging]
name = "my-worker-staging"
vars = { ENVIRONMENT = "staging" }
```

### Related Repositories

- **specialneeds-api** - Backend API that workers may proxy
- **specialneeds-client** - Frontend that uses workers
- **specialneeds-services** - Background services (not edge)
- **specialneeds-admin** - Admin interface

## Deployment

### Via Wrangler CLI
```bash
# Deploy to production
wrangler deploy

# Deploy to staging
wrangler deploy --env staging

# Tail logs
wrangler tail

# View deployments
wrangler deployments list
```

### Via Cloudflare Dashboard
1. Log into Cloudflare dashboard
2. Navigate to Workers & Pages
3. Select worker
4. Upload or edit code
5. Deploy

### Environment Management

**Development:**
```bash
wrangler dev
```

**Staging:**
```toml
[env.staging]
name = "worker-staging"
```

**Production:**
```bash
wrangler deploy
```

## Best Practices

1. **Performance**
   - Keep workers lightweight
   - Minimize dependencies
   - Use caching effectively
   - Optimize for edge execution
   - Monitor CPU time usage

2. **Security**
   - Validate all inputs
   - Use Cloudflare Secrets for sensitive data
   - Implement rate limiting
   - Set appropriate CORS headers
   - Add security headers (CSP, HSTS, etc.)

3. **Reliability**
   - Handle errors gracefully
   - Implement fallbacks
   - Log important events
   - Test thoroughly before deploying
   - Monitor worker health

4. **Code Quality**
   - Keep workers focused and simple
   - Write clear, maintainable code
   - Document complex logic
   - Use TypeScript for type safety
   - Test edge cases

## Common Tasks

### Creating a new worker
1. Create directory in `cloudflare/workers/`
2. Initialize with `wrangler init`
3. Write worker code in src/
4. Configure wrangler.toml
5. Test locally with `wrangler dev`
6. Deploy with `wrangler deploy`

### Updating existing worker
1. Make code changes
2. Test locally with `wrangler dev`
3. Deploy to staging (if configured)
4. Test staging deployment
5. Deploy to production
6. Monitor logs with `wrangler tail`

### Adding environment variables
1. Add to wrangler.toml `[vars]` section
2. Or use Cloudflare dashboard for secrets
3. Access via `env` parameter in code
4. Never commit secrets to git

## Monitoring

- **Logs:** `wrangler tail` or Cloudflare dashboard
- **Analytics:** Cloudflare Workers analytics dashboard
- **Errors:** Monitor error rates and types
- **Performance:** Track CPU time and response times

## Questions?

Refer to:
- Repository README.md
- Cloudflare Workers documentation
- Wrangler CLI documentation
- Project-wide docs/repository-guide.md
