// ビューアの表示領域を、スマホで実際に見えている範囲へ合わせる。
//
// ソフトキーボードは画面の下を覆うが、position:fixed のビューアはその下に
// 潜ったまま残る。放っておくと映像も特殊キーバーもキーボードの裏に隠れ、
// 等倍では2本指の操作がスクロールなので動かす手段もない。
// 隠れている高さを visualViewport から出し、ビューアの下端をそのぶん上げる。
//
// 上げるのは「下端(bottom)」だけで、高さは指定しない。ビューアは inset:0 で
// 上下に張られているので、値が何であれ箱が潰れることはない。高さで指定すると、
// 値がおかしいときに(中身は全部absoluteなので)高さ0になって何も映らなくなる。
//
// 縦の位置(top)にも触らない。iOSは入力欄を見せようとして自前でもページを
// ずらすので、こちらでも足すと画面の外へ送り出してしまう。

// 高さの通知(set*Height)は、すぐには反映しない。パネルの入れ替えでは
// 「閉じた」と「開いた」が別々に届くので、出揃うまで待ってから1回で反映する
// (下の scheduleApply)。
export interface ScreenLayout {
  // 表示領域を測り直して反映する
  apply(): void;
  // Webキーボードの高さ(隠しているときは0)。映像はこのぶんも上に詰める。
  setWebKeyboardHeight(height: number): void;
  // OSキーボード直上の入力欄と余白の高さ(閉じているときは0)。
  setTextInputHeight(height: number): void;
  // マウス操作パネルの高さ(隠しているときは0)。
  setMousePadHeight(height: number): void;
  dispose(): void;
}

// 下端で映像を削っているものの高さ。
export interface Occlusion {
  occluded: number; // OSキーボードが覆っている高さ
  webKeyboard: number; // 画面内キーボード
  textInput: number; // OSキーボード直上の入力欄
  mousePad: number; // マウス操作パネル
}

// 余白を埋める(拡大して切り取る)かどうか。
//
// 下端のトレイが出ているなら、中身が何であっても埋める。トレイは画面の半分
// 近くを持っていくので、残った隙間に16:9のデスクトップ全体を収め直すと上下が
// 真っ黒な余白になり、字も読めない大きさになる。
//
// 中身によって変えてはいけない。キーボードのときだけ埋めていた頃は、
// キーボード⇔マウスを切り替えるたびに映像が拡大と全体表示を行き来して、
// 同じ場所を見ているつもりでも見え方ごと変わってしまっていた。
// (トレイの高さも中身によらず同じなので、切り替えでは映像は一切動かない)
//
// 埋めるとデスクトップの一部しか映らないが、カーソルは映像の方が追う
// (input.ts の followCursor)。はみ出したぶんは2本指でも動かせる。
export function shouldFill(h: Occlusion): boolean {
  return h.occluded + Math.max(h.webKeyboard, h.textInput, h.mousePad) > 0;
}

// 表示領域がまだ途中の姿かどうか。
//
// OSキーボードは、入力欄にフォーカスしてから上がりきるまで、また入力欄を
// 閉じてから下がりきるまでに、それぞれ間がある。そのあいだに見えている領域は
// 本物ではない — 画面の3分の1ほどが、これから削られる/これから返ってくる。
// 見分け方は「入力欄とOSキーボードの食い違い」。OSキーボードを出す先はこの
// 入力欄しかないので、片方だけ在る状態は必ず動いている途中を指す。
//
// 途中で置き直すと、そのたびに映像は一瞬だけ別の領域に合わせて拡大され、
// 落ち着いた時点でもう一度置き直される。切り替えのたびに伸びて戻る、が
// 見えるのはこれで、上限まで拡大した状態を通ると位置まで巻き添えになる。
export function settling(h: Occlusion): boolean {
  return h.textInput > 0 !== h.occluded > 0; // 片方だけ在る = 動いている途中
}

export function attachScreenLayout(
  viewer: HTMLElement,
  // 領域が削られているか (削られているあいだ、映像は余白を作らず埋める)。
  // settling = OSキーボードの上がりきる前。まだ映像を置き直さない合図。
  onChanged: (occluded: boolean, settling: boolean) => void,
  vv: VisualViewport | null = window.visualViewport
): ScreenLayout {
  let webKeyboardHeight = 0;
  let textInputHeight = 0;
  let mousePadHeight = 0;

  // 下端のアクセサリは一度に1つしか出さないが、切り替え中にResizeObserverの
  // 通知順が前後することがある。最大を採って、片方の閉じた通知で開いている方を
  // 消してしまわないようにする。
  const accessoryHeight = (): number =>
    Math.max(webKeyboardHeight, textInputHeight, mousePadHeight);

  // ソフトキーボードが覆っている高さ。信用できない値は0(=覆っていない)にする。
  // 認証ダイアログやバックグラウンドで0や桁違いの値が来ることがあり、それを
  // そのまま使うと画面が消える。
  const occludedHeight = (): number => {
    const inner = window.innerHeight;
    if (!vv || !(vv.height > 0) || !(inner > 0)) return 0;
    const occluded = Math.round(inner - vv.height - (vv.offsetTop || 0));
    if (!(occluded > 0) || occluded > inner * 0.9) return 0;
    return occluded;
  };

  const apply = (): void => {
    const occluded = occludedHeight();
    // 下部アクセサリはOSキーボードの直上に置く (バー自身は position:fixed)
    document.documentElement.style.setProperty(
      "--viewport-occlusion-bottom",
      `${occluded}px`
    );
    // 映像はOSキーボードと下部アクセサリのぶんだけ上で終わらせる。
    // 避けるものが何も無いときは指定自体を消して、CSSの inset:0 の素の状態に戻す
    // (映像の箱にこちらから触れている状態を残さない)。
    const accessory = accessoryHeight();
    const raise = occluded + accessory;
    viewer.style.bottom = raise > 0 ? `${raise}px` : "";
    viewer.classList.toggle("keyboard-open", accessory > 0);
    const h: Occlusion = {
      occluded,
      webKeyboard: webKeyboardHeight,
      textInput: textInputHeight,
      mousePad: mousePadHeight,
    };
    onChanged(shouldFill(h), settling(h));
  };

  // 下端のパネルの入れ替えは、必ず「閉じた(高さ0)」と「開いた(高さH)」の
  // 2つの通知に分かれて届く。片方はResizeObserver、片方はその場で呼ばれるので、
  // 順序は揃えられない。0が先に来たぶんをそのまま反映すると、一瞬だけ
  // 「下端に何も無い」状態になり、映像は全体表示へ戻ってから埋め直される。
  // 見た目には出ない一瞬でも、そのあいだに拡大も位置も作り直されるので、
  // パネルを切り替えるたびに映像が動く。最大を採るだけでは足りない
  // (0が後から来る側は防げるが、先に来る側は防げない)。
  //
  // 高さの通知はいったん受け止め、同じ切れ目で届いたぶんが出揃ってから
  // 1回だけ反映する。押した瞬間の描画には間に合うので、遅れは見えない。
  let pending = 0;
  const scheduleApply = (): void => {
    if (pending) return;
    pending = window.setTimeout(() => {
      pending = 0;
      apply();
    }, 0);
  };

  // OSキーボードの開閉中は何度も飛んでくる。まとめても1つ後の処理まで待つだけ
  // なので追従は遅れないし、パネルの高さの通知と同じ切れ目で反映されるようになる
  // (OSキーボードが下がるのとパネルが入れ替わるのは同時に起きる)。
  vv?.addEventListener("resize", scheduleApply);
  vv?.addEventListener("scroll", scheduleApply);

  return {
    apply,
    setWebKeyboardHeight(height: number): void {
      webKeyboardHeight = height > 0 ? height : 0;
      scheduleApply();
    },
    setTextInputHeight(height: number): void {
      textInputHeight = height > 0 ? height : 0;
      scheduleApply();
    },
    setMousePadHeight(height: number): void {
      mousePadHeight = height > 0 ? height : 0;
      scheduleApply();
    },
    dispose(): void {
      clearTimeout(pending);
      vv?.removeEventListener("resize", scheduleApply);
      vv?.removeEventListener("scroll", scheduleApply);
      viewer.style.bottom = "";
      viewer.classList.remove("keyboard-open");
      document.documentElement.style.removeProperty("--viewport-occlusion-bottom");
    },
  };
}
