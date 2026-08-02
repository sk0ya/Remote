// クライアントが実際に表示できる大きさをホストへ伝えるための計算。
//
// ホストは既定でモニタの実解像度をそのままエンコードして送っていた。スマホの
// デコード電力はほぼピクセル数に比例するので、4Kデスクトップを受け取るのは
// 表示に必要な数倍のデコードを回していることになる。ここで求めた大きさを
// 申告し、ホスト側でそこまで落としてもらう。

export interface Size {
  w: number;
  h: number;
}

// CSSピクセルとデバイス比から実ピクセル数を求める。
// 上限はホスト側が決めるので、ここでは切り詰めない
// (PCブラウザから見たときに不必要にぼやけるのを避ける)。
export function viewportPixels(cssW: number, cssH: number, dpr: number): Size {
  if (!(cssW > 0) || !(cssH > 0) || !(dpr > 0)) return { w: 0, h: 0 };
  return { w: Math.round(cssW * dpr), h: Math.round(cssH * dpr) };
}

// いま表示に使える大きさ。ビューアは常に画面いっぱいなので画面の大きさで測る。
//
// 映像要素の実寸ではなく画面で測るのは、ソフトキーボードで映像の枠が一時的に
// 狭くなるため。そのたびに申告し直すとホストが解像度を切り替えてしまうが、
// 映像は見た目の大きさを保ったまま(はみ出して)表示されるので、必要な画素数は
// キーボードを開く前と変わらない。
export function currentViewport(): Size {
  const dpr = window.devicePixelRatio || 1;
  return viewportPixels(window.innerWidth, window.innerHeight, dpr);
}
