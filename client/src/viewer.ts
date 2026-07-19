// ビューア画面: ホストへ接続要求を送り、offer/answer交換して映像を表示する。

import { SignalChannel } from "./signal";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

export function renderViewer(app: HTMLElement, hostId: string, onExit: () => void): void {
  app.innerHTML = `
    <div class="viewer">
      <video id="screen" autoplay playsinline muted></video>
      <div class="hud">
        <span id="vst" class="status">接続中...</span>
        <button class="ghost" id="exit">切断</button>
      </div>
    </div>`;
  const video = document.getElementById("screen") as HTMLVideoElement;
  const st = document.getElementById("vst")!;
  let pc: RTCPeerConnection | null = null;

  const cleanup = () => {
    pc?.close();
    pc = null;
    ch.close();
  };
  document.getElementById("exit")!.addEventListener("click", () => {
    cleanup();
    onExit();
  });

  const setStatus = (text: string, error = false) => {
    st.textContent = text;
    st.classList.toggle("error", error);
  };

  async function handleOffer(sdp: string): Promise<void> {
    pc?.close();
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.ontrack = (ev) => {
      video.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
    };
    pc.ondatachannel = (ev) => {
      // task4: 入力チャネル
      void ev;
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      switch (pc.connectionState) {
        case "connected":
          setStatus("");
          break;
        case "connecting":
          setStatus("P2P接続中...");
          break;
        case "failed":
          setStatus("P2P接続失敗 (NAT越え不可の可能性)", true);
          break;
        case "disconnected":
          setStatus("接続が不安定です...", true);
          break;
      }
    };
    await pc.setRemoteDescription({ type: "offer", sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIceComplete(pc);
    ch.send({ t: "answer", sdp: pc.localDescription!.sdp });
    setStatus("answer送信、P2P確立待ち...");
  }

  const ch = new SignalChannel(hostId, {
    onOpen: (_ip, peerPresent) => {
      if (peerPresent) {
        setStatus("ホストへ接続要求...");
        ch.send({ t: "connect" });
      } else {
        setStatus("ホストがオフラインです。待機中...", true);
      }
    },
    onPeerJoined: () => {
      setStatus("ホストへ接続要求...");
      ch.send({ t: "connect" });
    },
    onPeerLeft: () => setStatus("ホストが切断しました", true),
    onMessage: (msg) => {
      const m = msg as { t: string; sdp?: string; reason?: string };
      if (m.t === "offer" && m.sdp) {
        handleOffer(m.sdp).catch((e) => setStatus(`offer処理失敗: ${e}`, true));
      } else if (m.t === "error") {
        setStatus(`ホスト側エラー: ${m.reason}`, true);
      }
    },
    onClose: (reason) => setStatus(`シグナリング切断: ${reason}`, true),
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
