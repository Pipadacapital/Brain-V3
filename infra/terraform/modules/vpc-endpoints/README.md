# `vpc-endpoints` — S3 Gateway + AWS-API Interface endpoints

Keeps AWS-API traffic **off the NAT path**. Pairs with `modules/nat-instance`:
the single fck-nat box stays cheap and lightly loaded because image pulls, log
shipping, secret/STS lookups, and all S3 I/O go via PrivateLink / the (free) S3
Gateway endpoint instead of traversing NAT.

## What it creates

| Endpoint | Type | Cost | Why |
|----------|------|------|-----|
| S3 | **Gateway** | **Free** | Iceberg/MinIO→S3, ECR layer blobs (stored in S3), large object I/O off NAT. |
| STS | Interface | ~$7/mo + data | IRSA `AssumeRoleWithWebIdentity`, signing. |
| Secrets Manager | Interface | ~$7/mo + data | App/connector secret fetches. |
| ECR `api` | Interface | ~$7/mo + data | Image auth / manifest. |
| ECR `dkr` | Interface | ~$7/mo + data | Image pulls (blob metadata; layers via S3 gateway). |
| CloudWatch Logs | Interface | ~$7/mo + data | Container/log shipping off NAT. |

> Interface endpoints have an hourly + per-GB charge. The win is twofold:
> (1) bytes bypass the single NAT instance (resilience + NAT data savings),
> and (2) the **free** S3 Gateway endpoint carries the heaviest flows (S3 +
> ECR layers). Net effect on a low-traffic starter stack is typically cost-neutral
> to positive while materially reducing single-NAT blast radius.

## Wiring

```hcl
module "vpc_endpoints" {
  source = "../../modules/vpc-endpoints"

  environment             = local.environment
  project                 = local.project
  vpc_id                  = module.network.vpc_id
  vpc_cidr                = "10.0.0.0/16"          # match modules/network vpc_cidr
  private_subnet_ids      = module.network.private_subnet_ids
  private_route_table_ids = module.network.private_route_table_ids   # for S3 gateway assoc

  # region defaults to the provider region (ap-south-1); override only if needed.
  # interface_services = ["sts", "secretsmanager", "ecr.api", "ecr.dkr", "logs"]
}
```

> Requires `modules/network` to export `private_route_table_ids` (it currently
> does not — add the output when integrating). `private_dns_enabled = true` on
> the interface endpoints means in-VPC clients resolve the public AWS API
> hostnames to the private ENIs automatically — **no app/SDK change needed**.

## Inputs

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `environment` | string | — | Env slug; naming + tags. |
| `project` | string | `brain` | Naming prefix. |
| `vpc_id` | string | — | Target VPC. |
| `vpc_cidr` | string | `10.0.0.0/16` | CIDR allowed to reach endpoints on 443. |
| `region` | string | `null` | Endpoint service region; null = provider region. |
| `private_subnet_ids` | list(string) | — | Subnets for interface ENIs. |
| `private_route_table_ids` | list(string) | — | RTs associated with the S3 gateway. |
| `interface_services` | list(string) | `[sts, secretsmanager, ecr.api, ecr.dkr, logs]` | Interface endpoints to create. |
| `tags` | map(string) | `{}` | Extra tags merged over the mandatory set. |

## Outputs

`s3_endpoint_id`, `interface_endpoint_ids` (map of service→id),
`endpoints_security_group_id`.

## Naming & tags

- Gateway endpoint `brain-{env}-vpce-s3`; interface endpoints
  `brain-{env}-vpce-{service}` (e.g. `brain-prod-vpce-ecr-api`); SG
  `brain-{env}-vpce-sg`.
- Mandatory tags on every resource: `Environment`, `Service=vpc-endpoints`,
  `Owner=data-team`, `CostCenter=brain-platform` (plus `project`/`environment`/
  `managed_by`).
