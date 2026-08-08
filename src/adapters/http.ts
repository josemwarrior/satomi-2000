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
    const detail = record.error ?? record.detail ?? record.title ?? response.statusText;
    throw new SatomiError(`${action} failed (${response.status}): ${String(detail).slice(0, 300)}`);
  }
  return body as T;
}

export function authorization(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
