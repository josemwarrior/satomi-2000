![Satomi-2000](img/header.png)

## What is Satomi?

Satomi-2000 is a CLI that publishes to Jekyll and optionally syndicates to Mastodon, Bluesky, X, Telegram, and Org Social.

It supports text, local images, animated GIFs, and external MP4 URLs.

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

# External MP4 (text is optional)
satomi post -t "New gameplay." -v https://example.com/video.mp4
satomi post -v https://example.com/video.mp4

# Bypass the local daily X limit (and authorize an X payload containing a URL)
satomi post -t "Extra update" --force-x
```

Need another option? Run `satomi --help`.

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
