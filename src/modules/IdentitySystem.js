const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/i;
const DERIVED_IDENTITY_NAMESPACE = 'eef2dca0-5a96-4f30-8771-ad5cc474a731';

function secureCrypto() {
  const value = globalThis.crypto;
  if (!value) throw new Error('Secure UUID generation is unavailable in this environment.');
  return value;
}

function bytesToUuid(bytes) {
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidToBytes(value) {
  const normalized = normalizeUuid(value);
  if (!normalized) throw new Error(`Expected a UUID, received ${JSON.stringify(value)}.`);
  const hex = normalized.replaceAll('-', '');
  if (!UUID_HEX_PATTERN.test(hex)) throw new Error(`Expected a UUID, received ${JSON.stringify(value)}.`);
  return Uint8Array.from(hex.match(/.{2}/g).map((pair) => Number.parseInt(pair, 16)));
}

function utf8Bytes(value) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(String(value));
  const encoded = unescape(encodeURIComponent(String(value)));
  return Uint8Array.from(encoded, (character) => character.charCodeAt(0));
}

function rotateLeft(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

// Synchronous SHA-1 is used only to produce RFC-compatible UUID-v5 values for
// stable derived/runtime locators. Independent drawing records always use v4.
function sha1(input) {
  const byteLength = input.length;
  const paddedLength = Math.ceil((byteLength + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[byteLength] = 0x80;
  const bitLength = byteLength * 8;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index += 1) {
      let f;
      let k;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (rotateLeft(a, 5) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const result = new Uint8Array(20);
  const resultView = new DataView(result.buffer);
  [h0, h1, h2, h3, h4].forEach((value, index) => resultView.setUint32(index * 4, value, false));
  return result;
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function normalizeUuid(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return UUID_PATTERN.test(text) ? text : null;
}

export function assertUuid(value, context = 'ID') {
  const normalized = normalizeUuid(value);
  if (!normalized) throw new Error(`${context} must be a canonical UUID.`);
  return normalized;
}

export function createUuid() {
  const crypto = secureCrypto();
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().toLowerCase();
  if (typeof crypto.getRandomValues !== 'function') {
    throw new Error('Secure UUID generation is unavailable in this environment.');
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

export function deriveUuid(namespaceUuid, value) {
  const namespace = uuidToBytes(namespaceUuid);
  const name = utf8Bytes(value);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const bytes = sha1(input).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

// Derived identities are UUIDs too, but their stable semantic inputs remain
// separate from the UUID representation. Tuple encoding avoids delimiter
// collisions and lets migration/render helpers handle legacy source values.
export function deriveUuidForKey(...parts) {
  return deriveUuid(DERIVED_IDENTITY_NAMESPACE, JSON.stringify(parts));
}

export function createUuidAllocator(reservedUuids = [], {
  generator = createUuid,
  maxAttempts = 1024,
} = {}) {
  if (typeof generator !== 'function') throw new TypeError('UUID allocator generator must be a function.');
  const attemptLimit = Math.max(1, Number.parseInt(maxAttempts, 10) || 0);
  const reserved = new Set([...reservedUuids].map((value) => assertUuid(value, 'Reserved ID')));
  return {
    allocate() {
      for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
        const value = assertUuid(generator(), 'Generated ID');
        if (reserved.has(value)) continue;
        reserved.add(value);
        return value;
      }
      throw new Error(`Unable to allocate a unique UUID after ${attemptLimit} attempts.`);
    },
    has(value) {
      const normalized = normalizeUuid(value);
      return Boolean(normalized && reserved.has(normalized));
    },
    reserve(value) {
      const normalized = assertUuid(value);
      if (reserved.has(normalized)) return false;
      reserved.add(normalized);
      return true;
    },
    snapshot() {
      return new Set(reserved);
    },
  };
}
