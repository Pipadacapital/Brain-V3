################################################################################
# Dev environment — Terraform backend configuration
# State bucket created by bootstrap/main.tf and applied separately.
# Replace <DEV_ACCOUNT_ID> with the actual AWS account ID.
################################################################################
terraform {
  backend "s3" {
    bucket         = "brain-tfstate-dev-<DEV_ACCOUNT_ID>"
    key            = "envs/dev/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "brain-tfstate-lock-dev"
    encrypt        = true
    kms_key_id     = "alias/brain-tfstate-dev"
    # TF 1.10+: use_lockfile = true (native S3 locking, deprecates DynamoDB)
    # use_lockfile = true
  }
  required_version = ">= 1.9"
}
