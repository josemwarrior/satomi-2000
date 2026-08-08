![Satomi-2000 header](img/header.png)

**A command-line interface (CLI) tool for microblog publishing.**

Satomi-2000 is a command-line publishing tool for a Jekyll microblog.

With a single command, you can publish text and an optional PNG, JPEG, WebP, or animated GIF image to:

- A Jekyll blog (**mandatory**)
- X (optional)
- Mastodon (optional)
- Bluesky (optional)
- Org Social (optional)

**Note:** The X API currently charges per use. Satomi-2000 blocks X payloads containing a URL unless that one run includes `--force-x-url`.

The Satomi-2000 project and the Jekyll site may live anywhere on the same machine. The Jekyll repository, posts directory, media directory, generated public-files directory, and public URLs are configuration values. Satomi does not assume a custom collection or a `/microblog` subpath.

## Requirements

- Node.js 20 or newer
- Git
- The Ruby, Bundler, and Jekyll toolchain required by the target site
- FFmpeg only when a publication combines an animated GIF with Bluesky

## Installation

From a checkout:

```bash
npm install
npm run build
./satomi-2000 --help
```

## Configuration

Rename `satomi.config.example.yml` to `satomi.config.yml` and complete the information.
When `--config` is omitted, Satomi-2000 reads `satomi.config.yml` from the current
working directory. `SATOMI_CONFIG` can define a different default path.

Change a destination from `true` to `false` to uncheck it:

```yaml
destinations:
  jekyll: true # Required canonical source; cannot be disabled.
  org_social: true # Generates and publishes social.org.
  mastodon: true
  bluesky: true
  x: true
```

The Jekyll filesystem paths and public URLs are independent:

```yaml
site:
  # Root or subpath where posts are publicly available. No trailing slash.
  public_url: https://example.com/microblog

  # Public URL corresponding to media_directory. No trailing slash.
  media_url: https://example.com/assets/microblog/media

  # Absolute, or relative to the directory containing this config file.
  repository_path: /Users/you/Sites/your-site

  # Relative to repository_path. This can be _posts, _microblog, or another
  # source directory already configured in Jekyll.
  posts_directory: _posts

  # An optional PNG, JPEG, WebP, or GIF is copied here.
  media_directory: assets/microblog/media

  # feed.xml, feed.json, and social.org are written here. This directory must
  # be served at public_url. Use "." for the site root.
  public_files_directory: microblog
```

Copy `.env.example` to `.env` if you run in local environment:
And fill the information.

Expected variables:

```text
MASTODON_URL
MASTODON_TOKEN
BLUESKY_HANDLE
BLUESKY_APP_PASSWORD
X_ACCESS_TOKEN
```

## Usage

Interactive publication:

```bash
./satomi-2000
```

Non-interactive publication:

```bash
./satomi-2000 publish \
  --text "Enemies now react to the weapon element." \
  --image captures/slime-fire.gif
```

PNG, JPEG, and WebP use the same option and are uploaded natively without FFmpeg:

```bash
./satomi-2000 publish --text "New title screen." --image captures/title.png
./satomi-2000 publish --text "New key art." --image captures/key-art.jpg
./satomi-2000 publish --text "New portrait." --image captures/portrait.webp
```

For a text-only publication, press Enter at the interactive image prompt or omit `--image` in a non-interactive command:

```bash
./satomi-2000 publish --text "The save system is now stable."
```

Alternative text is optional and is never requested interactively. Supply it explicitly with `--alt` when wanted. Satomi-2000 sends provided alt text only through platform features that support it: Mastodon media descriptions, Bluesky image/video alt, and X image metadata for PNG, JPEG, and WebP. X animated GIF uploads do not receive image-only alt metadata.

Formats are detected from their file signatures. With `validation.require_matching_image_extension` enabled, JPEG accepts either `.jpg` or `.jpeg`; PNG and WebP require `.png` and `.webp`. The existing `max_png_mb` platform setting is the shared size limit for all three static image formats.

The title is derived from the first sentence. The slug uses the local date plus the image filename, or the derived title for a text-only post. Both can be supplied explicitly with `--title` and `--slug`. Tags default to `content.default_tags` and can be replaced with `--tags tag-one,tag-two`.

Other commands:

```bash
# Validate credentials, limits, media, target files, and a temporary Jekyll build.
./satomi-2000 validate --text "..." --image capture.png

# Build the actual Jekyll repository without committing or publishing.
./satomi-2000 preview

# Read local state without consulting social APIs.
./satomi-2000 status 2026-08-08-slime-fire

# Retry one failed platform. Published and ambiguous attempts are rejected.
./satomi-2000 retry 2026-08-08-slime-fire --platform mastodon
```

If X is selected and its final payload contains any URL, validation stops before creating files or calling social APIs. Authorize only that higher-cost publication explicitly:

```bash
./satomi-2000 publish --text "Full notes: https://example.com/update" --force-x-url
```

The same flag is required for an X retry containing a URL. `--force-x-url` does not bypass character limits, media limits, duplicate protection, daily X limits, or the configured maximum cost.

Use `--config /private/path/config.yml` or set `SATOMI_CONFIG` when the private configuration is stored elsewhere.

## Platform behavior

### Org Social

When `destinations.org_social` is checked, Satomi-2000 publishes `social.org` under `site.public_files_directory` as part of the same Jekyll deployment. It requires no API key and does not use Emacs. The choice is stored in each entry's front matter, so an entry published while Org Social is unchecked will not appear retroactively if the file is regenerated later.

### Mastodon

Satomi-2000 optionally reads the instance configuration, verifies its advertised MIME support, applies the lower remote limits, uploads an attached PNG, JPEG, WebP, or GIF with a media description, waits for media processing, and creates the status with an idempotency key derived from the slug. Text-only statuses skip media upload.

### Bluesky

An animated GIF is converted to a silent H.264 MP4 with even dimensions and `yuv420p`, then published as `app.bsky.embed.video`. PNG, JPEG, and WebP are uploaded directly with their real MIME type as `app.bsky.embed.images`; they are never converted to MP4. Text-only posts have no embed. All variants use the same deterministic record key and rich-text facet handling.

### X

Satomi-2000 uses the official chunked media workflow (`INIT`, `APPEND`, `FINALIZE`, and `STATUS`) for an attached PNG, JPEG, WebP, or GIF and creates exactly one post. Supported image metadata is added to static-image uploads. Text-only posts skip media upload. A timeout or server error after the create request is stored as `unknown`; Satomi-2000 will not retry it. Reconcile the account manually first.

X is selected in the example so all choices are visible. Uncheck it until credentials and cost controls are ready. API pricing and access rules can change, so review the developer console before leaving it selected. Cost estimates are configuration values, not hard-coded assumptions.

Official references:

- [Jekyll posts](https://jekyllrb.com/docs/posts/)
- [Jekyll collections](https://jekyllrb.com/docs/collections/)
- [Org Social](https://org-social.org/)
- [Bluesky video uploads](https://docs.bsky.app/docs/tutorials/video)
- [Bluesky image embeds](https://docs.bsky.app/docs/tutorials/creating-a-post#images-embeds)
- [Mastodon media API](https://docs.joinmastodon.org/methods/media/)
- [Mastodon supported attachment formats](https://docs.joinmastodon.org/user/posting/#attachments)
- [Mastodon status API](https://docs.joinmastodon.org/methods/statuses/)
- [X chunked media uploads](https://docs.x.com/x-api/media/quickstart/media-upload-chunked)
- [X image specifications](https://docs.x.com/x-api/media/quickstart/best-practices#image-specifications-and-recommendations)
- [X create post API](https://docs.x.com/x-api/posts/create-post)

## Development

```bash
npm run typecheck
npm test
npm run build

# All checks
npm run check
```

## Make `satomi-2000` available from any directory (macOS and zsh)

First, open the Satomi-2000 project directory and run `pwd` to get its absolute
path. Then add the following line to `~/.zshrc`, replacing the example path with
that absolute path:

```bash
export PATH="/absolute/path/to/satomi:$PATH"
```

Reload the shell configuration and verify the command:

```bash
source ~/.zshrc
satomi-2000 --help
```

Adding the executable to `PATH` does not change where Satomi looks for its
configuration. To run it from any directory without passing `--config` each
time, also add this line to `~/.zshrc`:

```bash
export SATOMI_CONFIG="/absolute/path/to/satomi/satomi.config.yml"
```

Relative image paths are still resolved from the terminal's current directory;
use an absolute image path when publishing from elsewhere.

## License

MIT
