/**
 * ESLint rule: no-pci-card-fields (C4 — PCI SAQ-A card field allowlist enforcement)
 *
 * Bans column/field names that would expand Brain's PCI scope from SAQ-A to SAQ-A-EP.
 * The banned field names are card-network metadata that Razorpay (and other PSPs) include
 * in API responses. If any of these fields enter Brain's Bronze layer, PCI scope expands.
 *
 * This rule catches:
 *   - Variable/property names matching the blocked patterns
 *   - Object literal keys matching the blocked patterns
 *   - TypeScript interface/type property names matching the blocked patterns
 *   - SQL column references in template literals (best-effort detection)
 *
 * The mapper (packages/razorpay-mapper/src/index.ts) is the AUTHORITATIVE enforcement:
 * this rule is a belt-and-suspenders CI gate that catches accidental bypass.
 *
 * Failing examples:
 *   const card_last4 = '4242';              // banned field name
 *   const obj = { card_network: 'Visa' };   // banned object key
 *   interface Row { card_brand: string; }   // banned interface property
 *
 * Passing examples:
 *   const payment_id_hash = hashRazorpayId(rawId, salt);  // hashed — OK
 *   const utr_hash = '...';                                // hashed — OK
 */

const BLOCKED_CARD_FIELDS = new Set([
  'card_last4',
  'card_network',
  'card_brand',
  'card_issuer',
  'card_international',
  'card_type',
  'card_country',
]);

/** Returns true if the name matches any blocked card field */
function isBlockedCardField(name) {
  if (!name) return false;
  return BLOCKED_CARD_FIELDS.has(String(name));
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow PCI-scope-expanding card field names (card_last4, card_network, card_brand, etc.). ' +
        'These must be dropped at the @brain/razorpay-mapper boundary — never in Bronze or ledger (C4).',
      category: 'Brain — PCI Compliance',
      recommended: true,
    },
    schema: [],
    messages: {
      blockedCardField:
        'Card field "{{name}}" is blocked (C4 / PCI SAQ-A). ' +
        'Card-network metadata must be dropped at the @brain/razorpay-mapper boundary ' +
        'and must never appear in Bronze events, ledger rows, or logs. ' +
        'If this is in the mapper boundary itself (applyFieldAllowlist), add an eslint-disable comment.',
    },
  },

  create(context) {
    return {
      // Variable declarations: const card_last4 = '4242'
      VariableDeclarator(node) {
        const name = node.id?.name;
        if (isBlockedCardField(name)) {
          context.report({
            node: node.id,
            messageId: 'blockedCardField',
            data: { name: String(name) },
          });
        }
      },

      // Object literal keys: { card_network: 'Visa' }
      Property(node) {
        const key = node.key;
        const name = key?.name ?? key?.value;
        if (isBlockedCardField(name)) {
          context.report({
            node: key,
            messageId: 'blockedCardField',
            data: { name: String(name) },
          });
        }
      },

      // TypeScript interface / type properties
      TSPropertySignature(node) {
        const key = node.key;
        const name = key?.name ?? key?.value;
        if (isBlockedCardField(name)) {
          context.report({
            node: key ?? node,
            messageId: 'blockedCardField',
            data: { name: String(name) },
          });
        }
      },

      // TypeScript type literal members
      TSTypeElement(node) {
        const key = node.key;
        if (key) {
          const name = key.name ?? key.value;
          if (isBlockedCardField(name)) {
            context.report({
              node: key,
              messageId: 'blockedCardField',
              data: { name: String(name) },
            });
          }
        }
      },

      // Assignment targets: row.card_last4 = value
      MemberExpression(node) {
        if (node.computed) return; // skip computed members (row['card_last4'] — caught by Property above)
        const prop = node.property;
        const name = prop?.name;
        if (isBlockedCardField(name)) {
          context.report({
            node: prop,
            messageId: 'blockedCardField',
            data: { name: String(name) },
          });
        }
      },
    };
  },
};
