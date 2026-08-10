# 作業ルール

## Publish

このリポジトリでユーザーが「publish」と言った場合は、GitHub への push ではなく、Cloudflare への本番デプロイを意味する。

- クライアント: `client` で `npm run build` を実行し、`npx wrangler pages deploy dist --project-name remote-client`
- シグナリング Worker: `signaling` で `npx wrangler deploy`
- GitHub への `git push` は、ユーザーが明示的に push または GitHub への公開を依頼した場合だけ行う
- 実行前に、デプロイ対象が Pages と Worker であることを確認する
