################################################################################
# Prod environment — Terraform backend bootstrap
# EC10 PROD: workspace/account bootstrapped; terraform plan passes; NO apply
# of compute until M4. Account ID: 380254378136 (prod).
################################################################################
terraform {
  backend "s3" {
    bucket         = "brain-tfstate-prod-380254378136"
    key            = "envs/prod/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "brain-tfstate-lock-prod"
    encrypt        = true
    kms_key_id     = "alias/brain-tfstate-prod"
  }
  required_version = ">= 1.9"
}
