import fs from 'node:fs';
import path from 'node:path';
import type { ProjectMeta } from './types.ts';

const INVALID = /[\\/:*?"<>|]/g;

export function sanitizeId(name: string): string {
  const cleaned = name.replace(INVALID, '_').trim();
  return cleaned || `project-${Date.now().toString(36)}`;
}

export function projectsDir(dataRoot: string): string {
  return path.join(dataRoot, 'projects');
}

export function createProject(dataRoot: string, name: string, note?: string): ProjectMeta {
  const base = sanitizeId(name);
  const dir = projectsDir(dataRoot);
  fs.mkdirSync(dir, { recursive: true });
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(dir, id))) {
    id = `${base}-${n++}`;
  }
  const projectDir = path.join(dir, id);
  fs.mkdirSync(projectDir, { recursive: true });
  const meta: ProjectMeta = {
    id,
    name: name.trim(),
    note: note?.trim() || undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

export function listProjects(dataRoot: string): ProjectMeta[] {
  const dir = projectsDir(dataRoot);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const projects: ProjectMeta[] = [];
  for (const entry of entries) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, entry, 'project.json'), 'utf8')) as ProjectMeta;
      if (meta && typeof meta.id === 'string') projects.push(meta);
    } catch {
      // 非 DevEmu 目录跳过
    }
  }
  return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateProject(dataRoot: string, id: string, patch: { name?: string; note?: string }): ProjectMeta | null {
  const file = path.join(projectsDir(dataRoot), id, 'project.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectMeta;
  if (patch.name !== undefined) meta.name = patch.name.trim();
  if (patch.note !== undefined) meta.note = patch.note.trim() || undefined;
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

export function deleteProject(dataRoot: string, id: string): boolean {
  const dir = path.join(projectsDir(dataRoot), id);
  // 只允许删 projects/ 下一级目录，防路径逃逸
  if (path.dirname(dir) !== projectsDir(dataRoot) || !fs.existsSync(path.join(dir, 'project.json'))) {
    return false;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
