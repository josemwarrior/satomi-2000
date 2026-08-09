import { SatomiError } from "../errors.js";

export async function responseJson<T>(response: Response, action: string): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { detail: text.slice(0, 300) };
  }
  if (!response.ok) {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const nested = Array.isArray(record.errors) && record.errors[0] && typeof record.errors[0] === "object"
      ? record.errors[0] as Record<string, unknown>
      : undefined;
    const nestedDetail = nested
      ? [nested.detail, nested.parameter ? `parameter=${String(nested.parameter)}` : undefined]
          .filter(Boolean)
          .join("; ")
      : undefined;
    const detail = record.error ?? record.detail ?? nestedDetail ?? record.title ?? response.statusText;
    throw new SatomiError(`${action} failed (${response.status}): ${String(detail).slice(0, 300)}`);
  }
  return body as T;
}

export function authorization(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
