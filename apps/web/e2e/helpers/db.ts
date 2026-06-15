import { Client } from 'pg';

/**
 * Dev e2e helper: mark a registered user's email as verified.
 *
 * In development the app deliberately sends no real email (DevEmailAdapter logs
 * the token and stores only its sha256 hash). This helper simulates the user
 * clicking the verification link, so the smoke can proceed to login.
 */
const DSN = process.env.DATABASE_URL ?? 'postgres://brain:brain@localhost:5432/brain';

export async function markEmailVerified(email: string): Promise<void> {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  try {
    await client.query(
      'UPDATE app_user SET email_verified_at = now(), updated_at = now() WHERE email = $1',
      [email],
    );
  } finally {
    await client.end();
  }
}
