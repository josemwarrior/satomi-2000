import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishBluesky, type BlueskySession } from "./bluesky.js";
import type { PreparedEntry, ResolvedConfig, ThreadReply } from "../types.js";

const mocks = vi.hoisted(() => ({ login: vi.fn(), create: vi.fn(), get: vi.fn(), facets: vi.fn() }));
vi.mock("@atproto/api", () => ({
  AtpAgent: class {
    session?: { did: string };
    com = { atproto: { repo: { createRecord: mocks.create, getRecord: mocks.get } } };
    async login(args: unknown) {
      mocks.login(args);
      this.session = { did: "did:plc:test" };
    }
  },
  RichText: class {
    text: string;
    facets = [{ index: { byteStart: 0, byteEnd: 3 }, features: [] }];
    constructor({ text }: { text: string }) { this.text = text; }
    async detectFacets(agent: unknown) { mocks.facets(this.text, agent); }
  },
}));

const credentials = { handle: "test.bsky.social", appPassword: "test" };
const config = {} as ResolvedConfig;
const reply: ThreadReply = {
  root: { uri: "at://root", cid: "cid-root", url: "root" },
  parent: { uri: "at://parent", cid: "cid-parent", url: "parent" },
};
function entry(text = "...rest"): PreparedEntry {
  return { platformPayloads: { bluesky: text }, language: "es", publishedAt: "2026-09-15T00:00:00Z" } as PreparedEntry;
}
const storedReply = {
  parent: { uri: "at://parent", cid: "cid-parent" },
  root: { uri: "at://root", cid: "cid-root" },
};

beforeEach(() => { vi.clearAllMocks(); });

describe("Bluesky thread records", () => {
  it("converts Markdown links to facets with UTF-8 byte offsets", async () => {
    mocks.create.mockResolvedValue({ data: { uri: "at://new", cid: "cid-new" } });
    await publishBluesky(entry("👩🏽‍💻 Mira [Defold](https://defold.com) y [más](https://example.org)."), undefined, config, credentials, "links");
    const record = mocks.create.mock.calls[0]![0].record;
    expect(record.text).toBe("👩🏽‍💻 Mira Defold y más.");
    expect(record.facets).toContainEqual({
      index: { byteStart: Buffer.byteLength("👩🏽‍💻 Mira "), byteEnd: Buffer.byteLength("👩🏽‍💻 Mira Defold") },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://defold.com" }],
    });
    expect(record.facets).toContainEqual({
      index: { byteStart: Buffer.byteLength("👩🏽‍💻 Mira Defold y "), byteEnd: Buffer.byteLength("👩🏽‍💻 Mira Defold y más") },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.org" }],
    });
  });

  it("does not recover an existing post with a different link target", async () => {
    mocks.create.mockRejectedValue(new Error("record already exists"));
    mocks.get.mockResolvedValue({ data: { uri: "at://existing", cid: "cid-existing", value: {
      text: "Link", facets: [{ index: { byteStart: 0, byteEnd: 4 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://wrong.example" }] }],
    } } });
    await expect(publishBluesky(entry("[Link](https://example.com)"), undefined, config, credentials, "links")).rejects.toThrow("record already exists");
  });

  it("sends both strong references and recalculates facets for each part using one session", async () => {
    mocks.create.mockResolvedValue({ data: { uri: "at://new", cid: "cid-new" } });
    const session: BlueskySession = {};
    await publishBluesky(entry("First..."), undefined, config, credentials, "key1", undefined, session);
    await publishBluesky(entry(), undefined, config, credentials, "key2", reply, session);
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(mocks.facets.mock.calls.map(([text]) => text)).toEqual(["First...", "...rest"]);
    expect(mocks.create.mock.calls[0]![0].record.reply).toBeUndefined();
    expect(mocks.create.mock.calls[1]![0]).toMatchObject({
      rkey: "key2", record: { text: "...rest", reply: storedReply },
    });
  });

  it("recovers an existing record only when text and both references match", async () => {
    mocks.create.mockRejectedValue(new Error("record already exists"));
    mocks.get.mockResolvedValue({ data: {
      uri: "at://existing", cid: "cid-existing", value: { text: "...rest", reply: storedReply },
    } });
    await expect(publishBluesky(entry(), undefined, config, credentials, "key", reply)).resolves.toMatchObject({ uri: "at://existing", cid: "cid-existing" });
    mocks.get.mockResolvedValue({ data: {
      uri: "at://existing", cid: "cid-existing", value: { text: "...rest", reply: { ...storedReply, parent: { uri: "at://other", cid: "other" } } },
    } });
    await expect(publishBluesky(entry(), undefined, config, credentials, "key", reply)).rejects.toThrow("record already exists");
  });
});
