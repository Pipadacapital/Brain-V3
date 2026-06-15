################################################################################
# Staging environment — Terraform backend
# Replace <STAGING_ACCOUNT_ID> with the actual AWS account ID.
################################################################################
terraform {
  backend "s3" {
    bucket         = "brain-tfstate-staging-<STAGING_ACCOUNT_ID>"
    key            = "envs/staging/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "brain-tfstate-lock-staging"
    encrypt        = true
    kms_key_id     = "alias/brain-tfstate-staging"
  }
  required_version = ">= 1.9"
}
