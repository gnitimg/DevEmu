import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Modal, fmtTime } from '../components/Modal.tsx';
import type { ProjectMeta } from '../../core/types.ts';

export function Projects({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => {
    api.listProjects().then((r) => {
      if (r.ok) setProjects(r.data);
    });
  }, []);

  useEffect(reload, [reload]);

  async function remove(p: ProjectMeta) {
    if (!window.confirm(`删除项目「${p.name}」？其下虚拟机、APK 与测试记录都会删除，不可恢复。`)) return;
    const r = await api.deleteProject(p.id);
    if (!r.ok || !r.data) window.alert(r.ok ? '删除失败' : r.error);
    reload();
  }

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">项目</h1>
        <span className="page-sub">每个项目独立管理虚拟机、APK 与测试记录</span>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            新建项目
          </button>
        </div>
      </div>
      {projects === null ? (
        <div className="empty">
          <span className="spinner" />
        </div>
      ) : projects.length === 0 ? (
        <div className="empty">
          还没有项目
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            新建一个
          </button>
        </div>
      ) : (
        <div className="proj-grid">
          {projects.map((p) => (
            <div key={p.id} className="proj-card" onClick={() => onOpen(p.id)}>
              <div className="proj-name">{p.name}</div>
              <div className="proj-note">{p.note ?? ''}</div>
              <div className="proj-meta">
                <span>{fmtTime(p.createdAt)} 创建</span>
                <button
                  className="link-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(p);
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {creating && (
        <NewProjectModal
          onDone={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function NewProjectModal({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    const r = await api.createProject(name.trim(), note.trim() || undefined);
    if (!r.ok) {
      setError(r.error);
      setBusy(false);
      return;
    }
    onDone();
  }

  return (
    <Modal
      title="新建项目"
      onClose={onDone}
      footer={
        <>
          <button className="btn" onClick={onDone}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={create}>
            {busy ? '创建中' : '创建'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>项目名</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 商城 App" autoFocus />
      </div>
      <div className="form-row">
        <label>备注（可选）</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如 v2 重构联调" />
      </div>
      {error && <div className="error-line" style={{ border: 'none', padding: '0 0 0 1px' }}>{error}</div>}
    </Modal>
  );
}
