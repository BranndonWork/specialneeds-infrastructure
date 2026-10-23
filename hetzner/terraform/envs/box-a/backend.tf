terraform {
  backend "s3" {
    bucket = "specialneeds-data"
    key    = "terraform/api/box-a/terraform.tfstate"

    # R2 endpoint — from bws: prod__api__CLOUDFLARE_R2_DATA_ENDPOINT_URL
    endpoint = "https://fe1f2e378f772da0306f703d362b97f9.r2.cloudflarestorage.com"

    region = "auto"

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    force_path_style            = true

    # Credentials omitted — Terraform partial configuration.
    # Set env vars before running terraform init:
    #   export AWS_ACCESS_KEY_ID=$(bws ...)
    #   export AWS_SECRET_ACCESS_KEY=$(bws ...)
  }
}
