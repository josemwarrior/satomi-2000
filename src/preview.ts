import { graphemeCount } from "./graphemes.js";
import { buildPlatformThread, countPlatformText } from "./threads.js";
import type { PlatformName, ResolvedConfig } from "./types.js";

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
      : [text];
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
    const used = isPlatform(active) ? countPlatformText(active, part, reservedUrlLength) : graphemeCount(part);
    let maximum = isPlatform(active) ? Math.min(limits[active], nativeLimits[active]) : Infinity;
    if (active === "telegram" && mediaInput.checked && index === 0) maximum = Math.min(maximum, 1024);
    count.textContent = Number.isFinite(maximum) ? `${used} / ${maximum}` : `${used.toLocaleString("es")} caracteres · sin límite`;
    if (active === "bluesky") count.title = `${new TextEncoder().encode(part).byteLength} / 3000 bytes UTF-8`;
    header.append(position, count);
    const body = document.createElement("p");
    body.className = "post-text";
    // User input is always plain text, including strings that look like HTML.
    body.textContent = part;
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
    mastodon: "El límite depende de tu instancia. Los enlaces tienen su propio cómputo.",
    bluesky: "Hasta 300 caracteres visuales y 3000 bytes por publicación.",
    x: "Hasta 280 caracteres ponderados. Los enlaces y los emojis cuentan de forma especial.",
    telegram: "Hasta 4096 caracteres; con multimedia, el primer fragmento admite 1024.",
    org_social: "Tu texto completo en una sola publicación, como en Satomi.",
    jekyll: "La entrada del blog conserva todo el texto, sin dividirlo.",
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
  input.value = `Hay ideas que necesitan un poco más de espacio. Una frase se convierte en un párrafo, un párrafo lleva a otro y, cuando te das cuenta, lo que querías contar ya no cabe en una sola publicación.

Hoy estoy probando una forma más sencilla de compartir esas ideas: escribir el texto completo y dejar que cada red encuentre su propio ritmo. Las palabras se mantienen enteras y los puntos suspensivos conectan cada fragmento con el siguiente. No hace falta contar caracteres mientras escribo.

Lo interesante es que el mismo texto puede ocupar tres publicaciones en una red, cuatro en otra y una sola en el blog. El contenido es el mismo; lo que cambia es el espacio disponible para contarlo.

También hay pequeños detalles que importan. Un emoji como 👩🏽‍💻 no cuenta igual en todas partes. Y un enlace largo, por ejemplo https://example.com/una-historia-con-mucho-que-contar, puede tener un peso distinto al que parece. Por eso esta vista previa utiliza el cálculo de cada red.

Al final, lo que quiero es concentrarme en la historia. Escribir con calma, revisar los cortes y comprobar que la última palabra llega a su destino. El texto completo seguirá en Jekyll y Org Social; en las demás redes, las respuestas irán construyendo el hilo.`;
  render();
});

select(active);
