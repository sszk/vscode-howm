# 作業ルール

- 変更を完了するときは、バージョンを進めてからビルドする。
- バージョン指定がなければ `npm version patch --no-git-tag-version` で `package.json` と `package-lock.json` を更新する。
- `npm run package` でコンパイルとVSIXの作成を行い、完了報告にバージョンと生成したVSIXのパスを記載する。
