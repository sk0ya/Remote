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

export interface ScreenLayout {
  // 表示領域を測り直して反映する
  apply(): void;
  // Webキーボードの高さ(隠しているときは0)。映像はこのぶんも上に詰める。
  setWebKeyboardHeight(height: number): void;
  // OSキーボード直上の入力欄と余白の高さ(閉じているときは0)。
  setTextInputHeight(height: number): void;
  dispose(): void;
}

export function attachScreenLayout(
  viewer: HTMLElement,
  // 領域が削られているか (削られているあいだ、映像は余白を作らず埋める)
  onChanged: (occluded: boolean) => void,
  vv: VisualViewport | null = window.visualViewport
): ScreenLayout {
  let webKeyboardHeight = 0;
  let textInputHeight = 0;

  // 切り替え中にResizeObserverの通知順が前後しても、片方の閉じた通知で
  // 開いている方のアクセサリを消さない。
  const accessoryHeight = (): number => Math.max(webKeyboardHeight, textInputHeight);

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
    onChanged(raise > 0);
  };

  // キーボードの開閉中は何度も飛んでくるが、遅らせると表示が遅れて追従するので
  // その都度すぐ反映する(ホストへの送信は伴わないので回数は問題にならない)。
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);

  return {
    apply,
    setWebKeyboardHeight(height: number): void {
      webKeyboardHeight = height > 0 ? height : 0;
      apply();
    },
    setTextInputHeight(height: number): void {
      textInputHeight = height > 0 ? height : 0;
      apply();
    },
    dispose(): void {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      viewer.style.bottom = "";
      viewer.classList.remove("keyboard-open");
      document.documentElement.style.removeProperty("--viewport-occlusion-bottom");
    },
  };
}
