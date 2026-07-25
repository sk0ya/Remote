import { loadHostId, saveHostId, clearHostId, saveCredId } from "./config";
import { SignalChannel } from "./signal";
import { renderViewer } from "./viewer";
import { registerPasskey, recoverHostId, webauthnSupported } from "./webauthn";

const app = document.getElementById("app")!;

// ルーティング: QRから開くと #/pair?h=<hostId>&c=<code> が付く
function route(): void {
  const hash = location.hash;
  if (hash.startsWith("#/dev")) {
    // 開発用: #/dev?h=<hostId> でホストIDを流し込む(認証は通常どおりパスキー)
    const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
    const hostId = params.get("h");
    if (hostId) {
      saveHostId(hostId);
      location.hash = "";
      renderHome(hostId);
      return;
    }
  }
  if (hash.startsWith("#/pair")) {
    const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
    const hostId = params.get("h");
    const code = params.get("c");
    if (hostId && code) {
      renderPair(hostId, code);
      return;
    }
  }
  const hostId = loadHostId();
  if (hostId) {
    renderHome(hostId);
  } else {
    renderUnpaired();
  }
}

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

// ---- ペアリング画面 ----
// 別のタブ(たいていは接続画面)が同じ部屋に入り直すと、こちらのソケットが蹴られる。
const REPLACED_MSG =
  "接続が別のタブに奪われました。他のRemoteのタブを閉じ、PCでQRコードを再表示してやり直してください。";

const PAIR_ERRORS: Record<string, string> = {
  code: "コードが無効か期限切れです。PCで新しいQRコードを表示して読み直してください。",
  password: "パスワードが違います。",
  network: "PCと同じWi-Fi(ネットワーク)に接続してから再試行してください。",
  key: "パスキーの登録に失敗しました。もう一度お試しください。",
  unknown: "ペアリングに失敗しました。",
};

function renderPair(hostId: string, code: string): void {
  app.replaceChildren(
    el(`
    <div class="screen">
      <h1>ペアリング</h1>
      <p>PCに表示されているパスワードを入力してください</p>
      <input class="field" id="pw" type="text" inputmode="text" autocomplete="off"
             autocapitalize="characters" placeholder="パスワード" />
      <button class="primary" id="do-pair">ペアリング</button>
      <div class="status" id="st"></div>
    </div>`)
  );
  const st = document.getElementById("st")!;
  const btn = document.getElementById("do-pair") as HTMLButtonElement;

  if (!webauthnSupported()) {
    st.classList.add("error");
    st.textContent = "このブラウザはパスキーに対応していません。";
    btn.disabled = true;
    return;
  }

  let credId = ""; // 作成したパスキーの資格情報ID (登録完了まで保存しない)

  const fail = (text: string, ch: SignalChannel) => {
    st.classList.add("error");
    st.textContent = text;
    btn.disabled = false;
    ch.close();
  };

  btn.addEventListener("click", () => {
    const password = (document.getElementById("pw") as HTMLInputElement).value.trim().toUpperCase();
    if (!password) return;
    btn.disabled = true;
    st.classList.remove("error");
    st.textContent = "ペアリング中...";

    const ch = new SignalChannel(hostId, {
      onOpen: (_ip, peerPresent) => {
        if (!peerPresent) {
          fail("PCのアプリが起動していません。", ch);
        } else if (!ch.send({ t: "pair", code, password })) {
          fail(REPLACED_MSG, ch);
        }
      },
      onMessage: (msg) => {
        const m = msg as { t: string; reason?: string; reg?: string };
        if (m.t === "pair-ok") {
          // コード検証を通った。ここでパスキーを作り、公開鍵だけをホストへ渡す。
          // reg はホストが発行した合言葉で、そのまま返して登録要求の出所を示す。
          st.textContent = "パスキーを作成しています...";
          registerPasskey(hostId)
            .then((key) => {
              st.textContent = "登録中...";
              credId = key.credId;
              // パスキー作成中に部屋を奪われていることがある。
              // ここで黙って捨てると「登録中...」のまま固まるので必ず拾う。
              const sent = ch.send({
                t: "pair-key",
                reg: m.reg ?? "",
                credId: key.credId,
                pubKey: key.pubKey,
              });
              if (!sent) fail(REPLACED_MSG, ch);
            })
            .catch((e) => fail(`パスキーの作成に失敗しました: ${e}`, ch));
        } else if (m.t === "pair-done") {
          saveHostId(hostId);
          if (credId) saveCredId(credId);
          ch.close();
          location.hash = "";
          route();
        } else if (m.t === "pair-err") {
          fail(PAIR_ERRORS[m.reason ?? "unknown"] ?? PAIR_ERRORS.unknown, ch);
        }
      },
      onClose: (reason) => {
        st.classList.add("error");
        st.textContent = reason === "replaced" ? REPLACED_MSG : `接続エラー: ${reason}`;
        btn.disabled = false;
      },
    });
    ch.connect();
  });
}

// ---- ホーム画面 (ホストID判明済み) ----
function renderHome(hostId: string): void {
  app.replaceChildren(
    el(`
    <div class="screen">
      <h1>Remote</h1>
      <p>ホスト: ${hostId}</p>
      <button class="primary" id="connect">接続</button>
      <button class="ghost" id="forget">この端末から消す</button>
      <div class="status" id="st"></div>
    </div>`)
  );
  document.getElementById("forget")!.addEventListener("click", () => {
    // 消えるのは接続先の記憶だけ。パスキー自体はブラウザ/OSの設定から削除する。
    // ホスト側の登録を失効させたいときはPCで再ペアリングする。
    clearHostId();
    route();
  });
  document.getElementById("connect")!.addEventListener("click", () => {
    renderViewer(app, hostId, route);
  });
}

// ---- ホストID未取得 (初めて開いたブラウザ / 未ペアリング) ----
function renderUnpaired(): void {
  app.replaceChildren(
    el(`
    <div class="screen">
      <h1>Remote</h1>
      <p>ペアリング済みならパスキーで接続できます。まだならPCのQRコードを読み取ってください。</p>
      <button class="primary" id="passkey">パスキーで接続</button>
      <input class="field" id="dev-host" placeholder="開発用: ホストID直接入力" />
      <button class="ghost" id="dev-connect">開発用接続</button>
      <div class="status" id="st"></div>
    </div>`)
  );
  const st = document.getElementById("st")!;
  const passkeyBtn = document.getElementById("passkey") as HTMLButtonElement;

  if (!webauthnSupported()) {
    passkeyBtn.disabled = true;
    st.classList.add("error");
    st.textContent = "このブラウザはパスキーに対応していません。";
  }

  // パスキーのuserHandleに入れたホストIDを取り出す。
  // 別のブラウザで初めて開いたときはここから始まる。
  passkeyBtn.addEventListener("click", () => {
    passkeyBtn.disabled = true;
    st.classList.remove("error");
    st.textContent = "パスキーを確認しています...";
    recoverHostId()
      .then((found) => {
        if (!found) {
          st.classList.add("error");
          st.textContent = "この端末に使えるパスキーがありません。QRコードからペアリングしてください。";
          passkeyBtn.disabled = false;
          return;
        }
        saveHostId(found.hostId);
        saveCredId(found.credId);
        route();
      })
      .catch((e) => {
        st.classList.add("error");
        st.textContent = `パスキーの読み取りに失敗しました: ${e}`;
        passkeyBtn.disabled = false;
      });
  });

  document.getElementById("dev-connect")!.addEventListener("click", () => {
    const hostId = (document.getElementById("dev-host") as HTMLInputElement).value.trim();
    if (!hostId) return;
    saveHostId(hostId);
    route();
  });
}

window.addEventListener("hashchange", route);
route();
