// ビューアの表示領域を、スマホで実際に見えている範囲へ合わせる。
//
// ソフトキーボードは画面の下を覆うが、position:fixed のビューアはその下に
// 潜ったまま残る。放っておくと映像も特殊キーバーもキーボードの裏に隠れ、
// 等倍では2本指の操作がスクロールなので動かす手段もない。
// visualViewport が示す高さと、特殊キーバーの実測の高さをCSS変数で渡し、
// 見えているぶんだけをビューアに使わせる。
//
// 縦の位置(offsetTop)には触らない。iOSは入力欄を見せようとして自前でも
// ページをずらすので、こちらでも足すと画面外へ送り出してしまう。

export interface ScreenLayout {
  // 表示領域を測り直してCSS変数へ反映する
  apply(): void;
  // 特殊キーバーの高さ(隠しているときは0)
  setKeyboardHeight(height: number): void;
  dispose(): void;
}

export function attachScreenLayout(
  vroot: HTMLElement,
  onChanged: () => void,
  vv: VisualViewport | null = window.visualViewport
): ScreenLayout {
  const apply = (): void => {
    // 0や負の値が来ることがある(認証ダイアログ・バックグラウンド)。
    // そのまま入れるとビューアの高さが消えて何も見えなくなるので捨てる。
    if (vv && vv.height > 0) {
      vroot.style.setProperty("--vv-height", `${vv.height}px`);
    }
    onChanged();
  };

  // キーボードの開閉中は何度も飛んでくるが、遅らせると表示が遅れて追従するので
  // その都度すぐ反映する(ホストへの送信は伴わないので回数は問題にならない)。
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);

  return {
    apply,
    setKeyboardHeight(height: number): void {
      vroot.style.setProperty("--kbd-height", `${height}px`);
      // 開いているあいだは映像に残る高さが僅かなので、重なるものを退ける
      vroot.classList.toggle("kbd-open", height > 0);
      apply();
    },
    dispose(): void {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
    },
  };
}
