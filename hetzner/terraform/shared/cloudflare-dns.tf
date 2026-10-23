terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.5"
  backend "s3" {
    bucket                      = "specialneeds-data"
    key                         = "terraform/api/shared/terraform.tfstate"
    endpoint                    = "https://fe1f2e378f772da0306f703d362b97f9.r2.cloudflarestorage.com"
    region                      = "auto"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    force_path_style            = true
    # Credentials omitted — set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars before terraform init
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "zone_id" {
  type    = string
  default = "3df33cbd8f514275c7074407989b5b12"
}

# Box A IP — the current production server
variable "box_a_ipv4" {
  type    = string
  default = "46.224.10.193"
}

# Box B IP — fill in after `terraform apply` in envs/box-b
# On cutover: update this to Box B IP and flip api_active below
variable "box_b_ipv4" {
  type        = string
  description = "Box B public IPv4 — set after Phase 4a terraform apply"
  default     = ""
}

# Set to "box-b" during DR cutover to flip api.specialneeds.com to Box B
variable "api_active_box" {
  type        = string
  description = "Which box serves api.specialneeds.com: box-a or box-b"
  default     = "box-a"

  validation {
    condition     = contains(["box-a", "box-b"], var.api_active_box)
    error_message = "api_active_box must be box-a or box-b"
  }
}

locals {
  api_ip = var.api_active_box == "box-b" ? var.box_b_ipv4 : var.box_a_ipv4
}

# api.specialneeds.com — primary API endpoint
# Cutover: set api_active_box=box-b in terraform.tfvars and apply
resource "cloudflare_dns_record" "api" {
  zone_id = var.zone_id
  name    = "api"
  type    = "A"
  content = local.api_ip
  proxied = true
  ttl     = 1
}

# api-standby.specialneeds.com — Box B parked (not proxied, direct IP for health checks)
# Only created once box_b_ipv4 is set
resource "cloudflare_dns_record" "api_standby" {
  count   = var.box_b_ipv4 != "" ? 1 : 0
  zone_id = var.zone_id
  name    = "api-standby"
  type    = "A"
  content = var.box_b_ipv4
  proxied = false
  ttl     = 60
}
