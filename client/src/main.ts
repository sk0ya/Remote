import { loadPaired, savePaired, clearPaired, type Paired } from "./config";
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
      renderViewer(app, hostId, () => {
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

// ---- ペアリング画面 (実装は後続タスク: パスワード入力→トークン受領) ----
function renderPair(hostId: string, code: string): void {
  app.replaceChildren(
    el(`
    <div class="screen">
      <h1>ペアリング</h1>
      <p>PCに表示されているパスワードを入力してください</p>
      <input class="field" id="pw" type="password" autocomplete="off" placeholder="パスワード" />
      <button class="primary" id="do-pair">ペアリング</button>
      <div class="status" id="st"></div>
    </div>`)
  );
  const st = document.getElementById("st")!;
  document.getElementById("do-pair")!.addEventListener("click", () => {
    st.textContent = "ペアリング処理は未実装です(実装中)";
    void hostId;
    void code;
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
    renderViewer(app, paired.hostId, route);
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
