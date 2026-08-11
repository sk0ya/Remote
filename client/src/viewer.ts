// ビューア画面: ホストへ接続要求を送り、offer/answer交換して映像を表示する。

import { SignalChannel } from "./signal";
import { InputController } from "./input";
import { VirtualKeyboard } from "./keyboard";
import { MousePad } from "./mouse";
import { assertPasskey, ticketMAC, b64uDecode } from "./webauthn";
import { loadCredId, saveCredId } from "./config";
import { VoiceInput, voiceSupported } from "./voice";
import { TextInput } from "./text";
import { currentViewport } from "./viewport";
import { attachScreenLayout } from "./screen";
import { PROTOCOL_VERSION } from "./protocol";
import { IceCandidateRelay } from "./ice";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

// レイアウトの検証(test/layout.mjs)からも同じものを組み立てるので外に出す。
export const VIEWER_HTML = `
    <div class="viewer" id="vroot">
      <video id="screen" autoplay playsinline muted></video>
      <div class="surface" id="surface"></div>
      <button class="playgate" id="playgate" hidden>▶ タップして再生</button>
      <div class="hud">
        <span id="vst" class="status">接続中...</span>
        <span class="hud-btns">
          <button class="ghost" id="disp-toggle" style="display:none"></button>
          <button class="ghost icon" id="mouse-toggle" title="マウス操作パネル">🖱</button>
          <button class="ghost" id="kbd-toggle" title="Webアプリのキーボード">Web⌨</button>
          <button class="ghost text-input-toggle" id="text-toggle" style="display:none" title="スマホOSのキーボード">OS⌨</button>
          <button class="ghost" id="exit">切断</button>
        </span>
      </div>
      <button class="mic" id="mic" style="display:none">🎤</button>
      <form class="text-entry" id="text-entry" hidden autocomplete="off">
        <input id="text-field" type="text" inputmode="text" enterkeyhint="send"
               autocapitalize="sentences" autocomplete="off" placeholder="PCへ入力" />
        <button class="text-send" type="submit">送信</button>
        <button class="text-close" id="text-close" type="button" aria-label="閉じる">×</button>
      </form>
    </div>`;

export function renderViewer(app: HTMLElement, hostId: string, onExit: () => void): void {
  app.innerHTML = VIEWER_HTML;
  const video = document.getElementById("screen") as HTMLVideoElement;
  const surface = document.getElementById("surface")!;
  const vroot = document.getElementById("vroot")!;
  const st = document.getElementById("vst")!;
  const dispBtn = document.getElementById("disp-toggle") as HTMLButtonElement;
  const micBtn = document.getElementById("mic") as HTMLButtonElement;
  const mouseToggle = document.getElementById("mouse-toggle") as HTMLButtonElement;
  const textToggle = document.getElementById("text-toggle") as HTMLButtonElement;
  const textEntry = document.getElementById("text-entry") as HTMLFormElement;
  const textField = document.getElementById("text-field") as HTMLInputElement;
  const textClose = document.getElementById("text-close") as HTMLButtonElement;
  const gate = document.getElementById("playgate") as HTMLButtonElement;
  let pc: RTCPeerConnection | null = null;
  let keyboard: VirtualKeyboard | null = null;
  let mouse: MousePad | null = null;
  let voice: VoiceInput | null = null;
  let text: TextInput | null = null;
  let controller: InputController | null = null;
  let exited = false;
  // スマホがバックグラウンドに回っている / 画面が消えている。
  // このあいだに動くものはすべて誰にも見えないまま電池を減らすだけなので、
  // 映像もkeepaliveも再接続も止める。
  let hidden = false;
  let viewTimer = 0;
  let retryTimer = 0;
  let toastTimer = 0;
  let retries = 0; // 連続した自動再接続の回数 (接続成功でリセット)
  // ホストに拒否された等、繰り返しても結果が変わらない状態。
  // 部屋は role ごとに1本しか持てず、入り直すたびに他のタブを蹴り出してしまうため、
  // 見込みのない再接続を続けるとペアリング中のタブを妨害することになる。
  let halted = false;
  // 接続要求が進行中かどうか。onOpen / onPeerJoined / リトライがそれぞれ独立に
  // 撃つと、1回の切断で認証ダイアログが何枚も開いてしまうため1本に絞る。
  let connecting = false;
  let connectTimer = 0;
  // シグナリング(WebSocket)自体の再接続。接続成功でリセットする。
  let signalRetries = 0;
  let signalTimer = 0;
  // ホストから受け取る再接続チケット。これがあるあいだは生体認証を省ける。
  // メモリだけに置き、localStorageには書かない(タブを閉じれば消える)。
  let ticket: string | null = null;
  // 今のP2P経路が確立した後にだけ実行する認証処理。
  let authenticateCurrent: (() => Promise<void>) | null = null;
  let authenticating = false;
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
    clearTimeout(connectTimer);
    clearTimeout(signalTimer);
    clearTimeout(toastTimer);
    clearTimeout(viewTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", onResize);
    screen.dispose();
    voice?.dispose();
    voice = null;
    text?.dispose();
    text = null;
    mouse?.dispose();
    mouse = null;
    controller?.dispose();
    controller = null;
    pc?.close();
    pc = null;
    ch.close();
  };
  document.getElementById("exit")!.addEventListener("click", () => {
    cleanup();
    onExit();
  });

  // ホストへ「実際に表示できる大きさ」を伝える。ホストはこれを上限に縮小して
  // から送るので、スマホは表示に必要なぶんだけデコードすれば済む。
  const sendViewport = () => {
    const { w, h } = currentViewport();
    if (w > 0) controller?.send({ t: "view", w, h });
  };

  // ソフトキーボードで見えている範囲へビューアを収める配線 (screen.ts)。
  // はみ出した映像は2本指で動かして覗ける (input.ts の refit)。
  const screen = attachScreenLayout(vroot, (occluded) => controller?.relayout(occluded));
  // 特殊キーバーの高さぶん、映像の表示領域を上に詰める。
  // バーは折り返しで高さが変わるので、実測した値を渡してもらう。
  const onKbdLayout = (height: number) => screen.setWebKeyboardHeight(height);

  // 画面の回転やアドレスバーの伸縮で何度も飛んでくるのでまとめる
  // (送出解像度が変わらない申告ならホスト側でも無視される)。
  const onResize = () => {
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(sendViewport, 300);
    screen.apply();
  };

  // バックグラウンドに回った / 画面が消えた。ホストにキャプチャを止めさせ、
  // keepaliveも止める。復帰したら送り直して繋ぎ直す。
  function onVisibility(): void {
    if (exited) return;
    const nowHidden = document.hidden;
    if (nowHidden === hidden) return;
    hidden = nowHidden;
    ch.setActive(!hidden);

    if (hidden) {
      controller?.send({ t: "vis", on: false });
      // 見えないところで再接続を試しても、認証ダイアログが溜まるだけ
      clearTimeout(retryTimer);
      clearTimeout(signalTimer);
      return;
    }

    controller?.send({ t: "vis", on: true });
    sendViewport();
    // 隠れているあいだに切れていたら、ここで繋ぎ直す
    if (!ch.open) {
      signalRetries = 0;
      ch.connect();
    } else if (pc?.connectionState !== "connected") {
      requestConnect();
    }
  }

  // 切断・失敗時は少し待って自動で接続し直す。
  // 接続のたびにパスキーの認証ダイアログが出るので自動リトライは回数を絞り、
  // それ以降はタップで明示的にやり直してもらう(ダイアログが延々と出るのを避ける)。
  const maxAutoRetries = 3;
  const scheduleRetry = (delayMs: number) => {
    // 見えていないあいだの再接続は、誰も見ない映像のために電池を使うだけ。
    // 復帰時に onVisibility が繋ぎ直す。
    if (exited || halted || hidden) return;
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

  // 自動再生が止められたときだけ出す再生ボタン。ステータス表示と違って
  // 接続の進行では消えないので、押すまで復帰の手段が残る。
  const playgate = {
    show(): void {
      gate.hidden = false;
      setStatus("映像の再生が端末に止められました", true);
    },
    hide(): void {
      gate.hidden = true;
    },
  };
  gate.onclick = () => {
    void video
      .play()
      .then(() => {
        playgate.hide();
        setStatus("");
      })
      .catch((e) => setStatus(`映像を再生できません: ${e}`, true));
  };

  // 音声の処理結果など、一定時間で消える表示
  const toast = (text: string, error = false) => {
    setStatus(text, error);
    toastTimer = window.setTimeout(() => setStatus(""), 2500);
  };

  async function handleOffer(sdp: string, nonce: string, version: number): Promise<void> {
    if (version !== PROTOCOL_VERSION) {
      halt(`PC側とのバージョンが一致しません (PC: v${version || "?"} / この端末: v${PROTOCOL_VERSION})。`);
      return;
    }
    pc?.close();
    authenticateCurrent = null;
    authenticating = false;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    // answer送信前に集まった候補はいったん保持し、answer適用後は逐次送る。
    // 固定時間でICE収集を打ち切ると、モバイル回線でSTUNが遅い場合に
    // candidate 0件のanswerを送って接続不能になる。
    const candidateRelay = new IceCandidateRelay((candidate) => {
      ch.send({ t: "candidate", v: PROTOCOL_VERSION, candidate });
    });
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      candidateRelay.add(ev.candidate.toJSON());
    };
    pc.ontrack = (ev) => {
      video.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
      // 端末が自動再生を止めることがある。復帰の手段はステータス表示には
      // 載せない — ステータスは接続の進行で何度も書き換わるので、そのたびに
      // タップ先ごと消えて、映像が止まったまま戻せなくなる。
      void video
        .play()
        .then(() => playgate.hide())
        .catch(() => playgate.show());
    };
    pc.ondatachannel = (ev) => {
      if (ev.channel.label !== "input") return;
      controller?.dispose(); // 再接続時に古い購読を残さない
      controller = new InputController(video, surface, ev.channel);
      const ctl = controller;
      keyboard?.dispose(); // 再接続で古いキーボードのDOMを残さない
      keyboard = new VirtualKeyboard(vroot, (msg) => ctl.send(msg), onKbdLayout, voiceSupported());
      mouse?.dispose();
      mouse = new MousePad(
        vroot,
        (msg) => ctl.send(msg),
        (height) => screen.setMousePadHeight(height),
        // 出ているあいだ、映像へのタッチはカーソルを置くだけにする。
        // 押すのはパネルのボタンなので、タップでクリックまで起きると
        // 狙った場所にカーソルを置けない。
        (open) => {
          ctl.setCursorOnly(open);
          mouseToggle.classList.toggle("active", open);
          if (open) toast("タップで移動 / なぞって微調整 → ボタンで押す");
        }
      );
      text?.dispose();
      text = new TextInput(
        textToggle,
        textEntry,
        textField,
        textClose,
        (msg) => ctl.send(msg),
        () => {
          keyboard?.close();
          mouse?.close();
        },
        (height) => screen.setTextInputHeight(height)
      );
      textToggle.style.display = "";
      screen.apply(); // 新しいcontrollerに今の表示領域を教える
      // 開いた時点で、表示できる大きさを伝えてそこまで落として送ってもらう。
      // ondatachannel の時点ですでに開いていることもある。
      const onReady = () => {
        sendViewport();
        if (hidden) ctl.send({ t: "vis", on: false });
      };
      if (ev.channel.readyState === "open") onReady();
      else ev.channel.onopen = onReady;
      // 下端のパネルは一度に1つだけ出す。2つ並べると映像に残る高さが無くなる。
      // onclick代入で再接続時の重複登録を防ぐ (addEventListenerだと2回目以降トグルが打ち消し合う)
      (document.getElementById("kbd-toggle") as HTMLButtonElement).onclick = () => {
        text?.close();
        mouse?.close();
        keyboard?.toggle();
      };
      mouseToggle.onclick = () => {
        text?.close();
        keyboard?.close();
        mouse?.toggle();
      };
      // 音声入力 (対応ブラウザのみ。ボタンのハンドラはプロパティ代入なので再接続でも重複しない)
      // 映像の上に浮かぶ🎤と、キーボードの🎤キーの両方から同じ録音を動かす。
      // キーボードを出すと前者は引っ込むので、出していても喋れるようにする。
      if (voiceSupported()) {
        micBtn.style.display = "";
        voice?.dispose();
        const kbdMic = keyboard.micButton();
        voice = new VoiceInput(
          kbdMic ? [micBtn, kbdMic] : [micBtn],
          (msg) => ctl.send(msg),
          (buf) => ctl.sendBinary(buf),
          () => ctl.buffered,
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
            v?: string;
          };
          if (m.t === "ticket") {
            // 中継サーバーを通らないこの経路でしか渡されない
            ticket = m.v ?? null;
          } else if (m.t === "displays") {
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
        if (dispCount > 1) ctl.send({ t: "disp", n: (dispCur + 1) % dispCount });
      };
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      switch (pc.connectionState) {
        case "connected":
          setStatus("P2P接続確認済み — 認証します...");
          beginAuthentication();
          break;
        case "connecting":
          setStatus("P2P接続中...");
          break;
        case "failed":
          endAttempt();
          setStatus("P2P接続失敗 — 再接続します...", true);
          scheduleRetry(3000);
          break;
        case "disconnected":
          endAttempt();
          setStatus("接続が不安定です...", true);
          scheduleRetry(5000);
          break;
      }
    };
    await pc.setRemoteDescription({ type: "offer", sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    const answerSDP = pc.localDescription!.sdp;

    // まずanswerだけを渡してP2P経路を確認する。ホストはこの段階では映像を送らず、
    // DataChannelの入力も捨てる。connectionState=connected になってから下の認証を行う。
    authenticateCurrent = async () => {
      let auth: Record<string, string>;
      if (ticket) {
        setStatus("再接続を認証中...");
        auth = { mac: await ticketMAC(ticket, b64uDecode(nonce), sdp, answerSDP) };
      } else {
        setStatus("パスキーで認証中...");
        const assertion = await assertPasskey(b64uDecode(nonce), sdp, answerSDP, loadCredId());
        saveCredId(assertion.credId);
        auth = { ...assertion };
      }
      if (!ch.send({ t: "auth", v: PROTOCOL_VERSION, ...auth })) {
        throw new Error("接続が別のタブに奪われました");
      }
      setStatus("認証確認待ち...");
    };
    if (!ch.send({ t: "answer", v: PROTOCOL_VERSION, sdp: answerSDP })) {
      throw new Error("接続が別のタブに奪われました");
    }
    candidateRelay.markAnswerSent();
    setStatus("P2P経路を確認中...");
  }

  const beginAuthentication = () => {
    if (authenticating || !authenticateCurrent) return;
    authenticating = true;
    authenticateCurrent().catch((e) => {
      pc?.close();
      endAttempt();
      setStatus(`接続に失敗しました: ${e}`, true);
      scheduleRetry(3000);
    });
  };

  const requestConnect = () => {
    if (halted || connecting) return;
    // シグナリングが瞬断しただけならP2Pは生きている。張り直す必要はない
    // (再ネゴシエーションは映像の途切れと、チケットが無ければ認証ダイアログを招く)。
    if (pc?.connectionState === "connected") return;
    setStatus("ホストへ接続要求...");
    if (!ch.send({ t: "connect", v: PROTOCOL_VERSION })) {
      // 部屋を奪われている。onCloseで繋ぎ直すので、ここでは知らせるだけ。
      setStatus("接続が別のタブに奪われました", true);
      return;
    }
    connecting = true;
    clearTimeout(connectTimer);
    // 応答が来ないまま固まったとき、次の試行を永久に塞がないための保険
    connectTimer = window.setTimeout(() => {
      connecting = false;
      setStatus("ホストから応答がありません", true);
      scheduleRetry(2000);
    }, 45_000);
  };

  const endAttempt = () => {
    connecting = false;
    clearTimeout(connectTimer);
  };

  // これ以上試しても無駄な状態。部屋を明け渡して、他のタブの邪魔をしないようにする。
  const halt = (text: string) => {
    halted = true;
    endAttempt();
    clearTimeout(retryTimer);
    clearTimeout(signalTimer);
    setStatus(text, true);
    ch.close();
  };

  const ch = new SignalChannel(hostId, {
    onOpen: (_ip, peerPresent) => {
      signalRetries = 0;
      if (peerPresent) {
        requestConnect();
      } else {
        // ホストが入室したら onPeerJoined で自動的に繋ぎに行く
        endAttempt();
        setStatus("ホストがオフラインです。待機中...", true);
      }
    },
    onPeerJoined: () => requestConnect(),
    // ホスト側のシグナリングは再接続を繰り返すので、退室=あきらめ ではない。
    // 進行中の要求だけ畳んでおき、戻ってきた瞬間(onPeerJoined)に繋ぎ直す。
    // ここで畳まないと、次の入室時に「要求が進行中」と見なされて素通りしてしまう。
    onPeerLeft: () => {
      endAttempt();
      setStatus("ホストが切断しました。復帰を待っています...", true);
    },
    // 要求を出した時点でホストが部屋に居なかった。応答は来ないので待たない。
    onPeerAbsent: () => {
      endAttempt();
      setStatus("ホストがオフラインです。待機中...", true);
    },
    onMessage: (msg) => {
      const m = msg as {
        t: string;
        v?: number;
        sdp?: string;
        nonce?: string;
        reason?: string;
        expected?: number;
      };
      if (m.t === "offer" && m.sdp && m.nonce) {
        // 認証ダイアログを閉じられた場合もここに来る。放っておくと復帰手段が
        // なくなるので、通常の失敗と同じ再接続の流れに乗せる。
        handleOffer(m.sdp, m.nonce, m.v ?? 0).catch((e) => {
          endAttempt();
          setStatus(`接続に失敗しました: ${e}`, true);
          scheduleRetry(3000);
        });
      } else if (m.t === "ready-auth") {
        beginAuthentication();
      } else if (m.t === "auth-ok") {
        retries = 0;
        endAttempt();
        // DataChannelは認証前に開くため、その時点で送った初期状態はホスト側で
        // 意図的に破棄される。解禁直後に現在値を送り直し、送出解像度と
        // バックグラウンド時のキャプチャ停止を確実に反映する。
        sendViewport();
        if (hidden) controller?.send({ t: "vis", on: false });
        setStatus("");
      } else if (m.t === "error") {
        if (m.reason === "protocol") {
          halt(`PC側とのバージョンが一致しません (必要: v${m.expected ?? "?"})。`);
        } else if (m.reason === "auth") {
          endAttempt();
          if (ticket) {
            // チケットの期限切れ。パスキーからやり直せば通る
            ticket = null;
            setStatus("認証し直しています...", true);
            scheduleRetry(500);
          } else {
            halt("認証に失敗しました。再ペアリングが必要です。");
          }
        } else if (m.reason === "unpaired") {
          halt("PC側に端末が登録されていません。QRコードからペアリングしてください。");
        } else if (m.reason === "timeout") {
          endAttempt();
          setStatus("認証待ちの時間切れです — もう一度お試しください", true);
          scheduleRetry(1000);
        } else {
          endAttempt();
          setStatus(`ホスト側エラー: ${m.reason}`, true);
        }
      }
    },
    onClose: (reason) => {
      // ソケットが死んだ時点で交渉中の要求は無効。次の試行を塞がないよう畳む。
      endAttempt();
      if (exited || halted) return;
      // 見えていないあいだは繋ぎ直さない。復帰した時点で onVisibility が繋ぎ直す。
      if (hidden) return;
      // 最初の1回はすぐ繋ぎ直す(一瞬の瞬断が大半)。落ち続けるようなら間隔を空ける。
      const delay = Math.min(1000 * 2 ** signalRetries, 15_000);
      signalRetries++;
      setStatus(`シグナリング切断: ${reason} — 再接続します...`, true);
      clearTimeout(signalTimer);
      signalTimer = window.setTimeout(() => {
        if (!exited && !halted && !hidden) ch.connect();
      }, delay);
    },
  });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", onResize);
  ch.connect();
}
