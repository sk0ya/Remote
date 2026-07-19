// ペアリングで得た接続情報の永続化 (localStorage)

export interface Paired {
  hostId: string;
  token: string; // 端末トークン(ホストが検証)
  secret: string; // SDP HMAC用の共有シークレット (base64)
}

const KEY = "remote.paired";

// シグナリングサーバーのURL。
// 本番は VITE_SIGNAL_URL(Cloudflare WorkerのURL)、開発時は同一ホストの8787へ。
export const SIGNAL_URL: string =
  (import.meta.env.VITE_SIGNAL_URL as string | undefined) ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787/ws`;

export function loadPaired(): Paired | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Paired;
    if (!p.hostId || !p.token) return null;
    return p;
  } catch {
    return null;
  }
}

export function savePaired(p: Paired): void {
  localStorage.setItem(KEY, JSON.stringify(p));
}

export function clearPaired(): void {
  localStorage.removeItem(KEY);
}
