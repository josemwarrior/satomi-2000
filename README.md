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

# Image or GIF
satomi post -t "New animation." -i capture.gif

# External MP4
satomi post -t "New gameplay." -v https://example.com/video.mp4
```

Need another option? Run `satomi --help`.
