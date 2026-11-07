import { describe, expect, it } from "vitest";
import { completeMarkdown, htmlText, linkedText, referencedText, textSections, tokenizeText } from "./text.js";

export const inspiration = "No minusvalores aquello que te inspira. [Defold es tan liviano y crea compilados tan óptimos]\\([https://defold.com/2020/05/31/The-Defold-engine-code-style/](https://defold.com/2020/05/31/The-Defold-engine-code-style/)) simplemente porque sus creadores se sintieron inspirados al ver como [los ingenieros de God of War crearon un ejecutable de 1,5 MB]\\([https://www.gamedeveloper.com/design/gdc-i-god-of-war-i-how-the-left-and-right-brain-learned-to-love-one-another](https://www.gamedeveloper.com/design/gdc-i-god-of-war-i-how-the-left-and-right-brain-learned-to-love-one-another))";

describe("draft text syntax", () => {
  it("renders the Defold / God of War links as zero-based references", () => {
    const source = inspiration.replace("]\\([https://defold.com/2020/05/31/The-Defold-engine-code-style/](https://defold.com/2020/05/31/The-Defold-engine-code-style/))",
      "]\\(https\\://defold.com/2020/05/31/The-Defold-engine-code-style/)");
    const expected = "No minusvalores aquello que te inspira. Defold es tan liviano y crea compilados tan óptimos [0] simplemente porque sus creadores se sintieron inspirados al ver como los ingenieros de God of War crearon un ejecutable de 1,5 MB [1]\n\n[0]https://defold.com/2020/05/31/The-Defold-engine-code-style/\n[1]https://www.gamedeveloper.com/design/gdc-i-god-of-war-i-how-the-left-and-right-brain-learned-to-love-one-another";
    expect(referencedText(source)).toBe(expected);
    expect(referencedText(expected)).toBe(expected);
  });

  it("reuses the same number for repeated URLs across manual sections", () => {
    const source = "## [First](https://example.com) ## [Second](https://example.org) [Again](https://example.com) ##";
    expect(referencedText(source, true)).toBe("First [0]\n\n##\n\nSecond [1] Again [0]\n\n[0]https://example.com\n[1]https://example.org");
  });

  it("leaves literal code, bare URLs and non-web links unnumbered", () => {
    const source = '`[Code](https://example.com)` https://example.org [bad](javascript:alert(1))';
    expect(referencedText(source)).toBe(source);
  });

  it("accepts the pasted Defold / God of War example and normalizes it to Markdown", () => {
    const rendered = linkedText(inspiration);
    expect(rendered.links.map(link => link.url)).toEqual([
      "https://defold.com/2020/05/31/The-Defold-engine-code-style/",
      "https://www.gamedeveloper.com/design/gdc-i-god-of-war-i-how-the-left-and-right-brain-learned-to-love-one-another",
    ]);
    expect(rendered.text).toBe("No minusvalores aquello que te inspira. Defold es tan liviano y crea compilados tan óptimos simplemente porque sus creadores se sintieron inspirados al ver como los ingenieros de God of War crearon un ejecutable de 1,5 MB");
    expect(completeMarkdown(inspiration)).toContain("[Defold es tan liviano y crea compilados tan óptimos](https://defold.com/");
    expect(completeMarkdown(inspiration)).not.toContain("]\\(");
    expect(linkedText(completeMarkdown(inspiration))).toEqual(rendered);
  });

  it("handles balanced URL parentheses, optional titles, escapes and adjacent links", () => {
    const source = '[a \\[b\\]](https://example.com/a_(b)?x=1&y=2 "Title")[dos](<https://example.org>)';
    const rendered = linkedText(source);
    expect(rendered.text).toBe("a [b]dos");
    expect(rendered.links).toEqual([
      { start: 0, end: 5, url: "https://example.com/a_(b)?x=1&y=2" },
      { start: 5, end: 8, url: "https://example.org" },
    ]);
    expect(linkedText(completeMarkdown(source))).toEqual(rendered);
  });

  it("keeps code, images, Org links and escaped syntax literal", () => {
    const source = [
      '`[label](https://example.com) ##`',
      '```md\n[label](https://example.com)\n##\n```',
      '~~~md\n##\n~~~',
      '#+begin_src text\n##\n#+end_src',
      '[[https://example.com][Label]]',
      '![image](https://example.com/image.png)',
      '\\[label](https://example.com) \\##',
    ].join("\n");
    expect(completeMarkdown(source)).toBe(source);
    expect(linkedText(source)).toEqual({ text: source, links: [] });
  });

  it("uses only standalone ## outside code and links as a break", () => {
    expect(textSections("## \n Primero ## \n## Segundo \n##")).toEqual(["Primero", "Segundo"]);
    const source = "C## #tag ### https://example.com/##fragment [## label](https://example.com/##)";
    expect(textSections(source)).toEqual([source]);
    expect(completeMarkdown("Uno\n\n##\n\nDos")).toBe("Uno\n\nDos");
  });

  it("retains malformed links and unsafe schemes as literal text", () => {
    for (const source of ["[bad](javascript:alert(1))", "[bad](data:text/html,test)",
      "[bad](https://user:password@example.com)", "[bad](https://example.com", "[bad](no-url)"]) {
      expect(tokenizeText(source).some(token => token.kind === "link")).toBe(false);
      expect(linkedText(source).text).toBe(source);
    }
  });

  it("escapes HTML without losing the link text or URL", () => {
    expect(htmlText('<script>bad</script> [A & B](https://example.com/?x=1&y=2)')).toBe(
      '&lt;script&gt;bad&lt;/script&gt; <a href="https://example.com/?x=1&amp;y=2">A &amp; B</a>',
    );
    expect(linkedText("[https://example.com](https://example.com)", true).text).toBe("https://example.com");
  });
});
