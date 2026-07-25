// パスキー(WebAuthn)による端末認証。
//
// ペアリング時に鍵ペアを作り、公開鍵だけをホストへ渡す。以降の接続では
// ホストが出したnonceとSDPから作ったチャレンジに署名して本人性を示す。
// 秘密鍵は端末の資格情報ストアの中にあり、このコードからは触れない。
// 同期対象の端末・ブラウザなら同じパスキーが見えるので、ブラウザを変えても繋がる。

const RP_NAME = "Remote";
const CHALLENGE_DOMAIN = "remote-auth-v1";

export interface RegisteredKey {
  credId: string; // base64url
  pubKey: string; // SPKI DER (base64url)
}

export interface Assertion {
  credId: string;
  clientData: string;
  authData: string;
  sig: string;
}

export function webauthnSupported(): boolean {
  return !!(
    globalThis.PublicKeyCredential &&
    globalThis.crypto?.subtle &&
    navigator.credentials?.create
  );
}

function b64u(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

// Uint8Array をそのまま渡すと ArrayBufferLike 由来の型不一致になるため、
// WebAuthnへ渡す値はここでArrayBufferに揃える。
function toBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function randomChallenge(): ArrayBuffer {
  return toBuffer(crypto.getRandomValues(new Uint8Array(32)));
}

// challenge はホスト側の pair.Challenge と同じ値を作る。
// 各要素を8バイトのビッグエンディアン長で前置きして連結し、SHA-256にかける。
// offer/answer 両方を混ぜているので、中継サーバーがどちらかを書き換えると
// ホスト側の再計算と食い違って接続が拒否される。
async function challenge(
  nonce: Uint8Array,
  offerSDP: string,
  answerSDP: string
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts = [enc.encode(CHALLENGE_DOMAIN), nonce, enc.encode(offerSDP), enc.encode(answerSDP)];
  const total = parts.reduce((n, p) => n + 8 + p.length, 0);
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let off = 0;
  for (const p of parts) {
    view.setBigUint64(off, BigInt(p.length));
    off += 8;
    buf.set(p, off);
    off += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

// registerPasskey はペアリング時にパスキーを作る。
// hostId を userHandle (user.id) に入れておくことで、localStorageが空の
// 別ブラウザからでも recoverHostId() で接続先を取り戻せる。
export async function registerPasskey(hostId: string): Promise<RegisteredKey> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      // 登録時のチャレンジはホストで検証しない。ここへ来られるのは
      // ワンタイムコード+パスワード+同一ネットワークを通った相手だけのため。
      challenge: randomChallenge(),
      rp: { name: RP_NAME }, // idは省略 = 現在のドメイン
      user: {
        id: toBuffer(new TextEncoder().encode(hostId)),
        name: `Remote (${hostId.slice(0, 8)})`,
        displayName: "Remote Desktop",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256のみ
      authenticatorSelection: {
        residentKey: "required", // discoverableでないとuserHandleが返らない
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("パスキーが作成されませんでした");

  const res = cred.response as AuthenticatorAttestationResponse;
  if (typeof res.getPublicKey !== "function") {
    throw new Error("このブラウザはパスキーの公開鍵取得に対応していません");
  }
  if (res.getPublicKeyAlgorithm() !== -7) {
    throw new Error("ES256以外の鍵が作られました");
  }
  const spki = res.getPublicKey();
  if (!spki) throw new Error("公開鍵を取り出せませんでした");
  return { credId: b64u(cred.rawId), pubKey: b64u(spki) };
}

// assertPasskey は接続時の署名を作る。生体認証/PINのダイアログが出る。
export async function assertPasskey(
  nonce: Uint8Array,
  offerSDP: string,
  answerSDP: string,
  credId: string | null
): Promise<Assertion> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: toBuffer(await challenge(nonce, offerSDP, answerSDP)),
      // 使うパスキーが分かっていれば指定する。分からなければ選択式
      // (この端末に "Remote" のパスキーが複数あると取り違えが起きうる)。
      allowCredentials: credId
        ? [{ type: "public-key", id: toBuffer(b64uDecode(credId)) }]
        : [],
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("認証がキャンセルされました");

  const res = cred.response as AuthenticatorAssertionResponse;
  return {
    credId: b64u(cred.rawId),
    clientData: b64u(res.clientDataJSON),
    authData: b64u(res.authenticatorData),
    sig: b64u(res.signature),
  };
}

// recoverHostId はパスキーのuserHandleから接続先ホストIDを取り出す。
// 資格情報IDも一緒に返し、以降はそれを名指しできるようにする。
// 別ブラウザで初めて開いたときに使う(ここでも生体認証が1回入る)。
export async function recoverHostId(): Promise<{ hostId: string; credId: string } | null> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge(),
      allowCredentials: [],
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) return null;
  const handle = (cred.response as AuthenticatorAssertionResponse).userHandle;
  if (!handle) return null;
  const hostId = new TextDecoder().decode(handle).trim();
  return hostId ? { hostId, credId: b64u(cred.rawId) } : null;
}
