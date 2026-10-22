import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useDialogFocus } from './dialogFocus';

// A chat image, tapped: a big centred modal with the full picture, instead of navigating away (#72). Follows
// Confirm.tsx's pattern (its own tiny store, Esc caught in the capture phase, focus trapped by useDialogFocus).

interface Shown {
  src: string;
  alt: string;
}

const useImagePreview = create<{ shown: Shown | null }>(() => ({ shown: null }));

export function openImagePreview(src: string, alt: string) {
  useImagePreview.setState({ shown: { src, alt } });
}

function close() {
  useImagePreview.setState({ shown: null });
}

export function ImagePreview() {
  const shown = useImagePreview((s) => s.shown);
  if (!shown) return null;
  return <Preview shown={shown} />;
}

function Preview({ shown }: { shown: Shown }) {
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box);
  useEffect(() => {
    // Capture phase, so Esc closes only the preview and not the phone or panel behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="image-preview-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} className="image-preview" role="dialog" aria-modal="true" aria-label="Preview" tabIndex={-1}>
        <div className="image-preview-head">
          <span>Preview</span>
          <button type="button" className="image-preview-close" aria-label="Close preview" onClick={close}>
            ✕
          </button>
        </div>
        <img src={shown.src} alt={shown.alt} className="image-preview-img" />
      </div>
    </div>
  );
}
