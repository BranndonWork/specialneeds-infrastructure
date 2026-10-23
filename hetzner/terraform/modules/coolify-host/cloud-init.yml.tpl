#cloud-config
# Minimal bootstrap: installs Python (for Ansible) and creates the ansible user.
# Everything else is handled by Ansible — do not add complexity here.

packages:
  - python3
  - python3-pip
  - unzip

users:
  - name: ansible
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${ansible_user_pubkey}

runcmd:
  - systemctl enable --now qemu-guest-agent || true
  - touch /tmp/cloud-init-complete
