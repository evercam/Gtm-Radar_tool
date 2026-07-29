'use server';

import { revalidatePath } from 'next/cache';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { checkPermission } from '@/lib/auth/session';
import { encryptSecret, activeKeyId, isCryptoConfigured } from '@/lib/crypto/secrets';

export interface SaveCredentialResult {
  ok: boolean;
  message: string;
}

/**
 * Server Action used as the `action` for each source's credential form
 * (via `useActionState`). The api_key never needs to travel through
 * client-side state — the browser posts the form fields directly to this
 * server function, and `source_key` travels as a hidden form field rather
 * than a bound closure argument so every row can share the same action.
 *
 * The API key input is left blank when a key is already saved (we only ever
 * show a masked hint, never the real value) — leaving it blank on submit
 * means "don't change the key", so it is only included in the upsert payload
 * when non-empty. Supabase upsert only overwrites the columns present in the
 * payload, so omitting api_key preserves whatever was saved previously.
 */
export async function saveSourceCredential(
  _prevState: SaveCredentialResult | null,
  formData: FormData
): Promise<SaveCredentialResult> {
  // A Server Action is a public endpoint — anyone who can guess its id can
  // invoke it. The permission check belongs here, not only on the page that
  // renders the form.
  const auth = await checkPermission('credentials.manage');
  if (!auth.ok) return { ok: false, message: auth.message };

  if (!isSupabaseServiceConfigured()) {
    return { ok: false, message: 'Supabase service role is not configured — cannot save credentials.' };
  }

  const sourceKey = String(formData.get('sourceKey') ?? '').trim();
  if (!sourceKey) {
    return { ok: false, message: 'Missing source key.' };
  }

  const apiKeyInput = String(formData.get('apiKey') ?? '').trim();
  const baseUrlInput = String(formData.get('baseUrl') ?? '').trim();
  const usernameInput = String(formData.get('username') ?? '').trim();
  const passwordInput = String(formData.get('password') ?? '').trim();

  if (!isCryptoConfigured()) {
    return { ok: false, message: 'No encryption key available — refusing to store a credential in plaintext.' };
  }

  // Secrets are encrypted before they touch the database (AES-256-GCM). The
  // last-4 hint is stored alongside so Settings can show which key is saved
  // without decrypting anything.
  const payload: Record<string, unknown> = { source_key: sourceKey, updated_at: new Date().toISOString() };
  if (apiKeyInput) {
    payload.api_key = encryptSecret(apiKeyInput);
    payload.api_key_last4 = apiKeyInput.slice(-4);
    payload.key_version = activeKeyId();
  }
  if (passwordInput) {
    payload.api_secret = encryptSecret(passwordInput);
    payload.api_secret_last4 = passwordInput.slice(-4);
    payload.key_version = activeKeyId();
  }
  payload.base_url = baseUrlInput || null;
  // Barbour ABI's username isn't a secret, so unlike apiKey/password it's fine to
  // overwrite with an empty value (clearing it) rather than "blank = don't change".
  if (formData.has('username')) payload.username = usernameInput || null;

  const supabase = getServiceSupabase();
  const { error } = await supabase.from('source_credentials').upsert(payload, { onConflict: 'source_key' });

  if (error) {
    return { ok: false, message: `Failed to save: ${error.message}` };
  }

  revalidatePath('/settings');
  return { ok: true, message: 'Saved.' };
}
