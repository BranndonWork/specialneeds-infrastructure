output "ipv4" {
  description = "Public IPv4 address of the server — used in Ansible inventory and Cloudflare DNS"
  value       = hcloud_server.this.ipv4_address
}

output "server_id" {
  description = "Hetzner server ID — needed for terraform import of Box A"
  value       = hcloud_server.this.id
}
