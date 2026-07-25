// ビューア画面: ホストへ接続要求を送り、offer/answer交換して映像を表示する。

import { SignalChannel } from "./signal";
import { InputController } from "./input";
import { VirtualKeyboard } from "./keyboard";
import { assertPasskey, b64uDecode } from "./webauthn";
import { loadCredId, saveCredId } from "./config";
import { VoiceInput, voiceSupported } from "./voice";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

export function renderViewer(app: HTMLElement, hostId: string, onExit: () => void): void {
  app.innerHTML = `
    <div class="viewer" id="vroot">
      <video id="screen" autoplay playsinline muted></video>
      <div class="surface" id="surface"></div>
      <div class="hud">
        <span id="vst" class="status">接続中...</span>
        <span class="hud-btns">
          <button class="ghost" id="disp-toggle" style="display:none"></button>
          <button class="ghost" id="kbd-toggle">⌨</button>
          <button class="ghost" id="exit">切断</button>
        </span>
      </div>
      <button class="mic" id="mic" style="display:none">🎤</button>
    </div>`;
  const video = document.getElementById("screen") as HTMLVideoElement;
  const surface = document.getElementById("surface")!;
  const vroot = document.getElementById("vroot")!;
  const st = document.getElementById("vst")!;
  const dispBtn = document.getElementById("disp-toggle") as HTMLButtonElement;
  const micBtn = document.getElementById("mic") as HTMLButtonElement;
  let pc: RTCPeerConnection | null = null;
  let keyboard: VirtualKeyboard | null = null;
  let voice: VoiceInput | null = null;
  let exited = false;
  let retryTimer = 0;
  let toastTimer = 0;
  let retries = 0; // 連続した自動再接続の回数 (接続成功でリセット)
  // ホストのディスプレイ数と表示中index (ホストからの "displays" 通知で更新)
  let dispCount = 1;
  let dispCur = 0;

  const updateDispBtn = () => {
    dispBtn.style.display = dispCount > 1 ? "" : "none";
    dispBtn.textContent = `🖥 ${dispCur + 1}/${dispCount}`;
  };

  const cleanup = () => {
    exited = true;
    clearTimeout(retryTimer);
    clearTimeout(toastTimer);
    voice?.dispose();
    voice = null;
    pc?.close();
    pc = null;
    ch.close();
  };
  document.getElementById("exit")!.addEventListener("click", () => {
    cleanup();
    onExit();
  });

  // 切断・失敗時は少し待って自動で接続し直す。
  // 接続のたびにパスキーの認証ダイアログが出るので自動リトライは回数を絞り、
  // それ以降はタップで明示的にやり直してもらう(ダイアログが延々と出るのを避ける)。
  const maxAutoRetries = 3;
  const scheduleRetry = (delayMs: number) => {
    if (exited) return;
    clearTimeout(retryTimer);
    if (retries >= maxAutoRetries) {
      setStatus("再接続できませんでした — タップして再試行", true);
      st.onclick = () => {
        st.onclick = null;
        retries = 0;
        requestConnect();
      };
      return;
    }
    retries++;
    retryTimer = window.setTimeout(() => {
      if (!exited) requestConnect();
    }, delayMs);
  };

  const setStatus = (text: string, error = false) => {
    clearTimeout(toastTimer);
    st.onclick = null;
    st.textContent = text;
    st.classList.toggle("error", error);
  };

  // 音声の処理結果など、一定時間で消える表示
  const toast = (text: string, error = false) => {
    setStatus(text, error);
    toastTimer = window.setTimeout(() => setStatus(""), 2500);
  };

  async function handleOffer(sdp: string, nonce: string): Promise<void> {
    pc?.close();
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.ontrack = (ev) => {
      video.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
    };
    pc.ondatachannel = (ev) => {
      if (ev.channel.label !== "input") return;
      const controller = new InputController(video, surface, ev.channel);
      keyboard = new VirtualKeyboard(vroot, (msg) => controller.send(msg));
      // onclick代入で再接続時の重複登録を防ぐ (addEventListenerだと2回目以降トグルが打ち消し合う)
      (document.getElementById("kbd-toggle") as HTMLButtonElement).onclick = () => keyboard?.toggle();
      // 音声入力 (対応ブラウザのみ。ボタンのハンドラはプロパティ代入なので再接続でも重複しない)
      if (voiceSupported()) {
        micBtn.style.display = "";
        voice?.dispose();
        voice = new VoiceInput(
          micBtn,
          (msg) => controller.send(msg),
          (buf) => controller.sendBinary(buf),
          () => controller.buffered,
          setStatus
        );
      }
      // ホスト→クライアント通知 (ディスプレイ情報・音声の処理結果)
      ev.channel.onmessage = (me) => {
        try {
          const m = JSON.parse(String(me.data)) as {
            t: string;
            n?: number;
            cur?: number;
            s?: string;
            cmd?: string;
            err?: string;
          };
          if (m.t === "displays") {
            dispCount = m.n ?? 1;
            dispCur = m.cur ?? 0;
            updateDispBtn();
          } else if (m.t === "voice") {
            // cmdが空 = コマンド未一致 → 発話がそのまま打ち込まれた
            if (m.err) toast(`🎤 ${m.err}`, true);
            else toast(m.cmd ? `⚡ ${m.cmd}` : `⌨ ${m.s ?? ""}`);
          }
        } catch {
          // JSON以外は無視
        }
      };
      // 切替ボタン: 次のディスプレイへ巡回 (onclick代入で再接続時の重複登録を防ぐ)
      dispBtn.onclick = () => {
        if (dispCount > 1) controller.send({ t: "disp", n: (dispCur + 1) % dispCount });
      };
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      switch (pc.connectionState) {
        case "connected":
          retries = 0;
          setStatus("");
          break;
        case "connecting":
          setStatus("P2P接続中...");
          break;
        case "failed":
          setStatus("P2P接続失敗 — 再接続します...", true);
          scheduleRetry(3000);
          break;
        case "disconnected":
          setStatus("接続が不安定です...", true);
          scheduleRetry(5000);
          break;
      }
    };
    await pc.setRemoteDescription({ type: "offer", sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIceComplete(pc);
    const answerSDP = pc.localDescription!.sdp;

    // ホストのnonceとoffer/answerを束ねたチャレンジにパスキーで署名する。
    // これがホスト側の認証そのものであり、同時にSDPの改ざん検出も兼ねる
    // (中継サーバーがどちらかを書き換えていれば、ホストでの再計算と一致しない)。
    setStatus("パスキーで認証中...");
    const assertion = await assertPasskey(b64uDecode(nonce), sdp, answerSDP, loadCredId());
    saveCredId(assertion.credId); // 次回から allowCredentials で名指しする
    ch.send({ t: "answer", sdp: answerSDP, ...assertion });
    setStatus("answer送信、P2P確立待ち...");
  }

  const requestConnect = () => {
    setStatus("ホストへ接続要求...");
    ch.send({ t: "connect" });
  };

  const ch = new SignalChannel(hostId, {
    onOpen: (_ip, peerPresent) => {
      if (peerPresent) {
        requestConnect();
      } else {
        setStatus("ホストがオフラインです。待機中...", true);
      }
    },
    onPeerJoined: requestConnect,
    onPeerLeft: () => setStatus("ホストが切断しました", true),
    onMessage: (msg) => {
      const m = msg as { t: string; sdp?: string; nonce?: string; reason?: string };
      if (m.t === "offer" && m.sdp && m.nonce) {
        // 認証ダイアログを閉じられた場合もここに来る。放っておくと復帰手段が
        // なくなるので、通常の失敗と同じ再接続の流れに乗せる。
        handleOffer(m.sdp, m.nonce).catch((e) => {
          setStatus(`接続に失敗しました: ${e}`, true);
          scheduleRetry(3000);
        });
      } else if (m.t === "error") {
        if (m.reason === "auth") {
          setStatus("認証に失敗しました。再ペアリングが必要です。", true);
        } else if (m.reason === "timeout") {
          setStatus("認証待ちの時間切れです — もう一度お試しください", true);
          scheduleRetry(1000);
        } else if (m.reason === "unpaired") {
          setStatus("PC側に端末が登録されていません。QRコードからペアリングしてください。", true);
        } else {
          setStatus(`ホスト側エラー: ${m.reason}`, true);
        }
      }
    },
    onClose: (reason) => {
      if (exited) return;
      setStatus(`シグナリング切断: ${reason} — 再接続します...`, true);
      window.setTimeout(() => {
        if (!exited) ch.connect();
      }, 3000);
    },
  });
  ch.connect();
}

function waitIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    // 保険: 5秒で打ち切り(集まった候補だけで送る)
    setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }, 5000);
  });
}
