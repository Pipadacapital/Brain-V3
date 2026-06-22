{#
  generate_schema_name — custom-schema-as-is override (re-platform Phase E).

  Default dbt concatenates target.schema + custom schema (→ brain_silver_brain_gold). Brain's
  medallion uses distinct StarRocks databases per tier (brain_silver, brain_gold), so a model that
  declares `config(schema='brain_gold')` must land in EXACTLY brain_gold. Models with no explicit
  schema keep target.schema (brain_silver) — so existing Silver marts are unaffected.
#}
{% macro generate_schema_name(custom_schema_name, node) -%}
    {%- if custom_schema_name is none -%}
        {{ target.schema }}
    {%- else -%}
        {{ custom_schema_name | trim }}
    {%- endif -%}
{%- endmacro %}
