// 接続先ホストIDの保持。
//
// ここに秘密情報は置かない。認証はパスキー(WebAuthn)で行い、鍵は端末の
// 資格情報ストア(iCloudキーチェーン / Googleパスワードマネージャー等)にあって
// JavaScriptからは取り出せない。localStorageに残すのはホストIDだけで、
// これは中継サーバーの部屋名にあたる公開値。消えてもパスキーから復元できる。

const KEY = "remote.hostId";
const CRED_KEY = "remote.credId";
const PCIME_KEY = "remote.pcIme";

// シグナリングサーバーのURL。
// 本番は VITE_SIGNAL_URL(Cloudflare WorkerのURL)、開発時は同一ホストの8787へ。
// 読み込み時ではなく接続時に解決する(モジュールの副作用でlocationを触らない)。
export function signalUrl(): string {
  return (
    (import.meta.env.VITE_SIGNAL_URL as string | undefined) ??
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787/ws`
  );
}

export function loadHostId(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function saveHostId(hostId: string): void {
  try {
    localStorage.setItem(KEY, hostId);
  } catch {
    // プライベートモード等で書けなくても、パスキーから毎回復元すれば動く
  }
}

export function clearHostId(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(CRED_KEY);
  } catch {
    /* 失敗しても実害はない */
  }
}

// 使うパスキーの資格情報ID。これも秘密ではない。
// 覚えておくと allowCredentials で指定でき、"Remote" のパスキーが複数ある
// (ホストの設定を作り直した等) 場合に、別のものを選んで認証失敗するのを防げる。
export function loadCredId(): string | null {
  try {
    return localStorage.getItem(CRED_KEY) || null;
  } catch {
    return null;
  }
}

export function saveCredId(credId: string): void {
  try {
    localStorage.setItem(CRED_KEY, credId);
  } catch {
    /* 指定できないだけで、選択式にフォールバックする */
  }
}

// キーボードの変換モード。true ならPC側のIMEで変換する(打鍵をそのまま送る)。
// 接続のたびにキーボードを作り直すので、覚えておかないと毎回切り替えることになる。
export function loadPcIme(): boolean {
  try {
    return localStorage.getItem(PCIME_KEY) === "1";
  } catch {
    return false;
  }
}

export function savePcIme(on: boolean): void {
  try {
    localStorage.setItem(PCIME_KEY, on ? "1" : "0");
  } catch {
    /* 覚えられないだけで、その場の切り替えは効く */
  }
}
