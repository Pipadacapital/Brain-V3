-- ============================================================================
-- assert_touchpoint_no_money — touchpoints are NOT monetary: NO money/float column may
-- be smuggled into the mart. PASS = 0 rows returned. Reads StarRocks information_schema
-- and flags any column whose name looks monetary OR whose type is float/double/decimal
-- (I-S07 no-float-in-Silver + the §2 "no money column" invariant).
-- ============================================================================
select
    column_name,
    data_type
from information_schema.columns
where table_schema = '{{ target.schema }}'
  and table_name   = 'silver_touchpoint'
  and (
        -- no monetary-named columns at all
        lower(column_name) like '%amount%'
     or lower(column_name) like '%minor%'
     or lower(column_name) like '%price%'
     or lower(column_name) like '%value%'
     or lower(column_name) like '%revenue%'
        -- and absolutely no float/decimal types (counts/money would be the only reason)
     or lower(data_type) in ('float', 'double', 'decimal', 'decimalv2', 'decimal64', 'decimal128')
  )
