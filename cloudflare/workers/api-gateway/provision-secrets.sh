#!/usr/bin/env bash
set -euo pipefail

TFVARS="/Volumes/Storage/Dropbox/workspace/projects/special-needs/specialneeds-infrastructure/terraform/terraform.tfvars"
DJANGO_ENV="/Volumes/Storage/Dropbox/workspace/projects/special-needs/specialneeds-api/.env.production"

CF_API_TOKEN=$(python3 -c "import re; t=open('$TFVARS').read(); print(re.search(r'cloudflare_api_token\s*=\s*\"([^\"]+)\"', t).group(1))")
REVALIDATE_SECRET=$(grep '^REVALIDATE_SECRET=' "$DJANGO_ENV" | cut -d= -f2-)

echo "Provisioning CF_API_TOKEN..."
echo "$CF_API_TOKEN" | npx wrangler secret put CF_API_TOKEN

echo "Provisioning REVALIDATE_SECRET..."
echo "$REVALIDATE_SECRET" | npx wrangler secret put REVALIDATE_SECRET

echo "Done."
