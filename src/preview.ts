import { graphemeCount } from "./graphemes.js";
import { buildPlatformThread, countPlatformText } from "./threads.js";
import type { PlatformName, ResolvedConfig } from "./types.js";
import twitterText from "twitter-text";
import { completeMarkdown, linkedText, referencedText } from "./text.js";

type Destination = PlatformName | "org_social" | "jekyll";
const labels: Record<Destination, string> = {
  mastodon: "Mastodon", bluesky: "Bluesky", x: "X", telegram: "Telegram",
  org_social: "Org Social", jekyll: "Jekyll",
};
const limits: Record<PlatformName, number> = { mastodon: 500, bluesky: 300, x: 280, telegram: 4096 };
const nativeLimits: Record<PlatformName, number> = { mastodon: Infinity, bluesky: 300, x: 280, telegram: 4096 };
let active: Destination = "mastodon";
let reservedUrlLength = 23;
let timer: ReturnType<typeof setTimeout> | undefined;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing preview element: ${id}`);
  return found as T;
}
const input = element<HTMLTextAreaElement>("draft");
const cards = element("cards");
const status = element("preview-status");
const limitInput = element<HTMLInputElement>("limit");
const urlInput = element<HTMLInputElement>("url-length");
const mediaInput = element<HTMLInputElement>("with-media");
const clearButton = element<HTMLButtonElement>("clear");
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

function isPlatform(destination: Destination): destination is PlatformName {
  return destination !== "org_social" && destination !== "jekyll";
}

function emptyState(title: string, description: string, error = false): void {
  cards.replaceChildren();
  const box = document.createElement("div");
  box.className = error ? "empty-state error-state" : "empty-state";
  if (error) box.setAttribute("role", "alert");
  const symbol = document.createElement("span");
  symbol.className = "empty-symbol";
  symbol.textContent = error ? "!" : "…";
  symbol.setAttribute("aria-hidden", "true");
  const heading = document.createElement("h3");
  heading.textContent = title;
  const message = document.createElement("p");
  message.textContent = description;
  box.append(symbol, heading, message);
  cards.append(box);
}

function postBody(body: HTMLElement, source: string): void {
  const fallback = active === "mastodon" || active === "x";
  const rendered = fallback ? { text: referencedText(source), links: [] } : linkedText(source);
  const links = fallback ? [] : [...rendered.links];
  for (const { url, indices: [start, end] } of twitterText.extractUrlsWithIndices(rendered.text, { extractUrlsWithoutProtocol: false })) {
    if (!links.some(link => start < link.end && end > link.start)) links.push({ start, end, url });
  }
  links.sort((left, right) => left.start - right.start);
  let offset = 0;
  for (const link of links) {
    body.append(document.createTextNode(rendered.text.slice(offset, link.start)));
    const anchor = document.createElement("a");
    anchor.href = link.url;
    anchor.textContent = rendered.text.slice(link.start, link.end);
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    body.append(anchor);
    offset = link.end;
  }
  body.append(document.createTextNode(rendered.text.slice(offset)));
}

function render(): void {
  if (timer !== undefined) clearTimeout(timer);
  const text = input.value.trim();
  const words = text.match(/\S+/gu)?.length ?? 0;
  element("word-count").textContent = `${words.toLocaleString("es")} ${words === 1 ? "palabra" : "palabras"}`;
  element("character-count").textContent = `${graphemeCount(text).toLocaleString("es")} caracteres`;
  clearButton.disabled = !input.value;
  if (!text) {
    status.textContent = "Tu hilo empieza aquí";
    emptyState("Dale espacio a tu idea", "Escribe a la izquierda o carga el ejemplo para ver cómo se reparte en cada red.");
    return;
  }
  if (isPlatform(active) && (!Number.isSafeInteger(limits[active]) || limits[active] < 1 ||
    (active === "mastodon" && (!Number.isSafeInteger(reservedUrlLength) || reservedUrlLength < 1)))) {
    status.textContent = "Revisa los ajustes";
    emptyState("El límite debe ser un número entero positivo", "Corrige el valor para volver a ver los fragmentos.", true);
    return;
  }
  let parts: string[];
  try {
    const config = {
      platforms: Object.fromEntries(Object.entries(limits).map(([name, max_characters]) => [name, { max_characters }])),
    } as ResolvedConfig;
    parts = isPlatform(active)
      ? buildPlatformThread(active, text, config, active === "telegram" && mediaInput.checked ? "png" : undefined,
        undefined, reservedUrlLength)
      : [completeMarkdown(text)];
  } catch {
    status.textContent = "Este texto necesita un ajuste";
    emptyState("Una palabra o un enlace no cabe", "No se cortan palabras. Acorta esa palabra o enlace, aumenta el límite cuando la red lo permita, o cambia de pestaña. Los puntos de continuación también ocupan espacio.", true);
    return;
  }
  status.textContent = `${parts.length} ${parts.length === 1 ? "publicación" : "publicaciones"} en ${labels[active]}`;
  const fragment = document.createDocumentFragment();
  parts.forEach((part, index) => {
    const card = document.createElement("article");
    card.className = "post-card";
    const header = document.createElement("div");
    header.className = "post-meta";
    const position = document.createElement("span");
    position.className = "post-position";
    position.textContent = `POST ${String(index + 1).padStart(2, "0")}`;
    const count = document.createElement("span");
    const used = isPlatform(active) ? countPlatformText(active, part, reservedUrlLength) : graphemeCount(linkedText(part).text);
    let maximum = isPlatform(active) ? Math.min(limits[active], nativeLimits[active]) : Infinity;
    if (active === "telegram" && mediaInput.checked && index === 0) maximum = Math.min(maximum, 1024);
    count.textContent = Number.isFinite(maximum) ? `${used} / ${maximum}` : `${used.toLocaleString("es")} caracteres · sin límite`;
    if (active === "bluesky") count.title = `${new TextEncoder().encode(linkedText(part).text).byteLength} / 3000 bytes UTF-8`;
    header.append(position, count);
    const body = document.createElement("p");
    body.className = "post-text";
    // Build text and safe HTTP(S) anchors with DOM APIs; never inject user HTML.
    postBody(body, part);
    card.append(header, body);
    if (active === "telegram" && mediaInput.checked && index === 0) {
      const attachment = document.createElement("div");
      attachment.className = "attachment-note";
      attachment.textContent = "Imagen o vídeo en esta publicación";
      card.append(attachment);
    }
    fragment.append(card);
  });
  cards.replaceChildren(fragment);
}

function select(destination: Destination): void {
  active = destination;
  for (const tab of tabs) {
    const selected = tab.dataset.network === destination;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  element("preview-panel").setAttribute("aria-labelledby", `tab-${destination}`);
  element("limit-field").hidden = !isPlatform(destination);
  element("url-field").hidden = destination !== "mastodon";
  element("media-field").hidden = destination !== "telegram";
  if (isPlatform(destination)) {
    limitInput.value = String(limits[destination]);
    if (Number.isFinite(nativeLimits[destination])) limitInput.max = String(nativeLimits[destination]);
    else limitInput.removeAttribute("max");
  }
  const descriptions: Record<Destination, string> = {
    mastodon: "Límite según tu instancia. Enlaces con referencias [0], [1] y URLs al final del hilo. ## fuerza otro post.",
    bluesky: "Enlaces sobre el texto. Hasta 300 caracteres visuales y 3000 bytes. ## fuerza otro post.",
    x: "Hasta 280 caracteres ponderados. Referencias [0], [1] y URLs al final del hilo. ## fuerza otro post.",
    telegram: "Enlaces sobre el texto. Hasta 4096 caracteres; con multimedia, 1024 en el primer post. ## fuerza otro post.",
    org_social: "Un solo post con enlaces nativos de Org. ## se convierte en una separación de párrafos.",
    jekyll: "Una entrada completa con enlaces Markdown. ## se convierte en una separación de párrafos.",
  };
  element("network-description").textContent = descriptions[destination];
  render();
}

input.addEventListener("input", () => {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(render, 120);
});
limitInput.addEventListener("input", () => {
  if (isPlatform(active)) limits[active] = limitInput.valueAsNumber;
  render();
});
urlInput.addEventListener("input", () => { reservedUrlLength = urlInput.valueAsNumber; render(); });
mediaInput.addEventListener("change", render);
clearButton.addEventListener("click", () => { input.value = ""; render(); input.focus(); });
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => select(tab.dataset.network as Destination));
  tab.addEventListener("keydown", (event) => {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    tabs[next]!.focus();
    select(tabs[next]!.dataset.network as Destination);
  });
});
element("example").addEventListener("click", () => {
  input.value = `No minusvalores aquello que te inspira. [Defold es tan liviano y crea compilados tan óptimos](https://defold.com/2020/05/31/The-Defold-engine-code-style/) simplemente porque sus creadores se sintieron inspirados al ver como [los ingenieros de God of War crearon un ejecutable de 1,5 MB](https://www.gamedeveloper.com/design/gdc-i-god-of-war-i-how-the-left-and-right-brain-learned-to-love-one-another)

##

La inspiración también puede marcar el ritmo de un hilo. Con dos almohadillas indico dónde empieza la siguiente publicación, aunque todavía quede espacio en la anterior. Si una sección es demasiado larga, Satomi la sigue dividiendo entre palabras y conserva cada enlace completo.

##

Un emoji como 👩🏽‍💻 no cuenta igual en todas partes. Cambia de pestaña para comparar los enlaces y los límites de cada red. Jekyll y Org Social conservarán el texto completo en una sola entrada, con párrafos donde aparecen las dos almohadillas.`;
  render();
});

select(active);
