-- ============================================================================
-- assert_order_line_money_bigint — I-S07: the money + quantity columns must be BIGINT.
-- Float/NUMERIC money columns are banned. PASS = 0 rows returned. Reads StarRocks
-- information_schema for the mart's column types.
-- ============================================================================
select
    column_name,
    data_type
from information_schema.columns
where table_schema = '{{ target.schema }}'
  and table_name   = 'silver_order_line'
  and column_name  in ('quantity', 'unit_price_minor', 'line_total_minor', 'line_discount_minor')
  and lower(data_type) not in ('bigint')
