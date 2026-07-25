# Remote — スマホからWindowsPCへのリモートデスクトップ

スマホのブラウザ(Webアプリ)からWindowsPCを閲覧・操作するリモートデスクトップ。

- **ペアリング**: PCに表示したQRコード+パスワードで、**同一ネットワーク上でのみ**スマホを登録。登録の実体は**パスキー(WebAuthn)**で、PCが持つのは公開鍵だけ。登録できるのは1つで、再ペアリングすると旧パスキーは失効
- **認証**: 接続のたびに顔認証/指紋でパスキー署名。**スマホ側に秘密情報を一切保存しない**ので、同じ端末なら別のブラウザからでも、パスキーが同期していれば別の端末からでも繋がる
- **接続**: ペアリング後は**別ネットワークからでも**接続可能。映像・操作は常に**P2P(WebRTC/DTLS暗号化)**で、外部サーバーは接続開始時の待ち合わせ(シグナリング)にしか使わない
- **操作**: タップ=クリック / 長押し→ドラッグ / 2本指タップ=右クリック / 2本指スクロール / ピンチズーム / 仮想キーボード(IME対応)
- **音声**: 🎤を押している間だけ録音し、**PC側でローカルに認識**(クラウド送信なし)。定義済みの言い回しならコマンド実行、それ以外は喋った内容をそのままPCへ打ち込む

## 構成

```
[スマホブラウザ] ←WSS→ [Cloudflare Worker+DO (シグナリング中継のみ)] ←WSS→ [Go常駐アプリ @Windows]
       └────────────── WebRTC P2P (H.264映像 + 入力DataChannel) ──────────────┘
```

| ディレクトリ | 内容 |
|---|---|
| `host/` | Windows常駐アプリ (Go + Pion)。画面はffmpegサブプロセス(ddagrab→H.264、NVENC/AMF/QSV/libx264自動選択)、入力はSendInput |
| `signaling/` | Cloudflare Worker + Durable Object。hostId毎の部屋でメッセージを素通しするだけ(秘密情報は持たない) |
| `client/` | スマホ用SPA (Vite + TypeScript)。Cloudflare Pagesで配信 |
| `stt/` | 音声認識エンジン (Rust + sherpa-onnx + ReazonSpeech日本語モデル)。ホストが子プロセスとして常駐させる |

## 必要なもの

- Windows: Go 1.24+、FFmpeg(`winget install GoLang.Go Gyan.FFmpeg`)
- Node.js 20+
- 音声入力を使う場合: Rust(`winget install Rustlang.Rustup`)
- デプロイ時: Cloudflareアカウント(無料枠でOK)

## 開発(ローカル)

```powershell
# 1. シグナリング (http://<PC>:8787)
cd signaling; npm install; npm run dev

# 2. クライアント (http://<PC>:5175)
cd client; npm install; npm run dev

# 3. ホスト
cd host; go build -o remotehost.exe ./cmd/remotehost; ./remotehost.exe
```

ホスト起動時にタスクトレイに常駐し、未ペアリングならペアリングQRページが開く。
スマホをPCと同じWi-Fiにつなぎ、QRを読んでパスワードを入力し、続けて出るパスキーの作成を承認すればペアリング完了。

- 診断: `go run ./cmd/capturetest` で画面キャプチャ単体を確認(使用エンコーダ・fps表示)
- 開発用に `#/dev?h=<hostId>` でホストIDだけ流し込める(認証は通常どおりパスキー)
- **パスキーはセキュアコンテキストでしか作れない**ため、開発時は PCのブラウザから `http://localhost:5175` で操作すること。`http://<LAN IP>:5175`(スマホ実機)ではペアリングできない。実機で試すならデプロイ済みのHTTPSクライアントを使い、`clientUrl` をそちらに向ける

## デプロイ(インターネット越し接続)

```powershell
# 1. シグナリングWorker
cd signaling
npx wrangler login
npm run deploy        # → https://remote-signaling.<account>.workers.dev

# 2. クライアント (Cloudflare Pages)
cd client
"VITE_SIGNAL_URL=wss://remote-signaling.<account>.workers.dev/ws" | Set-Content .env.production
npm run build
npx wrangler pages deploy dist --project-name remote-client
#   → https://remote-client.pages.dev
```

3. ホストの設定 `%APPDATA%\RemoteDesk\config.json` を更新して再起動:

```json
{
  "signalUrl": "wss://remote-signaling.<account>.workers.dev/ws",
  "clientUrl": "https://remote-client.pages.dev"
}
```

4. トレイメニュー「ペアリングQRを表示」から再ペアリング(スマホは同一Wi-Fiで)。
   以降はモバイル回線など別ネットワークからも `https://remote-client.pages.dev` で接続できる。

## 設定 (`%APPDATA%\RemoteDesk\config.json`)

| キー | 意味 | 既定 |
|---|---|---|
| `hostId` | 部屋ID(自動生成) | — |
| `signalUrl` | シグナリングWSS URL | `ws://127.0.0.1:8787/ws` |
| `clientUrl` | QRに埋めるクライアントURL | `http://<LAN IP>:5175` |
| `credentialId` / `credentialKey` | 登録パスキーの資格情報IDと公開鍵(自動登録) | — |
| `clientOrigins` | パスキー検証で許可するクライアントのオリジン | Pages URL + `http://localhost:5175` |
| `bitrateMbps` | 映像ビットレート | 4 |
| `fps` | フレームレート | 30 |
| `voiceCommands` | 音声コマンド定義(下記) | 初回起動時に既定セットを書き込み |
| `sttCommand` | 音声認識エンジンの実行ファイル | ホストの隣の `../stt/target/release/remote-stt.exe` |
| `sttDir` | その作業ディレクトリ(`models/` がある場所) | `../stt` |

## 音声入力・音声コマンド

ビューア右上の🎤を**押している間だけ**録音する(push-to-talk)。離すと音声がPCへ送られ、**認識はPC側でローカルに**行う。

```
スマホ: MediaRecorderで録音 ─DataChannel(バイナリ)→ ホスト: ffmpegで16kHzモノラルwav化
                                                    → jvi-serve(常駐)で認識 → コマンド照合
```

- ブラウザの音声認識API (`webkitSpeechRecognition`) は使わない。Chromium派生(Vivaldi等)はGoogleのAPIキーを持たず、iOSのサードパーティブラウザにはAPI自体が無いため。**録音だけ**ブラウザにやらせるので、どのブラウザでも動く
- 認識エンジンは別プロジェクト `C:\Projects\Japanese` (sherpa-onnx + ReazonSpeech日本語モデル) の `jvi-serve`。クラウドには一切送らない
- 速度は2秒の発話で認識0.1秒程度。モデル読み込み(約5秒)は接続時に済ませておくので発話時には待たない
- ホストは認識結果を `voiceCommands` の `phrases` と照合し、**一致すればコマンド実行 / 一致しなければ認識結果をそのままキー入力**(ディクテーション)
- 結果はHUDに表示される(`⚡ メモ帳` = コマンド実行 / `⌨ …` = 打ち込み)
- 照合は空白・句読点を無視した部分一致。「メモ帳を開いて」は `"メモ帳"` にヒットする。複数一致したときは長いフレーズを優先
- 要HTTPS(Pages配信なら問題なし)。初回はマイク許可のダイアログが出る
- 対応していないブラウザでは🎤ボタン自体が出ない

### 認識エンジンの準備 (`stt/`)

```powershell
cd stt
.\scripts\setup-models.ps1   # モデル取得 (約720MB DL → 使う分だけ残して約160MB)
cargo build --release        # sherpa-onnxはビルド済みライブラリを取得するのでC++ビルドは不要
```

`remote-stt.exe` は「stdinにwavのパスを1行 → stdoutに `+認識結果` を1行」を返すだけのプロセスで、ホストが子プロセスとして起動し常駐させる。ホストは既定で `host/remotehost.exe` から見た `../stt/target/release/remote-stt.exe` を探すので、上記のビルドだけで繋がる(別の場所に置くなら `sttCommand` / `sttDir` で指定)。

実行ファイルやモデルが無い場合は**音声機能だけ無効**になり(HUDにその旨が出る)、他の機能はそのまま動く。

```json
{
  "voiceCommands": [
    { "name": "メモ帳", "phrases": ["メモ帳", "notepad"], "run": "notepad.exe" },
    { "name": "検索", "phrases": ["検索して"], "run": "cmd.exe",
      "args": ["/c", "start", "", "https://www.google.com/"] },
    { "name": "コピー", "phrases": ["コピー"], "keys": ["ControlLeft+KeyC"] },
    { "name": "署名", "phrases": ["署名入れて"], "text": "shigekazukoya@gmail.com" }
  ]
}
```

| キー | 意味 |
|---|---|
| `name` | ログとスマホHUDに出す名前 |
| `phrases` | 一致させる言い回し(複数可) |
| `run` / `args` | 起動する実行ファイルと引数 |
| `keys` | 送出するキー。`"ControlLeft+KeyC"` のように `+` で同時押し、配列で複数回 |
| `text` | 打ち込む固定テキスト |

`run` → `keys` → `text` の順に実行される。実行できるのはこのファイルに書いたものだけで、発話がそのままシェルに渡ることはない(音声認識は必ず誤認識するため、誤爆の被害を定義済み動作に閉じ込める設計)。`"voiceCommands": []` と書けばコマンドは無効になり、ディクテーションだけになる。

## セキュリティ

- ペアリングは「ワンタイムコード(TTL10分) + パスワード + 公開IP一致(=同一ネットワーク)」の3点検証。これを通った相手だけがパスキーを登録できる
- ホストが保存するのは資格情報IDと公開鍵だけ。**秘密情報はクライアントにもホストにも置かない**(秘密鍵は端末の資格情報ストアの中にあり、JavaScriptからは取り出せない)
- 接続ごとに `SHA-256(nonce ‖ offerSDP ‖ answerSDP)` をチャレンジとしてパスキーで署名。nonceはホストが接続ごとに発番するのでリプレイ不可、SDPを混ぜてあるので中継サーバーが書き換えれば検証で落ちる(旧HMAC方式の役割を兼ねる)
- 生体認証/PIN(UV)を必須にしており、端末を拾われただけでは接続できない。映像・操作はDTLS-SRTPで常時暗号化
- 再接続のたびに生体認証を求めると回線が不安定なときに使い物にならないため、認証済みセッションには10分間有効な再接続チケットを渡す。受け渡しはDataChannel(P2P/DTLS)限定で中継サーバーには見えず、クライアントもメモリにしか持たない(タブを閉じれば消える)。チケット利用時もSDPへの束縛は同じHMACで維持される
- 音声コマンドで実行できるのはホストの `config.json` に書いた定義だけ(発話をそのままシェルには渡さない)
- 制約: ペアリングの瞬間だけは中継サーバーを信頼する(自分のCloudflareアカウントで運用する前提)

## 既知の制限 (v1)

- パスキーはiCloudキーチェーン/Googleパスワードマネージャー等で**同期する**。「登録は1つ」だが、同じアカウントの他端末からも接続できる(同一端末の別ブラウザで使えるのと同じ仕組みの裏返しで、片方だけを選ぶことはできない)
- パスキー非対応のブラウザからは接続できない(フォールバックは用意していない)
- TURN中継なし: 双方が厳しいNAT(対称NAT同士など)の場合は接続不可
- マルチモニタは主モニタのみ / 音声転送なし
- UACダイアログや管理者権限アプリへの入力は、ホストを管理者実行した場合のみ可能
- キーフレーム要求(PLI)非対応のためGOP1秒固定。パケロス時は最大1秒乱れる
