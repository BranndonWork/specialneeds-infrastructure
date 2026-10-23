terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.0"
    }
  }
  required_version = ">= 1.5"
}

resource "hcloud_ssh_key" "deploy" {
  name       = "${var.name}-deploy"
  public_key = var.deploy_public_key
}

resource "hcloud_firewall" "web" {
  name = "${var.name}-web"

  # SSH is the only inbound port. All HTTP traffic, the Coolify UI included,
  # arrives through the Cloudflare Tunnel connector, which dials out.
  # Live rules: hetzner/firewall-rules.json, applied with hetzner/scripts/hcloud_firewall.py.
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_cidrs
  }
}

resource "hcloud_server" "this" {
  name         = var.name
  server_type  = var.server_type
  image        = "ubuntu-22.04"
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.deploy.id]
  firewall_ids = [hcloud_firewall.web.id]

  user_data = templatefile("${path.module}/cloud-init.yml.tpl", {
    ansible_user_pubkey = var.ansible_user_pubkey
  })

  labels = {
    role    = "coolify-host"
    managed = "terraform"
  }
}
