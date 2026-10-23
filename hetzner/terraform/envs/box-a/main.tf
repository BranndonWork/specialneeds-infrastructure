terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.0"
    }
  }
  required_version = ">= 1.5"
}

provider "hcloud" {
  token = var.hetzner_api_token
}

variable "hetzner_api_token" {
  type      = string
  sensitive = true
}

variable "server_type" {
  type        = string
  description = "Existing Box A server type — verify via Hetzner metadata endpoint on the host"
}

variable "location" {
  type        = string
  description = "Existing Box A location — verify in Hetzner Cloud Console"
}

variable "deploy_public_key" {
  type        = string
  description = "SSH public key currently on Box A"
}

variable "ansible_user_pubkey" {
  type        = string
  description = "SSH public key for the ansible user — will be added by Ansible on first run"
}

variable "ssh_allowed_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0", "::/0"]
}

# Box A uses terraform import in Phase 4b — do NOT apply this without importing first.
# Import commands:
#   terraform import module.box_a.hcloud_server.this <server_id>
#   terraform import module.box_a.hcloud_ssh_key.deploy <ssh_key_id>
#   terraform import module.box_a.hcloud_firewall.web <firewall_id>
module "box_a" {
  source = "../../modules/coolify-host"

  name                = "box-a"
  server_type         = var.server_type
  location            = var.location
  deploy_public_key   = var.deploy_public_key
  ansible_user_pubkey = var.ansible_user_pubkey
  ssh_allowed_cidrs   = var.ssh_allowed_cidrs
}

output "ipv4" {
  description = "Box A public IPv4"
  value       = module.box_a.ipv4
}

output "server_id" {
  value = module.box_a.server_id
}
