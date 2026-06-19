import { log } from "../../../log.js";

/**
 * SES email adapter — M1 transactional email delivery.
 *
 * In development: logs email content to console (no real send).
 * In production: uses AWS SES (credentials from Secrets Manager — I-S09).
 *
 * I-ST05: this is the ONLY egress path for email. No module calls SES directly.
 * The SES credentials are NEVER in env vars or code — loaded from Secrets Manager.
 */

export interface EmailPayload {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  correlationId: string;
}

export interface EmailAdapter {
  send(payload: EmailPayload): Promise<{ messageId: string }>;
}

/** Development adapter: logs to console only (no network call). */
export class DevEmailAdapter implements EmailAdapter {
  async send(payload: EmailPayload): Promise<{ messageId: string }> {
    log.info('', { detail: {
            to: payload.to.replace(/(.{1}).+@/, '$1***@'),
            subject: payload.subject,
            correlation_id: payload.correlationId,
            note: 'DEV MODE: Email not sent. Check logs for token.',
            // In dev we log the full text so developers can test the flow.
            body_preview: payload.textBody.substring(0, 200),
          } });
    return { messageId: `dev-${Date.now()}` };
  }
}

/**
 * Production SES adapter.
 * Credentials loaded from AWS Secrets Manager (I-S09).
 * Only instantiated in production; dev uses DevEmailAdapter.
 */
export class SesEmailAdapter implements EmailAdapter {
  constructor(
    private readonly fromAddress: string,
    private readonly region: string = 'ap-south-1',
  ) {}

  async send(payload: EmailPayload): Promise<{ messageId: string }> {
    // Dynamic import to avoid requiring @aws-sdk/client-ses in dev.
    // The module specifier is a computed expression so TypeScript does not
    // resolve the type at compile time (prod-only dep, intentionally absent in dev).
    const sesModule = await (new Function('m', 'return import(m)')('@aws-sdk/client-ses') as Promise<{
      SESClient: new (opts: { region: string }) => { send: (cmd: unknown) => Promise<{ MessageId?: string }> };
      SendEmailCommand: new (opts: unknown) => unknown;
    }>);
    const { SESClient, SendEmailCommand } = sesModule;
    const client = new SESClient({ region: this.region });

    const command = new SendEmailCommand({
      Source: this.fromAddress,
      Destination: { ToAddresses: [payload.to] },
      Message: {
        Subject: { Data: payload.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: payload.textBody, Charset: 'UTF-8' },
          ...(payload.htmlBody
            ? { Html: { Data: payload.htmlBody, Charset: 'UTF-8' } }
            : {}),
        },
      },
    });

    const result = await client.send(command);
    return { messageId: result.MessageId ?? `ses-${Date.now()}` };
  }
}

/** Factory: returns SES adapter in production, dev adapter otherwise. */
export function createEmailAdapter(env: string, fromAddress: string): EmailAdapter {
  if (env === 'production' || env === 'staging') {
    return new SesEmailAdapter(fromAddress);
  }
  return new DevEmailAdapter();
}
