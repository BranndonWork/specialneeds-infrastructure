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
  description = "Match Box A — check via SSH: curl -s http://169.254.169.254/hetzner/v1/metadata | python3 -m json.tool"
}

variable "location" {
  type        = string
  description = "Match Box A — verify in Hetzner Cloud Console"
}

variable "deploy_public_key" {
  type        = string
  description = "SSH public key for the root/deploy user on Box B"
}

variable "ansible_user_pubkey" {
  type        = string
  description = "SSH public key for the ansible user (cloud-init creates this user)"
}

variable "ssh_allowed_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0", "::/0"]
}

module "box_b" {
  source = "../../modules/coolify-host"

  name                = "box-b"
  server_type         = var.server_type
  location            = var.location
  deploy_public_key   = var.deploy_public_key
  ansible_user_pubkey = var.ansible_user_pubkey
  ssh_allowed_cidrs   = var.ssh_allowed_cidrs
}

output "ipv4" {
  description = "Box B public IPv4 — copy into ansible/inventory/hosts.yml and shared/cloudflare-dns.tf"
  value       = module.box_b.ipv4
}

output "server_id" {
  value = module.box_b.server_id
}
