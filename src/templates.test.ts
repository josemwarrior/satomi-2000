import { describe, expect, it } from "vitest";
import { renderJsonFeed, renderPost, renderRss, renderSocialOrg } from "./templates.js";
import type { ResolvedConfig } from "./types.js";

const config = {
  site: {
    public_url: "https://example.com/microblog",
    media_url: "https://example.com/media",
  },
  content: {
    title: "Devlog",
    description: "Game updates",
    language: "en",
  },
  org_social: {
    title: "Game on Org Social",
    nick: "Game",
    description: "Org Social updates",
    avatar_url: "https://example.com/org-social-avatar.png",
    links: ["https://example.com/social/", "https://example.com/about"],
    languages: ["es", "en"],
    default_language: "es",
  },
  destinations: {
    jekyll: true,
    org_social: true,
    mastodon: true,
    bluesky: true,
    x: false,
    telegram: true,
  },
} as ResolvedConfig;

const entry = {
  slug: "2026-08-08-test",
  title: "A test & update",
  date: "2026-08-08T17:30:00.000Z",
  image: "/assets/test.gif",
  alt: "Two slimes & a hero",
  tags: ["indiedev"],
  language: "en",
  orgSocialLanguage: "es",
  text: "The combat system works.",
  orgSocial: true,
};

describe("derived Jekyll artifacts", () => {
  it("renders a Markdown source of truth", () => {
    const post = renderPost(entry, config);
    expect(post).toContain("slug: 2026-08-08-test");
    expect(post).toContain("satomi: true");
    expect(post).toContain("permalink: /microblog/2026-08-08-test/");
    expect(post).toContain("org_social: true");
    expect(post).toContain("org_social_language: es");
    expect(post).toContain("telegram: true");
    expect(post).toContain("The combat system works.");
  });

  it("derives a root-level permalink without assuming a sub-blog", () => {
    const rootConfig = {
      ...config,
      site: { ...config.site, public_url: "https://example.com" },
    } as ResolvedConfig;
    const post = renderPost(entry, rootConfig);
    expect(post).toContain("permalink: /2026-08-08-test/");
    expect(post).not.toContain("layout:");
  });

  it("renders Org Social, RSS, and JSON Feed", () => {
    const social = renderSocialOrg([entry], config);
    expect(social).toContain("#+NICK: Game");
    expect(social).toContain("#+TITLE: Game on Org Social");
    expect(social).toContain("#+LANGUAGE: es en");
    expect(social).toContain("#+LINK: https://example.com/about");
    expect(social).toContain(":LANG: es");
    expect(social).toContain("[[https://example.com/assets/test.gif][Two slimes & a hero]]");
    expect(renderRss([entry], config)).toContain("A test &amp; update");
    const feed = JSON.parse(renderJsonFeed([entry], config)) as { items: unknown[] };
    expect(feed.items).toHaveLength(1);
  });

  it("renders an Org Social image without an empty link description", () => {
    const social = renderSocialOrg([{ ...entry, alt: undefined }], config);
    expect(social).toContain("[[https://example.com/assets/test.gif]]");
    expect(social).not.toContain("[[https://example.com/assets/test.gif][]]");
  });

  it("preserves Org Social reply metadata and Org-specific content", () => {
    const reply = {
      ...entry,
      orgSocialReplyTo:
        "https://example.com/alice/social.org#2026-08-08T16:30:00+0000",
      orgSocialClient: "iOS",
      orgSocialText: "[[org-social:https://example.com/alice/social.org][alice]] Reply.",
    };

    const post = renderPost(reply, config);
    expect(post).toContain(
      "org_social_reply_to: 'https://example.com/alice/social.org#2026-08-08T16:30:00+0000'",
    );
    expect(post).toContain("org_social_client: iOS");
    expect(post).toContain("org_social_text:");

    const social = renderSocialOrg([reply], config);
    expect(social).toContain(":CLIENT: iOS");
    expect(social).toContain(
      ":REPLY_TO: https://example.com/alice/social.org#2026-08-08T16:30:00+0000",
    );
    expect(social).toContain(
      "[[org-social:https://example.com/alice/social.org][alice]] Reply.",
    );
    expect(social).not.toContain("The combat system works.");
  });

  it("does not add entries that opted out when social.org is regenerated later", () => {
    expect(renderSocialOrg([{ ...entry, orgSocial: false }], config)).not.toContain(
      "The combat system works.",
    );
  });

  it("renders Org Social chronologically so the newest post is at the end", () => {
    const olderEntry = {
      ...entry,
      slug: "2026-08-07-older",
      date: "2026-08-07T17:30:00.000Z",
      text: "Older post.",
    };
    const social = renderSocialOrg([entry, olderEntry], config);

    expect(social.indexOf("Older post.")).toBeLessThan(
      social.indexOf("The combat system works."),
    );
  });

  it("renders an external MP4 without treating it as a repository image", () => {
    const videoEntry = {
      ...entry,
      image: undefined,
      video: "https://files.example/gameplay.mp4",
      videoType: "video/mp4" as const,
      videoWidth: 1280,
      videoHeight: 720,
      videoDurationSeconds: 7,
      videoBytes: 7_000_000,
    };
    const post = renderPost(videoEntry, config);
    expect(post).toContain("video: 'https://files.example/gameplay.mp4'");
    expect(post).not.toContain("\nimage:");
    expect(renderSocialOrg([videoEntry], config)).toContain(
      "[[https://files.example/gameplay.mp4][Two slimes & a hero]]",
    );
    expect(renderRss([videoEntry], config)).toContain("&lt;video controls");
    const feed = JSON.parse(renderJsonFeed([videoEntry], config)) as {
      items: Array<{ attachments?: Array<Record<string, unknown>> }>;
    };
    expect(feed.items[0]?.attachments?.[0]).toMatchObject({
      url: "https://files.example/gameplay.mp4",
      mime_type: "video/mp4",
      size_in_bytes: 7_000_000,
      duration_in_seconds: 7,
    });
  });
});
