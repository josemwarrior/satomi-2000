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
    expect(renderSocialOrg([entry], config)).toContain("#+NICK: Game");
    expect(renderSocialOrg([entry], config)).toContain("#+TITLE: Game on Org Social");
    expect(renderSocialOrg([entry], config)).toContain("#+LANGUAGE: es en");
    expect(renderSocialOrg([entry], config)).toContain("#+LINK: https://example.com/about");
    expect(renderSocialOrg([entry], config)).toContain(":LANG: es");
    expect(renderRss([entry], config)).toContain("A test &amp; update");
    const feed = JSON.parse(renderJsonFeed([entry], config)) as { items: unknown[] };
    expect(feed.items).toHaveLength(1);
  });

  it("does not add entries that opted out when social.org is regenerated later", () => {
    expect(renderSocialOrg([{ ...entry, orgSocial: false }], config)).not.toContain(
      "The combat system works.",
    );
  });
});
