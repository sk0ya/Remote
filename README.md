# Remote — スマホからWindowsPCへのリモートデスクトップ

スマホのブラウザ(Webアプリ)からWindowsPCを閲覧・操作するリモートデスクトップ。

- **ペアリング**: PCに表示したQRコード+パスワードで、**同一ネットワーク上でのみ**スマホを登録(登録できるのは1端末だけ。再ペアリングすると旧端末は失効)
- **接続**: ペアリング後は**別ネットワークからでも**接続可能。映像・操作は常に**P2P(WebRTC/DTLS暗号化)**で、外部サーバーは接続開始時の待ち合わせ(シグナリング)にしか使わない
- **操作**: タップ=クリック / 長押し→ドラッグ / 2本指タップ=右クリック / 2本指スクロール / ピンチズーム / 仮想キーボード(IME対応)

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

## 必要なもの

- Windows: Go 1.24+、FFmpeg(`winget install GoLang.Go Gyan.FFmpeg`)
- Node.js 20+
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
スマホをPCと同じWi-Fiにつなぎ、QRを読んでパスワードを入力すればペアリング完了。

- 診断: `go run ./cmd/capturetest` で画面キャプチャ単体を確認(使用エンコーダ・fps表示)
- 開発用に `http://<PC>:5175/#/dev?h=<hostId>` で認証なし接続画面を開ける(トークン検証は失敗するのでpair済みトークンが必要)

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
| `bitrateMbps` | 映像ビットレート | 4 |
| `fps` | フレームレート | 30 |

## セキュリティ

- ペアリングは「ワンタイムコード(TTL10分) + パスワード + 公開IP一致(=同一ネットワーク)」の3点検証
- 端末トークンはホスト側にSHA-256ハッシュのみ保存。映像・操作はDTLS-SRTPで常時暗号化
- HTTPS配信時はSDPにHMAC(ペアリング時の共有シークレット)を付け、中継サーバーのなりすましを検知
- 制約: ペアリングの瞬間だけは中継サーバーを信頼する(自分のCloudflareアカウントで運用する前提)

## 既知の制限 (v1)

- TURN中継なし: 双方が厳しいNAT(対称NAT同士など)の場合は接続不可
- マルチモニタは主モニタのみ / 音声転送なし
- UACダイアログや管理者権限アプリへの入力は、ホストを管理者実行した場合のみ可能
- キーフレーム要求(PLI)非対応のためGOP1秒固定。パケロス時は最大1秒乱れる
