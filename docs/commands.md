# Development Commands

## meilisearch-proxy

```bash
cd cloudflare/workers/meilisearch-proxy
npm install              # Install dependencies
npm run dev              # Start local dev server (wrangler dev)
npm start                # Alias for dev
npm test                 # Run Vitest tests
npm run deploy           # Deploy to Cloudflare
npm run cf-typegen       # Generate TypeScript types
```

## meilisearch-proxy-staging

```bash
cd cloudflare/workers/meilisearch-proxy-staging
npm install
npm run dev          # Start local dev server
npm test             # Run Vitest tests
npm run deploy       # Deploy to staging
```

## special-needs

```bash
cd cloudflare/workers/special-needs
wrangler deploy          # Deploy to Cloudflare
# Note: No npm scripts - direct wrangler commands
```

## Common Development Tasks

### Setting Secrets
```bash
cd cloudflare/workers/[worker-name]
wrangler secret put SECRET_NAME
# Enter secret value when prompted
```

### Viewing Logs
```bash
cd cloudflare/workers/[worker-name]
wrangler tail            # Stream live logs from production
```

### Testing Locally
```bash
cd cloudflare/workers/meilisearch-proxy
npm test                 # Only meilisearch-proxy has tests
```
