#!/usr/bin/env bash
# trigger-bronze-maintenance.sh — submit ONE bronze-maintenance run NOW from the cron's own spec,
# unmodified (same deadline, same env). Use when the 2-hourly cron failed and Bronze fragmentation
# is 500-ing the Bronze-reading serving surfaces (recent-events / data-health / tracking).
set -euo pipefail
K="kubectl --context brain-prod-ssm"
$K get cronworkflow bronze-maintenance -n argo -o json | python3 -c "
import json,sys
cw=json.load(sys.stdin)
wf={'apiVersion':'argoproj.io/v1alpha1','kind':'Workflow',
    'metadata':{'generateName':'bronze-maint-manual-','namespace':'argo','labels':{'app.kubernetes.io/part-of':'brain'}},
    'spec':cw['spec']['workflowSpec']}
json.dump(wf, sys.stdout)
" | $K create -f -
echo "submitted — watch: kubectl --context brain-prod-ssm get workflow -n argo | grep bronze-maint-manual"
