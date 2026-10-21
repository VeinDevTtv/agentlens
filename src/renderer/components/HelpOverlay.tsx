import { useEffect, useRef } from 'react';

const SHORTCUTS: Array<[string, string]> = [
  ['/', 'Focus the run search'],
  ['j / k', 'Next / previous run'],
  ['Enter', 'Open the main agent of the selected run'],
  ['Esc', 'Close panel or dialog, clear search'],
  ['1 / 2', 'Topology / Timeline view'],
  ['[', 'Toggle sidebar'],
  ['a', 'Toggle "Active only"'],
  ['r', 'Rescan session directories'],
  ['n', 'New workflow'],
  ['c', 'New chat'],
  [',', 'Open settings'],
  ['?', 'Show this help'],
];

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} className="dialog help-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="help-title">
      <div className="dialog-body">
        <h2 id="help-title">Keyboard shortcuts</h2>
        <dl className="shortcuts">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={keys}>
              <dt>
                {keys.split(' / ').map((k, i) => (
                  <span key={k}>
                    {i > 0 && ' / '}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
