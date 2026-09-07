import { isUtf8 } from 'node:buffer';
import { Webhook } from 'svix';
import { z } from 'zod';

export type EmailPayload = { from: string; to: string[]; subject: string; html: string; text: string };

/** Only these local codes and a fixed message may leave the provider boundary. */
export class EmailDeliveryError extends Error {
  constructor(public code: string, public retryable: boolean) {
    super('The email operation could not be completed.');
    this.name = 'EmailDeliveryError';
  }
}

const email = z.string().max(254).email();
const payloadSchema = z.object({
  from: z.string().min(1).max(512).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  to: z.array(email).length(1),
  subject: z.string().min(1).max(998).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  html: z.string().min(1).max(1024 * 1024),
  text: z.string().min(1).max(1024 * 1024),
}).strict();
const successSchema = z.object({ id: z.uuid() });
const deliveryTypes = [
  'email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced',
  'email.complained', 'email.failed', 'email.suppressed',
] as const;
const eventSchema = z.object({
  type: z.enum([...deliveryTypes, 'email.opened', 'email.clicked']),
  created_at: z.iso.datetime({ offset: true }).max(40),
  data: z.object({ email_id: z.uuid(), to: z.array(email).length(1) }),
});

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

// https://resend.com/docs/api-reference/emails/send-email
// https://resend.com/docs/dashboard/emails/idempotency-keys
export function createResendProvider(apiKey: string, fetcher: typeof fetch = fetch): {
  send(payload: EmailPayload, idempotencyKey: string, signal?: AbortSignal): Promise<{ id: string }>;
} {
  return {
    async send(payload, idempotencyKey, signal) {
      if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(apiKey)) {
        throw new EmailDeliveryError('EMAIL_PROVIDER_NOT_CONFIGURED', false);
      }
      const parsed = payloadSchema.safeParse(payload);
      if (!parsed.success || typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(idempotencyKey)) {
        throw new EmailDeliveryError('EMAIL_PAYLOAD_INVALID', false);
      }
      // Snapshot the permitted fields in a stable order before the first await.
      // The outbox owns preserving this same payload/key across the 24-hour window.
      const body = JSON.stringify(parsed.data);
      const controller = new AbortController();
      let timedOut = false;
      const interrupted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new EmailDeliveryError(
          timedOut ? 'EMAIL_PROVIDER_TIMEOUT' : 'EMAIL_PROVIDER_INTERRUPTED', true,
        )), { once: true });
      });
      const abort = () => controller.abort();
      const timer = setTimeout(() => { timedOut = true; abort(); }, 10_000);
      signal?.addEventListener('abort', abort, { once: true });
      const attempt = async (): Promise<{ id: string }> => {
        if (signal?.aborted) {
          abort();
          throw new EmailDeliveryError('EMAIL_PROVIDER_INTERRUPTED', true);
        }
        let response: Response;
        try {
          response = await fetcher('https://api.resend.com/emails', {
            method: 'POST', redirect: 'manual', signal: controller.signal,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
            body,
          });
        } catch {
          throw new EmailDeliveryError('EMAIL_PROVIDER_UNAVAILABLE', true);
        }
        if (!response.ok && response.status !== 409) {
          // Do not read or retain provider error messages or reflected content.
          await response.body?.cancel().catch(() => {});
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          throw new EmailDeliveryError('EMAIL_PROVIDER_REJECTED', retryable);
        }
        const result = await responseJson(response);
        if (response.status === 409) {
          const concurrent = result !== null && typeof result === 'object'
            && 'name' in result && result.name === 'concurrent_idempotent_requests';
          throw new EmailDeliveryError(concurrent ? 'EMAIL_PROVIDER_BUSY' : 'EMAIL_IDEMPOTENCY_CONFLICT', concurrent);
        }
        const success = successSchema.safeParse(result);
        if (!success.success) throw new EmailDeliveryError('EMAIL_PROVIDER_RESPONSE_INVALID', true);
        return success.data;
      };
      try {
        return await Promise.race([attempt(), interrupted]);
      } catch (error) {
        if (error instanceof EmailDeliveryError) throw error;
        throw new EmailDeliveryError('EMAIL_PROVIDER_UNAVAILABLE', true);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

// https://resend.com/docs/webhooks/verify-webhooks-requests
// https://resend.com/docs/webhooks/event-types
export function verifyResendEvent(
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): { eventId: string; messageId: string; type: string; createdAt: string; recipients: string[] } | null {
  try {
    if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > 256 * 1024 || !isUtf8(raw)) throw new Error();
    const signatureHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const normalized = name.toLowerCase();
      if (!['svix-id', 'svix-timestamp', 'svix-signature'].includes(normalized)) continue;
      if (typeof value !== 'string' || normalized in signatureHeaders) throw new Error();
      signatureHeaders[normalized] = value;
    }
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(signatureHeaders['svix-id'] ?? '')
      || !/^\d{1,13}$/.test(signatureHeaders['svix-timestamp'] ?? '')
      || !/^[\x20-\x7e]{1,2048}$/.test(signatureHeaders['svix-signature'] ?? '')) throw new Error();
    // Svix 2.3 verifies without parsing. Never reserialize before verifying.
    new Webhook(secret).verify(raw, signatureHeaders);
    const event = eventSchema.parse(JSON.parse(raw.toString('utf8')));
    if (event.type === 'email.opened' || event.type === 'email.clicked') return null;
    // Deliberately exclude raw payload, subject, sender, tags and provider reasons.
    return {
      eventId: signatureHeaders['svix-id'], messageId: event.data.email_id,
      type: event.type, createdAt: event.created_at, recipients: event.data.to,
    };
  } catch {
    throw new EmailDeliveryError('EMAIL_WEBHOOK_INVALID', false);
  }
}
