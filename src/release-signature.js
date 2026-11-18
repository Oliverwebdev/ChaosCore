// Signierte Releases.
//
// Jedes Release enthält SHA256SUMS.txt (Prüfsummen aller Dateien) und daneben SHA256SUMS.txt.sig:
// eine Ed25519-Signatur über genau diese Prüfsummen-Datei. Unterschrieben wird mit dem privaten
// Schlüssel des Entwicklers, der nur auf seinem eigenen PC liegt (nicht bei GitHub). Die öffentlichen
// Schlüssel stehen in product.json ("releaseKeys") und damit in jeder Installation.
//
// Der Updater installiert nur, wenn die Signatur zu einem dieser Schlüssel passt. Wer nur Zugriff auf
// das GitHub-Repo hat, kann so keine fremde Version an bestehende Installationen verteilen.
// Mehrere Schlüssel sind erlaubt, damit man später auf einen neuen Schlüssel wechseln kann.
import crypto from 'node:crypto';

export const SIG_HEADER = 'chaoscore-signature-v1';

// Öffentlicher Schlüssel als Base64 (SPKI/DER) -> KeyObject, oder null wenn ungültig/kein Ed25519.
export function parsePublicKey(b64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(b64).trim(), 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch { return null; }
}

const toPublic = (key) => (key?.type === 'public' ? key : crypto.createPublicKey(key));

export const publicKeyBase64 = (key) => toPublic(key).export({ format: 'der', type: 'spki' }).toString('base64');

// Kurze Kennung eines Schlüssels (zum Vergleichen, z. B. in SECURITY.md).
export const keyId = (key) => crypto.createHash('sha256')
  .update(toPublic(key).export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 16);

export function signSums(sumsBytes, privateKey) {
  const sig = crypto.sign(null, Buffer.from(sumsBytes), privateKey);
  return `${SIG_HEADER}\nkey: ${keyId(privateKey)}\nsig: ${sig.toString('base64')}\n`;
}

export function parseSignature(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== SIG_HEADER) return null;
  const get = (k) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2) || '';
  const sig = get('sig');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(sig)) return null; // Ed25519-Signaturen sind 64 Byte
  return { keyId: get('key'), sig: Buffer.from(sig, 'base64') };
}

// true, wenn die Signatur zu einem der erlaubten Schlüssel passt.
export function verifySums(sumsBytes, sigText, publicKeys) {
  const parsed = parseSignature(sigText);
  if (!parsed) return { ok: false, reason: 'format' };
  for (const k of publicKeys) {
    if (crypto.verify(null, Buffer.from(sumsBytes), k, parsed.sig)) return { ok: true, keyId: keyId(k) };
  }
  return { ok: false, reason: 'mismatch' };
}
