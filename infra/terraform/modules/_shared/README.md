# `_shared` — reusable Brain tag standard

A zero-resource Terraform module that emits the **mandatory Brain tag set** as a
single `common_tags` map. Wire it into the aws provider `default_tags` block of
each environment root so every taggable resource inherits the standard tags with
no per-resource boilerplate.

> Authoritative standard: [`docs/infra/naming-and-tagging.md`](../../../../docs/infra/naming-and-tagging.md)

## Mandatory tags

| Key | Source | Example |
| --- | --- | --- |
| `Environment` | `var.environment` | `prod` |
| `Service`     | per-resource (default `platform`) | `core` |
| `Owner`       | `var.owner` (default `data-team`) | `data-team` |
| `CostCenter`  | `var.cost_center` (default `brain-platform`) | `brain-platform` |

Plus two recommended baseline keys: `Project=brain`, `ManagedBy=terraform`.

## Adoption recipe (provider `default_tags`)

In each env root (`infra/terraform/envs/{dev,staging,prod}/`):

```hcl
module "tags" {
  source      = "../../modules/_shared"
  environment = local.environment
  project     = local.project
}

provider "aws" {
  region = "ap-south-1"

  default_tags {
    tags = module.tags.common_tags
  }
}
```

After this, **delete the inline `tags = { project = ..., environment = ... }`
blocks** from the resource modules — `default_tags` covers them. Keep ONLY the
tags that vary per resource, e.g. a `Name` tag or a resource-specific
`Service`/`role`/`purpose`/`tier`:

```hcl
resource "aws_eks_node_group" "system" {
  # ...
  tags = {
    Name    = "brain-${var.environment}-system"   # not covered by default_tags
    Service = "platform"                          # overrides the default_tags Service
    role    = "system"
  }
}
```

`default_tags` and a resource-level `tags` block **merge**; the resource-level
value wins on key collisions, so per-resource `Service`/`Name` overrides work.

## Per-resource `Service` override

`Service` defaults to `platform`. For service-scoped infra (ECR repo, a
service's IAM role, a per-service bucket) set `Service` on the resource itself
(`core` | `web` | `collector` | `stream-worker` | `spark-bronze` | `trino`).

## Why a module and not a bare `locals` file

Terraform `locals` are file/module-local and cannot be `include`d across roots.
A tiny output-only module is the idiomatic way to share a computed map. It plans
and applies for free (no resources), so it is safe to add to the EC10
declared-but-unapplied `envs/prod` root immediately.

## Known divergence to reconcile (follow-up)

Existing resource modules (`rds`, `eks`, `network`, `elasticache`, `s3-*`) today
hardcode **lowercase** tag keys (`project`, `environment`, `managed_by`,
`purpose`, `service`, `role`, `tier`). AWS treats `Environment` and
`environment` as **distinct** keys, so until those modules are migrated a
resource may carry both. The migration checklist lives in
`docs/infra/naming-and-tagging.md` §6. This module does **not** edit those
modules (out of scope for the authoring task that introduced it).
