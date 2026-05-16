# AGENTS.md

このリポジトリで作業するCodex/AIエージェント向けの共通ルール。

## AWS操作

- AWS CLIでAWSリソースを操作する場合は、原則として `dental-dev` プロファイルを使用する。
- `default` プロファイルではAWS操作を行わない。
- AWS操作前に、必要に応じて以下で対象アカウントを確認する。

```powershell
aws sts get-caller-identity --profile dental-dev
```

- SSOの認証期限が切れた場合は、以下で再ログインする。

```powershell
aws sso login --profile dental-dev
```

- AWS CLIコマンド例:

```powershell
aws s3 ls --profile dental-dev
```

## ファイル読み込み

- 日本語ファイルやMarkdownファイルを読み込む場合は、原則としてUTF-8として扱う。
- PowerShellで日本語ファイルを読む場合は、必要に応じて `-Encoding UTF8` を指定する。

```powershell
Get-Content -LiteralPath .\仕様書.md -Raw -Encoding UTF8
```

## Python実行

- Pythonスクリプトを実行する場合は、原則としてAnaconda環境のPythonを使用する。
- この環境では以下のPythonを優先する。

```powershell
C:\Users\1107s\anaconda3\python.exe
```

- 例:

```powershell
C:\Users\1107s\anaconda3\python.exe scripts\example.py
```

## Node.js / npm

- このプロジェクトではNode.js 24 LTSを使用する。
- Node.js 20系はEOL済みのため、新規開発・検証では使用しない。
- `nvm-windows` を使う場合は以下で切り替える。

```powershell
nvm use 24
```

- 実行前に必要に応じて以下で確認する。

```powershell
node --version
npm --version
```

## Amplify共有

- 共有リンクを作る場合はAWS Amplify HostingのGit連携SSRデプロイを前提にする。
- 手動アップロードのデプロイはSSRアプリに使わない。
- 共有認証は `APP_SHARE_PASSWORD` と `APP_AUTH_SECRET` を環境変数で設定して使う。
