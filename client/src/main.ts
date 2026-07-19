import { loadPaired, savePaired, clearPaired, type Paired } from "./config";
import { SignalChannel } from "./signal";

const app = document.getElementById("app")!;

// ルーティング: QRから開くと #/pair?h=<hostId>&c=<code> が付く
function route(): void {
  const hash = location.hash;
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
  const st = document.getElementById("st")!;
  document.getElementById("unpair")!.addEventListener("click", () => {
    clearPaired();
    route();
  });
  document.getElementById("connect")!.addEventListener("click", () => {
    connectTest(paired.hostId, st);
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

// ---- シグナリング疎通テスト (WebRTC実装までの仮動作) ----
function connectTest(hostId: string, st: HTMLElement): void {
  st.classList.remove("error");
  st.textContent = "シグナリング接続中...";
  const ch = new SignalChannel(hostId, {
    onOpen: (ip, peerPresent) => {
      st.textContent = `接続OK (自分のIP: ${ip}) ホスト${peerPresent ? "在室" : "不在"} → ping送信`;
      ch.send({ t: "ping" });
    },
    onMessage: (msg) => {
      st.textContent = `ホストから応答: ${JSON.stringify(msg)}`;
    },
    onPeerJoined: () => {
      st.textContent = "ホストが接続しました → ping送信";
      ch.send({ t: "ping" });
    },
    onClose: (reason) => {
      st.classList.add("error");
      st.textContent = `切断: ${reason}`;
    },
  });
  ch.connect();
}

window.addEventListener("hashchange", route);
route();
