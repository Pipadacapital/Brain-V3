-- ============================================================================
-- assert_order_state_money_bigint — I-S07: order_value_minor must be BIGINT.
-- Float/NUMERIC money columns are banned. PASS = 0 rows returned.
-- Reads StarRocks information_schema for the mart's column type.
-- ============================================================================
select
    column_name,
    data_type
from information_schema.columns
where table_schema = '{{ target.schema }}'
  and table_name   = 'silver_order_state'
  and column_name  = 'order_value_minor'
  and lower(data_type) not in ('bigint')
