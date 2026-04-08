# Architecture

## Tech Stack
- **Platform:** Cloudflare Workers (V8 isolates)
- **Runtime:** JavaScript/TypeScript on edge
- **CLI:** Wrangler for deployment
- **Deployment:** Edge network (global CDN)

## Directory Structure
```
specialneeds-infrastructure/
├── docs/                               # Documentation
├── scripts/                            # Utility scripts (if any)
├── cloudflare/
│   └── workers/
│       ├── meilisearch-proxy/          # Search proxy worker (production)
│       ├── meilisearch-proxy-staging/  # Search proxy worker (staging)
│       └── special-needs/              # Main worker
└── README.md
```

## R2 Bucket Architecture

All workers use the `x-specialneeds-env` request header to determine which R2 buckets to use:
- `x-specialneeds-env: production` → Uses PROD_BUCKET, PROD_LOG_BUCKET
- Any other value → Uses DEV_BUCKET, DEV_LOG_BUCKET

**Bucket Bindings:**

special-needs (wrangler.toml:12):
- `PROD_BUCKET` → `specialneeds-prod`
- `PROD_LOG_BUCKET` → `specialneeds-logs-prod`
- `DEV_BUCKET` → `specialneeds-dev`
- `DEV_LOG_BUCKET` → `specialneeds-logs-dev`

**Note:** R2 is preferred over KV for cost reasons (see comments in wrangler.toml files)

## Environment Routing Pattern

All workers in this repository use a custom header-based environment routing:

```javascript
const requestEnvironment = request.headers.get('x-specialneeds-env') === 'production'
  ? 'production'
  : 'development';
```

This header determines:
- Which R2 buckets to use (PROD vs DEV)
- Which log buckets to use
- Included in response headers as `x-env`

## File Organization Patterns

**meilisearch-proxy:**
- Single file worker (`src/index.ts`)
- TypeScript with proper type definitions
- Uses Vitest for testing

**special-needs:**
- Single file worker with inline helper functions
- All logic in `src/index.js`

## Related Repositories

- **specialneeds-api** - Backend API
- **specialneeds-client** - Frontend that calls meilisearch-proxy for search
- **specialneeds-services** - Background services (not edge-deployed)
- **specialneeds-admin** - Admin interface
