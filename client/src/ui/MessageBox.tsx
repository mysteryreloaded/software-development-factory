import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';
import { useTouch } from '../world/touch';

// The message box shared by the phone's CEO chat and the agent terminal: Enter sends,
// Shift+Enter adds a line. It starts one line tall, grows to about six, then scrolls.
// Put it in a <form> next to its Send button; Enter submits the form the same way
// pressing Enter in a single-line input did, so a disabled Send button still blocks it.
// On a touch device (no Shift+Enter on the on-screen keyboard), Enter just types a newline.

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'rows'> & {
  value: string;
  onChange: (value: string) => void;
};

/** Whether this Enter keystroke should send the message (vs. just typing a newline). */
export function enterSends(x: { touch: boolean; shiftKey: boolean; isComposing: boolean }): boolean {
  if (x.touch || x.shiftKey || x.isComposing) return false;
  return true;
}

export function MessageBox({ value, onChange, className, onKeyDown, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const touch = useTouch((s) => s.on);

  // Fit the height to the text; CSS max-height caps it at about six lines, after which it scrolls.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value]);

  return (
    <textarea
      {...rest}
      ref={ref}
      rows={1}
      enterKeyHint={touch ? 'enter' : 'send'}
      className={`msg-box ${className ?? ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || e.key !== 'Enter') return;
        // Enter that confirms an IME composition (Japanese, Chinese, …) must not send.
        const composing = e.nativeEvent.isComposing || e.keyCode === 229;
        if (!enterSends({ touch, shiftKey: e.shiftKey, isComposing: composing })) return;
        e.preventDefault();
        const form = e.currentTarget.form;
        const send = form?.querySelector<HTMLButtonElement>('button:not([type="button"])');
        if (form && !send?.disabled) form.requestSubmit();
      }}
    />
  );
}
