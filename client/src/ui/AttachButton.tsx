import { useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { attachmentProblem, kindOf, MAX_FILES, type AttachmentKind } from '../../../shared/attachments';
import type { AttachmentView } from '../../../shared/types';
import { normaliseImage } from './attachments';

// The 📎 on a message box (#48, reusable for agents' chats): opens the file picker (on a phone: camera roll and
// camera, since a plain <input type=file> already offers both), and the chip row for files picked or pasted into
// the box. Each chip uploads itself in the background; Send waits for the ones still going.

const ACCEPT = 'image/*,video/mp4,video/webm,video/quicktime,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.htm,.log';

const dropExt = (name: string) => name.replace(/\.[^./\\]+$/, '');

/** One file on a message box, from the moment it's picked (or pasted) to the moment it's uploaded or fails. */
export interface PendingAttachment {
  key: string;
  name: string;
  kind: AttachmentKind;
  previewUrl: string | null; // an image's own object URL, for the chip's thumbnail
  state: 'uploading' | 'done' | 'failed';
  error?: string;
  id?: string;
  view?: AttachmentView;
}

/** Manages a message box's pending files: picking or pasting adds a chip that uploads itself, in the background. */
export function usePendingAttachments() {
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;

  const patch = (key: string, p: Partial<PendingAttachment>) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...p } : f)));

  const uploadOne = async (file: File, key: string) => {
    const isImage = file.type.startsWith('image/');
    try {
      let blob: Blob = file;
      let name = file.name;
      if (isImage) {
        const result = await normaliseImage(file);
        if ('error' in result) throw new Error(result.error);
        blob = result.blob;
        name = `${dropExt(file.name) || 'image'}${result.ext}`;
      } else {
        const problem = attachmentProblem({ name: file.name, size: file.size });
        if (problem) throw new Error(problem.message);
      }
      const view = await api.upload(blob, name);
      patch(key, { state: 'done', id: view.id, view, name: view.name });
    } catch (err) {
      patch(key, { state: 'failed', error: err instanceof Error ? err.message : 'Upload failed' });
    }
  };

  const add = (picked: File[]) => {
    const room = MAX_FILES - filesRef.current.length;
    if (room <= 0 || picked.length > room) useStore.getState().pushToast('info', `Up to ${MAX_FILES} files per message.`);
    const take = picked.slice(0, Math.max(0, room));
    const entries: PendingAttachment[] = take.map((file) => ({
      key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      kind: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : kindOf(file.name),
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      state: 'uploading',
    }));
    setFiles((fs) => [...fs, ...entries]);
    for (const [i, file] of take.entries()) void uploadOne(file, entries[i].key);
  };

  const remove = (key: string) => {
    const f = filesRef.current.find((x) => x.key === key);
    if (f?.previewUrl) URL.revokeObjectURL(f.previewUrl);
    setFiles((fs) => fs.filter((x) => x.key !== key));
  };

  const reset = () => {
    for (const f of filesRef.current) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    setFiles([]);
  };

  return {
    files,
    add,
    remove,
    reset,
    ids: () => files.filter((f): f is PendingAttachment & { id: string } => f.state === 'done' && !!f.id).map((f) => f.id),
    busy: files.some((f) => f.state === 'uploading'),
    failed: files.some((f) => f.state === 'failed'),
  };
}

export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        multiple
        accept={ACCEPT}
        className="attach-input"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      <button type="button" className="btn-attach" title={`Attach a photo, video or document (up to ${MAX_FILES})`} disabled={disabled} onClick={() => ref.current?.click()}>
        📎
      </button>
    </>
  );
}

const KIND_ICON: Record<AttachmentKind, string> = { image: '🖼️', video: '🎬', doc: '📄' };

/** The chip row for a message box's pending files: a thumbnail, an ✕, and the uploading/failed state. */
export function AttachmentChips({ files, remove }: { files: PendingAttachment[]; remove: (key: string) => void }) {
  if (files.length === 0) return null;
  return (
    <div className="attach-chips">
      {files.map((f) => (
        <div key={f.key} className={`attach-chip ${f.state === 'failed' ? 'attach-chip-failed' : ''}`} title={f.state === 'failed' ? f.error : f.name}>
          {f.previewUrl ? <img src={f.previewUrl} alt="" className="attach-chip-thumb" /> : <span className="attach-chip-icon">{KIND_ICON[f.kind]}</span>}
          <span className="attach-chip-name">{f.name}</span>
          {f.state === 'uploading' && <span className="attach-chip-spin" aria-label="Uploading" />}
          {f.state === 'failed' && <span className="attach-chip-warn">⚠</span>}
          <button type="button" className="attach-chip-x" aria-label={`Remove ${f.name}`} onClick={() => remove(f.key)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
