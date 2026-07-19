import { loadPaired, savePaired, clearPaired, type Paired } from "./config";
import { SignalChannel } from "./signal";
import { renderViewer } from "./viewer";

const app = document.getElementById("app")!;

// ルーティング: QRから開くと #/pair?h=<hostId>&c=<code> が付く
function route(): void {
  const hash = location.hash;
  if (hash.startsWith("#/dev")) {
    // 開発用: #/dev?h=<hostId> で即ビューアを開く(認証実装前の動作確認用)
    const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
    const hostId = params.get("h");
    if (hostId) {
      renderViewer(app, { hostId, token: params.get("token") ?? "dev", secret: "" }, () => {
        location.hash = "";
      });
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
  const paired = loadPaired();
  if (paired) {
    renderHome(paired);
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
const PAIR_ERRORS: Record<string, string> = {
  code: "コードが無効か期限切れです。PCで新しいQRコードを表示して読み直してください。",
  password: "パスワードが違います。",
  network: "PCと同じWi-Fi(ネットワーク)に接続してから再試行してください。",
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
  btn.addEventListener("click", () => {
    const password = (document.getElementById("pw") as HTMLInputElement).value.trim().toUpperCase();
    if (!password) return;
    btn.disabled = true;
    st.classList.remove("error");
    st.textContent = "ペアリング中...";

    const ch = new SignalChannel(hostId, {
      onOpen: (_ip, peerPresent) => {
        if (peerPresent) {
          ch.send({ t: "pair", code, password });
        } else {
          st.classList.add("error");
          st.textContent = "PCのアプリが起動していません。";
          btn.disabled = false;
          ch.close();
        }
      },
      onMessage: (msg) => {
        const m = msg as { t: string; token?: string; secret?: string; reason?: string };
        if (m.t === "pair-ok" && m.token) {
          savePaired({ hostId, token: m.token, secret: m.secret ?? "" });
          ch.close();
          location.hash = "";
          route();
        } else if (m.t === "pair-err") {
          st.classList.add("error");
          st.textContent = PAIR_ERRORS[m.reason ?? "unknown"] ?? PAIR_ERRORS.unknown;
          btn.disabled = false;
          ch.close();
        }
      },
      onClose: (reason) => {
        st.classList.add("error");
        st.textContent = `接続エラー: ${reason}`;
        btn.disabled = false;
      },
    });
    ch.connect();
  });
}

// ---- ホーム画面 (ペアリング済み) ----
function renderHome(paired: Paired): void {
  app.replaceChildren(
    el(`
    <div class="screen">
      <h1>Remote</h1>
      <p>ホスト: ${paired.hostId}</p>
      <button class="primary" id="connect">接続</button>
      <button class="ghost" id="unpair">ペアリング解除</button>
      <div class="status" id="st"></div>
    </div>`)
  );
  document.getElementById("unpair")!.addEventListener("click", () => {
    clearPaired();
    route();
  });
  document.getElementById("connect")!.addEventListener("click", () => {
    renderViewer(app, paired, route);
  });
}

// ---- 未ペアリング画面 (開発用に手動ホストID入力も可能) ----
function renderUnpaired(): void {
  app.replaceChildren(
    el(`
    <div class="screen">
      <h1>Remote</h1>
      <p>PCのQRコードを読み取ってペアリングしてください</p>
      <input class="field" id="dev-host" placeholder="開発用: ホストID直接入力" />
      <button class="ghost" id="dev-connect">開発用接続</button>
      <div class="status" id="st"></div>
    </div>`)
  );
  const st = document.getElementById("st")!;
  document.getElementById("dev-connect")!.addEventListener("click", () => {
    const hostId = (document.getElementById("dev-host") as HTMLInputElement).value.trim();
    if (!hostId) return;
    savePaired({ hostId, token: "dev", secret: "" });
    route();
    void st;
  });
}

window.addEventListener("hashchange", route);
route();
