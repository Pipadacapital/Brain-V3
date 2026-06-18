# Research: GoKwik + Shopflo Data Connectors for Brain

> Source: deep-research workflow (100 agents, 18 sources, 17 confirmed / 8 refuted claims), 2026-06-18.

> Scope: build first-party DATA CONNECTORS (Brain READS their data; does not run checkout). GoKwik-first, Shopflo fast-follow. Domains: CoD/RTO, checkout conversion, settlement/fees, offers/EMI/loyalty.


## Executive summary

Both GoKwik and Shopflo are partner-gated India-D2C checkout/RTO products, but each exposes enough first-party documented surface to design a Brain read-connector — with sharply different shapes. GoKwik's only public, well-documented API is the synchronous RTO Predict endpoint (POST v2/rto/predict, appid/appsecret header auth, categorical High/Medium/Low risk_flag — NOT a numeric score, NOT an order/settlement read API), plus an AWB Service that establishes RTO as a late-changing shipment lifecycle (transition states → terminal RTO/Delivered end-states), which is the key signal for Brain's trailing-window re-pull. Shopflo exposes a merchant-self-serve credential model (Dashboard → Channels → copy a static API Access Token; API-key not OAuth, Merchant ID from support@shopflo.com) and two concrete read surfaces: a Token API (checkout-session init) and a self-configurable abandoned-checkout webhook (event_name=checkout_abandoned, POST, rich payload covering funnel + discount + financial-summary fields). Crucially, NEITHER vendor documents settlement/payments-fee endpoints, RTO numeric scores, OAuth, rate limits, or backfill depth publicly — so the CoD-CM2/net-of-fees and capability domains 3 (settlement/fees) and parts of 4 (EMI/loyalty) require a partner agreement or are dev-honest synthetic fixtures only. Self-authorization differs: Shopflo merchants can self-serve a token AND self-configure the abandoned-cart webhook URL to point at Brain, whereas GoKwik abandoned-checkout webhooks must be added by GoKwik's Merchant Integration team (manual, not self-serve).


## Verified findings

### 1. [HIGH · vote 3-0 (claims 9, 13)] 

GoKwik's only well-documented public API is RTO Predict: a synchronous REST POST to v2/rto/predict (sandbox base https://sandbox.gokwik.co/v2/rto/predict, Content-Type application/json) called at checkout before payment methods render, returning a CATEGORICAL risk_flag (High/Medium/Low Risk or Control) + request_id + free-text risk reason. It is NOT a numeric probability, NOT an order/settlement read API, and NOT a webhook feed — so the merchant can dynamically block/hide COD for high-risk shoppers.


_Evidence:_ Primary GoKwik vendor PDF (linked from gokwik.co/api-docs) confirms verbatim: Method POST, Path v2/rto/predict, Content-Type application/json; 'called before the user sees the payment methods list'; response gives 'risk_flag' (High/Medium/Low Risk/Control) + request_id + risk reason. No numeric score appears anywhere. Two unanimous (3-0) claims plus a third corroborating claim. Inference 'not an order/settlement read API or webhook' is well-grounded scoping — the documented shape is a request/response prediction call only.


_Sources:_ https://cdn.gokwik.co/rto-doc/rto-predict-api.pdf, https://www.gokwik.co/api-docs



### 2. [HIGH · vote 3-0 (claims 10, 14)] 

GoKwik RTO Predict authenticates via STATIC appid + appsecret passed as HTTP headers (NOT OAuth, no bearer-token exchange, no merchant-self-authorized third-party flow documented); credentials are provisioned to the merchant on the GoKwik Merchant Dashboard. A missing header returns HTTP 403 'Missing required header: appsecret'.


_Evidence:_ Vendor PDF states verbatim 'GoKwik RTO API requires appid and appsecret to be passed in the headers... will be made available on the Merchant Dashboard'; curl example uses static --header 'appid' / 'appsecret'; 403 'Missing required header: appsecret' reproduced exactly. Two 3-0 claims. 'Not OAuth' is sound inference (no authorization endpoint, redirect, consent, or refresh token anywhere). Note: the cited /api-docs URL now 404s but the underlying PDF resolves on GoKwik's CDN. Implication for Brain: Brain reads via merchant-provided static credentials, not a delegated OAuth grant — credential rotation/scope is undocumented.


_Sources:_ https://cdn.gokwik.co/rto-doc/rto-predict-api.pdf, https://www.gokwik.co/api-docs



### 3. [HIGH · vote 3-0 (claim 15)] 

GoKwik exposes RTO outcome as a LATE-CHANGING lifecycle via the AWB (Airway Bill) Service: merchants feed AWB number + latest status back to GoKwik; shipment status moves through non-terminal transition states (order placed, manifested, pending pickup, in transit, out for delivery, undelivered) before reaching TERMINAL end-states including 'RTO, rto initiated, rto in transit, rto undelivered, rto out for delivery, rto delivered' and 'Delivered/Completed'. This is the canonical late-data signal driving Brain's trailing-window re-pull.


_Evidence:_ Primary GoKwik PDF has a section literally titled 'AWB Service' with verbatim end-state list (RTO variants + Delivered/Completed + Cancelled/Lost/Damaged/Returned) and 10 transition states; doc explicitly defines End States as 'terminating states beyond which the status... will not change' vs Transition States 'non-terminating... expected to change with time.' This directly substantiates that CoD/RTO status changes weeks after order placement — the exact trailing-window restatement concern. Corroborated by GoKwik dashboard 'AWB end state' feature and independent video. 3-0.


_Sources:_ https://www.gokwik.co/api-docs, https://cdn.gokwik.co/rto-doc/rto-predict-api.pdf



### 4. [HIGH · vote 3-0 mechanism (claim 12); 2-1 on 100M figure (claim 11)] 

GoKwik's RTO Protection Suite mechanism: analyzes buyer behavior across 200+ parameters using network intelligence derived from 100M+ unique online shoppers to tier shoppers high/mid/low risk, and reduces RTO by hiding COD for high-risk shoppers, identifying problematic high-RTO pincodes, and flagging products with elevated COD RTO rates. (Address/pincode intelligence and product-level RTO are real capability domains, though efficacy percentages are vendor marketing.)


_Evidence:_ GoKwik Hopscotch case study supports verbatim: '200+ parameters', 'Data based of 100 million+ unique online shoppers', 'classifies shoppers as high/mid/low-risk', 'hiding COD as a payment option for high-risk shoppers', 'Identify problematic pin codes', 'Identify products with high COD RTO%'. The mechanism claim is 3-0; the 100M-shopper figure was 2-1 (one verifier flagged GoKwik also cites ~180M model-training base elsewhere — multiple internal numbers). Treat efficacy figures (e.g. 'cut RTO up to 40%') as marketing, NOT independently verified. Confirms CoD verification + RTO + address/pincode intelligence (capability domain 1) is GoKwik's core, but these signals surface via the suite/dashboard, not necessarily a documented read API.


_Sources:_ https://www.gokwik.co/case-studies/gokwik-helps-hopscotch-increase-cod-pincode-serviceability



### 5. [HIGH · vote 3-0 (claim 16)] 

GoKwik delivers abandoned-checkout events to external third parties via a CUSTOM webhook integration set up MANUALLY by GoKwik's Merchant Integration team — there is NO self-serve API or native connector. A merchant cannot self-add the webhook URL (especially in GoKwik V1 modal checkout); the URL must be shared with GoKwik's POC/integration team.


_Evidence:_ Spur (primary, secondary-quality) states GoKwik pushes abandoned-checkout events via webhook but 'relies on the merchant integration team to set up webhooks manually' and merchants 'do not have direct access to add webhooks in GoKwik Version 1.' Independently corroborated by BIK ('Contact your GoKwik POC... The GoKwik team then add a webhook trigger for abandoned carts... no self-serve API') and QuickReply's managed pattern. Three independent integrators describe the identical manual mechanism. 3-0. Implication: Brain CANNOT self-onboard GoKwik abandoned-checkout events — requires a partner/POC-mediated webhook registration.


_Sources:_ https://help.spurnow.com/en/articles/10562030-recover-abandoned-checkouts-with-gokwik-and-spur, https://help.bik.ai/en/articles/8750241



### 6. [HIGH · vote 3-0 (claims 4, 7, 8)] 

Shopflo authenticates via a merchant-self-service API-KEY model (NOT OAuth): the merchant creates a 'Channel' in Dashboard Settings (name + optional description → 'Create Channel'), which generates a static 'API Access Token' the merchant copies and can hand to a third party like Brain. The Token API also requires a Merchant ID obtained from support@shopflo.com. There is no documented OAuth/delegated-grant flow.


_Evidence:_ Shopflo Help Center confirms verbatim Settings → Channels → Add channel → Create Channel → 'Copy the generated API Access Token'; Token API doc states 'API key can be generated...' and 'Reach out to support@shopflo.com to get Merchant ID.' No OAuth artifacts (no authorization endpoint/redirect/consent/refresh) appear anywhere. Three 3-0 claims (7, 8, 4). Self-authorization for Brain is via copying a static token, not a delegated OAuth grant. Caveat: token expiry/rotation/scope is undocumented.


_Sources:_ https://intercom.help/shopflo-a9de00772be8/en/articles/10410585-creating-a-new-channel-to-get-api-token, https://www.shopflo.com/help/token-api, https://intercom.help/shopflo-a9de00772be8/en/articles/10125258-token-api



### 7. [HIGH · vote 3-0 (claims 0, 1)] 

Shopflo exposes a self-configurable ABANDONED-CHECKOUT webhook: a merchant adds it in Dashboard → Settings → Integrations → Abandoned Cart Webhook by providing a REST endpoint URL and enabling it. Delivery is an HTTP POST with event_name='checkout_abandoned', firing when abandoned checkouts are created — including addressless checkouts that cannot sync to Shopify. A merchant can self-configure delivery to a Brain endpoint (the integrator does NOT build a partner app).


_Evidence:_ Shopflo's own Intercom help article confirms verbatim: path 'Settings → Integrations → Abandoned Cart Webhook', 'Share a REST endpoint which accepts post request', 'add the URL and enable the configuration'; Request Type POST; event_name 'checkout_abandoned'; 'includes... abandoned checkouts that do not have address (and cannot be passed to Shopify).' Two 3-0 claims. Caveat: docs confirm a self-serve config field exists but do NOT state it is ungated for all plans — feature visibility could be plan/enablement-gated, and the merchant must already be a Shopflo customer with dashboard access.


_Sources:_ https://intercom.help/shopflo-a9de00772be8/en/articles/10520364-abandoned-checkout-webhook



### 8. [HIGH · vote 3-0 (claim 2)] 

The Shopflo abandoned-checkout webhook payload is rich enough to map checkout-conversion-funnel and discount-application Silver tables: identifiers (checkout_id, cart_token), customer fields (email, phone, customer.uid, marketing_consent), shipping/billing addresses, line_items (price/id/quantity/title), and a financial summary (subtotal_price, total_discount, total_shipping, total_tax, total_price).


_Evidence:_ Shopflo help center documents every named field verbatim in the example payload (e.g. financial summary subtotal_price=65, total_discount=0, total_tax=9.92, total_price=65; phone '+917777777777'; marketing_consent true). 3-0. Funnel keys + financials + discount field are all present → supports canonical Silver mapping for capability domains 2 (checkout funnel) and 4 (discount/coupon application). Caveat: addressless checkouts can have email:null — a data-completeness nuance, not a schema gap.


_Sources:_ https://intercom.help/shopflo-a9de00772be8/en/articles/10520364-abandoned-checkout-webhook



### 9. [HIGH · vote 3-0 (claims 3, 5)] 

Shopflo's Token API (https://api.shopflo.com/public/api/v2/tokens, REST, API-key+Merchant-ID auth) returns a checkout URL for session-based checkout initialization and exposes checkout-session, customer, payment-method, and discount/coupon (COUPON_INPUT/COUPON_LIST) data. '/public/' refers to the URL path, NOT unauthenticated access. The documentation does NOT cover OAuth, third-party authorization, webhooks, rate limits, settlement endpoints, or RTO scores.


_Evidence:_ Two first-party renderings confirm endpoint https://api.shopflo.com/public/api/v2/tokens returning checkout URL; Shopflo.getSessionId() session model; selective payment-method display; coupon/discount UI config. Two independent WebFetch passes confirm the doc does NOT mention OAuth, third-party auth, webhooks, rate limits, settlement, or RTO scores. 3-0 (claims 3, 5). The one webhook reference found (api.shopflo.co PG PayU webhook) is an inbound payment-gateway hook, not a third-party read surface. Implication: Shopflo settlement/fees + RTO numeric data are NOT publicly documented — partner agreement or synthetic fixtures only.


_Sources:_ https://www.shopflo.com/help/token-api, https://intercom.help/shopflo-a9de00772be8/en/articles/10125258-token-api



### 10. [HIGH · vote 3-0 (claim 6)] 

Shopflo's product positioning makes RTO reduction and prepaid-share improvement first-class capability domains (dedicated /improve-prepaid-share page, RTO Suite, COD-to-Prepaid feature, 'Reduce RTO & fake order', 'Reduce COD orders with automatic prepaid discounts'), confirming CoD/prepaid conversion + RTO are core to Shopflo's checkout product — though specific outcome percentages are vendor marketing.


_Evidence:_ Multiple Shopflo primary surfaces: integration page ('Reduce RTO & fake order', 'Prevent fraud, reduce returns'), dedicated improve-prepaid-share page, help-center RTO Suite + COD-to-Prepaid feature. 3-0. Positioning is current (live pages June 2026). Caveat: outcome figures (~17-42% RTO reduction, ~41% prepaid-share lift, +23% checkout conversion) are unverified vendor marketing. Confirms capability domains 1 (CoD/RTO) and 2 (conversion) are real product areas — but, per the finding above, the RTO SCORE itself is not exposed in public API docs.


_Sources:_ https://www.shopflo.com/integration, https://www.shopflo.com/improve-prepaid-share



### 11. [MEDIUM · vote synthesis of 3-0 claims] 

RECOMMENDED Brain connector design. GoKwik connector: model two ingestion seams — (a) at-checkout RTO Predict is a synchronous pre-payment call (a write-path enrichment, not a periodic read), so Brain should capture risk_flag+reason+request_id as emitted events keyed to the order; (b) the AWB lifecycle is the system-of-record for RTO OUTCOME, requiring a connector_instance with a cursor + a trailing-window re-pull (weeks-long, since end-states arrive late) to restate RTO/Delivered status — this is where CoD CM2 / RTO-clawback Gold ledgers resolve. GoKwik abandoned-checkout + settlement require GoKwik-team-mediated webhook setup / partner agreement. Shopflo connector: merchant self-serves a Channel API token + self-configures the checkout_abandoned webhook → Brain HMAC-verified endpoint → Bronze; canonical Silver from documented payload fields. For BOTH, settlement/payments-fee (domain 3), EMI/loyalty (domain 4 beyond coupons), and any numeric RTO score are NOT publicly documented → dev-honest SYNTHETIC FIXTURES only until real partner credentials/sandbox are obtained.


_Evidence:_ Design synthesizes the verified documented surfaces: GoKwik AWB end-states establish late-data restatement (claim 15) → trailing-window re-pull; static appid/appsecret (claims 10,14) → credential-based connector_instance; GoKwik manual webhook (claim 16) → partner-gated; Shopflo self-serve token + self-config webhook (claims 0,7) → self-authorizable. The DEV BOUNDARY is explicit: every verified source confirms settlement/fees and RTO-score endpoints are undocumented publicly (claims 5, plus refuted GitHub/partner-page claims showing no public data API) — so domains 3 and 4(EMI/loyalty) cannot be built against real data without a partner agreement; synthetic fixtures are dev-honest only. Confidence medium because the recommendation is engineering inference layered on documented facts, and rate limits / backfill depth / pagination cursors are UNDOCUMENTED for both vendors.


_Sources:_ https://cdn.gokwik.co/rto-doc/rto-predict-api.pdf, https://www.gokwik.co/api-docs, https://intercom.help/shopflo-a9de00772be8/en/articles/10520364-abandoned-checkout-webhook, https://www.shopflo.com/help/token-api, https://help.spurnow.com/en/articles/10562030-recover-abandoned-checkouts-with-gokwik-and-spur



## Open questions (partner-gated — need agreement/sandbox)

- What are the actual rate limits, pagination/cursor mechanics, and historical backfill depth for both vendors' partner APIs — none are publicly documented, and all are load-bearing for connector cursor/backfill design (this almost certainly requires a partner agreement + sandbox access to answer)?

- Do GoKwik and Shopflo expose any SETTLEMENT / payments-fee / MDR / settlement-file endpoint at the partner tier (required for net-of-fees realized revenue and CoD CM2 Gold ledgers), and does either return a NUMERIC RTO probability rather than just a categorical flag — both absent from public docs?

- What is the webhook security model (HMAC signing scheme, signature header, replay-protection/timestamp tolerance, retry/redelivery semantics) for the Shopflo checkout_abandoned webhook and the GoKwik abandoned-checkout webhook — undocumented publicly and essential for a trustworthy idempotent Brain ingest endpoint?

- Can a brand genuinely SELF-AUTHORIZE Brain end-to-end on Shopflo (token + abandoned-cart webhook) without any Shopflo-side partner enablement, and what is GoKwik's actual partner/POC onboarding path and SLA for registering Brain's webhook + provisioning read access to order/AWB/RTO-outcome data beyond the at-checkout Predict call?



## Sources

-  https://sandbox-rto-api.dev.gokwik.in/docs

-  https://help.spurnow.com/en/articles/10562030-recover-abandoned-checkouts-with-gokwik-and-spur

-  https://docs.quickreply.ai/product-modules/integrations/available-integrations/checkout-recovery/gokwik

-  https://github.com/GoKwik

-  https://intercom.help/shopflo-a9de00772be8/en/articles/10520364-abandoned-checkout-webhook

-  https://www.shopflo.com/help/token-api

-  https://www.shopflo.com/integration

-  https://www.shopflo.com/

-  https://www.theconvertway.com/blog/shopify-abandoned-checkout-deprecation

-  https://intercom.help/shopflo-a9de00772be8/en/articles/10410585-creating-a-new-channel-to-get-api-token

-  https://cdn.gokwik.co/rto-doc/rto-predict-api.pdf

-  https://www.gokwik.co/blog/rto-actions-by-gokwik

-  https://www.gokwik.co/blog/backed-by-data-driven-by-ai-manage-return-to-origin

-  https://www.gokwik.co/docs/web-integration

-  https://inc42.com/features/early-stage-d2c-brands-can-scale-faster-and-profitably-with-kwik-cod-app-on-shopify-gokwiks-vineeta-vora/

-  https://www.gokwik.co/case-studies/gokwik-helps-hopscotch-increase-cod-pincode-serviceability

-  https://www.gokwik.co/api-docs

-  https://www.shopflo.com/pricing
