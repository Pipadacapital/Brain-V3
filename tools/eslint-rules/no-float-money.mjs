/**
 * ESLint rule: no-float-money (I-S07)
 *
 * Bans float/double/unpinned numeric types on columns that carry monetary values.
 * Monetary column names end in: _minor, _amount, _value, _fee, _cost, _revenue, _price.
 * Money is ALWAYS integer minor units (BIGINT) paired with currency_code CHAR(3).
 *
 * Also bans float arithmetic on *_minor identifiers in TypeScript expressions.
 *
 * Failing fixture:  const revenue_amount: number = 9.99;       // float money — ERROR
 *                   const price_minor: number = amount * 1.1;   // float arithmetic — ERROR
 * Passing fixture:  const price_minor: bigint = BigInt(999);    // integer minor units — OK
 */

const MONEY_SUFFIX_PATTERN =
  /(_minor|_amount|_value|_fee|_cost|_revenue|_price)$/i;

const FLOAT_TYPE_NAMES = new Set(['float', 'double', 'Float', 'Double', 'number', 'Number']);

/** Returns true if the node represents a float literal (has a decimal point or exponent). */
function isFloatLiteral(node) {
  if (node.type !== 'Literal') return false;
  const raw = node.raw ?? String(node.value);
  return typeof node.value === 'number' && (raw.includes('.') || raw.includes('e') || raw.includes('E'));
}

/** Returns true if the identifier name matches a money column pattern. */
function isMoneyIdentifier(name) {
  return MONEY_SUFFIX_PATTERN.test(name);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow float/double types on monetary columns and float arithmetic on *_minor identifiers (I-S07).',
      category: 'Brain — Money',
      recommended: true,
    },
    schema: [],
    messages: {
      floatMoneyType:
        'Monetary column "{{name}}" must be an integer type (bigint/BIGINT/number as integer), not a float or double. Money is always minor-units integer (I-S07).',
      floatMoneyLiteral:
        'Float literal assigned to monetary identifier "{{name}}". Use integer minor units only (I-S07).',
      floatMoneyArithmetic:
        'Float arithmetic detected on monetary identifier "{{name}}". All money math must remain in integer minor units (I-S07).',
    },
  },

  create(context) {
    return {
      // Catch: const revenue_amount: number = 9.99
      VariableDeclarator(node) {
        const name = node.id?.name ?? node.id?.type;
        if (!name || !isMoneyIdentifier(String(name))) return;

        // Check type annotation for float-typed declaration
        const typeAnnotation = node.id?.typeAnnotation?.typeAnnotation;
        if (typeAnnotation) {
          const typeName =
            typeAnnotation.typeName?.name ??
            typeAnnotation.type?.replace('TSTypeReference', '') ??
            '';
          // TSNumberKeyword covers `number`
          if (
            typeAnnotation.type === 'TSNumberKeyword' ||
            FLOAT_TYPE_NAMES.has(typeName)
          ) {
            context.report({
              node: node.id,
              messageId: 'floatMoneyType',
              data: { name: String(name) },
            });
          }
        }

        // Check for float literal assignment: const price_minor = 9.99
        if (node.init && isFloatLiteral(node.init)) {
          context.report({
            node: node.init,
            messageId: 'floatMoneyLiteral',
            data: { name: String(name) },
          });
        }
      },

      // Catch: price_minor = amount * 1.1
      AssignmentExpression(node) {
        const name =
          node.left?.name ??
          (node.left?.type === 'MemberExpression' ? node.left?.property?.name : null);
        if (!name || !isMoneyIdentifier(String(name))) return;

        // Walk the right-hand side for float literals
        function hasFloat(n) {
          if (!n) return false;
          if (isFloatLiteral(n)) return true;
          if (n.left && hasFloat(n.left)) return true;
          if (n.right && hasFloat(n.right)) return true;
          return false;
        }

        if (hasFloat(node.right)) {
          context.report({
            node: node.right,
            messageId: 'floatMoneyArithmetic',
            data: { name: String(name) },
          });
        }
      },

      // Catch TypeScript type aliases: type PriceMinor = float (rare but possible via interop)
      TSPropertySignature(node) {
        const name =
          node.key?.name ?? node.key?.value;
        if (!name || !isMoneyIdentifier(String(name))) return;
        const typeAnnotation = node.typeAnnotation?.typeAnnotation;
        if (
          typeAnnotation?.type === 'TSNumberKeyword' ||
          FLOAT_TYPE_NAMES.has(typeAnnotation?.typeName?.name ?? '')
        ) {
          context.report({
            node,
            messageId: 'floatMoneyType',
            data: { name: String(name) },
          });
        }
      },
    };
  },
};
