variable "name" {
  type        = string
  description = "Unique name for this server (e.g. box-a, box-b)"
}

variable "server_type" {
  type        = string
  description = "Hetzner server type (e.g. cpx21, cx31) — match Box A via SSH Hetzner metadata"
}

variable "location" {
  type        = string
  description = "Hetzner datacenter location (e.g. nbg1, fsn1, hel1) — match Box A via Hetzner console"
}

variable "deploy_public_key" {
  type        = string
  description = "SSH public key for the root/deploy user"
}

variable "ansible_user_pubkey" {
  type        = string
  description = "SSH public key for the ansible user created by cloud-init"
}

variable "ssh_allowed_cidrs" {
  type        = list(string)
  description = "CIDR ranges allowed to reach port 22 — restrict to your IP in production"
  default     = ["0.0.0.0/0", "::/0"]
}
