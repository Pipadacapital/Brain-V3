################################################################################
# Brain – NAT Instance Module (fck-nat)
#
# A single, cost-optimised NAT *instance* (fck-nat) to replace the per-AZ
# managed NAT Gateways from modules/network. fck-nat is a maintained, minimal
# NAT-on-EC2 distribution that runs comfortably on a t4g.nano (~$3-4/mo + EIP).
#
# !! SINGLE-AZ / SINGLE-INSTANCE !!  This trades the per-AZ NAT-Gateway HA for
# cost. If the instance / its AZ is lost, ALL private-subnet egress stops until
# the instance is replaced. Acceptable for starter / dev / cost-sensitive prod;
# NOT highly-available. See README.md for the conscious-choice tradeoff.
#
# Naming: brain-{env}-nat ; mandatory tags applied via local.common_tags.
################################################################################

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

###############################################################################
# Variables
###############################################################################
variable "environment" {
  description = "Deployment environment (dev|staging|prod). Drives naming + tags."
  type        = string
}

variable "project" {
  description = "Project slug used in the brain-{env}-{resource} naming scheme."
  type        = string
  default     = "brain"
}

variable "vpc_id" {
  description = "VPC the NAT instance lives in (module.network.vpc_id)."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR allowed to route through the NAT instance (ingress)."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_id" {
  description = "Public subnet (single AZ) the NAT instance is launched into. Pick one of module.network.public_subnet_ids."
  type        = string
}

variable "private_route_table_ids" {
  description = <<-EOT
    Private route-table IDs whose default route (0.0.0.0/0) should point at this
    NAT instance. NOTE: modules/network ALREADY defines an inline 0.0.0.0/0 ->
    NAT-Gateway route on its private route tables; you cannot have two default
    routes in one table. To adopt fck-nat you must stop creating the network
    module's NAT Gateways (and their inline route) first. See README.md.
  EOT
  type        = list(string)
}

variable "instance_type" {
  description = "EC2 instance type. t4g.nano (arm64) is the cheapest viable NAT box."
  type        = string
  default     = "t4g.nano"
}

variable "ami_id" {
  description = <<-EOT
    Optional explicit fck-nat AMI id. When null, the latest community fck-nat
    arm64 AL2023 AMI (publisher account 568608671756) is looked up automatically.
    Pin this to a specific AMI id for reproducible, drift-free deploys.
  EOT
  type        = string
  default     = null
}

variable "root_volume_size" {
  description = "Root EBS volume size (GiB)."
  type        = number
  default     = 8
}

variable "tags" {
  description = "Extra tags merged over the mandatory tag set."
  type        = map(string)
  default     = {}
}

###############################################################################
# Locals — naming + mandatory tags
###############################################################################
locals {
  name_prefix = "${var.project}-${var.environment}"

  common_tags = merge(
    {
      Environment = var.environment
      Service     = "nat-egress"
      Owner       = "data-team"
      CostCenter  = "brain-platform"
      project     = var.project
      environment = var.environment
      managed_by  = "terraform"
    },
    var.tags,
  )

  ami_id = var.ami_id != null ? var.ami_id : data.aws_ami.fck_nat[0].id
}

###############################################################################
# AMI lookup — latest community fck-nat arm64 image (only when ami_id unset)
# Publisher account 568608671756 is the official fck-nat AMI owner.
###############################################################################
data "aws_ami" "fck_nat" {
  count       = var.ami_id == null ? 1 : 0
  most_recent = true
  owners      = ["568608671756"]

  filter {
    name   = "name"
    values = ["fck-nat-al2023-*-arm64-ebs"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

###############################################################################
# Security Group — accepts traffic from the VPC, egress anywhere
###############################################################################
resource "aws_security_group" "nat" {
  name        = "${local.name_prefix}-nat"
  description = "fck-nat instance SG: ingress from VPC CIDR, egress to internet"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
    description = "Allow all traffic from within the VPC (private subnets) to be NATed"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound (forwarded egress)"
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-nat-sg"
  })
}

###############################################################################
# Elastic IP — stable egress address
###############################################################################
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-nat-eip"
  })
}

###############################################################################
# NAT Instance (fck-nat)
# - source_dest_check MUST be false for an instance to forward traffic.
# - IMDSv2 required (http_tokens = required).
# - encrypted gp3 root volume.
###############################################################################
resource "aws_instance" "nat" {
  ami                    = local.ami_id
  instance_type          = var.instance_type
  subnet_id              = var.public_subnet_id
  vpc_security_group_ids = [aws_security_group.nat.id]
  source_dest_check      = false

  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size
    encrypted             = true
    delete_on_termination = true
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-nat"
  })
}

resource "aws_eip_association" "nat" {
  instance_id   = aws_instance.nat.id
  allocation_id = aws_eip.nat.id
}

###############################################################################
# Default routes — point each private route table at the NAT instance ENI.
# Routes to the instance's primary network interface; Terraform updates these
# if the instance (and thus its ENI) is replaced.
###############################################################################
resource "aws_route" "private_default" {
  count                  = length(var.private_route_table_ids)
  route_table_id         = var.private_route_table_ids[count.index]
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_instance.nat.primary_network_interface_id
}

###############################################################################
# Outputs
###############################################################################
output "instance_id" {
  description = "EC2 instance id of the NAT instance."
  value       = aws_instance.nat.id
}

output "primary_network_interface_id" {
  description = "Primary ENI id (the route target)."
  value       = aws_instance.nat.primary_network_interface_id
}

output "security_group_id" {
  description = "Security group id of the NAT instance."
  value       = aws_security_group.nat.id
}

output "public_ip" {
  description = "Elastic IP (stable egress address)."
  value       = aws_eip.nat.public_ip
}

output "eip_allocation_id" {
  description = "Allocation id of the NAT instance EIP."
  value       = aws_eip.nat.id
}
