// SDP改ざん防止用のHMAC-SHA256 (共有シークレットはbase64url)。
// WebCryptoはHTTPS環境でのみ使えるため、開発用HTTP環境ではnullを返す。

function b64uDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hmacSDP(secretB64u: string, sdp: string): Promise<string | null> {
  if (!secretB64u || !globalThis.crypto?.subtle) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    b64uDecode(secretB64u) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sdp));
  return b64uEncode(new Uint8Array(mac));
}
