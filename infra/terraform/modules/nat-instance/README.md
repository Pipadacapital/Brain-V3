# `nat-instance` — fck-nat single-instance egress

A cost-optimised NAT **instance** (the maintained [fck-nat](https://github.com/AndrewGuenther/fck-nat)
distribution) intended to replace the per-AZ managed **NAT Gateways** created by
`modules/network`. Runs on a `t4g.nano` (arm64) for roughly **$3–4/mo + EIP**,
versus ~$32/mo per managed NAT Gateway (×3 AZs in `staging`/`prod`).

## ⚠️ HA tradeoff — read before adopting

`modules/network` provisions **one NAT Gateway per AZ** when
`single_nat_gateway = false` (the prod default). That is **highly available**:
losing one AZ does not stop egress in the others.

**This module is the opposite: a SINGLE instance in a SINGLE AZ.** If the
instance, its EBS volume, or its AZ fails, **all private-subnet egress stops**
until EC2 auto-recovery / a Terraform re-apply replaces it. There is no
cross-AZ failover.

### Auto-recovery (AUD-OPS-035 — default ON)

`enable_auto_recovery = true` (the default) adds two CloudWatch alarms wired to
EC2's built-in actions — the cheapest meaningful hardening (~$0.20/mo):

| Alarm | Signal | Action |
|---|---|---|
| `…-nat-system-check-recover` | `StatusCheckFailed_System` (2×1m) | `ec2:recover` — same instance/ENI/private IP; routes + EIP association survive |
| `…-nat-instance-check-reboot` | `StatusCheckFailed_Instance` (3×1m) | `ec2:reboot` — hung OS / network stack |

This covers host failure and OS hangs; it does **not** cover AZ loss. Full
fck-nat **HA mode** (warm standby + EIP failover) is a separate, larger apply
decision — it replaces `aws_instance` with an ASG (a destructive change to this
module) and roughly doubles the instance cost (~+$2-3/mo). Adopt it when
connector-egress downtime tolerance drops below "minutes".

- ✅ Acceptable for: `dev`, cost-sensitive starter `prod`, anything where a few
  minutes of egress downtime during instance replacement is tolerable.
- ❌ Not acceptable for: workloads requiring HA egress SLAs. Keep the managed
  NAT-Gateway path (`modules/network`, `single_nat_gateway = false`) for those.

Choose consciously. This module does **not** silently swap HA for cost — you
must wire it in deliberately.

## Wiring (drop-in replacement for managed NAT)

Because `modules/network` defines an **inline** `0.0.0.0/0 → NAT-Gateway` route
on each private route table, you cannot simply add this module on top — a route
table can hold only one default route. To adopt fck-nat you must **stop creating
the network module's NAT Gateways and their inline default route** (e.g. a
network-module variable/fork that skips `aws_nat_gateway` + `aws_route_table.private`'s
inline route, leaving empty private route tables for this module to populate).

Once the private route tables exist **without** a default route, wire this
module in your env root (do NOT edit `modules/network` or `envs/*` as part of
authoring this module — this block is the operator's integration step):

```hcl
module "nat_instance" {
  source = "../../modules/nat-instance"

  environment             = local.environment
  project                 = local.project
  vpc_id                  = module.network.vpc_id
  vpc_cidr                = "10.0.0.0/16"           # match modules/network vpc_cidr
  public_subnet_id        = module.network.public_subnet_ids[0]  # single AZ
  private_route_table_ids = module.network.private_route_table_ids

  # Optional: pin a reproducible fck-nat AMI instead of "latest community".
  # ami_id        = "ami-xxxxxxxxxxxxxxxxx"
  # instance_type = "t4g.nano"
}
```

> Requires `modules/network` to expose `private_route_table_ids` as an output.
> The current `modules/network` does **not** export it (only `vpc_id`,
> `public_subnet_ids`, `private_subnet_ids`, and SG ids). Add that output when
> integrating — it is intentionally **not** done here (this module must not edit
> `modules/network`).

## AMI selection

- Default (`ami_id = null`): looks up the **latest** community fck-nat
  `al2023` **arm64** AMI from publisher account `568608671756`.
- For drift-free, reproducible deploys, **pin** `ami_id` to a concrete value.

## Inputs

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `environment` | string | — | `dev`/`staging`/`prod`; drives naming + tags. |
| `project` | string | `brain` | Naming prefix slug. |
| `vpc_id` | string | — | Target VPC. |
| `vpc_cidr` | string | `10.0.0.0/16` | CIDR allowed to be NATed (ingress). |
| `public_subnet_id` | string | — | Single public subnet (one AZ). |
| `private_route_table_ids` | list(string) | — | Private RTs to point at the instance. |
| `instance_type` | string | `t4g.nano` | arm64 instance type. |
| `ami_id` | string | `null` | Pin fck-nat AMI; null = latest community. |
| `root_volume_size` | number | `8` | Root gp3 size (GiB). |
| `tags` | map(string) | `{}` | Extra tags merged over the mandatory set. |

## Outputs

`instance_id`, `primary_network_interface_id`, `security_group_id`,
`public_ip`, `eip_allocation_id`.

## Naming & tags

- Resources named `brain-{env}-nat` (instance), `-nat-sg`, `-nat-eip`.
- Mandatory tags on every resource: `Environment`, `Service=nat-egress`,
  `Owner=data-team`, `CostCenter=brain-platform` (plus `project`/`environment`/
  `managed_by` for parity with the env provider `default_tags`).

## Security notes

- `source_dest_check = false` (mandatory for an instance to forward traffic).
- IMDSv2 enforced (`http_tokens = required`).
- Encrypted gp3 root volume.
- SG ingress is VPC-CIDR-scoped; no SSH is opened (use SSM Session Manager —
  pair with `modules/vpc-endpoints` for an internet-free SSM path if desired).
