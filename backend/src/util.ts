import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as fssync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function nowMs(): number {
  return Date.now();
}

export function sha256Hex(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sourceIdForUrl(url: string): string {
  return sha256Hex(url).slice(0, 16);
}

export function normalizeWhitespace(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(file: string): boolean {
  return fssync.existsSync(file);
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (!(await pathExists(file))) return fallback;
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, `${JSON.stringify(value)}\n`);
}

export async function readTextIfExists(file: string, fallback = ""): Promise<string> {
  if (!(await pathExists(file))) return fallback;
  return fs.readFile(file, "utf8");
}

export async function copyDir(from: string, to: string): Promise<void> {
  if (!(await pathExists(from))) return;
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });
}

export async function listFiles(root: string, predicate?: (file: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (!(await pathExists(dir))) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (ignoredName(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (!predicate || predicate(full)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

export function ignoredName(name: string): boolean {
  return new Set([".git", "node_modules", "target", "dist", "build", ".cache", ".next"]).has(name);
}

export function relPosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

export function slugify(value: string, fallback = "topic"): string {
  let slug = "";
  let lastDash = false;
  for (const ch of value.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      slug += ch;
      lastDash = false;
    } else if (!lastDash && slug.length > 0) {
      slug += "-";
      lastDash = true;
    }
  }
  slug = slug.replace(/^-+|-+$/g, "");
  return slug || fallback;
}

export function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function fileUrl(file: string): string {
  return pathToFileURL(file).toString();
}

export function directoryUrl(dir: string): string {
  const url = pathToFileURL(dir).toString();
  return url.endsWith("/") ? url : `${url}/`;
}

export function validateSimpleId(label: string, value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`invalid ${label}: ${value}`);
}

export function truncateChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  return match ? match[1].trim() : trimmed;
}

export function cleanFrontmatterValue(value: string): string {
  let out = value.trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1);
  }
  return out.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
