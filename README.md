![Satomi-2000](img/header.png)

## What is Satomi?

Satomi-2000 is a CLI that publishes to Jekyll and optionally syndicates to Mastodon, Bluesky, X, Telegram, and Org Social.

It supports text, local or HTTPS images (PNG, JPEG, WebP, animated GIF), and external MP4 URLs.

## How to install

Requires Node.js 20+, Git, and your Jekyll toolchain. Video support also requires FFmpeg.

```bash
npm install
npm run build
cp satomi.config.example.yml satomi.config.yml
cp .env.example .env
```

Edit `satomi.config.yml` and add credentials for enabled platforms to `.env`.

## How to use it

```bash
# Interactive
satomi

# Text
satomi post -t "A new update."

# Image or GIF (text is optional)
satomi post -t "New animation." -i capture.gif
satomi post -i capture.png

# External image (direct URL; text is optional)
satomi post -i "https://i.imgur.com/IDENTIFIER.jpeg" -a "Image description"

# External MP4 (text is optional)
satomi post -t "New gameplay." -v https://example.com/video.mp4
satomi post -v https://example.com/video.mp4

# Bypass the local daily X limit (and authorize an X payload containing a URL)
satomi post -t "Extra update" --force-x
```

Need another option? Run `satomi --help`.

Bare `https://` and `http://` links in post text become explicit `[[URL][URL]]` text links in `social.org`. Existing links and code are preserved. An explicit `org_social_text` override is used unchanged.

## How to preserve an Org Social reply

When a reply was created outside Satomi, add its metadata to the canonical Jekyll entry before the next publication rebuilds `social.org`:

```yaml
syndicate:
  org_social: true
  org_social_language: es
  org_social_client: iOS
  org_social_reply_to: 'https://example.com/social.org#2026-08-11T10:43:16+0200'
org_social_text: |-
  [[org-social:https://example.com/social.org][alice]] Reply written in Org syntax.
```

`org_social_text` is optional. Use it when the Jekyll body is Markdown and the Org Social version needs Org links or mentions. Satomi reads these fields only while rebuilding the derived files; editing an existing entry does not syndicate it again.

## External images

`-i` accepts a local path or a direct HTTPS image URL. Satomi downloads and validates remote images in a temporary directory, then uploads the file to Mastodon, Bluesky, and X. Telegram receives the public URL (WebP is sent as a document; GIF as an animation). GIF conversion for Bluesky still requires FFmpeg.

Jekyll's `image` front matter, RSS, JSON Feed, and Org Social retain the original external URL. No image is copied into the blog repository. The image server must allow public downloads and embedding and return the correct image Content-Type. HTML gallery pages are not supported. URLs may contain query parameters; credentials, fragments, and redirects to HTTP are rejected.

Downloads default to a maximum of 50 MB and 60 seconds, configurable with `validation.max_remote_image_mb` and `validation.image_download_timeout_seconds`. Selected platform limits still apply. Retries download the URL again and verify the original content hash; if the image changed, the retry stops.

## Global command and future builds

From this repository, link the CLI once:

```bash
npm install
npm run build
npm link
```

The global command then points to this checkout's `dist/cli.js`. After source changes, run:

```bash
npm run check
```

This runs type checking, tests, and the build. Once it succeeds, the global `satomi` uses the new build immediately; no reinstall is necessary. For a build alone, use `npm run build`.

To use the same configuration from any directory, set an absolute path in your shell profile, for example:

```bash
export SATOMI_CONFIG="$HOME/.satomi/satomi.config.yml"
```

The repository must remain in place. If you move it or switch your NVM Node version, run `npm link` again from the repository using that Node version.
